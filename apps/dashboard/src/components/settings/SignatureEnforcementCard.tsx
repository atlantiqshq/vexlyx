"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PenLine, RefreshCw } from "lucide-react";
import type { SignatureEnforcementStatus } from "@vexlyx/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorMessage, signatureApi } from "@/hooks/useMailSignatures";
import { refreshIconClassName, useRefreshAnimation } from "@/hooks/useRefreshAnimation";

const SKIP_LABELS: Record<string, string> = {
  signed_or_encrypted: "signed or encrypted",
  calendar: "calendar invitations",
  auto_reply: "automatic replies",
  bounce: "bounces",
  report: "delivery reports",
  already_signed: "already signed",
  reply: "replies (rule)",
  internal: "internal only (rule)",
  not_enforced: "domain not enforcing",
  switched_off: "switched off",
  no_signature: "no signature set",
  nothing_to_add: "nothing to add",
  no_text_part: "no text to sign",
  too_large: "too large",
};

/** ADMIN-only: the global switch for server-side signatures (F5.31), and what the mail server has done so far. */
export function SignatureEnforcementCard() {
  const [status, setStatus] = useState<SignatureEnforcementStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { isRefreshing, refresh: animate } = useRefreshAnimation();

  const load = useCallback(async () => {
    try {
      setStatus(await signatureApi.getEnforcement());
    } catch (err) {
      toast.error(errorMessage(err, "Could not load the signature settings"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (enabled: boolean) => {
    setIsSaving(true);
    try {
      const next = await signatureApi.setEnforcement(enabled);
      setStatus(next);
      toast.success(enabled ? "Server-side signatures are on" : "Server-side signatures are off");
      if (next.syncWarning) toast.warning(`Saved, but the mail servers weren't told yet: ${next.syncWarning}`);
    } catch (err) {
      toast.error(errorMessage(err, "Could not change the setting"));
    } finally {
      setIsSaving(false);
    }
  };

  const skipped = Object.entries(status?.stats?.skipped ?? {}).sort((a, b) => b[1] - a[1]);
  const skippedTotal = skipped.reduce((sum, [, count]) => sum + count, 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <PenLine className="h-4 w-4" /> Mail signatures
          </CardTitle>
          <CardDescription>
            Domains can ask the mail server to add their signature to mail sent from any app, not just webmail. This is the
            emergency switch for that.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Refresh signature counters"
          disabled={isRefreshing}
          onClick={() => void animate(load)}
        >
          <RefreshCw className={refreshIconClassName(isRefreshing, "h-4 w-4")} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="signature-enforcement">Server-side signatures</Label>
                <p className="text-xs text-muted-foreground">
                  Off: the mail server adds nothing. Mail still flows and is still DKIM-signed, and webmail goes back to
                  inserting each user&apos;s signature itself.
                </p>
              </div>
              <Switch
                id="signature-enforcement"
                checked={status?.enabled ?? true}
                disabled={isSaving}
                onCheckedChange={(checked) => void toggle(checked)}
              />
            </div>

            {status?.stats ? (
              <div className="space-y-2 text-sm">
                <p className="text-xs text-muted-foreground">
                  Since {status.stats.since ? new Date(status.stats.since).toLocaleString() : "the mail server started"}:
                </p>
                <ul className="grid gap-2 sm:grid-cols-3">
                  <li className="rounded-lg border border-border p-3">
                    <span className="block text-lg font-semibold">{status.stats.modified}</span>
                    <span className="text-xs text-muted-foreground">messages signed</span>
                  </li>
                  <li className="rounded-lg border border-border p-3">
                    <span className="block text-lg font-semibold">{skippedTotal}</span>
                    <span className="text-xs text-muted-foreground">passed through untouched</span>
                  </li>
                  <li className="rounded-lg border border-border p-3">
                    <span className="block text-lg font-semibold">{status.stats.failed}</span>
                    <span className="text-xs text-muted-foreground">delivered unsigned after a problem</span>
                  </li>
                </ul>
                {skipped.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Untouched because: {skipped.map(([reason, count]) => `${SKIP_LABELS[reason] ?? reason} ${count}`).join(" · ")}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Counters appear once the mail server has handled a message.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
