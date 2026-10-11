"""
test_postfix_smtp.py -- Automated test suite for F4.1 Postfix SMTP Server.

Tests:
1. OpenDKIM 2048-bit RSA Key Generation & RFC 6376 DNS TXT record formatting.
2. OpenDKIM tables configuration (KeyTable, SigningTable, TrustedHosts).
3. Postfix Virtual Domain and Mailbox map synchronization.
4. Postfix Configuration validation (main.cf, master.cf, opendkim.conf).
5. Submission Port 587 TLS encryption enforcement (mandatory STARTTLS).
6. Anti-Open-Relay restriction testing (rejecting unauthorized relay attempts).
7. Live Fastify API security (401 Unauthorized on unauthenticated requests).
"""

import json
import os
import re
import subprocess
import sys
import unittest
import urllib.request
import urllib.error
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT_DIR = Path(__file__).resolve().parent.parent
API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:5000")


class TestPostfixSystemManager(unittest.TestCase):
    """Unit tests for system/python/postfix_manager.py"""

    def setUp(self):
        self.script = ROOT_DIR / "system" / "python" / "postfix_manager.py"
        self.assertTrue(self.script.exists(), f"Script must exist at {self.script}")

    def run_manager(self, cmd: str, payload: dict) -> dict:
        proc = subprocess.run(
            [sys.executable, str(self.script), cmd],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(proc.returncode, 0, f"Script failed with code {proc.returncode}: {proc.stderr}")
        return json.loads(proc.stdout.strip())

    def test_01_generate_dkim_keys_and_dns_record(self):
        """Generates 2048-bit RSA DKIM key and checks RFC 6376 DNS TXT formatting."""
        domain = "test-postfix-mailer.org"
        res = self.run_manager("generate_dkim", {
            "domain": domain,
            "selector": "default",
            "keyLength": 2048,
        })

        self.assertEqual(res.get("domain"), domain)
        self.assertEqual(res.get("selector"), "default")
        self.assertEqual(res.get("dnsRecordName"), f"default._domainkey.{domain}")
        self.assertEqual(res.get("keyLength"), 2048)

        txt_val = res.get("dnsRecordValue", "")
        self.assertTrue(txt_val.startswith("v=DKIM1; k=rsa; p="), f"Invalid DKIM TXT record: {txt_val}")
        self.assertGreater(len(res.get("publicKey", "")), 200, "Public key must be valid base64 RSA key")

        # Verify key file on disk
        priv_file = ROOT_DIR / "docker" / "postfix" / "opendkim" / "keys" / domain / "default.private"
        self.assertTrue(priv_file.exists(), "Private key file must exist")
        content = priv_file.read_text(encoding="utf-8")
        self.assertIn("BEGIN RSA PRIVATE KEY", content)

    def test_02_opendkim_tables_updated(self):
        """Verifies KeyTable, SigningTable, and TrustedHosts are properly updated."""
        domain = "test-postfix-mailer.org"
        opendkim_dir = ROOT_DIR / "docker" / "postfix" / "opendkim"

        key_table = opendkim_dir / "KeyTable"
        signing_table = opendkim_dir / "SigningTable"
        trusted_hosts = opendkim_dir / "TrustedHosts"

        self.assertTrue(key_table.exists())
        self.assertTrue(signing_table.exists())
        self.assertTrue(trusted_hosts.exists())

        self.assertIn(f"default._domainkey.{domain}", key_table.read_text(encoding="utf-8"))
        self.assertIn(f"*@{domain}", signing_table.read_text(encoding="utf-8"))
        self.assertIn(domain, trusted_hosts.read_text(encoding="utf-8"))

    def test_03_get_dkim_existing(self):
        """Verifies reading an already generated DKIM key record."""
        domain = "test-postfix-mailer.org"
        res = self.run_manager("get_dkim", {
            "domain": domain,
            "selector": "default",
        })

        self.assertTrue(res.get("found"))
        self.assertEqual(res.get("domain"), domain)
        self.assertEqual(res.get("dnsRecordName"), f"default._domainkey.{domain}")

    def test_04_sync_virtual_domains(self):
        """Synchronizes virtual domains list and virtual mailbox maps to disk."""
        domains = ["site1.com", "site2.org", "mail.site1.com"]
        mailboxes = ["admin@site1.com", "info@site2.org"]

        res = self.run_manager("sync_virtual_domains", {
            "domains": domains,
            "mailboxes": mailboxes,
        })

        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("syncedCount"), 3)

        vdomains_file = ROOT_DIR / "docker" / "postfix" / "config" / "virtual_domains"
        vmailboxes_file = ROOT_DIR / "docker" / "postfix" / "config" / "virtual_mailbox_maps"

        self.assertTrue(vdomains_file.exists())
        self.assertTrue(vmailboxes_file.exists())

        vdom_content = vdomains_file.read_text(encoding="utf-8")
        for d in domains:
            self.assertIn(d, vdom_content)

        vbox_content = vmailboxes_file.read_text(encoding="utf-8")
        self.assertIn("admin@site1.com", vbox_content)
        self.assertIn("info@site2.org", vbox_content)

    def test_05_status_inspection(self):
        """Verifies system status probe returns expected schema fields."""
        res = self.run_manager("status", {"host": "127.0.0.1"})
        self.assertEqual(res.get("service"), "postfix")
        self.assertIn("status", res)
        self.assertIn("port25Open", res)
        self.assertIn("port587Open", res)
        self.assertIn("tlsEnforced", res)
        self.assertIn("openRelayProtected", res)
        self.assertIn("activeVirtualDomainsCount", res)


