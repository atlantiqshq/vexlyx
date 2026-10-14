import { describe, expect, it } from "vitest";
import type { DomainSignatureResponse } from "@vexlyx/shared";
import { draftToInput, parseSenderList, policyToDraft, sameDraft } from "@/lib/signatureDraft";

const policy: DomainSignatureResponse = {
  domainId: "d1",
  hostname: "example.com",
  enabled: true,
  template: "**{{name}}**",
  company: "Analytical Engines",
  website: null,
  logoUrl: null,
  locked: true,
  enforceServerSide: false,
  externalOnly: false,
  newMessagesOnly: true,
  senderListMode: "EXCEPT_LISTED",
  senderList: ["a@example.com", "b@example.com"],
  complianceEnabled: true,
  complianceText: "Legal",
  groups: [],
  banners: [],
  assets: [],
  enforcementAvailable: true,
};

describe("parseSenderList", () => {
  it("splits on newlines, commas, semicolons and spaces, lower-cases, and drops duplicates and blanks", () => {
    expect(parseSenderList("A@Example.com, b@example.com;\n  a@example.com\n\n c@example.com ")).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(parseSenderList("")).toEqual([]);
    expect(parseSenderList("  \n ")).toEqual([]);
  });
});

describe("draft conversion", () => {
  it("round-trips a policy through the form and back to the payload", () => {
    const input = draftToInput(policyToDraft(policy));
    expect(input).toEqual({
      enabled: true,
      template: "**{{name}}**",
      company: "Analytical Engines",
      website: null,
      logoUrl: null,
      locked: true,
      enforceServerSide: false,
      externalOnly: false,
      newMessagesOnly: true,
      senderListMode: "EXCEPT_LISTED",
      senderList: ["a@example.com", "b@example.com"],
      complianceEnabled: true,
      complianceText: "Legal",
    });
  });

  it("turns blank text fields into null so the server stores no empty strings", () => {
    const draft = { ...policyToDraft(policy), company: "   ", website: "", logoUrl: " " };
    expect(draftToInput(draft)).toMatchObject({ company: null, website: null, logoUrl: null });
  });

  it("trims what the user typed", () => {
    expect(draftToInput({ ...policyToDraft(policy), company: "  Acme  " }).company).toBe("Acme");
  });
});

describe("sameDraft", () => {
  it("ignores how the sender list is written", () => {
    const a = policyToDraft(policy);
    expect(sameDraft(a, { ...a, senderList: "B@example.com, a@example.com" })).toBe(false);
    expect(sameDraft(a, { ...a, senderList: "a@example.com b@example.com" })).toBe(true);
  });

  it("notices a real change", () => {
    const a = policyToDraft(policy);
    expect(sameDraft(a, { ...a, locked: false })).toBe(false);
    expect(sameDraft(a, { ...a, template: "different" })).toBe(false);
  });
});
