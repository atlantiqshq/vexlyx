import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
MANAGER = ROOT_DIR / "system" / "python" / "mail_tls_manager.py"


class TestMailTlsManager(unittest.TestCase):
    def run_manager(self, acme: Path, output: Path, hostname: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                sys.executable,
                str(MANAGER),
                "--acme",
                str(acme),
                "--output",
                str(output),
                "--hostname",
                hostname,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_extracts_exact_mail_hostname_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            acme = root / "acme.json"
            output = root / "certs"
            certificate = b"-----BEGIN CERTIFICATE-----\ntrusted\n-----END CERTIFICATE-----\n"
            private_key = b"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n"
            acme.write_text(
                json.dumps(
                    {
                        "letsencrypt": {
                            "Certificates": [
                                {
                                    "domain": {"main": "mail.example.com", "sans": []},
                                    "certificate": base64.b64encode(certificate).decode(),
                                    "key": base64.b64encode(private_key).decode(),
                                }
                            ]
                        }
                    }
                ),
                encoding="utf-8",
            )

            first = self.run_manager(acme, output, "mail.example.com")
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertTrue(json.loads(first.stdout)["changed"])
            self.assertEqual((output / "cert.pem").read_bytes(), certificate)
            self.assertEqual((output / "key.pem").read_bytes(), private_key)

            second = self.run_manager(acme, output, "mail.example.com")
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertFalse(json.loads(second.stdout)["changed"])

    def test_rejects_missing_hostname_without_overwriting_existing_pair(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            acme = root / "acme.json"
            output = root / "certs"
            output.mkdir()
            (output / "cert.pem").write_text("existing certificate", encoding="utf-8")
            (output / "key.pem").write_text("existing key", encoding="utf-8")
            acme.write_text(json.dumps({"letsencrypt": {"Certificates": []}}), encoding="utf-8")

            result = self.run_manager(acme, output, "mail.example.com")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("No ACME certificate found", result.stderr)
            self.assertEqual((output / "cert.pem").read_text(encoding="utf-8"), "existing certificate")
            self.assertEqual((output / "key.pem").read_text(encoding="utf-8"), "existing key")


class TestProductionMailTlsWiring(unittest.TestCase):
    def test_compose_mounts_shared_certificates_and_requests_mail_hostname(self):
        compose = (ROOT_DIR / "docker-compose.prod.yml").read_text(encoding="utf-8")
        self.assertEqual(compose.count("./docker/mail-data/certs:/etc/"), 2)
        self.assertIn("/etc/postfix/certs:ro", compose)
        self.assertIn("/etc/dovecot/certs:ro", compose)
        self.assertIn("Host(`${VEXLYX_MAIL_HOSTNAME}`)", compose)
        self.assertIn("vexlyx-mail-cert.tls.certresolver=letsencrypt", compose)

    def test_installer_configures_renewal_timer(self):
        step = (ROOT_DIR / "system" / "scripts" / "install" / "steps" / "14-services-up.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("vexlyx-mail-tls.timer", step)
        self.assertIn("OnUnitActiveSec=12h", step)
        self.assertIn("sync-mail-tls.sh", step)


if __name__ == "__main__":
    unittest.main(verbosity=2)
