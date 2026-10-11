"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { SIGNATURE_TEMPLATE_MAX, type DomainSignatureResponse } from "@vexlyx/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, signatureApi } from "@/hooks/useMailSignatures";
import { TemplateEditor } from "./TemplateEditor";

interface DomainGroupsTabProps {
  domain: DomainSignatureResponse;
  onChange: (next: DomainSignatureResponse) => void;
}

type Group = DomainSignatureResponse["groups"][number];

function GroupCard({ domainId, group, onChange }: { domainId: string; group: Group; onChange: (next: DomainSignatureResponse) => void }) {
  const [name, setName] = useState(group.name);
  const [template, setTemplate] = useState(group.template);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dirty = name !== group.name || template !== group.template;

  const run = async (action: () => Promise<DomainSignatureResponse>, done: string) => {
    setBusy(true);
    try {
      const next = await action();
      onChange(next);
      toast.success(done);
      if (next.syncWarning) toast.warning(`Saved, but the mail servers weren't updated yet: ${next.syncWarning}`);
    } catch (err) {
      toast.error(errorMessage(err, "Something went wrong"));
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={`group-name-${group.id}`}>Group name</Label>
          <Input id={`group-name-${group.id}`} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        </div>
        <span className="pb-2 text-xs text-muted-foreground">
          {group.members} {group.members === 1 ? "mailbox" : "mailboxes"}
        </span>
      </div>
      <TemplateEditor
        id={`group-template-${group.id}`}
        label="Template for this group"
        value={template}
        onChange={setTemplate}
        maxLength={SIGNATURE_TEMPLATE_MAX}
        rows={4}
        placeholder="Leave empty to use the domain template"
      />
      <div className="flex justify-between gap-2">
        {confirmingDelete ? (
          <div className="flex items-center gap-2 text-xs">
            <span>Its mailboxes go back to the domain template.</span>
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void run(() => signatureApi.deleteGroup(domainId, group.id), "Group deleted")}>
              Delete group
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-destructive" onClick={() => setConfirmingDelete(true)}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={busy || !dirty || name.trim() === ""}
          onClick={() => void run(() => signatureApi.updateGroup(domainId, group.id, { name, template }), "Group saved")}
        >
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Save group
        </Button>
      </div>
    </div>
  );
}

/** Department templates that sit between the domain default and a mailbox: Sales, Support, and so on. */
export function DomainGroupsTab({ domain, onChange }: DomainGroupsTabProps) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const add = async () => {
    setIsAdding(true);
    try {
      const next = await signatureApi.createGroup(domain.domainId, { name, template });
      onChange(next);
      setName("");
      setTemplate("");
      toast.success("Group added");
    } catch (err) {
      toast.error(errorMessage(err, "Could not add the group"));
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        A group gives some mailboxes their own template, for example Sales or Support. Put a mailbox in a group from its own
        signature settings, or all at once from Tools. A mailbox's own custom signature still wins, unless the domain is locked.
      </p>

      {domain.groups.map((group) => (
        <GroupCard key={group.id} domainId={domain.domainId} group={group} onChange={onChange} />
      ))}

      <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
        <div className="space-y-1.5">
          <Label htmlFor="new-group-name">New group</Label>
          <Input id="new-group-name" value={name} maxLength={60} placeholder="Sales" onChange={(event) => setName(event.target.value)} />
        </div>
        <TemplateEditor
          id="new-group-template"
          label="Template"
          value={template}
          onChange={setTemplate}
          maxLength={SIGNATURE_TEMPLATE_MAX}
          rows={4}
          placeholder={"**{{name}}**\n{{title}}, Sales\n{{phone}}"}
        />
        <Button type="button" size="sm" className="gap-1.5" disabled={isAdding || name.trim() === ""} onClick={() => void add()}>
          {isAdding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add group
        </Button>
      </div>
    </div>
  );
}
