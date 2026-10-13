"""Production-style IMAPS/SMTPS validation against real mail services."""

import json
import time
import unittest
import uuid

from tests.roundcube_tls_stack import ADDRESS, PASSWORD, RoundcubeTlsStack
from tests.test_roundcube_tls import ROOT, docker


class TestRoundcubeMailTls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack = RoundcubeTlsStack()
        cls.addClassCleanup(cls.stack.close)
        cls.stack.start()
        name = cls.stack.names["roundcube"]
        docker("exec", name, "mkdir", "-p", "/test")
        docker("cp", str(ROOT / "tests/roundcube-tls/probe.php"), name + ":/test/probe.php")
        docker("cp", str(ROOT / "docker/roundcube/config/local.inc.php"), name + ":/test/local.inc.php")

    def probe(self, mode, marker=None):
        service, port = ("dovecot", "993") if mode == "imap" else ("postfix", "465")
        args = ["exec", self.stack.names["roundcube"], "php", "/test/probe.php", mode, service, port, ADDRESS, PASSWORD]
        if marker:
            args.append(marker)
        return json.loads(docker(*args).stdout)

    def test_real_imap_and_smtp_authentication_with_verified_certificates(self):
        for mode in ("imap", "smtp"):
            with self.subTest(mode=mode):
                self.assertTrue(self.probe(mode)["ok"])

    def test_public_ca_is_readable_by_the_web_worker(self):
        docker("exec", "--user", "www-data", self.stack.names["roundcube"], "php", "-r",
               "exit(is_readable('/var/roundcube/config/test-ca.crt') ? 0 : 1);")

    def test_authenticated_delivery_and_anonymous_submission_rejection(self):
        self.assertTrue(self.probe("anonymous")["ok"], "SMTPS must reject an unauthenticated recipient")
        marker = "roundcube-strict-tls-" + uuid.uuid4().hex
        self.assertTrue(self.probe("send", marker)["ok"])
        for _ in range(30):
            result = docker("exec", self.stack.names["dovecot"], "doveadm", "search", "-u", ADDRESS,
                            "mailbox", "INBOX", "header", "subject", marker)
            if result.stdout.strip():
                return
            time.sleep(0.3)
        self.fail("Authenticated SMTPS message did not arrive in the legitimate mailbox")

    def test_wrong_host_certificates_block_actual_mail_services(self):
        for service, mode in (("dovecot", "imap"), ("postfix", "smtp")):
            with self.subTest(service=service):
                try:
                    self.stack.certificate(service, "wrong-host")
                    result = self.probe(mode)
                    self.assertFalse(result["ok"])
                    self.assertTrue(any("certificate" in warning.lower() for warning in result["warnings"]), result)
                finally:
                    self.stack.certificate(service, "trusted")
                self.assertTrue(self.probe(mode)["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
