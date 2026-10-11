import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const message = { to: "ada@example.com", subject: "Hello", text: "Body", html: "<p>Body</p>" };
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;

describe("sendEmail", () => {
  it("prints the message instead of sending when the log transport is active", async () => {
    const { sendEmail } = await import("./sender.js");
    const sendMail = vi.fn();

    const id = await sendEmail(message, logger, { sendMail });

    expect(id).toBeNull();
    expect(sendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it("sends from the configured address with auto-reply suppression over SMTP", async () => {
    vi.resetModules();
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.MAIL_FROM = "notifications@panel.example.com";
    process.env.MAIL_REPLY_TO = "admin@example.com";
    const { sendEmail } = await import("./sender.js");
    const sendMail = vi.fn(async () => ({ messageId: "<abc@panel.example.com>" }));

    const id = await sendEmail(message, logger, { sendMail });

    expect(id).toBe("<abc@panel.example.com>");
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { name: "Vexlyx", address: "notifications@panel.example.com" },
        replyTo: "admin@example.com",
        to: "ada@example.com",
        headers: expect.objectContaining({ "Auto-Submitted": "auto-generated" }),
      }),
    );
    delete process.env.EMAIL_TRANSPORT;
    delete process.env.MAIL_FROM;
    delete process.env.MAIL_REPLY_TO;
  });

  it("lets a transport error reach the caller so the queue can retry", async () => {
    vi.resetModules();
    process.env.EMAIL_TRANSPORT = "smtp";
    const { sendEmail } = await import("./sender.js");
    const sendMail = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    await expect(sendEmail(message, logger, { sendMail })).rejects.toThrow("ECONNREFUSED");
    delete process.env.EMAIL_TRANSPORT;
  });
});

describe("smtpOptions", () => {
  it("targets the bundled Postfix when no external relay is configured", async () => {
    vi.resetModules();
    delete process.env.EMAIL_SMTP_HOST;
    const { smtpOptions, transportKind } = await import("./sender.js");
    process.env.EMAIL_TRANSPORT = "smtp";

    expect(smtpOptions()).toMatchObject({ host: "127.0.0.1", port: 25, secure: false });
    expect(transportKind()).not.toBe("external");
    delete process.env.EMAIL_TRANSPORT;
  });

  it("uses the external relay and its credentials when EMAIL_SMTP_HOST is set", async () => {
    vi.resetModules();
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.EMAIL_SMTP_HOST = "smtp.resend.com";
    process.env.EMAIL_SMTP_USER = "resend";
    process.env.EMAIL_SMTP_PASS = "re_secret";
    const { smtpOptions, transportKind } = await import("./sender.js");

    expect(smtpOptions()).toMatchObject({
      host: "smtp.resend.com",
      port: 587,
      auth: { user: "resend", pass: "re_secret" },
    });
    expect(transportKind()).toBe("external");

    for (const key of ["EMAIL_TRANSPORT", "EMAIL_SMTP_HOST", "EMAIL_SMTP_USER", "EMAIL_SMTP_PASS"]) delete process.env[key];
  });
});
