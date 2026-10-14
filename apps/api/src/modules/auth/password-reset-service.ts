import * as argon2 from "argon2";
import type { PrismaClient, Role } from "@prisma/client";
import type { AdminPasswordResetResult } from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { destroyUserSessions } from "../../plugins/auth.js";
import type { AuditLogService } from "../audit-log/service.js";
import { transportKind } from "../system-email/sender.js";
import { notifyUser } from "../system-email/notifier.js";
import { panelUrl } from "../system-email/templates.js";
import { AuthError } from "./service.js";
import { RESET_TTL_MINUTES, hashResetToken, issueResetToken } from "./password-reset-token.js";

export { hashResetToken };
export const RESET_TOKEN_TTL_MINUTES = RESET_TTL_MINUTES.SELF_SERVICE;

// One email per account per minute: enough to stop someone using the form to
// flood a victim's inbox, without ever locking the real owner out.
const THROTTLE_SECONDS = 60;
const throttleKey = (userId: string) => `password-reset:throttle:${userId}`;

interface RedisLike {
  set(key: string, value: string, mode: "EX", ttl: number, nx: "NX"): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

interface LoggerLike {
  error(obj: unknown, message: string): void;
}

type Scheduler = (task: () => Promise<void>) => void;

export interface ResettableUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

const invalidLink = () =>
  new AuthError("This reset link is invalid or has expired", "INVALID_RESET_TOKEN", 400);

export class PasswordResetService {
  private schedule: Scheduler;

  constructor(
    private prisma: PrismaClient,
    private redis: RedisLike,
    private auditLog: AuditLogService,
    private logger?: LoggerLike,
    scheduler?: Scheduler,
  ) {
    this.schedule =
      scheduler ??
      ((task) => {
        setImmediate(() => {
          task().catch((err: unknown) => this.logger?.error({ err }, "Password reset request failed"));
        });
      });
  }

  /**
   * Starts a self-service reset and returns immediately. The lookup, token
   * write and email run after the caller has already answered, so response
   * time is the same whether or not the email belongs to an account.
   */
  requestReset(email: string, requestIp: string): void {
    this.schedule(() => this.handleRequest(email, requestIp));
  }

  /** The deferred work behind requestReset. Silent for unknown, throttled or ineligible accounts. */
  async handleRequest(email: string, requestIp: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;
    // Admins are root-equivalent on the host, so a compromised mailbox must
    // not be enough to take one over unless the operator opted in.
    if (user.role === "ADMIN" && !env.ALLOW_ADMIN_EMAIL_RESET) return;

    const claimed = await this.redis.set(throttleKey(user.id), "1", "EX", THROTTLE_SECONDS, "NX");
    if (!claimed) return;

    const { token, ttlMinutes } = await issueResetToken(this.prisma, {
      userId: user.id,
      source: "SELF_SERVICE",
      requestIp,
    });

    // The token rides in the URL fragment so it never reaches server logs or Referer headers.
    notifyUser("password_reset", user.email, {
      name: user.name,
      resetUrl: panelUrl(`/reset-password#token=${token}`),
      expiresMinutes: ttlMinutes,
    });
  }

  /**
   * Admin- or reseller-initiated reset (F5.30). The caller has already
   * checked that the actor may manage this user. The person issuing the
   * link never chooses or sees a password; with working email only the
   * user ever sees the link, otherwise it is returned once to hand over.
   */
  async issueForUser(actorId: string, target: ResettableUser): Promise<AdminPasswordResetResult> {
    // Admin accounts recover from the server shell, never from the panel.
    if (target.role === "ADMIN") {
      throw new AuthError("Admin accounts are recovered from the server", "ADMIN_NOT_RESETTABLE", 403);
    }

    const { token, expiresAt, ttlMinutes } = await issueResetToken(this.prisma, {
      userId: target.id,
      source: "ADMIN",
      createdById: actorId,
    });
    const resetUrl = panelUrl(`/reset-password#token=${token}`);
    const byEmail = env.EMAIL_ENABLED && transportKind() !== "log";

    await this.auditLog.log(actorId, "user.password_reset_issued", { type: "User", id: target.id }, {
      after: { delivery: byEmail ? "email" : "link" },
    });

    if (byEmail) {
      notifyUser("password_reset", target.email, {
        name: target.name,
        resetUrl,
        expiresMinutes: ttlMinutes,
        initiatedByAdmin: true,
      });
      return { delivery: "email", expiresAt: expiresAt.toISOString() };
    }
    return { delivery: "link", expiresAt: expiresAt.toISOString(), resetUrl };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
      include: { user: { select: { id: true, email: true, name: true, role: true } } },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) throw invalidLink();
    if (!this.mayResetRole(record.user.role, record.source)) throw invalidLink();

    // Atomic claim: if two requests race with the same link, only one updates a row.
    const claimed = await this.prisma.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw invalidLink();

    const hashedPassword = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.user.update({ where: { id: record.userId }, data: { password: hashedPassword } });
    await this.prisma.passwordResetToken.deleteMany({ where: { userId: record.userId, id: { not: record.id } } });

    // Not auto-logged-in, and every existing session ends. Two-factor is untouched,
    // so a reset can never be used to bypass it.
    await destroyUserSessions(this.prisma, this.redis, record.userId);
    await this.redis.del(throttleKey(record.userId));

    await this.auditLog.log(record.userId, "user.password_reset", { type: "User", id: record.userId }, {
      after: { source: record.source, issuedBy: record.createdById },
    });
    notifyUser("password_changed", record.user.email, { name: record.user.name });
  }

  /**
   * Who a link may reset. Admins: only shell-issued links (shell access is the
   * proof of ownership), or self-service links when the operator opted in. A
   * link issued for a user who has since been made an admin therefore stops working.
   */
  private mayResetRole(role: Role, source: "SELF_SERVICE" | "ADMIN" | "CLI"): boolean {
    if (role !== "ADMIN") return true;
    if (source === "CLI") return true;
    return source === "SELF_SERVICE" && env.ALLOW_ADMIN_EMAIL_RESET;
  }
}
