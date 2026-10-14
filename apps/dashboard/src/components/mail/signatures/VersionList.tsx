"use client";

import { useState } from "react";
import { toast } from "sonner";
import { History, Loader2 } from "lucide-react";
import type { SignatureVersionResponse } from "@vexlyx/shared";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/hooks/useMailSignatures";

interface VersionListProps {
  load: () => Promise<{ versions: SignatureVersionResponse[] }>;
  restore: (versionId: string) => Promise<void>;
}

/** Earlier states of a signature, newest first, each restorable. Loaded only when opened. */
export function VersionList({ load, restore }: VersionListProps) {
  const [versions, setVersions] = useState<SignatureVersionResponse[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const open = async () => {
    setIsLoading(true);
    try {
      setVersions((await load()).versions);
    } catch (err) {
      toast.error(errorMessage(err, "Could not load the history"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestore = async (versionId: string) => {
    setBusyId(versionId);
    try {
      await restore(versionId);
      setVersions((await load()).versions);
      toast.success("Earlier version restored");
    } catch (err) {
      toast.error(errorMessage(err, "Could not restore that version"));
    } finally {
      setBusyId(null);
    }
  };

  if (versions === null) {
    return (
      <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void open()} disabled={isLoading}>
        {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
        Show earlier versions
      </Button>
    );
  }

  if (versions.length === 0) {
    return <p className="text-xs text-muted-foreground">No earlier versions yet. One is saved each time this is changed.</p>;
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {versions.map((version) => (
        <li key={version.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
          <span>
            {new Date(version.createdAt).toLocaleString()}
            <span className="text-muted-foreground"> · changed by {version.createdByEmail ?? "unknown"}</span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            disabled={busyId !== null}
            onClick={() => void handleRestore(version.id)}
          >
            {busyId === version.id && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            Restore
          </Button>
        </li>
      ))}
    </ul>
  );
}
