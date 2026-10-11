import { z } from "zod";
import {
  CreateDomainSchema,
  UpdateDomainSchema,
  DomainListQuerySchema,
  HostnameSchema,
  DomainStatusSchema,
  SetDnsModeSchema,
} from "@vexlyx/shared";

export { CreateDomainSchema, UpdateDomainSchema, DomainListQuerySchema, HostnameSchema, DomainStatusSchema, SetDnsModeSchema };

export const DomainIdParamSchema = z.object({
  id: z.string().min(1, "Domain ID is required"),
});

export type DomainIdParam = z.infer<typeof DomainIdParamSchema>;

export const DomainRecordParamSchema = z.object({
  id: z.string().min(1, "Domain ID is required"),
  recordId: z.string().min(1, "Record ID is required"),
});

export type DomainRecordParam = z.infer<typeof DomainRecordParamSchema>;

export const VerifyDomainQuerySchema = z.object({
  mockRecord: z.string().optional(),
  mock: z.enum(["true", "false"]).optional(),
});

export type VerifyDomainQuery = z.infer<typeof VerifyDomainQuerySchema>;

export {
  CreateDnsRecordSchema,
  UpdateDnsRecordSchema,
  ImportZoneFileSchema,
  DnsRecordTypeSchema,
} from "@vexlyx/shared";
export type {
  CreateDnsRecordInput,
  UpdateDnsRecordInput,
  ImportZoneFileInput,
  DnsRecordType,
  DnsRecordResponse,
  DnsPropagationResponse,
} from "@vexlyx/shared";

export {
  UploadCertificateSchema,
  ProvisionSslSchema,
  UpdateSslSettingsSchema,
  CertTypeSchema,
  CertStatusSchema,
} from "@vexlyx/shared";
export type {
  UploadCertificateInput,
  ProvisionSslInput,
  UpdateSslSettingsInput,
  CertType,
  CertStatus,
  CertificateResponse,
} from "@vexlyx/shared";

