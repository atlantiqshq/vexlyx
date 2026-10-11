"use client";

import { fetchAPI } from "@/lib/api";

export function useTwoFactor() {
  const setup = () =>
    fetchAPI<{ otpauthUrl: string; qrDataUrl: string; manualKey: string }>(
      "/api/auth/2fa/setup",
      { method: "POST" },
    );
  const confirm = (code: string) =>
    fetchAPI<{ recoveryCodes: string[] }>("/api/auth/2fa/verify-setup", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  const disable = (password: string, codeOrRecovery: string) =>
    fetchAPI<{ message: string }>("/api/auth/2fa/disable", {
      method: "POST",
      body: JSON.stringify({ password, codeOrRecovery }),
    });
  const adminReset = (userId: string) =>
    fetchAPI<{ message: string }>(`/api/users/${userId}/2fa/reset`, {
      method: "POST",
    });
  return { setup, confirm, disable, adminReset };
}
