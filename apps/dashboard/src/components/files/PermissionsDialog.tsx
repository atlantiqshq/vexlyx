"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { fetchAPI } from "@/lib/api";
import {
  PERMISSION_BITS,
  PERMISSION_CLASSES,
  describeMode,
  gridToOctal,
  isValidOctalMode,
  octalToGrid,
  toggleBit,
} from "@/lib/filePermissions";
import type { FileNode } from "@vexlyx/shared";

interface PermissionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  node: FileNode | null;
  onApplied: () => void;
}

export function PermissionsDialog({
  open,
  onOpenChange,
  projectId,
  node,
  onApplied,
}: PermissionsDialogProps) {
  const [octal, setOctal] = useState("644");
  const [applyToContents, setApplyToContents] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isDir = node?.type === "dir";
  const isValid = isValidOctalMode(octal);
  const grid = octalToGrid(octal);

  useEffect(() => {
    if (!open || !node) return;
    setOctal(node.mode ?? (node.type === "dir" ? "755" : "644"));
    setApplyToContents(false);
    setIsConfirming(false);
  }, [open, node]);

  const handleApply = async () => {
    if (!node || !isValid) return;
    setIsSubmitting(true);
    try {
      const result = await fetchAPI<{ mode: string; updated: number }>(
        `/api/files/${projectId}/chmod`,
        {
          method: "POST",
          body: JSON.stringify({ path: node.path, mode: octal, recursive: applyToContents }),
        },
      );
      toast.success(
        result.updated > 1
          ? `Permissions set to ${result.mode} on ${result.updated} items`
          : `Permissions set to ${result.mode}`,
      );
      onApplied();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change permissions");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePrimaryClick = () => {
    if (applyToContents && !isConfirming) {
      setIsConfirming(true);
      return;
    }
    void handleApply();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isConfirming ? "Apply to everything inside?" : "Permissions"}
          </DialogTitle>
          <DialogDescription>
            {isConfirming ? (
              <>
                This changes every file and folder inside{" "}
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">/{node?.path}</code>{" "}
                to <span className="font-mono">{octal}</span>. Symlinks are skipped, and files that are not
                already executable stay non-executable.
              </>
            ) : (
              <>
                Change who can read, write and execute{" "}
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">/{node?.path}</code>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!isConfirming && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border">
              <div className="grid grid-cols-4 gap-2 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                <span />
                {PERMISSION_BITS.map((bit) => (
                  <span key={bit} className="capitalize">
                    {bit}
                  </span>
                ))}
              </div>
              {PERMISSION_CLASSES.map((cls) => (
                <div key={cls} className="grid grid-cols-4 items-center gap-2 px-3 py-2">
                  <span className="text-xs font-medium capitalize">{cls}</span>
                  {PERMISSION_BITS.map((bit) => (
                    <Checkbox
                      key={bit}
                      checked={grid[cls][bit]}
                      onCheckedChange={(checked) =>
                        setOctal(gridToOctal(toggleBit(grid, cls, bit, checked === true)))
                      }
                      aria-label={`${cls} ${bit}`}
                      id={`perm-${cls}-${bit}`}
                    />
                  ))}
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="perm-octal" className="text-xs">
                  Octal
                </Label>
                <Input
                  id="perm-octal"
                  value={octal}
                  maxLength={3}
                  inputMode="numeric"
                  className="w-24 font-mono"
                  aria-invalid={!isValid}
                  onChange={(e) => setOctal(e.target.value.replace(/[^0-7]/g, ""))}
                />
              </div>
              <p className="pt-5 font-mono text-xs text-muted-foreground">
                {isValid ? describeMode(octal) : "Enter three digits, 0–7"}
              </p>
            </div>

            {isDir && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="perm-recursive"
                  checked={applyToContents}
                  onCheckedChange={(checked) => setApplyToContents(checked === true)}
                />
                <Label htmlFor="perm-recursive" className="text-xs leading-snug">
                  Apply to contents (every file and folder inside)
                </Label>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {isConfirming ? (
            <Button variant="outline" onClick={() => setIsConfirming(false)} disabled={isSubmitting}>
              Back
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
          )}
          <Button
            id="apply-permissions-btn"
            onClick={handlePrimaryClick}
            disabled={isSubmitting || !isValid}
            variant={isConfirming ? "destructive" : "default"}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isConfirming ? "Apply to all contents" : applyToContents ? "Continue" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
