"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Lock, Send } from "lucide-react";
import { SIGNATURE_TEMPLATE_MAX, type MailboxResponse, type SignatureMode } from "@vexlyx/shared";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, signatureApi, useDomainSignature, useMailboxSignature } from "@/hooks/useMailSignatures";
import { previewMailboxSignature, toPreviewDomain } from "@/lib/signaturePreview";
import { cn } from "@/lib/utils";
import { SignaturePreview } from "./SignaturePreview";
import { TemplateEditor } from "./TemplateEditor";
import { VersionList } from "./VersionList";

interface MailboxSignatureDialogProps {
  mailbox: MailboxResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Draft {
  mode: SignatureMode;
  template: string;
  groupId: string;
  displayName: string;
  title: string;
  department: string;
  phone: string;
  mobile: string;
}

const NO_GROUP = "none";

const MODES: Array<{ id: SignatureMode; label: string; hint: string }> = [
  { id: "INHERIT", label: "Use the domain signature", hint: "Follows the domain's template, filled in from the profile above." },
  { id: "CUSTOM", label: "Write one for this mailbox", hint: "Replaces the domain's template for this mailbox only." },
  { id: "NONE", label: "No signature", hint: "Nothing is added. A legal footer, if the domain has one, still is." },
];

const empty: Draft = { mode: "INHERIT", template: "", groupId: NO_GROUP, displayName: "", title: "", department: "", phone: "", mobile: "" };

const nullable = (value: string) => (value.trim() === "" ? null : value.trim());

/** Edit one mailbox's signature: who it is (the variables), which template it follows, and a live preview. */
export function MailboxSignatureDialog({ mailbox, open, onOpenChange }: MailboxSignatureDialogProps) {
  const mailboxId = open && mailbox ? mailbox.id : null;
  const signature = useMailboxSignature(mailboxId);
  const domain = useDomainSignature(open && mailbox ? mailbox.domainId : null);

  const [draft, setDraft] = useState<Draft>(empty);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  const saved = signature.data;
  const toDraft = (data: NonNullable<typeof saved>): Draft => ({
    mode: data.mode,
    template: data.template ?? "",
    groupId: data.groupId ?? NO_GROUP,
    displayName: data.profile.displayName ?? "",
    title: data.profile.title ?? "",
    department: data.profile.department ?? "",
    phone: data.profile.phone ?? "",
    mobile: data.profile.mobile ?? "",
  });

  useEffect(() => {
    if (saved) setDraft(toDraft(saved));
  }, [saved]);

  const locked = saved?.domainLocked ?? false;
  const mode: SignatureMode = locked ? "INHERIT" : draft.mode;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const isDirty = useMemo(() => {
    if (!saved) return false;
    const base = toDraft(saved);
    return (Object.keys(base) as Array<keyof Draft>).some((key) => base[key] !== draft[key]);
  }, [saved, draft]);

  const preview = useMemo(() => {
    if (!mailbox || !domain.data) return null;
    return previewMailboxSignature(toPreviewDomain(domain.data), {
      address: mailbox.address,
      mode,
      template: draft.template,
      groupId: draft.groupId === NO_GROUP ? null : draft.groupId,
      displayName: nullable(draft.displayName),
      title: nullable(draft.title),
      department: nullable(draft.department),
      phone: nullable(draft.phone),
      mobile: nullable(draft.mobile),
    });
  }, [mailbox, domain.data, draft, mode]);

  const reportSync = (warning?: string) => {
    if (warning) toast.warning(`Saved, but the mail servers weren't updated yet: ${warning}`);
  };

  const handleSave = async () => {
    if (!mailbox) return;
    setIsSaving(true);
    try {
      const next = await signatureApi.updateMailbox(mailbox.id, {
        mode,
        template: mode === "CUSTOM" ? draft.template : null,
        groupId: draft.groupId === NO_GROUP ? null : draft.groupId,
        displayName: nullable(draft.displayName),
        title: nullable(draft.title),
        department: nullable(draft.department),
        phone: nullable(draft.phone),
        mobile: nullable(draft.mobile),
      });
      signature.set(next);
      toast.success("Signature saved");
      reportSync(next.syncWarning);
    } catch (err) {
      toast.error(errorMessage(err, "Could not save the signature"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    if (!mailbox) return;
    setIsSaving(true);
    try {
      const next = await signatureApi.resetMailbox(mailbox.id);
      signature.set(next);
      toast.success("Back to the domain default");
      reportSync(next.syncWarning);
    } catch (err) {
      toast.error(errorMessage(err, "Could not reset the signature"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    if (!mailbox) return;
    setIsTesting(true);
    try {
      const { sentTo } = await signatureApi.sendTest(mailbox.id);
      toast.success(`A preview message is on its way to ${sentTo}`);
    } catch (err) {
      toast.error(errorMessage(err, "Could not send the preview"));
    } finally {
      setIsTesting(false);
    }
  };

  const serverSide = !!domain.data?.enforceServerSide && !!domain.data.enforcementAvailable;
  const isLoading = signature.isLoading || domain.isLoading || (!saved && !signature.error);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Signature for {mailbox?.address}</DialogTitle>
          <DialogDescription>
            {serverSide
              ? "The mail server adds this to everything sent from this mailbox, from any app."
              : "Applied in webmail the next time this mailbox signs in. Other mail apps keep their own signature."}
          </DialogDescription>
        </DialogHeader>

        {signature.error || domain.error ? (
          <p className="text-sm text-destructive">{signature.error ?? domain.error}</p>
        ) : isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="space-y-5 overflow-y-auto pr-1">
            {locked && (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {mailbox?.hostname} uses a locked signature. Only the profile below can be changed; the template follows the
                  domain.
                </span>
              </div>
            )}

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Profile</h3>
              <p className="text-xs text-muted-foreground">Fills the variables in the template, such as {"{{name}}"} and {"{{phone}}"}.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["displayName", "Name", "Ada Lovelace"],
                    ["title", "Job title", "Engineer"],
                    ["department", "Department", "Research"],
                    ["phone", "Phone", "+44 20 7946 0000"],
                    ["mobile", "Mobile", "+44 7700 900123"],
                  ] as const
                ).map(([key, label, placeholder]) => (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={`sig-${key}`}>{label}</Label>
                    <Input
                      id={`sig-${key}`}
                      value={draft[key]}
                      maxLength={key === "phone" || key === "mobile" ? 40 : 100}
                      placeholder={placeholder}
                      onChange={(event) => set(key, event.target.value)}
                    />
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Signature</h3>
              <div role="radiogroup" aria-label="Signature source" className="grid gap-2">
                {MODES.map((option) => {
                  const disabled = locked && option.id !== "INHERIT";
                  const selected = mode === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={disabled}
                      onClick={() => set("mode", option.id)}
                      className={cn(
                        "rounded-lg border p-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                      )}
                    >
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="block text-xs text-muted-foreground">{option.hint}</span>
                    </button>
                  );
                })}
              </div>

              {mode === "INHERIT" && (domain.data?.groups.length ?? 0) > 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="sig-group">Group</Label>
                  <Select value={draft.groupId} onValueChange={(value) => set("groupId", value)}>
                    <SelectTrigger id="sig-group" className="w-full sm:w-72">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_GROUP}>No group (domain template)</SelectItem>
                      {domain.data?.groups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {mode === "CUSTOM" && (
                <TemplateEditor
                  id="sig-template"
                  label="Template"
                  value={draft.template}
                  onChange={(value) => set("template", value)}
                  maxLength={SIGNATURE_TEMPLATE_MAX}
                  placeholder={"**{{name}}**\n{{title}}\n{{phone}}"}
                />
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Preview</h3>
              <SignaturePreview
                html={preview?.html ?? null}
                text={preview?.text ?? null}
                emptyMessage="Nothing will be added to this mailbox's mail with these settings."
              />
              {saved && saved.resolved.source !== "none" && !isDirty && (
                <p className="text-xs text-muted-foreground">
                  Saved: this mailbox follows the {saved.resolved.source === "mailbox" ? "signature written for it" : `${saved.resolved.source} template`}.
                </p>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">History</h3>
              <VersionList
                load={() => signatureApi.mailboxVersions(mailbox!.id)}
                restore={async (versionId) => signature.set(await signatureApi.restoreMailboxVersion(mailbox!.id, versionId))}
              />
            </section>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void handleTest()}
              disabled={isTesting || isDirty || !saved?.resolved.html}
              title={isDirty ? "Save your changes first" : "Email yourself a preview of the saved signature"}
            >
              {isTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send me a test
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void handleReset()} disabled={isSaving || !saved}>
              Reset to default
            </Button>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="button" size="sm" onClick={() => void handleSave()} disabled={isSaving || !isDirty}>
              {isSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
