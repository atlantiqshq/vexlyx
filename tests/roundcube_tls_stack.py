"""Isolated production-style webmail stack for issue #42 browser checks.

Build both mail images with tag :roundcube-tls-test, then run this module with
--keep. Remove only this harness's resources using --cleanup.
"""

import json
import shutil
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from tests.test_roundcube_tls import IMAGE, PEER, ROOT, docker


STATE = ROOT / "docker/mail-data/roundcube-tls-browser.json"
ADDRESS = "tls-test@roundcube-test.example"
PASSWORD = "private-tls-test-password"


class RoundcubeTlsStack:
    def __init__(self):
        self.prefix = "vexlyx-roundcube-browser-" + uuid.uuid4().hex[:10]
        self.names = {service: self.prefix + "-" + service for service in ("fixture", "dovecot", "postfix", "roundcube")}
        self.volumes = {service: self.prefix + "-" + service + "-certs" for service in ("dovecot", "postfix")}
        self.network = self.prefix + "-network"
        self.browser_network = self.prefix + "-browser-network"
        (ROOT / "docker/mail-data").mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.mkdtemp(prefix="roundcube-tls-", dir=ROOT / "docker/mail-data")

    def close(self):
        for name in reversed(list(self.names.values())):
            docker("rm", "-fv", name, check=False)
        for volume in self.volumes.values():
            docker("volume", "rm", volume, check=False)
        docker("network", "rm", self.network, check=False)
        docker("network", "rm", self.browser_network, check=False)
        target = Path(self.directory).resolve()
        allowed = (ROOT / "docker/mail-data").resolve()
        if target.parent != allowed or not target.name.startswith("roundcube-tls-"):
            raise ValueError("Refusing to remove an unverified test directory")
        shutil.rmtree(target, ignore_errors=True)

    def start(self):
        directory = Path(self.directory)
        docker("network", "create", "--internal", self.network)
        docker("network", "create", self.browser_network)
        mounts = []
        for service, volume in self.volumes.items():
            docker("volume", "create", volume)
            mounts += ["--mount", f"type=volume,src={volume},dst=/certs/{service}"]
        docker("run", "-d", "--name", self.names["fixture"], "--network", self.network, *mounts,
               "--entrypoint", "sh", IMAGE, "-c", "sleep 3600")
        docker("cp", str(ROOT / "tests/roundcube-tls/certificates.sh"), self.names["fixture"] + ":/certificates.sh")
        docker("exec", self.names["fixture"], "sh", "-c",
               "sed -i 's/\r$//' /certificates.sh; sh /certificates.sh")
        for service in ("dovecot", "postfix"):
            self.certificate(service, "trusted", restart=False)
        docker("cp", self.names["fixture"] + ":/fixtures/ca.crt", str(directory / "ca.crt"))
        # Public trust anchor: Apache's unprivileged PHP worker must read it.
        (directory / "ca.crt").chmod(0o644)
        password_hash = docker("run", "--rm", "--entrypoint", "doveadm", "vexlyx-dovecot:roundcube-tls-test",
                               "-c", "/dev/null", "pw", "-s", "ARGON2ID", "-p", PASSWORD).stdout.strip()
        (directory / "users").write_text(f"{ADDRESS}:{password_hash}:5000:5000::::userdb_quota_rule=*:storage=1024M\n", encoding="utf-8")
        (directory / "virtual_domains").write_text("roundcube-test.example\n")
        (directory / "virtual_mailbox_maps").write_text(f"{ADDRESS} roundcube-test.example/tls-test/Maildir/\n")
        (directory / "test-ca.ini").write_text("openssl.cafile=/var/roundcube/config/test-ca.crt\n")
        docker("create", "--name", self.names["dovecot"], "--network", self.network,
               "--network-alias", "dovecot", "-e", "VEXLYX_SEED_DEV_FIXTURES=false",
               "--mount", f"type=volume,src={self.volumes['dovecot']},dst=/etc/dovecot/certs,readonly",
               "vexlyx-dovecot:roundcube-tls-test")
        docker("cp", str(directory / "users"), self.names["dovecot"] + ":/etc/dovecot/users")
        docker("start", self.names["dovecot"])
        docker("create", "--name", self.names["postfix"], "--network", self.network,
               "--network-alias", "postfix", "-e", "VEXLYX_SEED_DEV_FIXTURES=false", "-e", f"MYHOSTNAME={PEER}",
               "--mount", f"type=volume,src={self.volumes['postfix']},dst=/etc/postfix/certs,readonly",
               "vexlyx-postfix:roundcube-tls-test")
        for name in ("virtual_domains", "virtual_mailbox_maps"):
            docker("cp", str(directory / name), self.names["postfix"] + ":/etc/postfix/" + name)
        docker("start", self.names["postfix"])
        for service in ("dovecot", "postfix"):
            self.wait_for_service(service)
        docker("create", "--name", self.names["roundcube"], "--network", self.browser_network,
               "-p", "127.0.0.1::80", "-e", "ROUNDCUBEMAIL_DB_TYPE=sqlite",
               "-e", "ROUNDCUBEMAIL_DEFAULT_HOST=ssl://dovecot", "-e", "ROUNDCUBEMAIL_DEFAULT_PORT=993",
               "-e", "ROUNDCUBEMAIL_SMTP_SERVER=ssl://postfix", "-e", "ROUNDCUBEMAIL_SMTP_PORT=465",
               "-e", "VEXLYX_ROUNDCUBE_ENV=production", "-e", "VEXLYX_ROUNDCUBE_ALLOW_INSECURE_TLS=false",
               "-e", f"VEXLYX_MAIL_HOSTNAME={PEER}", IMAGE)
        for source, target in ((ROOT / "docker/roundcube/config/local.inc.php", "/var/roundcube/config/local.inc.php"),
                               (directory / "ca.crt", "/var/roundcube/config/test-ca.crt"),
                               (directory / "test-ca.ini", "/usr/local/etc/php/conf.d/test-ca.ini")):
            docker("cp", str(source), self.names["roundcube"] + ":" + target)
        docker("network", "connect", self.network, self.names["roundcube"])
        docker("start", self.names["roundcube"])
        self.webmail_url = "http://127.0.0.1:" + str(self.port("roundcube", "80/tcp"))
        for _ in range(30):
            try:
                with urllib.request.urlopen(self.webmail_url, timeout=2) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, OSError):
                time.sleep(0.3)
        raise AssertionError("Roundcube test stack did not become ready")

    def port(self, service, key):
        state = json.loads(docker("inspect", self.names[service]).stdout)[0]
        return int(state["NetworkSettings"]["Ports"][key][0]["HostPort"])

    def certificate(self, service, variant, restart=True):
        if service not in ("dovecot", "postfix") or variant not in ("trusted", "wrong-host", "self-signed"):
            raise ValueError("Invalid test certificate selection")
        docker("exec", self.names["fixture"], "sh", "-c",
               f"cp /fixtures/{variant}.crt /certs/{service}/cert.pem; cp /fixtures/{variant}.key /certs/{service}/key.pem")
        if restart:
            docker("restart", self.names[service])
            self.wait_for_service(service)

    def wait_for_service(self, service):
        port = "993" if service == "dovecot" else "465"
        for _ in range(30):
            result = docker("exec", self.names["fixture"], "php", "-r",
                            "$socket=@fsockopen($argv[1],(int)$argv[2],$error,$message,1); if(!$socket)exit(1); fclose($socket);",
                            service, port, check=False)
            if result.returncode == 0:
                return
            time.sleep(0.2)
        raise AssertionError(f"Test service {service} did not become ready")


def load_stack():
    stack = object.__new__(RoundcubeTlsStack)
    stack.__dict__.update(json.loads(STATE.read_text(encoding="utf-8")))
    if not stack.prefix.startswith("vexlyx-roundcube-browser-") or any(
        not value.startswith(stack.prefix) for value in [*stack.names.values(), *stack.volumes.values(), stack.network, stack.browser_network]
    ):
        raise ValueError("Invalid browser test resource names")
    return stack


if __name__ == "__main__":
    import sys
    if "--keep" in sys.argv:
        if STATE.exists():
            raise SystemExit("Clean up the previous test stack with --cleanup first")
        stack = RoundcubeTlsStack()
        try:
            stack.start()
            STATE.write_text(json.dumps(vars(stack)), encoding="utf-8")
            print(stack.webmail_url)
        except BaseException:
            stack.close()
            raise
    elif "--cleanup" in sys.argv:
        load_stack().close()
        STATE.unlink()
    elif "--certificate" in sys.argv:
        load_stack().certificate(sys.argv[-2], sys.argv[-1])
    else:
        raise SystemExit("Use --keep, --cleanup, or --certificate <dovecot|postfix> <variant>")
