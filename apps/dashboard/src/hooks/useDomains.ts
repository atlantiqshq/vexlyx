"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { useRefreshAnimation } from "@/hooks/useRefreshAnimation";
import type {
  DomainResponse,
  CreateDomainInput,
  UpdateDomainInput,
  DomainVerificationResult,
} from "@vexlyx/shared";

interface UseDomainsOptions {
  projectId?: string;
  parentId?: string;
  rootOnly?: boolean;
  autoFetch?: boolean;
}

export function useDomains(options: UseDomainsOptions = {}) {
  const { projectId, parentId, rootOnly, autoFetch = true } = options;
  const [domains, setDomains] = useState<DomainResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { isRefreshing, refresh: runRefresh } = useRefreshAnimation();
  const [error, setError] = useState<string | null>(null);

  const fetchDomains = useCallback(
    async (quiet = false) => {
      if (!quiet) setIsLoading(true);
      setError(null);

      try {
        const queryParams = new URLSearchParams();
        if (projectId) queryParams.append("projectId", projectId);
        if (parentId) queryParams.append("parentId", parentId);
        if (rootOnly !== undefined) queryParams.append("rootOnly", String(rootOnly));

        const url = `/api/domains${queryParams.toString() ? `?${queryParams.toString()}` : ""}`;
        const data = await fetchAPI<DomainResponse[]>(url);
        setDomains(data ?? []);
      } catch (err) {
        const message =
          err instanceof ApiRequestError ? err.message : "Failed to load custom domains";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, parentId, rootOnly],
  );


  useEffect(() => {
    if (autoFetch) {
      void fetchDomains();
    }
  }, [autoFetch, fetchDomains]);

  const refresh = async () => {
    await runRefresh(() => fetchDomains(true));
  };

  const createDomain = async (input: CreateDomainInput): Promise<DomainResponse> => {
    const created = await fetchAPI<DomainResponse>("/api/domains", {
      method: "POST",
      body: JSON.stringify(input),
    });

    setDomains((prev) => [created, ...prev]);
    return created;
  };

  const updateDomain = async (id: string, input: UpdateDomainInput): Promise<DomainResponse> => {
    const updated = await fetchAPI<DomainResponse>(`/api/domains/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    await fetchDomains(true);
    return updated;
  };

  const verifyDomain = async (
    id: string,
    mockRecord?: string,
  ): Promise<DomainVerificationResult> => {
    const query = mockRecord ? `?mockRecord=${encodeURIComponent(mockRecord)}` : "";
    const result = await fetchAPI<DomainVerificationResult>(`/api/domains/${id}/verify${query}`, {
      method: "POST",
    });

    // Update local domain status
    setDomains((prev) =>
      prev.map((d) => (d.id === id ? { ...d, status: result.status } : d)),
    );

    return result;
  };

  const deleteDomain = async (id: string): Promise<void> => {
    await fetchAPI(`/api/domains/${id}`, {
      method: "DELETE",
    });

    setDomains((prev) => prev.filter((d) => d.id !== id));
  };

  const fetchSubdomains = async (parentDomainId: string): Promise<DomainResponse[]> => {
    return await fetchAPI<DomainResponse[]>(`/api/domains/${parentDomainId}/subdomains`);
  };

  return {
    domains,
    isLoading,
    isRefreshing,
    error,
    refetch: () => fetchDomains(),
    refresh,
    createDomain,
    updateDomain,
    verifyDomain,
    deleteDomain,
    fetchSubdomains,
  };
}

