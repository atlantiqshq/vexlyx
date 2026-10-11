import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../config/env.js";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type TransportKind = "bundled" | "external" | "log";

export function transportKind(): TransportKind {
  if (env.EMAIL_TRANSPORT === "log") return "log";
  return env.EMAIL_SMTP_HOST ? "external" : "bundled";
}

/** SMTP connection options for the configured transport: an external relay if EMAIL_SMTP_HOST is set, otherwise the bundled Postfix. */
export function smtpOptions() {
  if (env.EMAIL_SMTP_HOST) {
    return {
      host: env.EMAIL_SMTP_HOST,
      port: env.EMAIL_SMTP_PORT,
      secure: env.EMAIL_SMTP_SECURE,
      auth:
        env.EMAIL_SMTP_USER && env.EMAIL_SMTP_PASS
          ? { user: env.EMAIL_SMTP_USER, pass: env.EMAIL_SMTP_PASS }
          : undefined,
    };
  }
  return {
    host: env.BUNDLED_SMTP_HOST,
    port: env.BUNDLED_SMTP_PORT,
    secure: false,
    // The bundled Postfix is reached over loopback or the private Docker
    // network, never the internet, and its certificate is issued for its
    // public hostname — strict verification against "postfix"/127.0.0.1
    // would always fail. Relaying is allowed via Postfix's mynetworks.
    tls: { rejectUnauthorized: false },
  };
}

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter {
  cachedTransporter ??= nodemailer.createTransport({
    ...smtpOptions(),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return cachedTransporter;
}

/**
 * Sends one message through the configured transport. Throws on failure so
 * the queue worker can retry; callers on the request path never call this
 * directly (they enqueue instead).
 * @returns The message id, or null for the log transport.
 */
export async function sendEmail(
  message: OutgoingEmail,
  logger: FastifyBaseLogger,
  transporter: { sendMail(options: SendMailOptions): Promise<unknown> } = getTransporter(),
): Promise<string | null> {
  if (transportKind() === "log") {
    logger.info({ to: message.to, subject: message.subject }, `[email:log]\n${message.text}`);
    return null;
  }

  const info = (await transporter.sendMail({
    from: { name: "Vexlyx", address: env.MAIL_FROM },
    ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    // Tells auto-responders and vacation replies not to answer machine mail.
    headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
  })) as { messageId?: string };

  return info.messageId ?? null;
}
