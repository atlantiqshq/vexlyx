import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAILBOX_SETTINGS,
  buildSignatureFile,
  composeAt,
  defaultDomainPolicy,
  markerFor,
  resolveSignature,
  type BannerSettings,
  type DomainPolicy,
  type GroupSettings,
  type MailboxSettings,
} from "./resolve.js";

const ADDRESS = "ada@example.com";
const NOW = new Date("2026-10-13T12:00:00Z");

const domain = (overrides: Partial<DomainPolicy> = {}): DomainPolicy => ({
  ...defaultDomainPolicy("example.com"),
  template: "**{{name}}**\n{{title}}\n{{company}}",
  company: "Analytical Engines",
  ...overrides,
});
const mailbox = (overrides: Partial<MailboxSettings> = {}): MailboxSettings => ({
  ...DEFAULT_MAILBOX_SETTINGS,
  displayName: "Ada Lovelace",
  title: "Engineer",
  ...overrides,
});
const group: GroupSettings = { id: "g1", name: "Sales", template: "{{name}} - Sales\n{{phone}}" };

const resolve = (d: DomainPolicy, m: MailboxSettings, g: GroupSettings | null = null, banners: BannerSettings[] = []) =>
  resolveSignature({ address: ADDRESS, domain: d, mailbox: m, group: g, banners });

describe("which template wins", () => {
  it("gives nothing when neither the mailbox nor the domain has a template", () => {
    const r = resolve(domain({ template: "" }), mailbox());
    expect(r.source).toBe("none");
    expect(r.personal).toBeNull();
    expect(composeAt(r, NOW)).toBeNull();
  });

  it("uses the domain default and fills it from the mailbox profile", () => {
    const r = resolve(domain(), mailbox());
    expect(r.source).toBe("domain");
    expect(r.personal!.text).toBe("Ada Lovelace\nEngineer\nAnalytical Engines");
  });

  it("prefers the group over the domain, and the mailbox's own template over both", () => {
    expect(resolve(domain(), mailbox({ groupId: "g1", phone: "123" }), group).source).toBe("group");
    const own = resolve(domain(), mailbox({ mode: "CUSTOM", template: "Just {{name}}", groupId: "g1" }), group);
    expect(own.source).toBe("mailbox");
    expect(own.personal!.text).toBe("Just Ada Lovelace");
  });

  it("falls back to the domain when the group's template is empty", () => {
    expect(resolve(domain(), mailbox({ groupId: "g1" }), { ...group, template: "  " }).source).toBe("domain");
  });

  it("gives a mailbox set to NONE no signature", () => {
    expect(resolve(domain(), mailbox({ mode: "NONE" })).personal).toBeNull();
  });

  it("gives an unconfigured mailbox exactly what it had before this feature: nothing", () => {
    const r = resolve(defaultDomainPolicy("example.com"), DEFAULT_MAILBOX_SETTINGS);
    expect(r).toEqual({ source: "none", personal: null, compliance: null, banners: [] });
  });
});

describe("locked domain", () => {
  it("ignores a mailbox's own template and its NONE choice, but keeps its profile", () => {
    const d = domain({ locked: true });
    const custom = resolve(d, mailbox({ mode: "CUSTOM", template: "Mine" }));
    expect(custom.source).toBe("domain");
    expect(custom.personal!.text).toContain("Ada Lovelace");
    expect(resolve(d, mailbox({ mode: "NONE" })).personal).not.toBeNull();
  });

  it("still applies the mailbox's group", () => {
    expect(resolve(domain({ locked: true }), mailbox({ groupId: "g1", phone: "1" }), group).source).toBe("group");
  });
});

describe("domain switches and the sender list", () => {
  it("gives nothing, not even the legal footer, when the domain is disabled", () => {
    const r = resolve(domain({ enabled: false, complianceEnabled: true, complianceText: "Legal" }), mailbox());
    expect(r).toEqual({ source: "none", personal: null, compliance: null, banners: [] });
  });

  it("ONLY_LISTED leaves out senders who are not listed", () => {
    const d = domain({ senderListMode: "ONLY_LISTED", senderList: ["bob@example.com"] });
    expect(resolve(d, mailbox()).personal).toBeNull();
    expect(resolve({ ...d, senderList: [ADDRESS] }, mailbox()).personal).not.toBeNull();
  });

  it("EXCEPT_LISTED leaves out the listed senders", () => {
    const d = domain({ senderListMode: "EXCEPT_LISTED", senderList: [ADDRESS] });
    expect(resolve(d, mailbox()).personal).toBeNull();
    expect(resolve({ ...d, senderList: ["bob@example.com"] }, mailbox()).personal).not.toBeNull();
  });

  it("matches the sender list case-insensitively", () => {
    const d = domain({ senderListMode: "ONLY_LISTED", senderList: [ADDRESS] });
    expect(resolveSignature({ address: "ADA@Example.com", domain: d, mailbox: mailbox(), group: null, banners: [] }).personal).not.toBeNull();
  });
});

