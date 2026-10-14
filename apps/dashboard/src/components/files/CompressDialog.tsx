"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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
import { fetchAPI } from "@/lib/api";
import { commonParentDir } from "@/lib/filePermissions";
import type { FileNode } from "@vexlyx/shared";

interface CompressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  nodes: FileNode[];
  onCompressed: (archivePath: string) => void;
}

interface CompressResponse {
  path: string;
  files: number;
  skipped: string[];
}

export function CompressDialog({
  open,
  onOpenChange,
  projectId,
  nodes,
  onCompressed,
}: CompressDialogProps) {
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const parent = commonParentDir(nodes.map((n) => n.path));

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const handleCompress = async () => {
    const trimmed = name.trim().replace(/^[/\\]+/, "");
    const fileName = trimmed ? (/\.zip$/i.test(trimmed) ? trimmed : `${trimmed}.zip`) : undefined;
    setIsSubmitting(true);
    try {
      const result = await fetchAPI<CompressResponse>(`/api/files/${projectId}/compress`, {
        method: "POST",
        body: JSON.stringify({
          paths: nodes.map((n) => n.path),
          ...(fileName ? { archivePath: parent ? `${parent}/${fileName}` : fileName } : {}),
        }),
      });
      toast.success(`Created ${result.path} (${result.files} ${result.files === 1 ? "file" : "files"})`);
      if (result.skipped.length > 0) {
        toast.info(`Skipped symlinks: ${result.skipped.join(", ")}`);
      }
      onCompressed(result.path);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create archive");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Compress to .zip</DialogTitle>
          <DialogDescription>
            {nodes.length === 1
              ? `Add “${nodes[0]?.name}” to a new zip archive.`
              : `Add ${nodes.length} selected items to a new zip archive.`}{" "}
            The archive is saved in{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">/{parent}</code>; download
            it from there.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="compress-name" className="text-xs">
            Archive name (optional)
          </Label>
          <Input
            id="compress-name"
            className="font-mono"
            placeholder="archive-YYYYMMDDHHMMSS.zip"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCompress();
            }}
            autoFocus
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            id="confirm-compress-btn"
            onClick={() => void handleCompress()}
            disabled={isSubmitting || nodes.length === 0}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Compress
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
