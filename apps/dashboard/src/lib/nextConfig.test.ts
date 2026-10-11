import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("next.config headers", () => {
  it("stops the reset page leaking its token fragment through Referer and keeps it out of caches", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((r) => r.source === "/reset-password");
    const headers = Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));

    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Cache-Control"]).toBe("no-store");
  });
});
