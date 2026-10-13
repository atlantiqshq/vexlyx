import type { PrismaClient } from "@prisma/client";

export async function hasMonitoringAccess(
  prisma: PrismaClient,
  redis: { get(key: string): Promise<string | null> },
  userId: unknown,
  sessionId: unknown,
): Promise<boolean> {
  if (typeof userId !== "string" || !userId || typeof sessionId !== "string" || !sessionId) return false;
  const raw = await redis.get(`session:${sessionId}`);
  if (!raw) return false;

  let session: unknown;
  try {
    session = JSON.parse(raw);
  } catch {
    return false;
  }
  if (
    !session || typeof session !== "object" || !("userId" in session) || !("expiresAt" in session)
    || session.userId !== userId || typeof session.expiresAt !== "number"
    || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()
  ) return false;

  // A socket's handshake can outlive both its session and its administrator role.
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user?.role === "ADMIN" && session.expiresAt > Date.now();
}
