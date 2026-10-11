"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAPI } from "@/lib/api";
import type { SystemEmailStatusResponse } from "@vexlyx/shared";

// F5.23 — ADMIN-only on the API side, so `enabled` lets non-admins skip the
// request instead of triggering a guaranteed 403.
export function useSystemEmail(enabled: boolean) {
  const [status, setStatus] = useState<SystemEmailStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    try {
      setStatus(await fetchAPI<SystemEmailStatusResponse>("/api/system-email/status"));
    } catch {
      setStatus(null);
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sendTest = (to: string) =>
    fetchAPI<{ message: string }>("/api/system-email/test", {
      method: "POST",
      body: JSON.stringify({ to }),
    });

  return { status, isLoading, refresh, sendTest };
}
