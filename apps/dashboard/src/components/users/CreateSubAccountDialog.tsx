"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MIN_PASSWORD_LENGTH } from "@vexlyx/shared";
import type { CreateSubAccountInput, Role } from "@vexlyx/shared";

interface CreateSubAccountDialogProps {
  isAdmin: boolean;
  onCreate: (input: CreateSubAccountInput) => Promise<void>;
  isCreating: boolean;
  /** True when the requester (reseller) is at their maxSubAccounts limit. */
  disabled?: boolean;
}

const DEFAULTS = { name: "", email: "", password: "", role: "USER" as Role };

export function CreateSubAccountDialog({ isAdmin, onCreate, isCreating, disabled }: CreateSubAccountDialogProps) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(DEFAULTS);

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.email.trim() || form.password.length < MIN_PASSWORD_LENGTH) return;

    try {
      await onCreate({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        ...(isAdmin ? { role: form.role } : {}),
      });
      setForm(DEFAULTS);
      setOpen(false);
    } catch {
      // Error toast already surfaced by useUsers; keep the dialog open so the user can adjust and retry.
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={disabled}
          title={disabled ? "You've reached your sub-account limit" : undefined}
        >
          <Plus className="h-3.5 w-3.5" />
          {isAdmin ? "New User" : "New Sub-account"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isAdmin ? "Create user" : "Create sub-account"}</DialogTitle>
          <DialogDescription>
            {isAdmin
              ? "Creates a new account directly, with the role you choose below."
              : "Creates a regular user account under your reseller account, subject to your sub-account quota."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isAdmin && (
            <div className="space-y-1.5">
              <Label htmlFor="user-role">Role</Label>
              <Select value={form.role} onValueChange={(v: Role) => setForm((f) => ({ ...f, role: v }))}>
                <SelectTrigger id="user-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">User</SelectItem>
                  <SelectItem value="RESELLER">Reseller</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="sub-name">Name</Label>
            <Input
              id="sub-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Jane Doe"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sub-email">Email</Label>
            <Input
              id="sub-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="jane@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sub-password">Password</Label>
            <Input
              id="sub-password"
              type="password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={isCreating}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={isCreating || !form.name || !form.email || form.password.length < MIN_PASSWORD_LENGTH}
          >
            {isCreating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
