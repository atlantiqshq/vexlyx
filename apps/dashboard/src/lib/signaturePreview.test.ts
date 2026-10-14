import { describe, expect, it } from "vitest";
import { previewDocument, previewMailboxSignature, type PreviewDomain, type PreviewMailbox } from "@/lib/signaturePreview";

const NOW = new Date("2026-10-13T12:00:00Z");

const domain = (overrides: Partial<PreviewDomain> = {}): PreviewDomain => ({
  template: "**{{name}}**\n{{title}}\n{{company}}",
  company: "Analytical Engines",
  website: "example.com",
  logoUrl: null,
  locked: false,
  complianceEnabled: false,
  complianceText: "",
  groups: [],
  banners: [],
  ...overrides,
});

const mailbox = (overrides: Partial<PreviewMailbox> = {}): PreviewMailbox => ({
  address: "ada@example.com",
  mode: "INHERIT",
  template: null,
  groupId: null,
  displayName: "Ada Lovelace",
  title: "Engineer",
  department: null,
  phone: null,
  mobile: null,
  ...overrides,
});

describe("previewMailboxSignature", () => {
  it("fills the domain template from the mailbox profile", () => {
    expect(previewMailboxSignature(domain(), mailbox(), NOW)!.text).toBe("-- \nAda Lovelace\nEngineer\nAnalytical Engines");
  });

  it("uses the mailbox's own template when it is custom, and nothing when it is none", () => {
    expect(previewMailboxSignature(domain(), mailbox({ mode: "CUSTOM", template: "Just {{email}}" }), NOW)!.text).toBe("-- \nJust ada@example.com");
    expect(previewMailboxSignature(domain(), mailbox({ mode: "NONE" }), NOW)).toBeNull();
  });

  it("prefers the group's template over the domain's, unless the group's is empty", () => {
    const groups = [{ id: "g1", template: "{{name}} - Sales" }];
    expect(previewMailboxSignature(domain({ groups }), mailbox({ groupId: "g1" }), NOW)!.text).toBe("-- \nAda Lovelace - Sales");
    expect(previewMailboxSignature(domain({ groups: [{ id: "g1", template: " " }] }), mailbox({ groupId: "g1" }), NOW)!.text).toContain("Analytical Engines");
  });

  it("ignores a custom template and an opt-out while the domain is locked", () => {
    const locked = domain({ locked: true });
    expect(previewMailboxSignature(locked, mailbox({ mode: "CUSTOM", template: "Mine" }), NOW)!.text).toContain("Analytical Engines");
    expect(previewMailboxSignature(locked, mailbox({ mode: "NONE" }), NOW)).not.toBeNull();
  });

  it("shows only banners inside their dates, for the mailbox's group", () => {
    const banners = [
      { text: "Open now", startsAt: "2026-10-13T00:00:00Z", endsAt: "2026-10-14T00:00:00Z", enabled: true, groupId: null },
      { text: "Later", startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-02T00:00:00Z", enabled: true, groupId: null },
      { text: "Off", startsAt: "2026-10-13T00:00:00Z", endsAt: "2026-10-14T00:00:00Z", enabled: false, groupId: null },
      { text: "Other group", startsAt: "2026-10-13T00:00:00Z", endsAt: "2026-10-14T00:00:00Z", enabled: true, groupId: "g2" },
    ];
    const text = previewMailboxSignature(domain({ banners }), mailbox(), NOW)!.text;
    expect(text).toContain("Open now");
    expect(text).not.toMatch(/Later|Off|Other group/);
  });

  it("keeps the legal footer even for a mailbox with no signature of its own", () => {
    const legal = domain({ complianceEnabled: true, complianceText: "Registered No. 1" });
    expect(previewMailboxSignature(legal, mailbox({ mode: "NONE" }), NOW)!.text).toBe("-- \nRegistered No. 1");
  });

  it("escapes anything typed into the profile", () => {
    const html = previewMailboxSignature(domain(), mailbox({ displayName: "<script>alert(1)</script>" }), NOW)!.html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("previewDocument", () => {
  it("wraps the signature for a light or dark preview", () => {
    expect(previewDocument("<div>x</div>", false)).toContain("background:#ffffff");
    expect(previewDocument("<div>x</div>", true)).toContain("background:#0f172a");
    expect(previewDocument("<div>x</div>", true)).toContain("<div>x</div>");
  });
});
