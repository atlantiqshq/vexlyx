import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Queue } from "bullmq";
import type Redis from "ioredis";
import type { SystemEmailEvent, SystemEmailStatusResponse, SystemEmailDnsRecord } from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { runPostfixManager } from "../mail/service.js";
import {
  buildRequiredMailRecords,
  isRecordLive,
  lookupLiveMailRecords,
} from "../mail/required-records.js";
import { renderEmail, type EmailParams } from "./templates.js";
import { sendEmail, transportKind } from "./sender.js";

export const SYSTEM_EMAIL_QUEUE = "system-email";

const LAST_SENT_KEY = "system-email:last-sent";
const LAST_ERROR_KEY = "system-email:last-error";
const DKIM_SELECTOR = "default";

export interface SystemEmailJob {
  event: SystemEmailEvent;
  to: string;
  params: Record<string, unknown>;
}

// Retries ride out a briefly unavailable Postfix or relay. Failed jobs are
// dropped quickly because reset-email jobs carry a live token in their data.
const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: 3600, count: 50 },
};

export class SystemEmailService {
  constructor(
    private queue: Queue,
    private redis: Redis,
    private prisma: PrismaClient,
    private logger: FastifyBaseLogger,
  ) {}

  /**
   * Queues one email. Never throws: a notification failing to enqueue must
   * not break the action (a role change, a backup) that triggered it.
   */
  async notify<E extends SystemEmailEvent>(event: E, to: string, params: EmailParams[E]): Promise<void> {
    if (!env.EMAIL_ENABLED) return;
    try {
      await this.queue.add(event, { event, to, params } satisfies SystemEmailJob, JOB_OPTIONS);
    } catch (err) {
      this.logger.error({ err, event }, "Failed to queue system email");
    }
  }

  /** Emails every admin — used for server-level events such as a failed backup. */
  async notifyAdmins<E extends SystemEmailEvent>(event: E, params: EmailParams[E]): Promise<void> {
    const admins = await this.prisma.user.findMany({ where: { role: "ADMIN" }, select: { email: true } });
    await Promise.all(admins.map((admin) => this.notify(event, admin.email, params)));
  }

  /** Worker entry point: renders and sends one queued email, recording the outcome for the admin status card. */
  async deliver(job: SystemEmailJob): Promise<void> {
    try {
      const rendered = renderEmail(job.event, job.params as never);
      await sendEmail({ to: job.to, ...rendered }, this.logger);
      await this.redis.set(LAST_SENT_KEY, new Date().toISOString());
      await this.redis.del(LAST_ERROR_KEY);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown email error";
      this.logger.error({ err, event: job.event }, "System email delivery failed");
      await this.redis.set(LAST_ERROR_KEY, message.slice(0, 500));
      throw err;
    }
  }

  /** Sends immediately (not queued) so the admin sees the real error when the test fails. */
  async sendTest(to: string): Promise<void> {
    await this.deliver({ event: "test", to, params: {} });
  }

  /**
   * Makes sure the sender domain has a DKIM key loaded into OpenDKIM so the
   * bundled Postfix signs panel mail. Idempotent. Not fatal when it fails
   * (e.g. no Postfix in a bare dev setup) — mail then just goes out unsigned.
   */
  async ensureSenderIdentity(): Promise<void> {
    if (transportKind() !== "bundled") return;
    try {
      await runPostfixManager("generate_dkim", {
        domain: env.MAIL_DOMAIN,
        selector: DKIM_SELECTOR,
        keyLength: 2048,
      });
    } catch (err) {
      this.logger.warn({ err }, "Could not prepare the DKIM key for system email");
    }
  }

  async status(): Promise<SystemEmailStatusResponse> {
    const [lastSentAt, lastError] = await Promise.all([
      this.redis.get(LAST_SENT_KEY),
      this.redis.get(LAST_ERROR_KEY),
    ]);

    return {
      enabled: env.EMAIL_ENABLED,
      transport: transportKind(),
      from: env.MAIL_FROM,
      domain: env.MAIL_DOMAIN,
      lastSentAt,
      lastError,
      dnsRecords: await this.requiredDnsRecords(),
    };
  }

  /** SPF/DKIM/DMARC the operator must publish for the bundled sender, with a live public-DNS check. External relays manage their own DNS, so none are listed. */
  private async requiredDnsRecords(): Promise<SystemEmailDnsRecord[]> {
    if (transportKind() !== "bundled" || !env.PUBLIC_IP) return [];

    try {
      const dkim = await runPostfixManager<{ found: boolean; dnsRecordValue: string }>("get_dkim", {
        domain: env.MAIL_DOMAIN,
        selector: DKIM_SELECTOR,
      });
      const required = buildRequiredMailRecords(
        env.MAIL_DOMAIN,
        env.PUBLIC_IP,
        dkim.found ? { selector: DKIM_SELECTOR, value: dkim.dnsRecordValue } : undefined,
      ).filter((r) => r.purpose === "SPF" || r.purpose === "DKIM" || r.purpose === "DMARC");

      const live = await lookupLiveMailRecords(env.MAIL_DOMAIN, required);
      return required.map((r) => ({
        type: r.type,
        name: r.name,
        host: r.name === "@" ? env.MAIL_DOMAIN : `${r.name}.${env.MAIL_DOMAIN}`,
        value: r.value,
        purpose: r.purpose as SystemEmailDnsRecord["purpose"],
        present: isRecordLive(r, live),
      }));
    } catch (err) {
      this.logger.warn({ err }, "Could not compute system email DNS records");
      return [];
    }
  }
}
