import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums (mirrors Prisma DomainStatus)
// ---------------------------------------------------------------------------

export const DomainStatusSchema = z.enum(["PENDING", "ACTIVE", "ERROR"]);
export type DomainStatus = z.infer<typeof DomainStatusSchema>;

export const DnsModeSchema = z.enum(["CONNECTED", "MANAGED"]);
export type DnsMode = z.infer<typeof DnsModeSchema>;

export const SetDnsModeSchema = z.object({
  mode: DnsModeSchema,
  // Load the zone before nameservers are switched, so a live domain has no
  // gap between delegation and the zone existing (F5.27).
  skipDelegationCheck: z.boolean().optional(),
});
export type SetDnsModeInput = z.infer<typeof SetDnsModeSchema>;

export interface DnsDelegationCheckResponse {
  delegated: boolean;
  found: string[];
  expected: string[];
}

// ---------------------------------------------------------------------------
// Hostname validator & helpers
// ---------------------------------------------------------------------------

/**
 * Validates a Fully Qualified Domain Name (FQDN) according to RFC 1123,
 * with support for wildcard subdomains (e.g. *.example.com).
 * Accepts standard domains and subdomains (e.g. example.com, app.example.com, test.co.uk).
 * Forbids protocols, paths, ports, IP addresses, and invalid characters.
 */
export const HostnameSchema = z
  .string()
  .min(3, "Hostname must be at least 3 characters")
  .max(253, "Hostname cannot exceed 253 characters")
  .toLowerCase()
  .trim()
  .refine((val) => !val.includes("://"), {
    message: "Do not include http:// or https:// in hostname",
  })
  .refine((val) => !val.includes("/") && !val.includes(":") && !val.includes(" "), {
    message: "Hostname cannot contain slashes, ports, or whitespace",
  })
  .refine(
    (val) => {
      // Regex for valid domain labels separated by dots
      const fqdnRegex =
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

      // Wildcard validation: must start with `*.` followed by a valid FQDN
      if (val.startsWith("*.")) {
        const remaining = val.slice(2);
        // Wildcard must have at least one dot in remaining (e.g. *.example.com, not *.com)
        if (!remaining.includes(".") || remaining.includes("*")) {
          return false;
        }
        return fqdnRegex.test(remaining);
      }

      return fqdnRegex.test(val);
    },
    {
      message:
        "Must be a valid domain or subdomain (e.g. example.com, app.example.com, or *.example.com)",
    },
  );

/**
 * Checks if a given hostname is a wildcard subdomain (starts with *.).
 */
export function isWildcardHostname(hostname: string): boolean {
  return hostname.startsWith("*.");
}

/**
 * Extracts base/parent domain if the hostname is a subdomain, or null if it's already an apex domain.
 * Handles wildcards (*.domain.com -> domain.com) and common multi-part TLDs.
 */
export function getParentDomain(hostname: string): string | null {
  const clean = hostname.toLowerCase().trim();
  const isWild = clean.startsWith("*.");
  const stripped = isWild ? clean.slice(2) : clean;
  const parts = stripped.split(".");

  if (parts.length <= 2) {
    if (isWild && parts.length === 2) {
      return stripped;
    }
    return null;
  }

  // Common second-level TLDs (e.g., co.uk, com.au)
  const secondLevelTlds = ["co.uk", "com.au", "co.nz", "co.jp", "com.br", "org.uk", "gov.uk"];
  const lastTwo = parts.slice(-2).join(".");

  if (secondLevelTlds.includes(lastTwo)) {
    if (parts.length > 3) {
      return parts.slice(1).join(".");
    }
    return isWild ? stripped : null;
  }

  return parts.slice(1).join(".");
}


/**
 * Checks if a hostname represents a subdomain or wildcard.
 */
export function isSubdomain(hostname: string): boolean {
  if (isWildcardHostname(hostname)) return true;
  return getParentDomain(hostname) !== null;
}

// ---------------------------------------------------------------------------
// Create Domain
// ---------------------------------------------------------------------------

export const CreateDomainSchema = z.object({
  hostname: HostnameSchema,
  projectId: z.string().min(1, "Project ID is required").optional().nullable(),
  parentId: z.string().min(1).optional().nullable(),
  pathPrefix: z
    .string()
    .trim()
    .refine((val) => !val || val.startsWith("/"), {
      message: "Path prefix must start with a forward slash (e.g. /api)",
    })
    .optional()
    .nullable(),
});

export type CreateDomainInput = z.infer<typeof CreateDomainSchema>;

export const UpdateDomainSchema = z.object({
  projectId: z.string().min(1, "Project ID is required").nullable(),
}).strict();
export type UpdateDomainInput = z.infer<typeof UpdateDomainSchema>;

// ---------------------------------------------------------------------------
// List Query
// ---------------------------------------------------------------------------

export const DomainListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  projectId: z.string().optional(),
  status: DomainStatusSchema.optional(),
  search: z.string().max(100).optional(),
  parentId: z.string().optional(),
  rootOnly: z.coerce.boolean().optional(),
});

export type DomainListQuery = z.infer<typeof DomainListQuerySchema>;

// ---------------------------------------------------------------------------
// Verification instructions & result types
// ---------------------------------------------------------------------------

export interface DomainVerificationInstructions {
  recordType: "TXT";
  recordName: string;
  recordValue: string;
  // The A record needed to actually route traffic here once ownership is
  // verified — TXT verification alone proves ownership, it doesn't point
  // the domain at the server. publicIp is null if the server's public IP
  // hasn't been detected (mirrors DnsOnboardingInfoResponse, F5.9).
  routingRecord: {
    recordType: "A";
    recordName: string;
    publicIp: string | null;
  };
}

export interface DomainVerificationResult {
  verified: boolean;
  status: DomainStatus;
  message: string;
  expectedRecord: DomainVerificationInstructions;
  detectedRecords?: string[];
}

export interface DomainResponse {
  id: string;
  hostname: string;
  status: DomainStatus;
  dnsMode: DnsMode;
  sslEnabled: boolean;
  userId: string;
  projectId: string | null;
  parentId?: string | null;
  pathPrefix?: string | null;
  verificationToken: string | null;
  isWildcard?: boolean;
  subdomainCount?: number;
  subdomains?: DomainResponse[];
  parent?: {
    id: string;
    hostname: string;
    status: DomainStatus;
  } | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  project?: {
    id: string;
    name: string;
    type: string;
    status: string;
  } | null;
  verificationInstructions?: DomainVerificationInstructions;
  certificate?: import("./ssl.js").CertificateResponse | null;
  sslStatus?: import("./ssl.js").CertStatus;
}

