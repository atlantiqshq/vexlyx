import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

vi.mock("argon2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("argon2")>();
  return { ...actual, verify: vi.fn() };
});

const { AuthService } = await import("./service.js");
const USER = { id: "u1", email: "ada@example.test", name: "Ada", role: "USER", password: "stored-password-hash" };
const credentials = { email: USER.email, password: "submitted-password" };
const invalidCredentials = { message: "Invalid email or password", code: "INVALID_CREDENTIALS", statusCode: 401 };

function fixture(user: typeof USER | null = USER) {
  const prisma = { user: {
    findUnique: vi.fn().mockResolvedValue(user),
    count: vi.fn().mockResolvedValue(1),
    create: vi.fn().mockResolvedValue(USER),
  } };
  const service = new AuthService(prisma as unknown as PrismaClient);
  const currentUser = vi.spyOn(service, "getCurrentUser");
  return { service, prisma, currentUser };
}

beforeEach(() => {
  vi.mocked(argon2.verify).mockReset().mockResolvedValue(false);
});

describe("AuthService.login", () => {
  it("verifies a dummy hash exactly once for an unknown account", async () => {
    const { service, currentUser } = fixture(null);
    await expect(service.login(credentials)).rejects.toMatchObject(invalidCredentials);
    expect(argon2.verify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\$argon2id\$/), credentials.password);
    expect(currentUser).not.toHaveBeenCalled();
  });

  it("verifies the stored hash exactly once for an existing account with a wrong password", async () => {
    const { service, currentUser } = fixture();
    await expect(service.login(credentials)).rejects.toMatchObject(invalidCredentials);
    expect(argon2.verify).toHaveBeenCalledExactlyOnceWith(USER.password, credentials.password);
    expect(currentUser).not.toHaveBeenCalled();
  });

  it.each([null, USER])("awaits password verification before rejecting: %j", async (user) => {
    let finishVerification!: (verified: boolean) => void;
    const verification = new Promise<boolean>((resolve) => { finishVerification = resolve; });
    vi.mocked(argon2.verify).mockReturnValue(verification);
    const { service } = fixture(user);
    let settled = false;
    const result = service.login(credentials).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    await vi.waitFor(() => expect(argon2.verify).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    finishVerification(false);
    expect(await result).toMatchObject(invalidCredentials);
  });

  it("rejects unknown accounts even if dummy verification reports a match", async () => {
    vi.mocked(argon2.verify).mockResolvedValue(true);
    const { service, currentUser } = fixture(null);
    await expect(service.login(credentials)).rejects.toMatchObject(invalidCredentials);
    expect(currentUser).not.toHaveBeenCalled();
  });

  it("returns the public user for a valid password", async () => {
    vi.mocked(argon2.verify).mockResolvedValue(true);
    const { service, currentUser } = fixture();
    const { password: _password, ...publicUser } = USER;
    currentUser.mockResolvedValue(publicUser as never);
    expect(await service.login(credentials)).toEqual(publicUser);
    expect(argon2.verify).toHaveBeenCalledExactlyOnceWith(USER.password, credentials.password);
    expect(currentUser).toHaveBeenCalledExactlyOnceWith(USER.id);
  });

  it("does not authenticate when verification fails unexpectedly", async () => {
    vi.mocked(argon2.verify).mockRejectedValue(new Error("verification failed"));
    const { service, currentUser } = fixture();
    await expect(service.login(credentials)).rejects.toThrow("verification failed");
    expect(currentUser).not.toHaveBeenCalled();
  });

  it("uses a real, valid dummy hash with the same cost as newly registered passwords", async () => {
    const actual = await vi.importActual<typeof import("argon2")>("argon2");
    const { service, prisma } = fixture(null);
    await expect(service.login(credentials)).rejects.toMatchObject(invalidCredentials);
    const dummyHash = vi.mocked(argon2.verify).mock.calls[0]![0];
    expect(await actual.verify(dummyHash, credentials.password)).toBe(false);
    await service.register({ ...credentials, confirmPassword: credentials.password, name: "Ada" });
    const registeredHash = prisma.user.create.mock.calls[0]![0].data.password as string;
    const parameters = (hash: string) => {
      const [, algorithm, version, costs, salt, digest] = hash.split("$");
      return { algorithm, version, costs, saltLength: Buffer.from(salt!, "base64").length, digestLength: Buffer.from(digest!, "base64").length };
    };
    expect(parameters(dummyHash)).toEqual(parameters(registeredHash));
    expect(parameters(dummyHash)).toMatchObject({ algorithm: "argon2id", version: "v=19", saltLength: 16, digestLength: 32 });
  }, 30_000);
});
