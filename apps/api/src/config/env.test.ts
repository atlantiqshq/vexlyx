import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function loadEnv(overrides: Record<string, string | undefined>) {
  const nextEnv: NodeJS.ProcessEnv = {
    ...originalEnv,
    DATABASE_URL: "postgresql://vexlyx:test@localhost:5432/vexlyx_test",
    SESSION_SECRET: "test-session-secret-that-is-at-least-32-characters",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete nextEnv[key];
    else nextEnv[key] = value;
  }
  process.env = nextEnv;
  vi.resetModules();
  return (await import("./env.js")).env;
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("Adminer environment configuration", () => {
  it("keeps the localhost default in development", async () => {
    const env = await loadEnv({
      NODE_ENV: "development",
      ADMINER_URL: undefined,
    });

    expect(env.ADMINER_URL).toBe("http://localhost:8088");
  });

  it("disables Adminer by default in production", async () => {
    const env = await loadEnv({
      NODE_ENV: "production",
      ADMINER_URL: undefined,
    });

    expect(env.ADMINER_URL).toBeUndefined();
  });

  it("rejects an insecure production URL", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", ADMINER_URL: "http://db.example.com" }),
    ).rejects.toThrow("ADMINER_URL must use HTTPS in production");
  });

  it("rejects a production localhost URL even over HTTPS", async () => {
    await expect(
      loadEnv({
        NODE_ENV: "production",
        ADMINER_URL: "https://localhost:8088",
      }),
    ).rejects.toThrow("ADMINER_URL must not point to localhost in production");
  });

  it("accepts an explicit HTTPS production URL", async () => {
    const env = await loadEnv({
      NODE_ENV: "production",
      ADMINER_URL: "https://db-admin.example.com",
    });

    expect(env.ADMINER_URL).toBe("https://db-admin.example.com");
  });
});
