"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { useRefreshAnimation } from "@/hooks/useRefreshAnimation";
import type { MailboxResponse, CreateMailboxInput, QuotaPreset } from "@vexlyx/shared";

export function useMailboxes() {
  const [mailboxes, setMailboxes] = useState<MailboxResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { isRefreshing, refresh: runRefresh } = useRefreshAnimation();
  const [error, setError] = useState<string | null>(null);

  const fetchMailboxes = useCallback(async () => {
    try {
      const data = await fetchAPI<{ mailboxes: MailboxResponse[] }>("/api/mailboxes");
      setMailboxes(data.mailboxes ?? []);
    } catch (err) {
      const msg = err instanceof ApiRequestError ? err.message : "Failed to load mailboxes";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await runRefresh(() => fetchMailboxes());
  }, [fetchMailboxes, runRefresh]);

  useEffect(() => {
    void fetchMailboxes();
  }, [fetchMailboxes]);

  const createMailbox = async (
    input: CreateMailboxInput,
  ): Promise<{ mailbox: MailboxResponse; password: string }> => {
    try {
      return await fetchAPI<{ mailbox: MailboxResponse; password: string }>(
        "/api/mailboxes", { method: "POST", body: JSON.stringify(input) },
      );
    } finally {
      await fetchMailboxes();
    }
  };

  const deleteMailbox = async (id: string): Promise<void> => {
    try {
      await fetchAPI(`/api/mailboxes/${id}`, { method: "DELETE" });
    } finally {
      await fetchMailboxes();
    }
  };

  const updateQuota = async (id: string, quota: QuotaPreset): Promise<void> => {
    try {
      await fetchAPI(`/api/mailboxes/${id}/quota`, {
        method: "PATCH", body: JSON.stringify({ quota }),
      });
    } finally {
      await fetchMailboxes();
    }
  };

  const resetPassword = async (id: string): Promise<{ password: string }> => {
    const result = await fetchAPI<{ password: string }>(`/api/mailboxes/${id}/reset-password`, {
      method: "POST",
    });
    return result;
  };

  return {
    mailboxes,
    isLoading,
    isRefreshing,
    error,
    refresh,
    createMailbox,
    deleteMailbox,
    updateQuota,
    resetPassword,
  };
}
