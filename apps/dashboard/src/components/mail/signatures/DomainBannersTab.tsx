"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { SIGNATURE_BANNER_MAX, type DomainSignatureResponse } from "@vexlyx/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, signatureApi } from "@/hooks/useMailSignatures";
import { fromDateTimeLocal, toDateTimeLocal } from "@/lib/dateInput";
import { TemplateEditor } from "./TemplateEditor";

interface DomainBannersTabProps {
  domain: DomainSignatureResponse;
  onChange: (next: DomainSignatureResponse) => void;
}

const WHOLE_DOMAIN = "all";
const DAY = 86_400_000;

function status(banner: DomainSignatureResponse["banners"][number], now: number) {
  if (!banner.enabled) return { label: "Off", tone: "secondary" as const };
  if (now < new Date(banner.startsAt).getTime()) return { label: "Scheduled", tone: "outline" as const };
  if (now >= new Date(banner.endsAt).getTime()) return { label: "Ended", tone: "secondary" as const };
  return { label: "Showing now", tone: "default" as const };
}

/** Notices that appear under signatures between two dates, then disappear on their own. */
export function DomainBannersTab({ domain, onChange }: DomainBannersTabProps) {
  const [text, setText] = useState("");
  const [groupId, setGroupId] = useState(WHOLE_DOMAIN);
  const [startsAt, setStartsAt] = useState(() => toDateTimeLocal(new Date()));
  const [endsAt, setEndsAt] = useState(() => toDateTimeLocal(new Date(Date.now() + 7 * DAY)));
  const [isSaving, setIsSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const now = Date.now();

  const report = (next: DomainSignatureResponse) => {
    onChange(next);
    if (next.syncWarning) toast.warning(`Saved, but the mail servers weren't updated yet: ${next.syncWarning}`);
  };

  const add = async () => {
    const start = fromDateTimeLocal(startsAt);
    const end = fromDateTimeLocal(endsAt);
    if (!start || !end) {
      toast.error("Choose a start and an end time");
      return;
    }
    setIsSaving(true);
    try {
      report(
        await signatureApi.createBanner(domain.domainId, {
          text,
          groupId: groupId === WHOLE_DOMAIN ? null : groupId,
          startsAt: start,
          endsAt: end,
          enabled: true,
        }),
      );
      setText("");
      toast.success("Banner scheduled");
    } catch (err) {
      toast.error(errorMessage(err, "Could not schedule the banner"));
    } finally {
      setIsSaving(false);
    }
  };

  const change = async (id: string, action: () => Promise<DomainSignatureResponse>) => {
    setBusyId(id);
    try {
      report(await action());
    } catch (err) {
      toast.error(errorMessage(err, "Something went wrong"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        A banner is added below the signature from its start time until its end time, then disappears without anyone changing
        anything. Only mailboxes that have a signature show it.
      </p>

      {domain.banners.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {domain.banners.map((banner) => {
            const state = status(banner, now);
            const group = domain.groups.find((g) => g.id === banner.groupId);
            return (
              <li key={banner.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={state.tone}>{state.label}</Badge>
                    <span className="text-xs text-muted-foreground">{group ? `Group: ${group.name}` : "Whole domain"}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm">{banner.text}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(banner.startsAt).toLocaleString()} → {new Date(banner.endsAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={banner.enabled}
                    disabled={busyId === banner.id}
                    aria-label={`Show banner: ${banner.text.slice(0, 30)}`}
                    onCheckedChange={(checked) =>
                      void change(banner.id, () =>
                        signatureApi.updateBanner(domain.domainId, banner.id, {
                          groupId: banner.groupId,
                          text: banner.text,
                          startsAt: banner.startsAt,
                          endsAt: banner.endsAt,
                          enabled: checked,
                        }),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    aria-label="Delete banner"
                    disabled={busyId === banner.id}
                    onClick={() => void change(banner.id, () => signatureApi.deleteBanner(domain.domainId, banner.id))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
        <TemplateEditor
          id="new-banner-text"
          label="New banner"
          value={text}
          onChange={setText}
          maxLength={SIGNATURE_BANNER_MAX}
          rows={3}
          placeholder="Our office is closed 24 to 26 December."
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="banner-start">Starts</Label>
            <Input id="banner-start" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="banner-end">Ends</Label>
            <Input id="banner-end" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="banner-group">Shown for</Label>
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger id="banner-group" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={WHOLE_DOMAIN}>Whole domain</SelectItem>
                {domain.groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button type="button" size="sm" className="gap-1.5" disabled={isSaving || text.trim() === ""} onClick={() => void add()}>
          {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Schedule banner
        </Button>
      </div>
    </div>
  );
}
