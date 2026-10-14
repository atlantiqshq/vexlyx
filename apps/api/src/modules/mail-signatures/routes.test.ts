import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.setConfig({ testTimeout: 30_000 });

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const assetsDir = realpathSync.native(mkdtempSync(join(tmpdir(), "vexlyx-sig-assets-")));
process.env.SIGNATURE_ASSETS_DIR = assetsDir;

// Never start Python from a unit test.
const runManager = vi.fn(async () => ({ written: 0, removed: 0 }));
vi.mock("./manager.js", () => ({ runSignatureManager: (...args: unknown[]) => runManager(...(args as [])) }));

const { mailSignatureRoutes } = await import("./routes.js");
const { errorHandlerPlugin } = await import("../../plugins/error-handler.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

interface Mocks {
  mailboxFindFirst: ReturnType<typeof vi.fn>;
  domainFindFirst: ReturnType<typeof vi.fn>;
  assetFindUnique: ReturnType<typeof vi.fn>;
  assetCreate: ReturnType<typeof vi.fn>;
  assetCount: ReturnType<typeof vi.fn>;
}

/** Guards behave like the real ones: 401 signed out, 403 for the wrong role. */
async function buildApp(session: { userId: string | null; role?: "ADMIN" | "USER" }, owned = false) {
  const mocks: Mocks = {
    mailboxFindFirst: vi.fn(async () => (owned ? { id: "m1", address: "ada@example.com", domainId: "d1", signature: null } : null)),
    domainFindFirst: vi.fn(async () => (owned ? { id: "d1", hostname: "example.com", userId: "u1", mailSignature: null } : null)),
    assetFindUnique: vi.fn(async () => null),
    assetCreate: vi.fn(async ({ data }: { data: { fileName: string; size: number } }) => ({ id: "a1", createdAt: new Date(), ...data })),
    assetCount: vi.fn(async () => 0),
  };
  const app = Fastify();
  await app.register(multipart);
  app.decorate("prisma", {
    mailbox: { findFirst: mocks.mailboxFindFirst },
    domain: { findFirst: mocks.domainFindFirst },
    signatureAsset: { findUnique: mocks.assetFindUnique, create: mocks.assetCreate, count: mocks.assetCount },
    user: { findUnique: vi.fn(async () => ({ email: "owner@example.com", name: "Owner" })) },
    auditLog: { create: vi.fn() },
  } as never);
  app.decorate("redis", { get: vi.fn(), set: vi.fn(), del: vi.fn() } as never);
  app.decorate("requireAuth", (async (request: FastifyRequest, reply: FastifyReply) => {
    if (!session.userId) {
      return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED", details: {} });
    }
    request.userId = session.userId;
  }) as never);
  app.decorate(
    "requireRole",
    ((...roles: string[]) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!session.userId) return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED", details: {} });
        if (!roles.includes(session.role ?? "USER")) return reply.status(403).send({ error: "Forbidden", code: "FORBIDDEN_ROLE", details: {} });
        request.userId = session.userId;
      }) as never,
  );
  app.decorateRequest("userId", null);
  await app.register(errorHandlerPlugin);
  await app.register(mailSignatureRoutes, { prefix: "/api" });
  return { app: app as unknown as FastifyInstance, ...mocks };
}

const DOMAIN_BODY = {
  enabled: true,
  template: "**{{name}}**\n{{title}}",
  company: "Analytical Engines",
  website: "example.com",
  logoUrl: null,
  locked: false,
  enforceServerSide: false,
  externalOnly: false,
  newMessagesOnly: false,
  senderListMode: "ALL",
  senderList: [],
  complianceEnabled: false,
  complianceText: "",
};
const MAILBOX_BODY = { mode: "INHERIT", template: null, groupId: null, displayName: "Ada", title: null, department: null, phone: null, mobile: null };
const BANNER_BODY = { text: "Closed", startsAt: "2026-12-24T00:00:00Z", endsAt: "2026-12-26T00:00:00Z", enabled: true };

function multipartBody(bytes: Buffer, filename = "logo.png") {
  const boundary = "----vxboundary";
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), bytes, Buffer.from(tail)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

