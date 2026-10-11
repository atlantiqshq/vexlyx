// Runs against a real Postgres, because what needs proving here is the database behaviour:
// unique constraints, cascades, transactions and the shape of every query.
//   SIGNATURE_TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db pnpm exec vitest run <this file>
// The database must already have the migrations applied (prisma migrate deploy).
// Without that variable the whole file is skipped, so ordinary `pnpm test` needs no database.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, existsSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

vi.setConfig({ testTimeout: 60_000 });

const databaseUrl = process.env.SIGNATURE_TEST_DATABASE_URL;
process.env.DATABASE_URL = databaseUrl ?? "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const assetsDir = realpathSync.native(mkdtempSync(join(tmpdir(), "vexlyx-sig-int-")));
process.env.SIGNATURE_ASSETS_DIR = assetsDir;

/** A pretend mail-side directory: what signature_manager.py would have on disk. */
const files = new Map<string, Record<string, unknown>>();
let globalEnabled: boolean | null = null;
let failManager = false;
const fakeRun = vi.fn(async (command: string, payload: Record<string, unknown> = {}) => {
  if (failManager) throw new Error("docker is not running");
  if (command === "sync") {
    for (const entry of (payload.files as Array<{ address: string; data: Record<string, unknown> }>) ?? []) {
      files.set(entry.address, entry.data);
    }
    for (const address of (payload.remove as string[]) ?? []) files.delete(address);
    return {};
  }
  if (command === "prune_domain") {
    const keep = new Set(payload.keep as string[]);
    for (const address of [...files.keys()]) {
      if (address.endsWith(`@${payload.domain as string}`) && !keep.has(address)) files.delete(address);
    }
    return {};
  }
  if (command === "set_global") {
    globalEnabled = payload.enabled as boolean;
    return {};
  }
  if (command === "stats") return { stats: { modified: 3, skipped: { reply: 1 }, failed: 0, since: "2026-10-13T00:00:00Z" } };
  throw new Error(`unexpected command ${command}`);
});
vi.mock("./manager.js", () => ({ runSignatureManager: (...args: unknown[]) => fakeRun(...(args as [string, Record<string, unknown>])) }));

const notifyUser = vi.fn();
vi.mock("../system-email/notifier.js", () => ({ notifyUser: (...args: unknown[]) => notifyUser(...args) }));

