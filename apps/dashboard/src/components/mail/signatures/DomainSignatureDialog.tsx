"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ImagePlus, Loader2, Trash2 } from "lucide-react";
import {
  SIGNATURE_NOTICE_MAX,
  SIGNATURE_TEMPLATE_MAX,
  type DomainSignatureResponse,
  type SignatureSenderListMode,
} from "@vexlyx/shared";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, signatureApi, useDomainSignature } from "@/hooks/useMailSignatures";
import { draftToInput, policyToDraft, sameDraft, type PolicyDraft } from "@/lib/signatureDraft";
import { previewMailboxSignature, type PreviewDomain } from "@/lib/signaturePreview";
import { DomainBannersTab } from "./DomainBannersTab";
import { DomainGroupsTab } from "./DomainGroupsTab";
import { DomainToolsTab } from "./DomainToolsTab";
import { SignaturePreview } from "./SignaturePreview";
import { TemplateEditor } from "./TemplateEditor";

interface DomainSignatureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domains: Array<{ domainId: string; hostname: string }>;
  /** Preselect a domain, e.g. the one a mailbox belongs to. */
  initialDomainId?: string;
}

const LIST_MODES: Array<{ id: SignatureSenderListMode; label: string }> = [
  { id: "ALL", label: "Every mailbox" },
  { id: "ONLY_LISTED", label: "Only the listed mailboxes" },
  { id: "EXCEPT_LISTED", label: "Everyone except the listed mailboxes" },
];

function ToggleRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function LogoPicker({
  domain,
  value,
  onSelect,
  onChange,
}: {
  domain: DomainSignatureResponse;
  value: string;
  onSelect: (url: string) => void;
  onChange: (next: DomainSignatureResponse) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const upload = async (file: File) => {
    setIsUploading(true);
    try {
      const asset = await signatureApi.uploadLogo(domain.domainId, file);
      onChange(await signatureApi.getDomain(domain.domainId));
      onSelect(asset.url);
      toast.success("Logo uploaded. Save to use it in the signature.");
    } catch (err) {
      toast.error(errorMessage(err, "Could not upload the logo"));
    } finally {
      setIsUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async (assetId: string) => {
    setDeleting(assetId);
    try {
      onChange(await signatureApi.deleteLogo(domain.domainId, assetId));
      toast.success("Logo deleted");
    } catch (err) {
      toast.error(errorMessage(err, "Could not delete the logo"));
    } finally {
      setDeleting(null);
      setConfirming(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="sig-logo-url">Logo address</Label>
        <Input
          id="sig-logo-url"
          value={value}
          placeholder="https://… or upload one below"
          onChange={(event) => onSelect(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Must start with https://. Many mail apps hide remote images until the reader allows them, so the signature also reads well
          without it.
        </p>
      </div>

      {domain.assets.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {domain.assets.map((asset) => (
            <li key={asset.id} className="flex items-center gap-3 rounded-lg border border-border p-2">
              <img src={asset.url} alt="Uploaded logo" className="h-10 w-16 rounded-sm border border-border bg-white object-contain" />
              <div className="min-w-0 flex-1 text-xs text-muted-foreground">{Math.max(1, Math.round(asset.size / 1024))} KB</div>
              <Button type="button" size="sm" variant={value === asset.url ? "secondary" : "outline"} className="h-7" onClick={() => onSelect(asset.url)}>
                {value === asset.url ? "In use" : "Use"}
              </Button>
              {confirming === asset.id ? (
                <Button type="button" size="sm" variant="destructive" className="h-7" disabled={deleting === asset.id} onClick={() => void remove(asset.id)}>
                  Delete?
                </Button>
              ) : (
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-destructive" aria-label="Delete logo" onClick={() => setConfirming(asset.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Button type="button" variant="outline" size="sm" className="gap-2" disabled={isUploading} onClick={() => fileInput.current?.click()}>
        {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
        Upload a logo
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        aria-label="Logo image file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <p className="text-xs text-muted-foreground">PNG, JPEG, GIF or WebP, up to 200 KB, 10 per domain.</p>
    </div>
  );
}

/** A domain's signature: the default template, who it applies to, the legal footer, groups, banners and bulk tools. */
export function DomainSignatureDialog({ open, onOpenChange, domains, initialDomainId }: DomainSignatureDialogProps) {
  const [domainId, setDomainId] = useState(initialDomainId ?? domains[0]?.domainId ?? "");
  const domain = useDomainSignature(open && domainId ? domainId : null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const initialisedFor = useRef<string | null>(null);

  useEffect(() => {
    if (open) setDomainId(initialDomainId ?? domains[0]?.domainId ?? "");
    else initialisedFor.current = null;
  }, [open, initialDomainId]);

  // Fill the form once per domain. Later responses (a new group, an upload) must not wipe unsaved edits.
  const data = domain.data;
  useEffect(() => {
    if (data && initialisedFor.current !== data.domainId) {
      initialisedFor.current = data.domainId;
      setDraft(policyToDraft(data));
    }
  }, [data]);

  const set = <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  /** The whole policy changed on the server (saved, restored, imported): show it. */
  const replace = (next: DomainSignatureResponse) => {
    domain.set(next);
    setDraft(policyToDraft(next));
  };
  /** Something else changed (groups, banners, logos): keep unsaved edits in the form. */
  const refresh = (next: DomainSignatureResponse) => domain.set(next);

  const isDirty = !!draft && !!data && !sameDraft(draft, policyToDraft(data));

  const preview = useMemo(() => {
    if (!draft || !data) return null;
    const previewDomain: PreviewDomain = {
      template: draft.template,
      company: draft.company.trim() || null,
      website: draft.website.trim() || null,
      logoUrl: draft.logoUrl.trim() || null,
      locked: draft.locked,
      complianceEnabled: draft.complianceEnabled,
      complianceText: draft.complianceText,
      groups: data.groups.map((group) => ({ id: group.id, template: group.template })),
      banners: data.banners,
    };
    return previewMailboxSignature(previewDomain, {
      address: `alex@${data.hostname}`,
      mode: "INHERIT",
      template: null,
      groupId: null,
      displayName: "Alex Example",
      title: "Account Manager",
      department: "Sales",
      phone: "+1 555 0100",
      mobile: "+1 555 0101",
    });
  }, [draft, data]);

  const handleSave = async () => {
    if (!draft || !data) return;
    setIsSaving(true);
    try {
      const next = await signatureApi.updateDomain(data.domainId, draftToInput(draft));
      replace(next);
      toast.success("Domain signature saved");
      if (next.syncWarning) toast.warning(`Saved, but the mail servers weren't updated yet: ${next.syncWarning}`);
    } catch (err) {
      toast.error(errorMessage(err, "Could not save the domain signature"));
    } finally {
      setIsSaving(false);
    }
  };

  const listed = draft?.senderListMode !== "ALL";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Domain signature</DialogTitle>
          <DialogDescription>
            The signature every mailbox on this domain starts from. Each mailbox fills it in from its own profile.
          </DialogDescription>
        </DialogHeader>

        {domains.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="sig-domain">Domain</Label>
            <Select value={domainId} onValueChange={setDomainId} disabled={isDirty}>
              <SelectTrigger id="sig-domain" className="w-full sm:w-72" title={isDirty ? "Save your changes before switching domain" : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {domains.map((d) => (
                  <SelectItem key={d.domainId} value={d.domainId}>
                    {d.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {domain.error ? (
          <p className="text-sm text-destructive">{domain.error}</p>
        ) : !data || !draft || data.domainId !== domainId ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <Tabs defaultValue="signature" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="signature">Signature</TabsTrigger>
              <TabsTrigger value="delivery">Delivery</TabsTrigger>
              <TabsTrigger value="groups">Groups</TabsTrigger>
              <TabsTrigger value="banners">Banners</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
            </TabsList>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              <TabsContent value="signature" className="space-y-5">
                <ToggleRow
                  id="sig-enabled"
                  label="Signatures on this domain"
                  hint="Off: no mailbox on this domain gets a signature or a legal footer from the panel."
                  checked={draft.enabled}
                  onChange={(checked) => set("enabled", checked)}
                />

                <TemplateEditor
                  id="sig-domain-template"
                  label="Default template"
                  value={draft.template}
                  onChange={(value) => set("template", value)}
                  maxLength={SIGNATURE_TEMPLATE_MAX}
                  rows={7}
                  placeholder={"**{{name}}**\n{{title}}\n{{company}}\n[{{website}}](https://{{website}})"}
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="sig-company">Company ({"{{company}}"})</Label>
                    <Input id="sig-company" value={draft.company} maxLength={100} onChange={(event) => set("company", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sig-website">Website ({"{{website}}"})</Label>
                    <Input id="sig-website" value={draft.website} maxLength={200} placeholder="example.com" onChange={(event) => set("website", event.target.value)} />
                  </div>
                </div>

                <LogoPicker domain={data} value={draft.logoUrl} onSelect={(url) => set("logoUrl", url)} onChange={refresh} />

                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Preview</h3>
                  <p className="text-xs text-muted-foreground">Shown for a sample mailbox, Alex Example.</p>
                  <SignaturePreview html={preview?.html ?? null} text={preview?.text ?? null} emptyMessage="With these settings nothing would be added." />
                </section>
              </TabsContent>

              <TabsContent value="delivery" className="space-y-4">
                <ToggleRow
                  id="sig-locked"
                  label="Lock the signature"
                  hint="Every mailbox gets this signature. Mailboxes can't write their own or turn it off, and webmail users can't edit it. Their profile still fills in the variables."
                  checked={draft.locked}
                  onChange={(checked) => set("locked", checked)}
                />

                <ToggleRow
                  id="sig-server-side"
                  label="Add it on the mail server"
                  hint="The server adds the signature to everything sent from these mailboxes, including from phones and desktop mail apps. Webmail then stops adding its own, so it never appears twice."
                  checked={draft.enforceServerSide}
                  onChange={(checked) => set("enforceServerSide", checked)}
                />
                {draft.enforceServerSide && !data.enforcementAvailable && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>The administrator has switched server-side signatures off, so this has no effect until it is turned back on.</span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  The server leaves signed or encrypted mail, calendar invitations, bounces and automatic replies alone, and never adds a
                  second signature to a message that already has one. If anything goes wrong the message is delivered unchanged.
                </p>

                <div className="space-y-3 rounded-lg border border-border p-3">
                  <h3 className="text-sm font-medium">Rules for server-side signatures</h3>
                  <ToggleRow
                    id="sig-external-only"
                    label="Only mail that leaves the company"
                    hint="Skip messages sent only to addresses on your own domains."
                    checked={draft.externalOnly}
                    disabled={!draft.enforceServerSide}
                    onChange={(checked) => set("externalOnly", checked)}
                  />
                  <ToggleRow
                    id="sig-new-only"
                    label="Only new messages"
                    hint="Skip replies and forwards."
                    checked={draft.newMessagesOnly}
                    disabled={!draft.enforceServerSide}
                    onChange={(checked) => set("newMessagesOnly", checked)}
                  />
                  {!draft.enforceServerSide && (
                    <p className="text-xs text-muted-foreground">These apply to the mail server, so they need &quot;Add it on the mail server&quot;.</p>
                  )}
                </div>

                <div className="space-y-3 rounded-lg border border-border p-3">
                  <h3 className="text-sm font-medium">Who gets a signature</h3>
                  <Select value={draft.senderListMode} onValueChange={(value) => set("senderListMode", value as SignatureSenderListMode)}>
                    <SelectTrigger className="w-full sm:w-80" aria-label="Who gets a signature">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LIST_MODES.map((mode) => (
                        <SelectItem key={mode.id} value={mode.id}>
                          {mode.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {listed && (
                    <div className="space-y-1.5">
                      <Label htmlFor="sig-sender-list">Mailboxes</Label>
                      <Textarea
                        id="sig-sender-list"
                        rows={4}
                        value={draft.senderList}
                        placeholder={`info@${data.hostname}\nsales@${data.hostname}`}
                        className="font-mono text-xs"
                        onChange={(event) => set("senderList", event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">One address per line.</p>
                    </div>
                  )}
                </div>

                <ToggleRow
                  id="sig-compliance"
                  label="Legal footer"
                  hint="A separate block, such as company registration details, added below the signature. It stays even for a mailbox that has turned its own signature off."
                  checked={draft.complianceEnabled}
                  onChange={(checked) => set("complianceEnabled", checked)}
                />
                {draft.complianceEnabled && (
                  <TemplateEditor
                    id="sig-compliance-text"
                    label="Legal footer text"
                    value={draft.complianceText}
                    onChange={(value) => set("complianceText", value)}
                    maxLength={SIGNATURE_NOTICE_MAX}
                    rows={4}
                    placeholder="Registered in England and Wales, company number 123456."
                  />
                )}
              </TabsContent>

              <TabsContent value="groups">
                <DomainGroupsTab domain={data} onChange={refresh} />
              </TabsContent>
              <TabsContent value="banners">
                <DomainBannersTab domain={data} onChange={refresh} />
              </TabsContent>
              <TabsContent value="tools">
                <DomainToolsTab domain={data} onReplaced={replace} onMailboxesChanged={() => void domain.reload()} />
              </TabsContent>
            </div>
          </Tabs>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={isSaving || !isDirty}>
            {isSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save signature and delivery settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
