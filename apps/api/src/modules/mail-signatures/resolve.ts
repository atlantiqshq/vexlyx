import { createHash } from "node:crypto";
import {
  composeSignature,
  renderNoticeBlock,
  renderSignatureTemplate,
  type RenderedBlock,
  type SignatureFile,
  type SignatureMode,
  type SignatureSenderListMode,
  type SignatureSource,
  type SignatureVars,
} from "@vexlyx/shared";

// Pure functions: which signature a mailbox gets and what the mail layers are told.
// Nothing here touches the database, so every rule is covered by unit tests.

export interface DomainPolicy {
  hostname: string;
  enabled: boolean;
  template: string;
  company: string | null;
  website: string | null;
  logoUrl: string | null;
  locked: boolean;
  enforceServerSide: boolean;
  externalOnly: boolean;
  newMessagesOnly: boolean;
  senderListMode: SignatureSenderListMode;
  senderList: string[];
  complianceEnabled: boolean;
  complianceText: string;
}

export interface MailboxSettings {
  mode: SignatureMode;
  template: string | null;
  groupId: string | null;
  displayName: string | null;
  title: string | null;
  department: string | null;
  phone: string | null;
  mobile: string | null;
}

export interface GroupSettings {
  id: string;
  name: string;
  template: string;
}

export interface BannerSettings {
  groupId: string | null;
  text: string;
  startsAt: Date;
  endsAt: Date;
  enabled: boolean;
}

export function defaultDomainPolicy(hostname: string): DomainPolicy {
  return {
    hostname,
    enabled: true,
    template: "",
    company: null,
    website: null,
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
}

export const DEFAULT_MAILBOX_SETTINGS: MailboxSettings = {
  mode: "INHERIT",
  template: null,
  groupId: null,
  displayName: null,
  title: null,
  department: null,
  phone: null,
  mobile: null,
};

export interface Resolution {
  source: SignatureSource;
  personal: RenderedBlock | null;
  compliance: RenderedBlock | null;
  banners: Array<{ block: RenderedBlock; startsAt: Date; endsAt: Date }>;
}

interface ResolveInput {
  address: string;
  domain: DomainPolicy;
  mailbox: MailboxSettings;
  group: GroupSettings | null;
  banners: BannerSettings[];
}

/** Short stable token that identifies a sender's signature inside a message without exposing the address. */
export function markerFor(address: string): string {
  return createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 12);
}

export function variablesFor(address: string, domain: DomainPolicy, mailbox: MailboxSettings): SignatureVars {
  return {
    name: mailbox.displayName,
    title: mailbox.title,
    department: mailbox.department,
    phone: mailbox.phone,
    mobile: mailbox.mobile,
    email: address,
    company: domain.company,
    website: domain.website,
  };
}

function isExcluded(address: string, domain: DomainPolicy): boolean {
  const listed = domain.senderList.includes(address.toLowerCase());
  if (domain.senderListMode === "ONLY_LISTED") return !listed;
  if (domain.senderListMode === "EXCEPT_LISTED") return listed;
  return false;
}

const EMPTY: Resolution = { source: "none", personal: null, compliance: null, banners: [] };

/**
 * Decides which template applies and renders it.
 *
 * - A disabled domain, or a sender the sender list leaves out, gets nothing.
 * - When the domain is locked every mailbox follows the domain (or its group): its own
 *   template and "no signature" choice are ignored, but its profile still fills the variables.
 * - Otherwise: the mailbox's own template, else its group's, else the domain's.
 * - Banners are part of the signature, so they only appear with one.
 *   The legal footer is separate and appears either way.
 */
export function resolveSignature({ address, domain, mailbox, group, banners }: ResolveInput): Resolution {
  if (!domain.enabled || isExcluded(address, domain)) return EMPTY;

  const vars = variablesFor(address, domain, mailbox);
  const mode: SignatureMode = domain.locked ? "INHERIT" : mailbox.mode;

  let source: SignatureSource = "none";
  let personal: RenderedBlock | null = null;

  if (mode !== "NONE") {
    let template: string;
    if (mode === "CUSTOM") {
      template = mailbox.template ?? "";
      source = "mailbox";
    } else if (group && group.template.trim() !== "") {
      template = group.template;
      source = "group";
    } else {
      template = domain.template;
      source = "domain";
    }
    personal = renderSignatureTemplate(template, vars, {
      logoUrl: domain.logoUrl,
      logoAlt: domain.company,
      marker: markerFor(address),
    });
    if (!personal) source = "none";
  }

  const compliance = domain.complianceEnabled ? renderNoticeBlock(domain.complianceText, vars, "compliance") : null;

  const rendered = personal
    ? banners
        .filter((banner) => banner.enabled && (banner.groupId === null || banner.groupId === group?.id))
        .flatMap((banner) => {
          const block = renderNoticeBlock(banner.text, vars, "banner");
          return block ? [{ block, startsAt: banner.startsAt, endsAt: banner.endsAt }] : [];
        })
    : [];

  return { source, personal, compliance, banners: rendered };
}

/** The signature as it would be sent at `now`: only banners inside their window are included. */
export function composeAt(resolution: Resolution, now: Date): RenderedBlock | null {
  return composeSignature({
    signature: resolution.personal,
    banners: resolution.banners
      .filter((banner) => banner.startsAt <= now && now < banner.endsAt)
      .map((banner) => banner.block),
    compliance: resolution.compliance,
  });
}

/**
 * The JSON file the Roundcube plugin and the mail-server filter read, or null when this
 * sender has nothing to add (the file is then removed). Banners that have already ended
 * are left out; ones that haven't started yet are kept with their dates, so the readers
 * switch them on and off without anyone re-syncing.
 */
export function buildSignatureFile(
  input: ResolveInput & { internalDomains: string[]; now: Date },
): SignatureFile | null {
  const resolution = resolveSignature(input);
  if (!resolution.personal && !resolution.compliance) return null;

  const { domain, address } = input;
  const content: Omit<SignatureFile, "version" | "updatedAt"> = {
    v: 1,
    address: address.toLowerCase(),
    marker: markerFor(address),
    locked: domain.locked,
    enforceServerSide: domain.enforceServerSide,
    signature: resolution.personal,
    compliance: resolution.compliance,
    banners: resolution.banners
      .filter((banner) => banner.endsAt > input.now)
      .map((banner) => ({
        html: banner.block.html,
        text: banner.block.text,
        startsAt: banner.startsAt.toISOString(),
        endsAt: banner.endsAt.toISOString(),
      })),
    rules: { externalOnly: domain.externalOnly, newMessagesOnly: domain.newMessagesOnly },
    internalDomains: [...new Set(input.internalDomains.map((d) => d.toLowerCase()))].sort(),
  };

  const version = createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
  return { ...content, version, updatedAt: input.now.toISOString() };
}