const { MailSignatureService } = await import("./service.js");
const { SignatureSync } = await import("./sync.js");
const { AuditLogService } = await import("../audit-log/service.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const logger = { error: vi.fn() };

describe.skipIf(!databaseUrl)("MailSignatureService against Postgres", () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const service = new MailSignatureService(prisma, new AuditLogService(prisma, logger as never), new SignatureSync(prisma, logger, fakeRun as never));
  const userIds: string[] = [];

  const domainBody = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    template: "**{{name}}**\n{{title}}\n{{company}}",
    company: "Analytical Engines",
    website: "example.com",
    logoUrl: null,
    locked: false,
    enforceServerSide: false,
    externalOnly: false,
    newMessagesOnly: false,
    senderListMode: "ALL" as const,
    senderList: [] as string[],
    complianceEnabled: false,
    complianceText: "",
    ...overrides,
  });
  const mailboxBody = (overrides: Record<string, unknown> = {}) => ({
    mode: "INHERIT" as const,
    template: null,
    groupId: null,
    displayName: null,
    title: null,
    department: null,
    phone: null,
    mobile: null,
    ...overrides,
  });

  async function fixture(localParts: string[] = ["ada", "bob"]) {
    const id = randomBytes(4).toString("hex");
    const user = await prisma.user.create({ data: { email: `owner-${id}@signature-test.local`, name: "Owner", password: "x" } });
    userIds.push(user.id);
    const domain = await prisma.domain.create({ data: { hostname: `d${id}.example.com`, userId: user.id } });
    const mailboxes: Awaited<ReturnType<typeof prisma.mailbox.create>>[] = [];
    for (const local of localParts) {
      mailboxes.push(await prisma.mailbox.create({ data: { address: `${local}@${domain.hostname}`, password: "x", userId: user.id, domainId: domain.id } }));
    }
    return { user, domain, mailboxes, ...Object.fromEntries(localParts.map((local, index) => [local, mailboxes[index]])) } as {
      user: typeof user;
      domain: typeof domain;
      mailboxes: typeof mailboxes;
      ada: (typeof mailboxes)[number];
      bob: (typeof mailboxes)[number];
    };
  }
  const fileFor = (address: string) => files.get(address) as { signature: { text: string; html: string } | null; locked: boolean; banners: Array<{ text: string }>; version: string } | undefined;

  beforeEach(() => {
    files.clear();
    globalEnabled = null;
    failManager = false;
    fakeRun.mockClear();
    notifyUser.mockClear();
    logger.error.mockClear();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
    rmSync(assetsDir, { recursive: true, force: true });
  });

  describe("resolution and files", () => {
    it("gives every mailbox the domain default, filled from its own profile", async () => {
      const { user, domain, ada, bob } = await fixture();
      await service.updateMailbox(user.id, ada.id, mailboxBody({ displayName: "Ada Lovelace", title: "Engineer" }));
      await service.updateMailbox(user.id, bob.id, mailboxBody({ displayName: "Bob Babbage" }));
      await service.updateDomain(user.id, domain.id, domainBody());

      expect(fileFor(ada.address)!.signature!.text).toBe("Ada Lovelace\nEngineer\nAnalytical Engines");
      expect(fileFor(bob.address)!.signature!.text).toBe("Bob Babbage\nAnalytical Engines");
    });

    it("gives an untouched mailbox on an unconfigured domain nothing at all", async () => {
      const { user, ada } = await fixture();
      const view = await service.getMailbox(user.id, ada.id);
      expect(view).toMatchObject({ mode: "INHERIT", domainLocked: false, resolved: { source: "none", html: null, text: null } });
      expect(files.size).toBe(0);
    });

    it("applies a new mailbox's defaults as soon as the sync runs for it", async () => {
      const { user, domain } = await fixture(["ada"]);
      await service.updateDomain(user.id, domain.id, domainBody());
      const created = await prisma.mailbox.create({ data: { address: `new@${domain.hostname}`, password: "x", userId: user.id, domainId: domain.id } });
      expect(fileFor(created.address)).toBeUndefined();
      expect(await new SignatureSync(prisma, logger, fakeRun as never).syncMailbox(created.id)).toBeNull();
      expect(fileFor(created.address)!.signature!.text).toBe("Analytical Engines");
    });

    it("lets a mailbox use its own template and sets the source", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      const view = await service.updateMailbox(user.id, ada.id, mailboxBody({ mode: "CUSTOM", template: "Just {{email}}" }));
      expect(view.resolved.source).toBe("mailbox");
      expect(fileFor(ada.address)!.signature!.text).toBe(`Just ${ada.address}`);
    });

    it("removes the file when a mailbox chooses no signature, and when the domain is switched off", async () => {
      const { user, domain, ada, bob } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      expect(files.size).toBe(2);
      await service.updateMailbox(user.id, ada.id, mailboxBody({ mode: "NONE" }));
      expect(fileFor(ada.address)).toBeUndefined();
      expect(fileFor(bob.address)).toBeDefined();
      await service.updateDomain(user.id, domain.id, domainBody({ enabled: false }));
      expect(files.size).toBe(0);
    });

    it("keeps a legal footer on a mailbox that opted out of a personal signature", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody({ complianceEnabled: true, complianceText: "Registered No. 123" }));
      await service.updateMailbox(user.id, ada.id, mailboxBody({ mode: "NONE" }));
      const file = fileFor(ada.address)!;
      expect(file.signature).toBeNull();
      expect((file as unknown as { compliance: { text: string } }).compliance.text).toBe("Registered No. 123");
    });

    it("honours the sender list", async () => {
      const { user, domain, ada, bob } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody({ senderListMode: "ONLY_LISTED", senderList: [ada.address] }));
      expect(fileFor(ada.address)).toBeDefined();
      expect(fileFor(bob.address)).toBeUndefined();
    });

    it("rejects a sender-list address from another domain", async () => {
      const { user, domain } = await fixture();
      await expect(
        service.updateDomain(user.id, domain.id, domainBody({ senderListMode: "ONLY_LISTED", senderList: ["x@other.example.org"] })),
      ).rejects.toMatchObject({ code: "INVALID_SENDER", statusCode: 400 });
    });

    it("does not rewrite a file's version when nothing changed", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      const before = fileFor(ada.address)!.version;
      await service.updateDomain(user.id, domain.id, domainBody());
      expect(fileFor(ada.address)!.version).toBe(before);
    });
  });

  describe("locking", () => {
    it("refuses a mailbox's own template or opt-out while locked, but accepts its profile", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody({ locked: true }));
      await expect(service.updateMailbox(user.id, ada.id, mailboxBody({ mode: "CUSTOM", template: "Mine" }))).rejects.toMatchObject({ code: "DOMAIN_LOCKED", statusCode: 409 });
      await expect(service.updateMailbox(user.id, ada.id, mailboxBody({ mode: "NONE" }))).rejects.toMatchObject({ code: "DOMAIN_LOCKED" });

      const view = await service.updateMailbox(user.id, ada.id, mailboxBody({ displayName: "Ada Lovelace" }));
      expect(view.domainLocked).toBe(true);
      expect(fileFor(ada.address)).toMatchObject({ locked: true, signature: { text: "Ada Lovelace\nAnalytical Engines" } });
    });

    it("ignores a template saved before the domain was locked", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateMailbox(user.id, ada.id, mailboxBody({ mode: "CUSTOM", template: "Mine" }));
      await service.updateDomain(user.id, domain.id, domainBody({ locked: true }));
      expect(fileFor(ada.address)!.signature!.text).toBe("Analytical Engines");
      expect((await service.getMailbox(user.id, ada.id)).resolved.source).toBe("domain");
    });
  });

  describe("groups", () => {
    it("uses the group's template for its members, and falls back when the group is deleted", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      const created = await service.createGroup(user.id, domain.id, { name: "Sales", template: "{{name}} - Sales" });
      const groupId = created.groups[0]!.id;

      await service.updateMailbox(user.id, ada.id, mailboxBody({ displayName: "Ada", groupId }));
      expect(fileFor(ada.address)!.signature!.text).toBe("Ada - Sales");

      await service.deleteGroup(user.id, domain.id, groupId);
      expect(fileFor(ada.address)!.signature!.text).toBe("Ada\nAnalytical Engines");
      expect((await service.getMailbox(user.id, ada.id)).groupId).toBeNull();
    });

    it("rejects a duplicate name, a group from another domain, and too many groups", async () => {
      const { user, domain, ada } = await fixture();
      const other = await fixture();
      await service.createGroup(user.id, domain.id, { name: "Sales", template: "x" });
      await expect(service.createGroup(user.id, domain.id, { name: "Sales", template: "y" })).rejects.toMatchObject({ code: "GROUP_EXISTS", statusCode: 409 });

      const foreign = (await service.createGroup(other.user.id, other.domain.id, { name: "Theirs", template: "z" })).groups[0]!.id;
      await expect(service.updateMailbox(user.id, ada.id, mailboxBody({ groupId: foreign }))).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
      await expect(service.updateGroup(user.id, domain.id, foreign, { name: "Theirs", template: "z" })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("banners", () => {
    it("writes upcoming banners with their dates, and shows only the active one in the preview", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      const day = 86_400_000;
      const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
      await service.createBanner(user.id, domain.id, { text: "Active now", startsAt: iso(-1), endsAt: iso(1), enabled: true });
      await service.createBanner(user.id, domain.id, { text: "Next month", startsAt: iso(30), endsAt: iso(40), enabled: true });
      await service.createBanner(user.id, domain.id, { text: "Long over", startsAt: iso(-40), endsAt: iso(-30), enabled: true });

      expect(fileFor(ada.address)!.banners.map((b) => b.text).sort()).toEqual(["Active now", "Next month"]);
      const preview = (await service.getMailbox(user.id, ada.id)).resolved.text!;
      expect(preview).toContain("Active now");
      expect(preview).not.toContain("Next month");
      expect(preview).not.toContain("Long over");
    });

    it("scopes a banner to a group and rejects a foreign group", async () => {
      const { user, domain, ada, bob } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      const groupId = (await service.createGroup(user.id, domain.id, { name: "Sales", template: "" })).groups[0]!.id;
      await service.updateMailbox(user.id, ada.id, mailboxBody({ groupId }));
      const now = Date.now();
      await service.createBanner(user.id, domain.id, { groupId, text: "Sales only", startsAt: new Date(now - 1000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(), enabled: true });
      expect(fileFor(ada.address)!.banners).toHaveLength(1);
      expect(fileFor(bob.address)!.banners).toHaveLength(0);

      await expect(
        service.createBanner(user.id, domain.id, { groupId: "nope", text: "x", startsAt: new Date(now).toISOString(), endsAt: new Date(now + 1000).toISOString(), enabled: true }),
      ).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
    });
  });

  describe("bulk apply", () => {
    it("counts without changing anything on a dry run, then applies", async () => {
      const { user, domain, ada, bob } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      await service.updateMailbox(user.id, ada.id, mailboxBody({ mode: "CUSTOM", template: "Mine", displayName: "Ada" }));
      await service.updateMailbox(user.id, bob.id, mailboxBody({ mode: "NONE" }));

      expect(await service.bulk(user.id, domain.id, { action: "RESET_TO_DEFAULT", dryRun: true })).toMatchObject({ dryRun: true, affected: 2, total: 2 });
      expect((await service.getMailbox(user.id, ada.id)).mode).toBe("CUSTOM");

      expect(await service.bulk(user.id, domain.id, { action: "RESET_TO_DEFAULT", dryRun: false })).toMatchObject({ dryRun: false, affected: 2 });
      const adaView = await service.getMailbox(user.id, ada.id);
      expect(adaView).toMatchObject({ mode: "INHERIT", template: null, profile: { displayName: "Ada" } });
      expect(fileFor(bob.address)).toBeDefined();
      expect(await service.bulk(user.id, domain.id, { action: "RESET_TO_DEFAULT", dryRun: true })).toMatchObject({ affected: 0 });
    });

    it("assigns and clears a group, including for mailboxes that have no settings yet", async () => {
      const { user, domain, ada, bob } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      const groupId = (await service.createGroup(user.id, domain.id, { name: "Support", template: "{{email}}" })).groups[0]!.id;

      expect(await service.bulk(user.id, domain.id, { action: "ASSIGN_GROUP", groupId, dryRun: true })).toMatchObject({ affected: 2 });
      await service.bulk(user.id, domain.id, { action: "ASSIGN_GROUP", groupId, dryRun: false });
      expect(fileFor(bob.address)!.signature!.text).toBe(bob.address);
      expect(fileFor(ada.address)!.signature!.text).toBe(ada.address);

      await service.bulk(user.id, domain.id, { action: "ASSIGN_GROUP", groupId: null, dryRun: false });
      expect(fileFor(ada.address)!.signature!.text).toBe("Analytical Engines");
    });

    it("writes a version for each mailbox it changes", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateMailbox(user.id, ada.id, mailboxBody({ mode: "NONE" }));
      const before = (await service.listMailboxVersions(user.id, ada.id)).length;
      await service.bulk(user.id, domain.id, { action: "RESET_TO_DEFAULT", dryRun: false });
      expect((await service.listMailboxVersions(user.id, ada.id)).length).toBe(before + 1);
    });
  });

  describe("versions", () => {
    it("lets a domain go back to an earlier template, recording who changed it", async () => {
      const { user, domain } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody({ template: "first" }));
      await service.updateDomain(user.id, domain.id, domainBody({ template: "second" }));
      await service.updateDomain(user.id, domain.id, domainBody({ template: "third" }));

      const versions = await service.listDomainVersions(user.id, domain.id);
      expect(versions).toHaveLength(3);
      expect(versions[0]!.createdByEmail).toBe(user.email);

      // Newest first: [state before "third" (= second), state before "second" (= first), state before "first" (= empty)]
      const restored = await service.restoreDomainVersion(user.id, domain.id, versions[1]!.id);
      expect(restored.template).toBe("first");
      expect(await service.listDomainVersions(user.id, domain.id)).toHaveLength(4);
    });

    it("keeps only the latest twenty and refuses a version that belongs elsewhere", async () => {
      const { user, domain, ada } = await fixture();
      for (let i = 0; i < 24; i++) await service.updateDomain(user.id, domain.id, domainBody({ template: `t${i}` }));
      expect(await service.listDomainVersions(user.id, domain.id)).toHaveLength(20);

      const [version] = await service.listDomainVersions(user.id, domain.id);
      await expect(service.restoreMailboxVersion(user.id, ada.id, version!.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it("restores a mailbox's earlier settings, dropping a group that no longer exists", async () => {
      const { user, domain, ada } = await fixture();
      const groupId = (await service.createGroup(user.id, domain.id, { name: "Sales", template: "x" })).groups[0]!.id;
      await service.updateMailbox(user.id, ada.id, mailboxBody({ displayName: "Ada", groupId }));
      await service.updateMailbox(user.id, ada.id, mailboxBody({ displayName: "Changed" }));
      await service.deleteGroup(user.id, domain.id, groupId);

      const [latest] = await service.listMailboxVersions(user.id, ada.id);
      const restored = await service.restoreMailboxVersion(user.id, ada.id, latest!.id);
      expect(restored.profile.displayName).toBe("Ada");
      expect(restored.groupId).toBeNull();
    });
  });

  describe("export and import", () => {
    it("copies a template to another domain, keeping that domain's own sender list and groups", async () => {
      const a = await fixture();
      await service.updateDomain(a.user.id, a.domain.id, domainBody({ template: "From A", complianceEnabled: true, complianceText: "Legal A", locked: true }));
      await service.createGroup(a.user.id, a.domain.id, { name: "Sales", template: "Sales A" });
      const now = Date.now();
      await service.createBanner(a.user.id, a.domain.id, { text: "Promo", startsAt: new Date(now).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(), enabled: true });
      const exported = await service.exportDomain(a.user.id, a.domain.id);
      expect(exported).toMatchObject({ format: "vexlyx-signature-template", version: 1 });
      expect(JSON.stringify(exported)).not.toContain(a.domain.hostname);

      const b = await fixture();
      await service.updateDomain(b.user.id, b.domain.id, domainBody({ senderListMode: "ONLY_LISTED", senderList: [b.ada.address] }));
      await service.createGroup(b.user.id, b.domain.id, { name: "Keepers", template: "stay" });
      const imported = await service.importDomain(b.user.id, b.domain.id, exported);

      expect(imported).toMatchObject({ template: "From A", locked: true, complianceText: "Legal A", senderListMode: "ONLY_LISTED", senderList: [b.ada.address] });
      expect(imported.groups.map((g) => g.name).sort()).toEqual(["Keepers", "Sales"]);
      expect(imported.banners.map((x) => x.text)).toEqual(["Promo"]);

      const again = await service.importDomain(b.user.id, b.domain.id, exported);
      expect(again.banners).toHaveLength(1);
      expect(again.groups).toHaveLength(2);
    });
  });

  describe("logos", () => {
    it("stores, serves and deletes a logo, clearing the signature that used it", async () => {
      const { user, domain, ada } = await fixture();
      const asset = await service.uploadLogo(user.id, domain.id, PNG);
      expect(asset.url).toMatch(/\/api\/signature-assets\/[a-f0-9]{32}\.png$/);
      const fileName = asset.url.split("/").pop()!;
      expect(existsSync(join(assetsDir, fileName))).toBe(true);
      expect(await service.findPublicAsset(fileName)).toMatchObject({ contentType: "image/png", size: PNG.length });

      await service.updateDomain(user.id, domain.id, domainBody({ logoUrl: asset.url }));
      expect(fileFor(ada.address)!.signature!.html).toContain(`<img src="${asset.url}"`);

      const after = await service.deleteLogo(user.id, domain.id, asset.id);
      expect(after.logoUrl).toBeNull();
      expect(existsSync(join(assetsDir, fileName))).toBe(false);
      expect(await service.findPublicAsset(fileName)).toBeNull();
      expect(fileFor(ada.address)!.signature!.html).not.toContain("<img");
    });

    it("won't serve a logo that belongs to someone else's deletion, or one that isn't an image", async () => {
      const a = await fixture();
      const b = await fixture();
      const asset = await service.uploadLogo(a.user.id, a.domain.id, PNG);
      await expect(service.deleteLogo(b.user.id, b.domain.id, asset.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.uploadLogo(a.user.id, a.domain.id, Buffer.from("<svg onload=alert(1)>"))).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE", statusCode: 415 });
    });

    it("sweeps files no row points to, but only old ones", async () => {
      const orphan = `${randomBytes(16).toString("hex")}.png`;
      const fresh = `${randomBytes(16).toString("hex")}.png`;
      writeFileSync(join(assetsDir, orphan), PNG);
      writeFileSync(join(assetsDir, fresh), PNG);
      const old = new Date(Date.now() - 2 * 3_600_000);
      utimesSync(join(assetsDir, orphan), old, old);

      const removed = await new SignatureSync(prisma, logger, fakeRun as never).sweepOrphanAssets();
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(assetsDir, orphan))).toBe(false);
      expect(existsSync(join(assetsDir, fresh))).toBe(true);
    });
  });

  describe("ownership and cleanup", () => {
    it("treats another account's mailbox and domain as not found, for every operation", async () => {
      const mine = await fixture();
      const theirs = await fixture();
      const probes: Array<() => Promise<unknown>> = [
        () => service.getMailbox(theirs.user.id, mine.ada.id),
        () => service.updateMailbox(theirs.user.id, mine.ada.id, mailboxBody()),
        () => service.resetMailbox(theirs.user.id, mine.ada.id),
        () => service.listMailboxVersions(theirs.user.id, mine.ada.id),
        () => service.sendTest(theirs.user.id, mine.ada.id),
        () => service.getDomain(theirs.user.id, mine.domain.id),
        () => service.updateDomain(theirs.user.id, mine.domain.id, domainBody()),
        () => service.createGroup(theirs.user.id, mine.domain.id, { name: "x", template: "" }),
        () => service.bulk(theirs.user.id, mine.domain.id, { action: "RESET_TO_DEFAULT", dryRun: false }),
        () => service.exportDomain(theirs.user.id, mine.domain.id),
        () => service.uploadLogo(theirs.user.id, mine.domain.id, PNG),
      ];
      for (const probe of probes) await expect(probe()).rejects.toMatchObject({ statusCode: 404 });
      expect(files.size).toBe(0);
      expect(await prisma.domainSignature.count({ where: { domainId: mine.domain.id } })).toBe(0);
    });

    it("deletes a mailbox's settings and versions' target with the mailbox, and a domain's everything with the domain", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      await service.createGroup(user.id, domain.id, { name: "Sales", template: "x" });
      await service.updateMailbox(user.id, ada.id, mailboxBody({ displayName: "Ada" }));

      await prisma.mailbox.delete({ where: { id: ada.id } });
      expect(await prisma.mailboxSignature.count({ where: { mailboxId: ada.id } })).toBe(0);

      await prisma.domain.delete({ where: { id: domain.id } });
      expect(await prisma.domainSignature.count({ where: { domainId: domain.id } })).toBe(0);
      expect(await prisma.signatureGroup.count({ where: { domainId: domain.id } })).toBe(0);
    });

    it("removes a deleted mailbox's file and a deleted domain's files through the sync hooks", async () => {
      const { user, domain, ada, bob } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      const sync = new SignatureSync(prisma, logger, fakeRun as never);
      await sync.removeAddresses([ada.address]);
      expect(fileFor(ada.address)).toBeUndefined();
      expect(fileFor(bob.address)).toBeDefined();
      await sync.removeDomain(domain.hostname);
      expect(files.size).toBe(0);
    });
  });

  describe("audit log", () => {
    it("records who changed what, without the template text", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody({ template: "SECRET-TEMPLATE-TEXT", locked: true }));
      await service.updateMailbox(user.id, ada.id, mailboxBody({ displayName: "Private Name" }));

      const entries = await prisma.auditLog.findMany({ where: { actorId: user.id } });
      expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(["domain.mail_signature_updated", "mailbox.signature_updated"]));
      expect(JSON.stringify(entries)).not.toContain("SECRET-TEMPLATE-TEXT");
      expect(JSON.stringify(entries)).not.toContain("Private Name");
      expect(entries.find((e) => e.action === "domain.mail_signature_updated")).toMatchObject({ targetId: domain.id, actorEmail: user.email });
    });
  });

  describe("test message", () => {
    it("emails the owner the signature as it would be sent", async () => {
      const { user, domain, ada } = await fixture();
      await service.updateDomain(user.id, domain.id, domainBody());
      await service.updateMailbox(user.id, ada.id, mailboxBody({ displayName: "Ada Lovelace" }));

      expect(await service.sendTest(user.id, ada.id)).toEqual({ sentTo: user.email });
      expect(notifyUser).toHaveBeenCalledWith(
        "signature_test",
        user.email,
        expect.objectContaining({ address: ada.address, signatureText: expect.stringContaining("Ada Lovelace") }),
      );
    });

    it("refuses when there is no signature to show", async () => {
      const { user, ada } = await fixture();
      await expect(service.sendTest(user.id, ada.id)).rejects.toMatchObject({ code: "NO_SIGNATURE", statusCode: 400 });
      expect(notifyUser).not.toHaveBeenCalled();
    });
  });

  describe("the global switch", () => {
    it("is stored, passed to the mail layer and audited, and reports the filter's counters", async () => {
      const { user } = await fixture();
      expect(await service.getEnforcement()).toMatchObject({ stats: { modified: 3 } });
      const status = await service.setEnforcement(user.id, false);
      expect(status.enabled).toBe(false);
      expect(globalEnabled).toBe(false);
      expect((await service.getEnforcement()).enabled).toBe(false);
      await service.setEnforcement(user.id, true);
      expect(globalEnabled).toBe(true);
      expect(await prisma.auditLog.count({ where: { actorId: user.id, action: "mail.signature_enforcement_changed" } })).toBe(2);
    });

    it("tells the dashboard when enforcement is switched off", async () => {
      const { user, domain } = await fixture();
      await service.setEnforcement(user.id, false);
      expect((await service.getDomain(user.id, domain.id)).enforcementAvailable).toBe(false);
      await service.setEnforcement(user.id, true);
      expect((await service.getDomain(user.id, domain.id)).enforcementAvailable).toBe(true);
    });
  });

  describe("when the mail side is unreachable", () => {
    it("still saves, and reports that the servers weren't updated", async () => {
      const { user, domain, ada } = await fixture();
      failManager = true;
      const saved = await service.updateDomain(user.id, domain.id, domainBody({ template: "kept" }));
      expect(saved.template).toBe("kept");
      expect(saved.syncWarning).toContain("docker is not running");
      expect(logger.error).toHaveBeenCalled();

      const mailbox = await service.updateMailbox(user.id, ada.id, mailboxBody({ displayName: "Ada" }));
      expect(mailbox.syncWarning).toContain("docker is not running");
      expect((await prisma.domainSignature.findUniqueOrThrow({ where: { domainId: domain.id } })).template).toBe("kept");

      failManager = false;
      expect((await service.getDomain(user.id, domain.id)).syncWarning).toBeUndefined();
    });
  });
});
