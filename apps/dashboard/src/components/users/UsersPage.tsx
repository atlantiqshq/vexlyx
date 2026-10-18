"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { useTwoFactor } from "@/hooks/useTwoFactor";
import { useUsers } from "@/hooks/useUsers";
import { useUsage } from "@/hooks/useUsage";
import { QuotaBadge, isQuotaAtLimit } from "@/components/quota/QuotaBadge";
import { UserList } from "./UserList";
import { CreateSubAccountDialog } from "./CreateSubAccountDialog";
import { EditUserDialog } from "./EditUserDialog";
import { DeleteUserConfirmDialog } from "./DeleteUserConfirmDialog";
import type { UserResponse } from "@vexlyx/shared";

/**
 * Web-based user & role management (F5.5). ADMIN sees and manages every
 * account; RESELLER sees only themselves and their own sub-accounts and can
 * create new ones (capped by their maxSubAccounts quota).
 */
export function UsersPage() {
  const { user, isLoading: isAuthLoading } = useAuth();
  const {
    users,
    isLoading,
    updateRole,
    updateQuotas,
    isSavingQuotas,
    updatePermissions,
    deleteUser,
    createSubAccount,
    isCreating,
  } = useUsers();
  const { usage, isLoading: isUsageLoading } = useUsage();
  const { adminReset } = useTwoFactor();
  const [editTarget, setEditTarget] = useState<UserResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserResponse | null>(null);

  if (isAuthLoading) return null;

  if (user?.role !== "ADMIN" && user?.role !== "RESELLER") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <ShieldAlert className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">Access restricted</p>
          <p className="text-xs text-muted-foreground">
            Only administrators and resellers can manage users.
          </p>
        </CardContent>
      </Card>
    );
  }

  const isAdmin = user.role === "ADMIN";
  const isReseller = user.role === "RESELLER";

  const oversoldResources = isReseller
    ? (["project", "domain", "database", "mailbox"] as const)
        .filter((resource) => usage?.[resource]?.oversold)
        .map((resource) => ({ resource, ...usage![resource] }))
    : [];

  return (
    <div className="space-y-6">
      {oversoldResources.length > 0 && (
        <div className="rounded-lg border border-amber-600/30 bg-amber-600/5 p-4 dark:border-amber-400/30 dark:bg-amber-400/5">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
            You&apos;re in oversold territory
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Your sub-accounts&apos; nominal quotas exceed your own limit for:{" "}
            {oversoldResources
              .map(
                ({ resource, nominalSum, limit }) =>
                  `${resource}s (${nominalSum ?? "unlimited"} allocated vs. ${limit} limit)`,
              )
              .join(", ")}
            . Actual resource creation is still capped by your real limit.
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
          <p className="text-muted-foreground">
            {isAdmin
              ? "Manage every account, role, and resource quota on this panel."
              : "Manage your sub-accounts and their resource quotas."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!isAdmin && (
            <QuotaBadge label="Sub-accounts" usage={usage?.subAccount} isLoading={isUsageLoading} />
          )}
          <CreateSubAccountDialog
            isAdmin={isAdmin}
            onCreate={createSubAccount}
            isCreating={isCreating}
            disabled={!isAdmin && isQuotaAtLimit(usage?.subAccount)}
          />
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">
            {isAdmin ? "All users" : "Your sub-accounts"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <UserList
            users={users}
            isLoading={isLoading}
            currentUserId={user.id}
            isAdmin={isAdmin}
            onEdit={setEditTarget}
            onDelete={setDeleteTarget}
          />
        </CardContent>
      </Card>

      <EditUserDialog
        user={editTarget}
        canEditRole={isAdmin && editTarget?.id !== user.id}
        isSelf={editTarget?.id === user.id}
        canReset2FA={isAdmin && editTarget?.id !== user.id}
        onOpenChange={(open) => !open && setEditTarget(null)}
        isSaving={isSavingQuotas}
        onSave={async (id, data) => {
          if (data.role) await updateRole(id, { role: data.role });
          await updateQuotas(id, data.quotas);
          if (data.permissions) await updatePermissions(id, { permissions: data.permissions });
          setEditTarget(null);
        }}
        onReset2FA={(id) => adminReset(id).then(() => undefined)}
      />

      <DeleteUserConfirmDialog
        user={deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteUser(deleteTarget.id);
        }}
      />
    </div>
  );
}
