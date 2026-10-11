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
import { parentDir } from "@/lib/filePermissions";
import type { FileNode } from "@vexlyx/shared";

interface ExtractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  node: FileNode | null;
  onExtracted: () => void;
}

interface ExtractResponse {
  destination: string;
  files: number;
  skipped: string[];
}

export function ExtractDialog({
  open,
  onOpenChange,
  projectId,
  node,
  onExtracted,
}: ExtractDialogProps) {
  const [destination, setDestination] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !node) return;
    setDestination(parentDir(node.path));
    setOverwrite(false);
  }, [open, node]);

  const handleExtract = async () => {
    if (!node) return;
    setIsSubmitting(true);
    try {
      const result = await fetchAPI<ExtractResponse>(`/api/files/${projectId}/extract`, {
        method: "POST",
        body: JSON.stringify({
          path: node.path,
          destination: destination.trim() || "/",
          overwrite,
        }),
      });
      toast.success(`Extracted ${result.files} ${result.files === 1 ? "file" : "files"}`);
      if (result.skipped.length > 0) {
        toast.info(`Skipped protected files: ${result.skipped.join(", ")}`);
      }
      onExtracted();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to extract archive");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Extract archive</DialogTitle>
          <DialogDescription>
            Unpack{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{node?.name}</code> on the
            server. Nothing is written if any entry in the archive is unsafe.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="extract-destination" className="text-xs">
              Destination folder
            </Label>
            <Input
              id="extract-destination"
              className="font-mono"
              placeholder="/ (project root)"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleExtract();
              }}
            />
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="extract-overwrite"
              checked={overwrite}
              onCheckedChange={(checked) => setOverwrite(checked === true)}
            />
            <Label htmlFor="extract-overwrite" className="text-xs leading-snug">
              Overwrite existing files (otherwise extraction stops if anything would be replaced)
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button id="confirm-extract-btn" onClick={() => void handleExtract()} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Extract
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
