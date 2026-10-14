import * as argon2 from "argon2";
import type { PrismaClient } from "@prisma/client";
import { PasswordSchema } from "@vexlyx/shared";
import { destroyUserSessions } from "../../plugins/auth.js";
import type { AuditLogService } from "../audit-log/service.js";
import { issueResetToken } from "./password-reset-token.js";

export class RecoveryError extends Error {
  constructor(
    message: string,
    public code: "NOT_FOUND" | "WEAK_PASSWORD" | "NO_REDIS" | "NOTHING_TO_DO",
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

interface RecoveryDeps {
  prisma: PrismaClient;
  /** Needed whenever sessions must end (setting a password or disabling 2FA). */
  redis?: { del(...keys: string[]): Promise<unknown> };
  audit: Pick<AuditLogService, "log">;
  buildUrl: (path: string) => string;
}

export interface RecoveryOptions {
  email: string;
  /** Print a single-use reset link. This is also what happens when nothing else is asked for. */
  link?: boolean;
  /** Set this password directly. Meant to be read from stdin, never from a command-line argument. */
  newPassword?: string;
  disable2fa?: boolean;
}

export interface RecoveryResult {
  email: string;
  resetUrl?: string;
  expiresMinutes?: number;
  passwordChanged: boolean;
  twoFactorDisabled: boolean;
}

/**
 * Server-side account recovery (F5.30), run from a shell on the host. Having
 * shell access is the proof of ownership, so unlike the emailed reset it works
 * for admin accounts. Every action is audited, attributed to the recovered
 * account with source "cli" since there is no logged-in actor.
 */
export async function recoverAccount(deps: RecoveryDeps, options: RecoveryOptions): Promise<RecoveryResult> {
  const { prisma, audit } = deps;

  const user = await prisma.user.findFirst({
    where: { email: { equals: options.email.trim(), mode: "insensitive" } },
    select: { id: true, email: true },
  });
  if (!user) throw new RecoveryError(`No account with the email ${options.email}`, "NOT_FOUND");

  const wantsSessionEnd = options.newPassword !== undefined || options.disable2fa === true;
  if (wantsSessionEnd && !deps.redis) {
    throw new RecoveryError("Redis is required to end the account's sessions", "NO_REDIS");
  }

  // Validate before changing anything, so a rejected password leaves the account untouched.
  let hashedPassword: string | undefined;
  if (options.newPassword !== undefined) {
    const checked = PasswordSchema.safeParse(options.newPassword);
    if (!checked.success) {
      throw new RecoveryError(checked.error.issues[0]?.message ?? "Invalid password", "WEAK_PASSWORD");
    }
    hashedPassword = await argon2.hash(options.newPassword, { type: argon2.argon2id });
  }

  const result: RecoveryResult = {
    email: user.email,
    passwordChanged: false,
    twoFactorDisabled: false,
  };
  const target = { type: "User", id: user.id };

  if (hashedPassword !== undefined) {
    await prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } });
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    result.passwordChanged = true;
    await audit.log(user.id, "user.password_reset", target, { after: { source: "cli" } });
  }

  if (options.disable2fa) {
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecretEncrypted: null, totpEnabled: false, totpVerifiedAt: null },
    });
    await prisma.recoveryCode.deleteMany({ where: { userId: user.id } });
    result.twoFactorDisabled = true;
    await audit.log(user.id, "user.2fa_reset", target, { after: { source: "cli" } });
  }

  if (wantsSessionEnd) {
    await destroyUserSessions(prisma, deps.redis!, user.id);
  }

  const onlyLink = options.newPassword === undefined && !options.disable2fa;
  if (options.link || onlyLink) {
    const { token, ttlMinutes } = await issueResetToken(prisma, { userId: user.id, source: "CLI" });
    result.resetUrl = deps.buildUrl(`/reset-password#token=${token}`);
    result.expiresMinutes = ttlMinutes;
    await audit.log(user.id, "user.password_reset_issued", target, { after: { source: "cli", delivery: "link" } });
  }

  return result;
}
