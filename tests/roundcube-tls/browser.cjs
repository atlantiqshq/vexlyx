// Run after: python -m tests.roundcube_tls_stack --keep
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require(
  process.env.VEXLYX_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../..");
const state = JSON.parse(
  fs.readFileSync(
    path.join(root, "docker/mail-data/roundcube-tls-browser.json"),
    "utf8",
  ),
);
const address = "tls-test@roundcube-test.example";
const password = "private-tls-test-password";
assert.match(state.prefix, /^vexlyx-roundcube-browser-[a-f0-9]{10}$/);
for (const service of ["fixture", "dovecot", "postfix", "roundcube"]) {
  assert.equal(state.names[service], `${state.prefix}-${service}`);
}

function certificate(service, variant) {
  execFileSync(
    process.env.VEXLYX_TEST_PYTHON || "python3",
    ["-m", "tests.roundcube_tls_stack", "--certificate", service, variant],
    { cwd: root },
  );
}

async function login(page) {
  await page.goto(state.webmail_url);
  await page.locator("#rcmloginuser").fill(address);
  await page.locator("#rcmloginpwd").fill(password);
  await page.getByRole("button", { name: /login/i }).click();
}

async function inbox(page) {
  await page.waitForURL(/_task=mail/);
  await page
    .getByText("Loading...", { exact: true })
    .waitFor({ state: "hidden" });
  assert.match(await page.locator("body").innerText(), /Inbox/i);
}

async function compose(page, subject) {
  await page.locator("a.compose:visible").click();
  await page.waitForURL(/_action=compose/);
  const recipient = page
    .locator("#_to")
    .locator("..")
    .locator('input[type="text"]');
  await recipient.fill(address);
  await recipient.press("Enter");
  await page.locator("#compose-subject").fill(subject);
  await page
    .locator("#composebody")
    .fill("Local mail verification under strict TLS.");
  await page.getByRole("button", { name: /Send/i }).click();
}

async function main() {
  const url = new URL(state.webmail_url);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.VEXLYX_BROWSER_EXECUTABLE || undefined,
  });
  let page;
  try {
    certificate("dovecot", "trusted");
    certificate("postfix", "trusted");
    page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await login(page);
    await inbox(page);
    console.log(
      "PASS: trusted matching IMAP certificate permits browser login",
    );

    const marker = `strict-tls-browser-${Date.now()}`;
    await compose(page, marker);
    // Roundcube redirects after sending; wait before any further navigation.
    await page.waitForURL(
      (location) => location.searchParams.get("_action") !== "compose",
    );
    await inbox(page);
    let delivered = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt > 0) {
        await page.goto(`${url.href}?_task=mail&_mbox=INBOX`);
        await inbox(page);
      }
      if (await page.getByText(marker, { exact: true }).count()) {
        delivered = true;
        break;
      }
    }
    assert.equal(
      delivered,
      true,
      "Browser-submitted local message must arrive in Inbox",
    );
    console.log(
      "PASS: trusted matching SMTP certificate permits browser send and receipt",
    );

    certificate("postfix", "wrong-host");
    const blockedMarker = `${marker}-blocked`;
    await compose(page, blockedMarker);
    await page
      .getByText(
        /SMTP Error|Connection to SMTP server failed|Failed to connect to server/i,
      )
      .waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#compose-subject").inputValue(),
      blockedMarker,
    );
    const messages = execFileSync(
      "docker",
      [
        "exec",
        state.names.dovecot,
        "doveadm",
        "search",
        "-u",
        address,
        "mailbox",
        "INBOX",
        "header",
        "subject",
        blockedMarker,
      ],
      { encoding: "utf8" },
    );
    assert.equal(messages.trim(), "");
    console.log(
      "PASS: wrong-host SMTP certificate blocks browser send and delivery",
    );
    certificate("postfix", "trusted");

    certificate("dovecot", "wrong-host");
    const rejected = await browser.newContext();
    page = await rejected.newPage();
    page.setDefaultTimeout(30000);
    await login(page);
    await page
      .getByText(/Connection to storage server failed|Login failed/i)
      .waitFor({ state: "visible" });
    assert.equal(await page.locator("#rcmloginuser").isVisible(), true);
    assert.notEqual(new URL(page.url()).searchParams.get("_task"), "mail");
    console.log("PASS: wrong-host IMAP certificate blocks browser login");
    await rejected.close();
    certificate("dovecot", "trusted");

    const recovered = await browser.newContext();
    page = await recovered.newPage();
    await login(page);
    await inbox(page);
    await page.screenshot({
      path: path.join(
        root,
        "docker/mail-data/roundcube-tls-browser-success.png",
      ),
    });
    console.log("PASS: restoring a valid certificate restores browser login");
    await recovered.close();
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({
        path: path.join(
          root,
          "docker/mail-data/roundcube-tls-browser-failure.png",
        ),
      });
      console.error(await page.locator("body").innerText());
    }
    throw error;
  } finally {
    await browser.close();
    certificate("dovecot", "trusted");
    certificate("postfix", "trusted");
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
