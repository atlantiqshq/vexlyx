import crypto from "node:crypto";
import * as argon2 from "argon2";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { destroyUserSessions } from "../../plugins/auth.js";
import type { AuditLogService } from "../audit-log/service.js";
import { notifyUser } from "../system-email/notifier.js";
import { panelUrl } from "../system-email/templates.js";
import { AuthError } from "./service.js";

export const RESET_TOKEN_TTL_MINUTES = 30;
// One email per account per minute: enough to stop someone using the form to
// flood a victim's inbox, without ever locking the real owner out.
const THROTTLE_SECONDS = 60;
const throttleKey = (userId: string) => `password-reset:throttle:${userId}`;

export const hashResetToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

interface RedisLike {
  set(key: string, value: string, mode: "EX", ttl: number, nx: "NX"): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

const invalidLink = () =>
  new AuthError("This reset link is invalid or has expired", "INVALID_RESET_TOKEN", 400);

export class PasswordResetService {
  constructor(
    private prisma: PrismaClient,
    private redis: RedisLike,
    private auditLog: AuditLogService,
  ) {}

  /**
   * Starts a reset. Deliberately returns nothing and never throws for an
   * unknown, throttled or ineligible account — the route answers every
   * request identically so it can't be used to discover which emails exist.
   */
  async requestReset(email: string, requestIp: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;
    // Admins are root-equivalent on the host, so a compromised mailbox must
    // not be enough to take one over unless the operator opted in.
    if (user.role === "ADMIN" && !env.ALLOW_ADMIN_EMAIL_RESET) return;

    const claimed = await this.redis.set(throttleKey(user.id), "1", "EX", THROTTLE_SECONDS, "NX");
    if (!claimed) return;

    // 32 random bytes; only the hash is stored, so a database read yields no usable link.
    const token = crypto.randomBytes(32).toString("hex");

    // The newest link wins: earlier unused links stop working.
    await this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
        requestIp,
      },
    });

    // The token rides in the URL fragment so it never reaches server logs or Referer headers.
    notifyUser("password_reset", user.email, {
      name: user.name,
      resetUrl: panelUrl(`/reset-password#token=${token}`),
      expiresMinutes: RESET_TOKEN_TTL_MINUTES,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
      include: { user: { select: { id: true, email: true, name: true, role: true } } },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) throw invalidLink();
    if (record.user.role === "ADMIN" && !env.ALLOW_ADMIN_EMAIL_RESET) throw invalidLink();

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

    await this.auditLog.log(record.userId, "user.password_reset", { type: "User", id: record.userId }, {});
    notifyUser("password_changed", record.user.email, { name: record.user.name });
  }
}
