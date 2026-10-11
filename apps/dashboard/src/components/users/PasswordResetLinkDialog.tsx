"use client";

import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AdminPasswordResetResult } from "@vexlyx/shared";

interface PasswordResetLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userName: string;
  result: AdminPasswordResetResult | null;
}

export function PasswordResetLinkDialog({ open, onOpenChange, userName, result }: PasswordResetLinkDialogProps) {
  const handleCopy = () => {
    if (!result?.resetUrl) return;
    navigator.clipboard
      .writeText(result.resetUrl)
      .then(() => toast.success("Reset link copied"))
      .catch(() => toast.error("Could not copy — select the link and copy it manually"));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reset link for {userName}</DialogTitle>
          <DialogDescription>
            Panel email isn&apos;t set up, so the link can&apos;t be sent for you. Share it with {userName} through a
            channel you trust. It works once
            {result ? ` and expires ${new Date(result.expiresAt).toLocaleString()}` : ""}, and this is the only
            time it is shown.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="reset-link">Single-use link</Label>
          <div className="flex gap-2">
            <Input id="reset-link" readOnly value={result?.resetUrl ?? ""} className="font-mono text-xs" />
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={handleCopy}>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
