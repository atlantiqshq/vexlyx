"use client";

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  UserResponse,
  CreateSubAccountInput,
  UpdateUserRoleInput,
  UpdateUserQuotasInput,
  UpdateUserPermissionsInput,
  AdminPasswordResetResult,
} from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// API client helpers
// ---------------------------------------------------------------------------

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

async function extractError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

async function fetchUsers(): Promise<UserResponse[]> {
  const res = await fetch(`${API_URL}/api/users`, { credentials: "include" });
  if (!res.ok) throw new Error(await extractError(res, "Failed to fetch users"));
  return res.json() as Promise<UserResponse[]>;
}

async function createSubAccount(input: CreateSubAccountInput): Promise<void> {
  const res = await fetch(`${API_URL}/api/users`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await extractError(res, "Failed to create sub-account"));
}

async function updateUserRole(id: string, input: UpdateUserRoleInput): Promise<void> {
  const res = await fetch(`${API_URL}/api/users/${id}/role`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await extractError(res, "Failed to update role"));
}

async function updateUserQuotas(id: string, input: UpdateUserQuotasInput): Promise<void> {
  const res = await fetch(`${API_URL}/api/users/${id}/quotas`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await extractError(res, "Failed to update quotas"));
}

async function updateUserPermissions(id: string, input: UpdateUserPermissionsInput): Promise<void> {
  const res = await fetch(`${API_URL}/api/users/${id}/permissions`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await extractError(res, "Failed to update permissions"));
}

async function issuePasswordReset(id: string): Promise<AdminPasswordResetResult> {
  const res = await fetch(`${API_URL}/api/users/${id}/password-reset`, { method: "POST", credentials: "include" });
  if (!res.ok) throw new Error(await extractError(res, "Failed to create a reset link"));
  return res.json() as Promise<AdminPasswordResetResult>;
}

async function deleteUser(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/users/${id}`, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new Error(await extractError(res, "Failed to delete user"));
}

// ---------------------------------------------------------------------------
// useUsers
// ---------------------------------------------------------------------------

export function useUsers() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["users"],
    queryFn: fetchUsers,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const createMutation = useMutation({
    mutationFn: createSubAccount,
    onSuccess: () => {
      toast.success("Sub-account created");
      void invalidate();
    },
    onError: (err: Error) => toast.error("Failed to create sub-account", { description: err.message }),
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserRoleInput }) => updateUserRole(id, input),
    onSuccess: () => {
      toast.success("Role updated");
      void invalidate();
    },
    onError: (err: Error) => toast.error("Failed to update role", { description: err.message }),
  });

  const quotasMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserQuotasInput }) => updateUserQuotas(id, input),
    onSuccess: () => {
      toast.success("Quotas updated");
      void invalidate();
    },
    onError: (err: Error) => toast.error("Failed to update quotas", { description: err.message }),
  });

  const permissionsMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserPermissionsInput }) =>
      updateUserPermissions(id, input),
    onSuccess: () => {
      toast.success("Permissions updated");
      void invalidate();
    },
    onError: (err: Error) => toast.error("Failed to update permissions", { description: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => {
      toast.success("User deleted");
      void invalidate();
    },
    onError: (err: Error) => toast.error("Failed to delete user", { description: err.message }),
  });

  return {
    users: query.data ?? [],
    isLoading: query.isLoading,
    createSubAccount: (input: CreateSubAccountInput) => createMutation.mutateAsync(input),
    isCreating: createMutation.isPending,
    updateRole: (id: string, input: UpdateUserRoleInput) => roleMutation.mutateAsync({ id, input }),
    updateQuotas: (id: string, input: UpdateUserQuotasInput) => quotasMutation.mutateAsync({ id, input }),
    isSavingQuotas: quotasMutation.isPending,
    updatePermissions: (id: string, input: UpdateUserPermissionsInput) =>
      permissionsMutation.mutateAsync({ id, input }),
    deleteUser: (id: string) => deleteMutation.mutate(id),
    issuePasswordReset,
  };
}
