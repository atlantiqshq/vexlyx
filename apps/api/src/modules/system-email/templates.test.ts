import { describe, expect, it } from "vitest";
import { SYSTEM_EMAIL_EVENTS } from "@vexlyx/shared";
import type { EmailParams } from "./templates.js";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { panelUrl, renderEmail } = await import("./templates.js");

const SAMPLES: { [E in keyof EmailParams]: EmailParams[E] } = {
  password_reset: { name: "Ada", resetUrl: "https://panel.example.com/reset-password#token=abc", expiresMinutes: 30 },
  password_changed: { name: "Ada" },
  role_changed: { name: "Ada", newRole: "RESELLER" },
  two_factor_enabled: { name: "Ada" },
  two_factor_disabled: { name: "Ada" },
  two_factor_reset: { name: "Ada" },
  quota_warning: { name: "Ada", resource: "project", used: 8, limit: 10, level: 80 },
  backup_failed: { error: "disk full", snapshotId: "snap-1" },
  signature_test: { name: "Ada", address: "ada@example.com", signatureHtml: "<div>Ada Lovelace</div>", signatureText: "Ada Lovelace" },
  scheduled_task_failed: { name: "Ada", taskName: "Nightly report", projectName: "Shop", projectId: "p1", status: "FAILED", failures: 3 },
  test: {},
};

describe("renderEmail", () => {
  it.each(SYSTEM_EMAIL_EVENTS)("renders a subject, text and html body for %s", (event) => {
    const mail = renderEmail(event, SAMPLES[event] as never);
    expect(mail.subject.length).toBeGreaterThan(0);
    expect(mail.text).toContain("— Vexlyx");
    expect(mail.html).toContain("<div");
  });

  it("puts the reset link in both the text and html bodies", () => {
    const mail = renderEmail("password_reset", SAMPLES.password_reset);
    expect(mail.text).toContain("https://panel.example.com/reset-password#token=abc");
    expect(mail.html).toContain('href="https://panel.example.com/reset-password#token=abc"');
  });

  it("escapes user-controlled text in the html body", () => {
    const mail = renderEmail("backup_failed", { error: "<script>alert(1)</script>", snapshotId: "s" });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("shows the rendered signature in both bodies, and escapes everything else", () => {
    const mail = renderEmail("signature_test", { ...SAMPLES.signature_test, name: "<b>Ada</b>" });
    expect(mail.html).toContain("<div>Ada Lovelace</div>");
    expect(mail.text).toContain("Ada Lovelace");
    expect(mail.html).not.toContain("<b>Ada</b>");
    expect(mail.subject).toBe("Signature preview for ada@example.com");
  });

  it("names the failing task and links to its project, escaping user-chosen names", () => {
    const mail = renderEmail("scheduled_task_failed", { ...SAMPLES.scheduled_task_failed, taskName: "<img src=x>", status: "TIMEOUT" });
    expect(mail.html).not.toContain("<img src=x>");
    expect(mail.html).toContain("&lt;img src=x&gt;");
    expect(mail.text).toContain("3 times in a row");
    expect(mail.text).toContain("/projects/p1");
  });

  it("labels the scheduled task quota in plain words", () => {
    const mail = renderEmail("quota_warning", { name: "Ada", resource: "scheduledTask", used: 4, limit: 5, level: 80 });
    expect(mail.text).toContain("4 of 5 scheduled tasks");
  });

  it("uses the stronger wording when the limit is fully reached", () => {
    const warning = renderEmail("quota_warning", { ...SAMPLES.quota_warning, level: 80 });
    const reached = renderEmail("quota_warning", { ...SAMPLES.quota_warning, used: 10, level: 100 });
    expect(warning.subject).toContain("close to");
    expect(reached.subject).toContain("reached");
  });
});

describe("panelUrl", () => {
  it("builds links from configured origin, not a request header", () => {
    expect(panelUrl("/dashboard")).toMatch(/^https?:\/\/[^/]+\/dashboard$/);
  });
});