type Call = { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; payload?: unknown };
const OWNER_ROUTES: Call[] = [
  { method: "GET", url: "/api/mailboxes/m1/signature" },
  { method: "PUT", url: "/api/mailboxes/m1/signature", payload: MAILBOX_BODY },
  { method: "DELETE", url: "/api/mailboxes/m1/signature" },
  { method: "GET", url: "/api/mailboxes/m1/signature/versions" },
  { method: "POST", url: "/api/mailboxes/m1/signature/versions/v1/restore" },
  { method: "POST", url: "/api/mailboxes/m1/signature/test" },
  { method: "GET", url: "/api/domains/d1/mail-signature" },
  { method: "PUT", url: "/api/domains/d1/mail-signature", payload: DOMAIN_BODY },
  { method: "GET", url: "/api/domains/d1/mail-signature/versions" },
  { method: "POST", url: "/api/domains/d1/mail-signature/versions/v1/restore" },
  { method: "POST", url: "/api/domains/d1/mail-signature/groups", payload: { name: "Sales", template: "{{name}}" } },
  { method: "PUT", url: "/api/domains/d1/mail-signature/groups/g1", payload: { name: "Sales", template: "{{name}}" } },
  { method: "DELETE", url: "/api/domains/d1/mail-signature/groups/g1" },
  { method: "POST", url: "/api/domains/d1/mail-signature/banners", payload: BANNER_BODY },
  { method: "PUT", url: "/api/domains/d1/mail-signature/banners/b1", payload: BANNER_BODY },
  { method: "DELETE", url: "/api/domains/d1/mail-signature/banners/b1" },
  { method: "POST", url: "/api/domains/d1/mail-signature/bulk", payload: { action: "RESET_TO_DEFAULT", dryRun: true } },
  { method: "GET", url: "/api/domains/d1/mail-signature/export" },
  { method: "POST", url: "/api/domains/d1/mail-signature/import", payload: { format: "vexlyx-signature-template", version: 1, policy: { ...DOMAIN_BODY, senderList: undefined, senderListMode: undefined }, groups: [], banners: [] } },
  { method: "DELETE", url: "/api/domains/d1/mail-signature/logo/a1" },
];

beforeEach(() => runManager.mockClear());
afterAll(() => rmSync(assetsDir, { recursive: true, force: true }));

describe("authentication", () => {
  it.each(OWNER_ROUTES)("returns 401 for $method $url when signed out", async ({ method, url, payload }) => {
    const { app } = await buildApp({ userId: null });
    const res = await app.inject({ method, url, payload: payload as never });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for the logo upload and the admin switch when signed out", async () => {
    const { app } = await buildApp({ userId: null });
    const upload = multipartBody(PNG);
    expect((await app.inject({ method: "POST", url: "/api/domains/d1/mail-signature/logo", ...upload })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/mail-signatures/enforcement" })).statusCode).toBe(401);
  });
});

describe("ownership", () => {
  it.each(OWNER_ROUTES)("returns 404 for $method $url on something the user doesn't own", async ({ method, url, payload }) => {
    const { app } = await buildApp({ userId: "u2" }, false);
    const res = await app.inject({ method, url, payload: payload as never });
    expect(res.statusCode).toBe(404);
    expect(runManager).not.toHaveBeenCalled();
  });

  it("looks mailboxes and domains up by the signed-in user", async () => {
    const { app, mailboxFindFirst, domainFindFirst } = await buildApp({ userId: "u2" }, false);
    await app.inject({ method: "GET", url: "/api/mailboxes/m1/signature" });
    await app.inject({ method: "GET", url: "/api/domains/d1/mail-signature" });
    expect(mailboxFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "m1", userId: "u2" } }));
    expect(domainFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d1", userId: "u2" } }));
  });

  it("returns 404 for a logo upload to a domain the user doesn't own", async () => {
    const { app } = await buildApp({ userId: "u2" }, false);
    const res = await app.inject({ method: "POST", url: "/api/domains/d1/mail-signature/logo", ...multipartBody(PNG) });
    expect(res.statusCode).toBe(404);
    expect(readdirSync(assetsDir)).toEqual([]);
  });
});

