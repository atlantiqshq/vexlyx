import { z } from "zod";
import { isSafeLogoUrl, validateSignatureTemplate } from "./render.js";

export const SIGNATURE_TEMPLATE_MAX = 4000;
export const SIGNATURE_NOTICE_MAX = 2000;
export const SIGNATURE_BANNER_MAX = 500;
export const SIGNATURE_VERSIONS_KEPT = 20;
export const SIGNATURE_LOGO_MAX_BYTES = 200 * 1024;

const template = (max: number) =>
  z.string().superRefine((value, ctx) => {
    for (const message of validateSignatureTemplate(value, max)) {
      ctx.addIssue({ code: "custom", message });
    }
  });

const SingleLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "Must be a single line of text");

const optionalLine = (max: number) =>
  z
    .union([SingleLine(max), z.null()])
    .optional()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value));

const phone = z
  .union([z.string().trim().max(40).regex(/^[0-9+().\-\s/xX]*$/, "Use digits and + ( ) - . only"), z.null()])
  .optional()
  .transform((value) => (value === undefined || value === null || value === "" ? null : value));

const website = z
  .union([
    z
      .string()
      .trim()
      .max(200)
      .regex(/^(https:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(\/[^\s<>"'`]*)?$/, "Enter a web address like example.com"),
    z.null(),
  ])
  .optional()
  .transform((value) => (value === undefined || value === null || value === "" ? null : value));

const logoUrl = z
  .union([
    z
      .string()
      .trim()
      .max(2000)
      .refine(isSafeLogoUrl, "The logo must be an https:// image address"),
    z.null(),
  ])
  .optional()
  .transform((value) => (value === undefined || value === null || value === "" ? null : value));

export const SignatureModeSchema = z.enum(["INHERIT", "CUSTOM", "NONE"]);
export const SignatureSenderListModeSchema = z.enum(["ALL", "ONLY_LISTED", "EXCEPT_LISTED"]);
export type SignatureMode = z.infer<typeof SignatureModeSchema>;
export type SignatureSenderListMode = z.infer<typeof SignatureSenderListModeSchema>;

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

export const MailboxProfileSchema = z.object({
  displayName: optionalLine(100),
  title: optionalLine(100),
  department: optionalLine(100),
  phone,
  mobile: phone,
});
export type MailboxProfile = z.infer<typeof MailboxProfileSchema>;

export const UpdateMailboxSignatureSchema = MailboxProfileSchema.extend({
  mode: SignatureModeSchema,
  template: template(SIGNATURE_TEMPLATE_MAX).nullish(),
  groupId: z.string().min(1).nullish(),
}).superRefine((value, ctx) => {
  if (value.mode === "CUSTOM" && !value.template?.trim()) {
    ctx.addIssue({ code: "custom", path: ["template"], message: "A custom signature needs a template" });
  }
});
export type UpdateMailboxSignatureInput = z.input<typeof UpdateMailboxSignatureSchema>;

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

const senderAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a full mailbox address");

export const DomainSignaturePolicySchema = z.object({
  enabled: z.boolean(),
  template: template(SIGNATURE_TEMPLATE_MAX),
  company: optionalLine(100),
  website,
  logoUrl,
  locked: z.boolean(),
  enforceServerSide: z.boolean(),
  externalOnly: z.boolean(),
  newMessagesOnly: z.boolean(),
  senderListMode: SignatureSenderListModeSchema,
  senderList: z.array(senderAddress).max(500).transform((list) => [...new Set(list)]),
  complianceEnabled: z.boolean(),
  complianceText: template(SIGNATURE_NOTICE_MAX),
});
export type DomainSignaturePolicy = z.infer<typeof DomainSignaturePolicySchema>;
export type UpdateDomainSignatureInput = z.input<typeof DomainSignaturePolicySchema>;

export const SignatureGroupSchema = z.object({
  name: z.string().trim().min(1).max(60),
  template: template(SIGNATURE_TEMPLATE_MAX),
});
export type SignatureGroupInput = z.input<typeof SignatureGroupSchema>;

const bannerText = template(SIGNATURE_BANNER_MAX).refine((value) => value.trim() !== "", "Banner text is required");

export const SignatureBannerSchema = z
  .object({
    groupId: z.string().min(1).nullish(),
    text: bannerText,
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    enabled: z.boolean().default(true),
  })
  .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
    message: "The end must be after the start",
    path: ["endsAt"],
  });
export type SignatureBannerInput = z.input<typeof SignatureBannerSchema>;

export const SignatureBulkSchema = z
  .object({
    action: z.enum(["RESET_TO_DEFAULT", "ASSIGN_GROUP"]),
    groupId: z.string().min(1).nullish(),
    /** Count what would change without changing anything. */
    dryRun: z.boolean(),
  })
  .refine((value) => value.action !== "ASSIGN_GROUP" || value.groupId !== undefined, {
    message: "Choose a group (or none) to assign",
    path: ["groupId"],
  });
export type SignatureBulkInput = z.input<typeof SignatureBulkSchema>;

export const SIGNATURE_EXPORT_FORMAT = "vexlyx-signature-template";

export const SignatureExportSchema = z.object({
  format: z.literal(SIGNATURE_EXPORT_FORMAT),
  version: z.literal(1),
  policy: DomainSignaturePolicySchema.omit({ senderList: true, senderListMode: true }),
  groups: z.array(SignatureGroupSchema).max(50),
  banners: z
    .array(
      z.object({
        group: z.string().trim().min(1).max(60).nullish(),
        text: bannerText,
        startsAt: z.string().datetime({ offset: true }),
        endsAt: z.string().datetime({ offset: true }),
        enabled: z.boolean().default(true),
      }),
    )
    .max(50),
});
export type SignatureExport = z.infer<typeof SignatureExportSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type SignatureSource = "mailbox" | "group" | "domain" | "none";

export interface ResolvedSignatureResponse {
  source: SignatureSource;
  html: string | null;
  text: string | null;
}

export interface MailboxSignatureResponse {
  mailboxId: string;
  address: string;
  mode: SignatureMode;
  template: string | null;
  groupId: string | null;
  profile: MailboxProfile;
  /** The domain locks signatures, so custom templates are ignored and webmail can't edit them. */
  domainLocked: boolean;
  resolved: ResolvedSignatureResponse;
  /** Set when the change was saved but the mail servers could not be updated yet. */
  syncWarning?: string;
}

export interface SignatureVersionResponse {
  id: string;
  createdAt: string;
  createdByEmail: string | null;
}

export interface DomainSignatureResponse extends DomainSignaturePolicy {
  domainId: string;
  hostname: string;
  groups: Array<{ id: string; name: string; template: string; members: number }>;
  banners: Array<{
    id: string;
    groupId: string | null;
    text: string;
    startsAt: string;
    endsAt: string;
    enabled: boolean;
  }>;
  assets: Array<{ id: string; url: string; size: number; createdAt: string }>;
  /** Server-side enforcement can only run while the global switch is on. */
  enforcementAvailable: boolean;
  /** Set when the change was saved but the mail servers could not be updated yet. */
  syncWarning?: string;
}

export interface SignatureBulkResult {
  dryRun: boolean;
  /** Mailboxes whose settings would change (or did). */
  affected: number;
  total: number;
  /** Set when the change was saved but the mail servers could not be updated yet. */
  syncWarning?: string;
}

export interface SignatureEnforcementStatus {
  enabled: boolean;
  stats: {
    modified: number;
    skipped: Record<string, number>;
    failed: number;
    since: string | null;
  } | null;
}

/** Contents of the per-mailbox JSON file the Roundcube plugin and the mail-server filter read. */
export interface SignatureFile {
  v: 1;
  address: string;
  /** Changes whenever anything in the file changes. */
  version: string;
  updatedAt: string;
  marker: string;
  locked: boolean;
  enforceServerSide: boolean;
  signature: { html: string; text: string } | null;
  compliance: { html: string; text: string } | null;
  banners: Array<{ html: string; text: string; startsAt: string; endsAt: string }>;
  rules: { externalOnly: boolean; newMessagesOnly: boolean };
  /** Domains whose recipients count as internal for the externalOnly rule. */
  internalDomains: string[];
}
