"use client";

import { fetchAPI } from "@/lib/api";

export function usePasswordReset() {
  const requestReset = (email: string) =>
    fetchAPI<{ message: string }>("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  const resetPassword = (token: string, newPassword: string) =>
    fetchAPI<{ message: string }>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, newPassword }),
    });
  return { requestReset, resetPassword };
}