describe("the global switch is admin only", () => {
  it("returns 403 for a normal user on both methods", async () => {
    const { app } = await buildApp({ userId: "u1", role: "USER" });
    expect((await app.inject({ method: "GET", url: "/api/mail-signatures/enforcement" })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/mail-signatures/enforcement", payload: { enabled: false } })).statusCode).toBe(403);
    expect(runManager).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  const put = async (url: string, payload: unknown) => {
    const { app } = await buildApp({ userId: "u1" }, true);
    return app.inject({ method: "PUT", url, payload: payload as never });
  };
  const post = async (url: string, payload: unknown) => {
    const { app } = await buildApp({ userId: "u1" }, true);
    return app.inject({ method: "POST", url, payload: payload as never });
  };

  it.each([
    ["a custom signature with no template", { ...MAILBOX_BODY, mode: "CUSTOM", template: "  " }],
    ["an unknown variable", { ...MAILBOX_BODY, mode: "CUSTOM", template: "Hi {{nmae}}" }],
    ["an oversized template", { ...MAILBOX_BODY, mode: "CUSTOM", template: "x".repeat(4001) }],
    ["a control character", { ...MAILBOX_BODY, mode: "CUSTOM", template: "a\u0000b" }],
    ["a bad mode", { ...MAILBOX_BODY, mode: "EVERYONE" }],
    ["letters in a phone number", { ...MAILBOX_BODY, phone: "call me" }],
    ["a multi-line name", { ...MAILBOX_BODY, displayName: "Ada\nBcc: x@example.com" }],
    ["an over-long title", { ...MAILBOX_BODY, title: "t".repeat(101) }],
  ])("rejects %s on a mailbox with 400", async (_name, body) => {
    expect((await put("/api/mailboxes/m1/signature", body)).statusCode).toBe(400);
    expect(runManager).not.toHaveBeenCalled();
  });

  it.each([
    ["a javascript: logo", { ...DOMAIN_BODY, logoUrl: "javascript:alert(1)" }],
    ["a plain http logo", { ...DOMAIN_BODY, logoUrl: "http://example.com/logo.png" }],
    ["a data: logo", { ...DOMAIN_BODY, logoUrl: "data:image/png;base64,AAAA" }],
    ["a logo with credentials", { ...DOMAIN_BODY, logoUrl: "https://user:pw@example.com/l.png" }],
    ["a website that isn't an address", { ...DOMAIN_BODY, website: "not a site" }],
    ["a script as the website", { ...DOMAIN_BODY, website: "<script>alert(1)</script>" }],
    ["an unknown variable", { ...DOMAIN_BODY, template: "{{salary}}" }],
    ["a bad sender address", { ...DOMAIN_BODY, senderList: ["not-an-address"] }],
    ["too many senders", { ...DOMAIN_BODY, senderList: Array.from({ length: 501 }, (_, i) => `u${i}@example.com`) }],
    ["a bad list mode", { ...DOMAIN_BODY, senderListMode: "SOME" }],
    ["an oversized legal footer", { ...DOMAIN_BODY, complianceText: "x".repeat(2001) }],
    ["a missing field", { ...DOMAIN_BODY, locked: undefined }],
  ])("rejects %s on a domain with 400", async (_name, body) => {
    expect((await put("/api/domains/d1/mail-signature", body)).statusCode).toBe(400);
  });

  it("rejects bad groups, banners, bulk requests and imports with 400", async () => {
    const base = "/api/domains/d1/mail-signature";
    expect((await post(`${base}/groups`, { name: "", template: "x" })).statusCode).toBe(400);
    expect((await post(`${base}/groups`, { name: "Sales", template: "{{bad}}" })).statusCode).toBe(400);
    expect((await post(`${base}/banners`, { ...BANNER_BODY, endsAt: BANNER_BODY.startsAt })).statusCode).toBe(400);
    expect((await post(`${base}/banners`, { ...BANNER_BODY, text: "" })).statusCode).toBe(400);
    expect((await post(`${base}/banners`, { ...BANNER_BODY, startsAt: "tomorrow" })).statusCode).toBe(400);
    expect((await post(`${base}/bulk`, { action: "ASSIGN_GROUP", dryRun: true })).statusCode).toBe(400);
    expect((await post(`${base}/bulk`, { action: "DELETE_EVERYTHING", dryRun: true })).statusCode).toBe(400);
    expect((await post(`${base}/bulk`, { action: "RESET_TO_DEFAULT" })).statusCode).toBe(400);
    expect((await post(`${base}/import`, { format: "something-else", version: 1 })).statusCode).toBe(400);
    expect((await post("/api/mailboxes/m1/signature/test", undefined)).statusCode).not.toBe(400);
  });

  it("rejects a non-boolean switch value", async () => {
    const { app } = await buildApp({ userId: "u1", role: "ADMIN" });
    expect((await app.inject({ method: "PUT", url: "/api/mail-signatures/enforcement", payload: { enabled: "yes" } })).statusCode).toBe(400);
  });
});

describe("logo upload", () => {
  const upload = async (bytes: Buffer, filename?: string) => {
    const ctx = await buildApp({ userId: "u1" }, true);
    const res = await ctx.app.inject({ method: "POST", url: "/api/domains/d1/mail-signature/logo", ...multipartBody(bytes, filename) });
    return { ...ctx, res };
  };

  it("stores a real PNG under a random name and returns its public URL", async () => {
    const { res, assetCreate } = await upload(PNG, "../../evil.png");
    expect(res.statusCode).toBe(201);
    const body = res.json() as { url: string; size: number };
    expect(body.url).toMatch(/\/api\/signature-assets\/[a-f0-9]{32}\.png$/);
    expect(body.size).toBe(PNG.length);
    const [stored] = readdirSync(assetsDir);
    expect(stored).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(assetCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ contentType: "image/png", fileName: stored }) });
  });

  it("rejects a file that is not a supported image, whatever it is called or declares", async () => {
    for (const bytes of [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"), Buffer.from("<?php echo 1;"), Buffer.from("MZ" + "x".repeat(50)), Buffer.from("GIF")]) {
      const { res } = await upload(bytes, "logo.png");
      expect(res.statusCode).toBe(415);
    }
    expect(readdirSync(assetsDir).filter((f) => !/\.png$/.test(f))).toEqual([]);
  });

  it("rejects an empty file and one over the size limit", async () => {
    expect((await upload(Buffer.alloc(0))).res.statusCode).toBe(400);
    const { res } = await upload(Buffer.concat([PNG, Buffer.alloc(200 * 1024)]));
    expect(res.statusCode).toBe(413);
  });

  it("stops at ten logos per domain", async () => {
    const ctx = await buildApp({ userId: "u1" }, true);
    ctx.assetCount.mockResolvedValue(10);
    const res = await ctx.app.inject({ method: "POST", url: "/api/domains/d1/mail-signature/logo", ...multipartBody(PNG) });
    expect(res.statusCode).toBe(409);
  });
});

describe("public logo route", () => {
  const FILE = "0123456789abcdef0123456789abcdef.png";

  it("serves a known logo without a session, with locked-down headers", async () => {
    writeFileSync(join(assetsDir, FILE), PNG);
    const { app, assetFindUnique } = await buildApp({ userId: null });
    assetFindUnique.mockResolvedValue({ fileName: FILE, contentType: "image/png", size: PNG.length });

    const res = await app.inject({ method: "GET", url: `/api/signature-assets/${FILE}` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  it.each(["../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", "logo.svg", "ABCDEF0123456789abcdef.png", "0123456789abcdef0123456789abcdef.html", "short.png", "a%00.png"])(
    "never touches the database or disk for the file name %j",
    async (name) => {
      const { app, assetFindUnique } = await buildApp({ userId: null });
      const res = await app.inject({ method: "GET", url: `/api/signature-assets/${name}` });
      expect(res.statusCode).toBe(404);
      expect(assetFindUnique).not.toHaveBeenCalled();
    },
  );

  it("returns 404 for a well-formed name that isn't in the database", async () => {
    const { app } = await buildApp({ userId: null });
    expect((await app.inject({ method: "GET", url: `/api/signature-assets/${FILE}` })).statusCode).toBe(404);
  });
});
