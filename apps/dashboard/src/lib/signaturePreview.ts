import {
  composeSignature,
  renderNoticeBlock,
  renderSignatureTemplate,
  type DomainSignatureResponse,
  type RenderedBlock,
  type SignatureMode,
  type SignatureVars,
} from "@vexlyx/shared";

export interface PreviewBanner {
  text: string;
  startsAt: string;
  endsAt: string;
  enabled: boolean;
  groupId: string | null;
}

export interface PreviewDomain {
  template: string;
  company: string | null;
  website: string | null;
  logoUrl: string | null;
  locked: boolean;
  complianceEnabled: boolean;
  complianceText: string;
  groups: Array<{ id: string; template: string }>;
  banners: PreviewBanner[];
}

export interface PreviewMailbox {
  address: string;
  mode: SignatureMode;
  template: string | null;
  groupId: string | null;
  displayName: string | null;
  title: string | null;
  department: string | null;
  phone: string | null;
  mobile: string | null;
}

/**
 * What a mailbox's signature will look like, drawn with the same renderer the server uses,
 * so the preview shows edits before they are saved. It does not know about the sender list or
 * a switched-off domain: the dialog shows what the server last resolved for those.
 */
export function previewMailboxSignature(domain: PreviewDomain, mailbox: PreviewMailbox, now: Date = new Date()): RenderedBlock | null {
  const vars: SignatureVars = {
    name: mailbox.displayName,
    title: mailbox.title,
    department: mailbox.department,
    phone: mailbox.phone,
    mobile: mailbox.mobile,
    email: mailbox.address,
    company: domain.company,
    website: domain.website,
  };

  const mode = domain.locked ? "INHERIT" : mailbox.mode;
  let personal: RenderedBlock | null = null;
  if (mode !== "NONE") {
    const group = domain.groups.find((g) => g.id === mailbox.groupId);
    const template =
      mode === "CUSTOM" ? (mailbox.template ?? "") : group && group.template.trim() !== "" ? group.template : domain.template;
    personal = renderSignatureTemplate(template, vars, { logoUrl: domain.logoUrl, logoAlt: domain.company });
  }

  const banners = personal
    ? domain.banners
        .filter(
          (banner) =>
            banner.enabled &&
            (banner.groupId === null || banner.groupId === mailbox.groupId) &&
            new Date(banner.startsAt) <= now &&
            now < new Date(banner.endsAt),
        )
        .flatMap((banner) => renderNoticeBlock(banner.text, vars, "banner") ?? [])
    : [];
  const compliance = domain.complianceEnabled ? renderNoticeBlock(domain.complianceText, vars, "compliance") : null;

  return composeSignature({ signature: personal, banners, compliance });
}

/** Adapts the domain response to what the preview needs. */
export function toPreviewDomain(domain: DomainSignatureResponse): PreviewDomain {
  return {
    template: domain.template,
    company: domain.company,
    website: domain.website,
    logoUrl: domain.logoUrl,
    locked: domain.locked,
    complianceEnabled: domain.complianceEnabled,
    complianceText: domain.complianceText,
    groups: domain.groups.map((group) => ({ id: group.id, template: group.template })),
    banners: domain.banners,
  };
}

/** A document for the sandboxed preview frame. The signature HTML is produced by the shared renderer, which escapes all input. */
export function previewDocument(html: string, dark: boolean): string {
  const background = dark ? "#0f172a" : "#ffffff";
  const colour = dark ? "#e2e8f0" : "#0f172a";
  return `<!doctype html><meta charset="utf-8"><body style="margin:12px;background:${background};color:${colour};font:14px Arial,Helvetica,sans-serif">${html}</body>`;
}
