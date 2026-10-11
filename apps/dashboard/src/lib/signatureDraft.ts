import type { DomainSignatureResponse, SignatureSenderListMode, UpdateDomainSignatureInput } from "@vexlyx/shared";

/** The domain settings form as the user edits it: everything is a string or boolean the inputs can hold. */
export interface PolicyDraft {
  enabled: boolean;
  template: string;
  company: string;
  website: string;
  logoUrl: string;
  locked: boolean;
  enforceServerSide: boolean;
  externalOnly: boolean;
  newMessagesOnly: boolean;
  senderListMode: SignatureSenderListMode;
  /** One address per line (commas and spaces also separate them). */
  senderList: string;
  complianceEnabled: boolean;
  complianceText: string;
}

export function parseSenderList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ""))];
}

export function policyToDraft(policy: DomainSignatureResponse): PolicyDraft {
  return {
    enabled: policy.enabled,
    template: policy.template,
    company: policy.company ?? "",
    website: policy.website ?? "",
    logoUrl: policy.logoUrl ?? "",
    locked: policy.locked,
    enforceServerSide: policy.enforceServerSide,
    externalOnly: policy.externalOnly,
    newMessagesOnly: policy.newMessagesOnly,
    senderListMode: policy.senderListMode,
    senderList: policy.senderList.join("\n"),
    complianceEnabled: policy.complianceEnabled,
    complianceText: policy.complianceText,
  };
}

const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

export function draftToInput(draft: PolicyDraft): UpdateDomainSignatureInput {
  return {
    enabled: draft.enabled,
    template: draft.template,
    company: orNull(draft.company),
    website: orNull(draft.website),
    logoUrl: orNull(draft.logoUrl),
    locked: draft.locked,
    enforceServerSide: draft.enforceServerSide,
    externalOnly: draft.externalOnly,
    newMessagesOnly: draft.newMessagesOnly,
    senderListMode: draft.senderListMode,
    senderList: parseSenderList(draft.senderList),
    complianceEnabled: draft.complianceEnabled,
    complianceText: draft.complianceText,
  };
}

export function sameDraft(a: PolicyDraft, b: PolicyDraft): boolean {
  return JSON.stringify({ ...a, senderList: parseSenderList(a.senderList) }) === JSON.stringify({ ...b, senderList: parseSenderList(b.senderList) });
}