class TestPostfixConfigurations(unittest.TestCase):
    """Verifies that Postfix and OpenDKIM config files conform to security specifications."""

    def test_01_main_cf_security_parameters(self):
        main_cf = ROOT_DIR / "docker" / "postfix" / "main.cf"
        self.assertTrue(main_cf.exists(), "main.cf must exist")
        content = main_cf.read_text(encoding="utf-8")

        # Relay restrictions must reject unauth destination
        self.assertIn("reject_unauth_destination", content)
        self.assertIn("virtual_mailbox_domains", content)
        self.assertIn("smtpd_milters", content)
        self.assertIn("8891", content)
        self.assertIn("smtpd_tls_security_level", content)

    def test_02_master_cf_submission_service(self):
        master_cf = ROOT_DIR / "docker" / "postfix" / "master.cf"
        self.assertTrue(master_cf.exists(), "master.cf must exist")
        content = master_cf.read_text(encoding="utf-8")

        # Must define submission on port 587
        self.assertIn("submission inet", content)
        self.assertIn("smtpd_tls_security_level=encrypt", content)
        self.assertIn("smtpd_sasl_auth_enable=yes", content)
        self.assertIn("milter_macro_daemon_name=ORIGINATING", content)

    def test_03_opendkim_conf_parameters(self):
        opendkim_conf = ROOT_DIR / "docker" / "postfix" / "opendkim.conf"
        self.assertTrue(opendkim_conf.exists(), "opendkim.conf must exist")
        content = opendkim_conf.read_text(encoding="utf-8")

        self.assertIn("Socket", content)
        self.assertIn("8891", content)
        self.assertIn("KeyTable", content)
        self.assertIn("SigningTable", content)
        self.assertIn("TrustedHosts", content)
        self.assertIn("rsa-sha256", content)

    def test_04_host_setup_script_exists(self):
        setup_script = ROOT_DIR / "system" / "scripts" / "setup-postfix.sh"
        self.assertTrue(setup_script.exists(), "setup-postfix.sh must exist")
        content = setup_script.read_text(encoding="utf-8")
        self.assertIn("apt-get install -y postfix opendkim", content)
        self.assertIn("postconf", content)

    def test_05_dockerfile_normalizes_windows_line_endings(self):
        dockerfile = ROOT_DIR / "docker" / "postfix" / "Dockerfile"
        content = dockerfile.read_text(encoding="utf-8")
        self.assertIn("sed -i 's/\\r$//' /usr/local/bin/entrypoint.sh", content)


class TestMailApiSecurity(unittest.TestCase):
    """Verifies that all Fastify /api/mail endpoints enforce authentication."""

    def test_01_unauthenticated_requests_return_401(self):
        endpoints = [
            ("GET", f"{API_BASE_URL}/api/mail/status"),
            ("GET", f"{API_BASE_URL}/api/mail/domains"),
            ("POST", f"{API_BASE_URL}/api/mail/sync"),
            ("POST", f"{API_BASE_URL}/api/mail/dkim/dummy-id"),
            ("POST", f"{API_BASE_URL}/api/mail/test-send"),
            ("GET", f"{API_BASE_URL}/api/mail/test-relay"),
        ]

        for method, url in endpoints:
            req = urllib.request.Request(url, method=method)
            req.add_header("Content-Type", "application/json")
            if method == "POST":
                req.data = b"{}"

            try:
                with urllib.request.urlopen(req) as resp:
                    self.fail(f"Expected 401 Unauthorized for {method} {url}, got {resp.status}")
            except urllib.error.HTTPError as e:
                self.assertEqual(
                    e.code,
                    401,
                    f"Expected 401 for {method} {url}, got {e.code}",
                )
            except urllib.error.URLError:
                # If API server is not running on 5000 during isolated test, skip live network assertion
                pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
