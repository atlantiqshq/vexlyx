import crypto from "node:crypto";
import type { PasswordResetSource, PrismaClient } from "@prisma/client";

// Self-service links are short because anyone with the mailbox could use them;
// links an admin hands over out of band need longer; a shell link is used
// right away by whoever typed the command.
export const RESET_TTL_MINUTES: Record<PasswordResetSource, number> = {
  SELF_SERVICE: 30,
  ADMIN: 24 * 60,
  CLI: 60,
};

export const hashResetToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

interface IssueOptions {
  userId: string;
  source: PasswordResetSource;
  createdById?: string | null;
  requestIp?: string | null;
}

export interface IssuedResetToken {
  token: string;
  expiresAt: Date;
  ttlMinutes: number;
}

/**
 * Creates a single-use reset token and invalidates the user's earlier unused
 * ones, so the newest link always wins. Only the SHA-256 hash is stored — a
 * database read yields no usable link. 32 random bytes make a fast hash safe.
 */
export async function issueResetToken(prisma: PrismaClient, options: IssueOptions): Promise<IssuedResetToken> {
  const token = crypto.randomBytes(32).toString("hex");
  const ttlMinutes = RESET_TTL_MINUTES[options.source];
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  await prisma.passwordResetToken.deleteMany({ where: { userId: options.userId, usedAt: null } });
  await prisma.passwordResetToken.create({
    data: {
      userId: options.userId,
      tokenHash: hashResetToken(token),
      expiresAt,
      source: options.source,
      createdById: options.createdById ?? null,
      requestIp: options.requestIp ?? null,
    },
  });

  return { token, expiresAt, ttlMinutes };
}