describe("legal footer and banners", () => {
  const legal = { complianceEnabled: true, complianceText: "Registered No. {{company}}" };

  it("appears with a signature, and also for a mailbox that opted out of its own", () => {
    expect(resolve(domain(legal), mailbox()).compliance!.text).toBe("Registered No. Analytical Engines");
    const none = resolve(domain(legal), mailbox({ mode: "NONE" }));
    expect(none.personal).toBeNull();
    expect(composeAt(none, NOW)!.text).toBe("-- \nRegistered No. Analytical Engines");
  });

  it("is off unless enabled", () => {
    expect(resolve(domain({ complianceText: "Legal" }), mailbox()).compliance).toBeNull();
  });

  const banner = (overrides: Partial<BannerSettings> = {}): BannerSettings => ({
    groupId: null,
    text: "Closed **24 Dec**",
    startsAt: new Date("2026-10-13T00:00:00Z"),
    endsAt: new Date("2026-10-14T00:00:00Z"),
    enabled: true,
    ...overrides,
  });

  it("shows a banner only inside its window", () => {
    const r = resolve(domain(), mailbox(), null, [banner()]);
    expect(composeAt(r, NOW)!.text).toContain("Closed 24 Dec");
    expect(composeAt(r, new Date("2026-10-12T23:59:59Z"))!.text).not.toContain("Closed");
    expect(composeAt(r, new Date("2026-10-14T00:00:00Z"))!.text).not.toContain("Closed");
  });

  it("ignores disabled banners and banners for another group", () => {
    expect(resolve(domain(), mailbox(), null, [banner({ enabled: false })]).banners).toHaveLength(0);
    expect(resolve(domain(), mailbox(), null, [banner({ groupId: "g2" })]).banners).toHaveLength(0);
    expect(resolve(domain(), mailbox({ groupId: "g1", phone: "1" }), group, [banner({ groupId: "g1" })]).banners).toHaveLength(1);
  });

  it("does not show a banner for a mailbox with no signature", () => {
    expect(resolve(domain(), mailbox({ mode: "NONE" }), null, [banner()]).banners).toHaveLength(0);
  });
});

describe("signature file", () => {
  const build = (d: DomainPolicy, m: MailboxSettings, banners: BannerSettings[] = []) =>
    buildSignatureFile({ address: ADDRESS, domain: d, mailbox: m, group: null, banners, internalDomains: ["Example.com", "example.org"], now: NOW });

  it("is null when there is nothing to add", () => {
    expect(build(domain({ template: "" }), mailbox())).toBeNull();
  });

  it("carries the rendered parts, the policy and the lock", () => {
    const file = build(domain({ locked: true, enforceServerSide: true, externalOnly: true }), mailbox())!;
    expect(file).toMatchObject({
      v: 1,
      address: ADDRESS,
      marker: markerFor(ADDRESS),
      locked: true,
      enforceServerSide: true,
      rules: { externalOnly: true, newMessagesOnly: false },
      internalDomains: ["example.com", "example.org"],
    });
    expect(file.signature!.html).toContain(`<!--vx-sig:${markerFor(ADDRESS)}-->`);
    expect(file.signature!.text).toBe("Ada Lovelace\nEngineer\nAnalytical Engines");
    expect(file.compliance).toBeNull();
  });

  it("keeps upcoming banners with their dates and drops ones that have ended", () => {
    const file = build(domain(), mailbox(), [
      { groupId: null, text: "Soon", enabled: true, startsAt: new Date("2026-12-01T00:00:00Z"), endsAt: new Date("2026-12-25T00:00:00Z") },
      { groupId: null, text: "Over", enabled: true, startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: new Date("2026-02-01T00:00:00Z") },
    ])!;
    expect(file.banners).toHaveLength(1);
    expect(file.banners[0]).toMatchObject({ text: "Soon", startsAt: "2026-12-01T00:00:00.000Z", endsAt: "2026-12-25T00:00:00.000Z" });
  });

  it("has a version that changes with the content but not with the time it was built", () => {
    const a = build(domain(), mailbox())!;
    const later = buildSignatureFile({ address: ADDRESS, domain: domain(), mailbox: mailbox(), group: null, banners: [], internalDomains: ["Example.com", "example.org"], now: new Date(NOW.getTime() + 3_600_000) })!;
    expect(later.version).toBe(a.version);
    expect(build(domain(), mailbox({ title: "Director" }))!.version).not.toBe(a.version);
    expect(build(domain({ locked: true }), mailbox())!.version).not.toBe(a.version);
  });

  it("writes only a file's own address, lower-cased, so the file name can never escape its directory", () => {
    const file = buildSignatureFile({ address: "ADA@Example.com", domain: domain(), mailbox: mailbox(), group: null, banners: [], internalDomains: [], now: NOW })!;
    expect(file.address).toBe("ada@example.com");
  });
});
