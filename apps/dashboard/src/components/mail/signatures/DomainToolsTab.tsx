"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Loader2, Upload } from "lucide-react";
import type { DomainSignatureResponse, SignatureBulkResult } from "@vexlyx/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage, signatureApi } from "@/hooks/useMailSignatures";
import { VersionList } from "./VersionList";

interface DomainToolsTabProps {
  domain: DomainSignatureResponse;
  /** Called with a fresh domain response after something that changes the whole policy (import, restore). */
  onReplaced: (next: DomainSignatureResponse) => void;
  /** Called after a change that affects mailboxes but not the policy, so counts can refresh. */
  onMailboxesChanged: () => void;
}

type BulkAction = "RESET_TO_DEFAULT" | "ASSIGN_GROUP";
const NO_GROUP = "none";

/** Whole-domain operations: change many mailboxes at once, copy a template between domains, undo. */
export function DomainToolsTab({ domain, onReplaced, onMailboxesChanged }: DomainToolsTabProps) {
  const [action, setAction] = useState<BulkAction>("RESET_TO_DEFAULT");
  const [groupId, setGroupId] = useState(NO_GROUP);
  const [counted, setCounted] = useState<SignatureBulkResult | null>(null);
  const [busy, setBusy] = useState<"count" | "apply" | "export" | "import" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const bulkBody = (dryRun: boolean) =>
    action === "RESET_TO_DEFAULT"
      ? ({ action, dryRun } as const)
      : ({ action, groupId: groupId === NO_GROUP ? null : groupId, dryRun } as const);

  const count = async () => {
    setBusy("count");
    try {
      setCounted(await signatureApi.bulk(domain.domainId, bulkBody(true)));
    } catch (err) {
      toast.error(errorMessage(err, "Could not count the mailboxes"));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy("apply");
    try {
      const result = await signatureApi.bulk(domain.domainId, bulkBody(false));
      setCounted(null);
      onMailboxesChanged();
      toast.success(`Updated ${result.affected} ${result.affected === 1 ? "mailbox" : "mailboxes"}`);
      if (result.syncWarning) toast.warning(`Saved, but the mail servers weren't updated yet: ${result.syncWarning}`);
    } catch (err) {
      toast.error(errorMessage(err, "Could not apply the change"));
    } finally {
      setBusy(null);
    }
  };

  const exportTemplate = async () => {
    setBusy("export");
    try {
      const data = await signatureApi.exportDomain(domain.domainId);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `signature-template-${domain.hostname}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err, "Could not export the template"));
    } finally {
      setBusy(null);
    }
  };

  const importTemplate = async (file: File) => {
    setBusy("import");
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const next = await signatureApi.importDomain(domain.domainId, parsed as Parameters<typeof signatureApi.importDomain>[1]);
      onReplaced(next);
      toast.success("Template imported");
      if (next.syncWarning) toast.warning(`Saved, but the mail servers weren't updated yet: ${next.syncWarning}`);
    } catch (err) {
      toast.error(err instanceof SyntaxError ? "That file isn't a signature template" : errorMessage(err, "Could not import the template"));
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Change many mailboxes at once</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-action">What to do</Label>
            <Select
              value={action}
              onValueChange={(value) => {
                setAction(value as BulkAction);
                setCounted(null);
              }}
            >
              <SelectTrigger id="bulk-action" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="RESET_TO_DEFAULT">Put every mailbox back on the domain signature</SelectItem>
                <SelectItem value="ASSIGN_GROUP">Put every mailbox in a group</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {action === "ASSIGN_GROUP" && (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-group">Group</Label>
              <Select
                value={groupId}
                onValueChange={(value) => {
                  setGroupId(value);
                  setCounted(null);
                }}
              >
                <SelectTrigger id="bulk-group" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_GROUP}>No group</SelectItem>
                  {domain.groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Mailbox profiles (names, titles, phone numbers) are kept. Every mailbox changed gets an earlier version it can be restored
          from.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void count()}>
            {busy === "count" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Count what would change
          </Button>
          {counted && (
            <>
              <span className="text-sm">
                {counted.affected} of {counted.total} {counted.total === 1 ? "mailbox" : "mailboxes"} would change.
              </span>
              <Button type="button" size="sm" disabled={busy !== null || counted.affected === 0} onClick={() => void apply()}>
                {busy === "apply" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Apply to {counted.affected}
              </Button>
            </>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Copy this setup to another domain</h3>
        <p className="text-xs text-muted-foreground">
          Exports the template, rules, legal footer, groups and banners as a file. Importing replaces the template, rules and banners,
          and adds or updates groups by name; mailboxes, sender lists and logo uploads are not included.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="gap-2" disabled={busy !== null} onClick={() => void exportTemplate()}>
            {busy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Export
          </Button>
          <Button type="button" variant="outline" size="sm" className="gap-2" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
            {busy === "import" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Import…
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Signature template file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importTemplate(file);
            }}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">History</h3>
        <VersionList
          load={() => signatureApi.domainVersions(domain.domainId)}
          restore={async (versionId) => onReplaced(await signatureApi.restoreDomainVersion(domain.domainId, versionId))}
        />
      </section>
    </div>
  );
}
