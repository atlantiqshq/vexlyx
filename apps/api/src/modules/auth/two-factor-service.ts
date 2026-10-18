import crypto from "node:crypto";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import * as argon2 from "argon2";
import type { PrismaClient } from "@prisma/client";
import { encrypt, decrypt } from "../../utils/encryption.js";
import type { AuditLogService } from "../audit-log/service.js";
import { notifyUser } from "../system-email/notifier.js";
import { AuthError } from "./service.js";

const CHALLENGE_PREFIX = "2fa-challenge:";
const CHALLENGE_TTL_SECONDS = 300;
const ISSUER = "Vexlyx";

// ±1 step (±30s) tolerance for authenticator clock skew (spec §3).
authenticator.options = { window: 1 };

function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () =>
    crypto.randomBytes(5).toString("hex"),
  );
}

export class TwoFactorService {
  constructor(
    private prisma: PrismaClient,
    private redis: { set(k: string, v: string, mode: string, ttl: number): Promise<unknown>; get(k: string): Promise<string | null>; del(k: string): Promise<unknown> },
    private auditLog: AuditLogService,
  ) {}

  async createSetup(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AuthError("User not found", "USER_NOT_FOUND", 404);
    if (user.totpEnabled) throw new AuthError("Two-factor already enabled — disable first", "2FA_ALREADY_ENABLED", 409);
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecretEncrypted: encrypt(secret), totpEnabled: false, totpVerifiedAt: null },
    });
    const otpauthUrl = authenticator.keyuri(user.email, ISSUER, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    await this.prisma.recoveryCode.deleteMany({ where: { userId } });
    return { otpauthUrl, qrDataUrl, manualKey: secret };
  }

  async confirmSetup(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.totpSecretEncrypted) throw new AuthError("Setup not started", "2FA_NOT_STARTED", 400);
    const secret = decrypt(user.totpSecretEncrypted);
    if (!authenticator.check(code, secret)) throw new AuthError("Invalid code", "2FA_INVALID_CODE", 401);
    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => argon2.hash(c)));
    await this.prisma.recoveryCode.deleteMany({ where: { userId, usedAt: null } });
    await this.prisma.recoveryCode.createMany({
      data: codes.map((_c, i) => ({ userId, codeHash: hashes[i] as string })),
    });
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabled: true, totpVerifiedAt: new Date() } });
    await this.auditLog.log(userId, "user.2fa_enabled", { type: "User", id: userId }, {});
    notifyUser("two_factor_enabled", user.email, { name: user.name });
    return { recoveryCodes: codes };
  }

  async verifyLoginCode(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.totpEnabled || !user.totpSecretEncrypted) return false;
    if (/^\d{6}$/.test(code) && authenticator.check(code, decrypt(user.totpSecretEncrypted))) return true;
    const rows = await this.prisma.recoveryCode.findMany({ where: { userId, usedAt: null } });
    for (const row of rows) {
      if (await argon2.verify(row.codeHash, code)) {
        await this.prisma.recoveryCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
        return true;
      }
    }
    return false;
  }

  async disable(userId: string, password: string, codeOrRecovery: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AuthError("User not found", "USER_NOT_FOUND", 404);
    if (!(await argon2.verify(user.password, password))) throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS", 401);
    if (!(await this.verifyLoginCode(userId, codeOrRecovery))) throw new AuthError("Invalid code", "2FA_INVALID_CODE", 401);
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecretEncrypted: null, totpEnabled: false, totpVerifiedAt: null } });
    await this.prisma.recoveryCode.deleteMany({ where: { userId } });
    await this.auditLog.log(userId, "user.2fa_disabled", { type: "User", id: userId }, {});
    notifyUser("two_factor_disabled", user.email, { name: user.name });
  }

  async adminReset(actorId: string, targetUserId: string) {
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new AuthError("User not found", "USER_NOT_FOUND", 404);
    await this.prisma.user.update({ where: { id: targetUserId }, data: { totpSecretEncrypted: null, totpEnabled: false, totpVerifiedAt: null } });
    await this.prisma.recoveryCode.deleteMany({ where: { userId: targetUserId } });
    await this.auditLog.log(actorId, "user.2fa_reset", { type: "User", id: targetUserId }, {});
    notifyUser("two_factor_reset", target.email, { name: target.name });
  }

  async storeChallenge(userId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString("hex");
    await this.redis.set(CHALLENGE_PREFIX + token, JSON.stringify({ userId }), "EX", CHALLENGE_TTL_SECONDS);
    return token;
  }

  async consumeChallenge(token: string): Promise<string | null> {
    const userId = await this.peekChallenge(token);
    if (userId) await this.redis.del(CHALLENGE_PREFIX + token);
    return userId;
  }

  // Read without deleting — lets a typo'd code be retried on the same token
  // (spec §7: delete on success/expiry only). Rate limit bounds guessing.
  async peekChallenge(token: string): Promise<string | null> {
    const raw = await this.redis.get(CHALLENGE_PREFIX + token);
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { userId: string }).userId;
    } catch {
      return null;
    }
  }

  async deleteChallenge(token: string): Promise<void> {
    await this.redis.del(CHALLENGE_PREFIX + token);
  }
}
