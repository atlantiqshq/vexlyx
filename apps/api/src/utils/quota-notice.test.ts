import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const notifyUser = vi.fn();
vi.mock("../modules/system-email/notifier.js", () => ({ notifyUser: (...args: unknown[]) => notifyUser(...args) }));

const { notifyQuotaThreshold } = await import("./quota.js");

function setup(limit: number | null, used: number) {
  const notices = new Set<string>();
  const state = { used };
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ email: "ada@example.com", name: "Ada", maxProjects: limit })) },
    project: { count: vi.fn(async () => state.used) },
    quotaNotice: {
      findUnique: vi.fn(async ({ where }: { where: { userId_resource_level: { level: number } } }) =>
        notices.has(String(where.userId_resource_level.level)) ? { id: "n" } : null,
      ),
      create: vi.fn(async ({ data }: { data: { level: number } }) => {
        notices.add(String(data.level));
      }),
      deleteMany: vi.fn(async ({ where }: { where: { level: number } }) => {
        notices.delete(String(where.level));
      }),
    },
  };
  return { prisma, state, notices };
}

beforeEach(() => notifyUser.mockClear());

describe("notifyQuotaThreshold", () => {
  it("stays silent below 80%", async () => {
    const { prisma } = setup(10, 7);
    await notifyQuotaThreshold(prisma as never, "u1", "project");
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("warns once at 80%, then not again on later creates", async () => {
    const { prisma, state } = setup(10, 8);
    await notifyQuotaThreshold(prisma as never, "u1", "project");
    state.used = 9;
    await notifyQuotaThreshold(prisma as never, "u1", "project");

    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledWith("quota_warning", "ada@example.com", expect.objectContaining({ level: 80, used: 8, limit: 10 }));
  });

  it("sends a second, stronger warning at 100%", async () => {
    const { prisma, state } = setup(10, 8);
    await notifyQuotaThreshold(prisma as never, "u1", "project");
    state.used = 10;
    await notifyQuotaThreshold(prisma as never, "u1", "project");

    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenLastCalledWith("quota_warning", "ada@example.com", expect.objectContaining({ level: 100 }));
  });

  it("sends only the 100% warning when both thresholds are crossed at once", async () => {
    const { prisma } = setup(1, 1);
    await notifyQuotaThreshold(prisma as never, "u1", "project");
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledWith("quota_warning", "ada@example.com", expect.objectContaining({ level: 100 }));
  });

  it("re-arms after usage drops back under the threshold", async () => {
    const { prisma, state } = setup(10, 8);
    await notifyQuotaThreshold(prisma as never, "u1", "project");
    state.used = 3;
    await notifyQuotaThreshold(prisma as never, "u1", "project");
    state.used = 8;
    await notifyQuotaThreshold(prisma as never, "u1", "project");

    expect(notifyUser).toHaveBeenCalledTimes(2);
  });

  it("does nothing for an unlimited quota", async () => {
    const { prisma } = setup(null, 50);
    await notifyQuotaThreshold(prisma as never, "u1", "project");
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("never throws, even if the database does", async () => {
    const prisma = { user: { findUnique: vi.fn(async () => { throw new Error("db down"); }) } };
    await expect(notifyQuotaThreshold(prisma as never, "u1", "project")).resolves.toBeUndefined();
  });
});
