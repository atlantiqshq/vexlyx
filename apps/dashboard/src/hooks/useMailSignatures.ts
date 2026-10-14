"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, fetchAPI } from "@/lib/api";
import type {
  DomainSignatureResponse,
  MailboxSignatureResponse,
  SignatureBannerInput,
  SignatureBulkInput,
  SignatureBulkResult,
  SignatureEnforcementStatus,
  SignatureExport,
  SignatureGroupInput,
  SignatureVersionResponse,
  UpdateDomainSignatureInput,
  UpdateMailboxSignatureInput,
} from "@vexlyx/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Thin wrappers over the signature endpoints. Hooks below keep the latest response in state. */
export const signatureApi = {
  getMailbox: (mailboxId: string) => fetchAPI<MailboxSignatureResponse>(`/api/mailboxes/${mailboxId}/signature`),
  updateMailbox: (mailboxId: string, body: UpdateMailboxSignatureInput) =>
    fetchAPI<MailboxSignatureResponse>(`/api/mailboxes/${mailboxId}/signature`, json("PUT", body)),
  resetMailbox: (mailboxId: string) =>
    fetchAPI<MailboxSignatureResponse>(`/api/mailboxes/${mailboxId}/signature`, json("DELETE")),
  mailboxVersions: (mailboxId: string) =>
    fetchAPI<{ versions: SignatureVersionResponse[] }>(`/api/mailboxes/${mailboxId}/signature/versions`),
  restoreMailboxVersion: (mailboxId: string, versionId: string) =>
    fetchAPI<MailboxSignatureResponse>(`/api/mailboxes/${mailboxId}/signature/versions/${versionId}/restore`, json("POST")),
  sendTest: (mailboxId: string) => fetchAPI<{ sentTo: string }>(`/api/mailboxes/${mailboxId}/signature/test`, json("POST")),

  getDomain: (domainId: string) => fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature`),
  updateDomain: (domainId: string, body: UpdateDomainSignatureInput) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature`, json("PUT", body)),
  domainVersions: (domainId: string) =>
    fetchAPI<{ versions: SignatureVersionResponse[] }>(`/api/domains/${domainId}/mail-signature/versions`),
  restoreDomainVersion: (domainId: string, versionId: string) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature/versions/${versionId}/restore`, json("POST")),

  createGroup: (domainId: string, body: SignatureGroupInput) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature/groups`, json("POST", body)),
  updateGroup: (domainId: string, groupId: string, body: SignatureGroupInput) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature/groups/${groupId}`, json("PUT", body)),
  deleteGroup: (domainId: string, groupId: string) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature/groups/${groupId}`, json("DELETE")),

  createBanner: (domainId: string, body: SignatureBannerInput) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature/banners`, json("POST", body)),
  updateBanner: (domainId: string, bannerId: string, body: SignatureBannerInput) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature/banners/${bannerId}`, json("PUT", body)),
  deleteBanner: (domainId: string, bannerId: string) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature/banners/${bannerId}`, json("DELETE")),

  bulk: (domainId: string, body: SignatureBulkInput) =>
    fetchAPI<SignatureBulkResult>(`/api/domains/${domainId}/mail-signature/bulk`, json("POST", body)),
  exportDomain: (domainId: string) => fetchAPI<SignatureExport>(`/api/domains/${domainId}/mail-signature/export`),
  importDomain: (domainId: string, body: SignatureExport) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature/import`, json("POST", body)),

  deleteLogo: (domainId: string, assetId: string) =>
    fetchAPI<DomainSignatureResponse>(`/api/domains/${domainId}/mail-signature/logo/${assetId}`, json("DELETE")),

  /** Multipart upload, so it can't go through fetchAPI, which always sends a JSON content type with a body. */
  async uploadLogo(domainId: string, file: File): Promise<{ id: string; url: string; size: number; createdAt: string }> {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`${API_URL}/api/domains/${domainId}/mail-signature/logo`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
      throw new ApiRequestError(body?.error ?? "Could not upload the logo", body?.code ?? "UPLOAD_FAILED", response.status);
    }
    return response.json() as Promise<{ id: string; url: string; size: number; createdAt: string }>;
  },

  getEnforcement: () => fetchAPI<SignatureEnforcementStatus>("/api/mail-signatures/enforcement"),
  setEnforcement: (enabled: boolean) =>
    fetchAPI<SignatureEnforcementStatus & { syncWarning?: string }>("/api/mail-signatures/enforcement", json("PUT", { enabled })),
};

export const errorMessage = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

interface Loaded<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  /** Replaces the held data with a fresh server response. */
  set: (next: T) => void;
  reload: () => Promise<void>;
}

function useLoaded<T>(id: string | null, load: (id: string) => Promise<T>, failure: string): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    try {
      setData(await load(id));
    } catch (err) {
      setError(errorMessage(err, failure));
    } finally {
      setIsLoading(false);
    }
  }, [id, load, failure]);

  useEffect(() => {
    if (id) void reload();
    else {
      setData(null);
      setError(null);
    }
  }, [id, reload]);

  return { data, isLoading, error, set: setData, reload };
}

export function useMailboxSignature(mailboxId: string | null) {
  return useLoaded(mailboxId, signatureApi.getMailbox, "Could not load the signature");
}

export function useDomainSignature(domainId: string | null) {
  return useLoaded(domainId, signatureApi.getDomain, "Could not load the domain signature");
}
