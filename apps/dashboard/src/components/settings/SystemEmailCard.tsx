"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Loader2, Mail, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { useSystemEmail } from "@/hooks/useSystemEmail";
import { useRefreshAnimation, refreshIconClassName } from "@/hooks/useRefreshAnimation";
import { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/utils";

const TRANSPORT_LABELS = {
  bundled: "Bundled Postfix",
  external: "External SMTP relay",
  log: "Log only (development)",
} as const;

/** ADMIN-only status for the panel's own outbound email (F5.23). */
export function SystemEmailCard() {
  const { user } = useAuth();
  const { status, isLoading, refresh, sendTest } = useSystemEmail(true);
  const { isRefreshing, refresh: refreshAnimation } = useRefreshAnimation();
  const [to, setTo] = useState(user?.email ?? "");
  const [isSending, setIsSending] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleSendTest = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSending(true);
    try {
      await sendTest(to);
      toast.success(`Test email sent to ${to}`);
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : "Failed to send the test email");
      void refresh();
    } finally {
      setIsSending(false);
    }
  };

  const copyRecord = (value: string, index: number) => {
    void navigator.clipboard.writeText(value);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
    toast.success("Copied to clipboard");
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" />
            System Email
          </CardTitle>
          <CardDescription>
            Password resets, security alerts and quota warnings the panel emails to its users.
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh system email status"
          onClick={() => void refreshAnimation(() => refresh())}
          disabled={isRefreshing || isLoading}
        >
          <RefreshCw className={refreshIconClassName(isRefreshing, "h-4 w-4")} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && !status ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : !status ? (
          <p className="text-sm text-muted-foreground">Could not load the system email status.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <span className="text-xs text-muted-foreground">Status</span>
                <p className="mt-1">
                  <Badge variant={status.enabled ? "default" : "secondary"}>
                    {status.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Delivery</span>
                <p className="mt-1 text-sm font-medium">{TRANSPORT_LABELS[status.transport]}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Sends as</span>
                <p className="mt-1 truncate font-mono text-sm font-medium">{status.from}</p>
              </div>
            </div>

            {status.lastError ? (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Last delivery failed: {status.lastError}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {status.lastSentAt
                  ? `Last email sent ${new Date(status.lastSentAt).toLocaleString()}`
                  : "No email has been sent yet."}
              </p>
            )}

            {status.dnsRecords.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <p className="text-sm font-medium">Publish these DNS records</p>
                  <p className="text-xs text-muted-foreground">
                    Without them, receiving mail servers may send panel emails to spam.
                  </p>
                  {status.dnsRecords.map((record, i) => (
                    <div
                      key={`${record.purpose}-${record.name}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs font-medium">
                          {record.purpose} — {record.type} {record.host}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground">{record.value}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge
                          variant={record.present ? "default" : "secondary"}
                          className={cn(
                            record.present && "bg-emerald-600/10 text-emerald-600 dark:text-emerald-400",
                          )}
                        >
                          {record.present ? "Published" : "Not found"}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Copy ${record.purpose} record`}
                          onClick={() => copyRecord(record.value, i)}
                        >
                          {copiedIndex === i ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <Separator />
            <form onSubmit={handleSendTest} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="system-email-test-to">Send a test email to</Label>
                <Input
                  id="system-email-test-to"
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  disabled={isSending || !status.enabled}
                  required
                />
              </div>
              <Button type="submit" size="sm" disabled={isSending || !status.enabled || !to} className="gap-1.5">
                {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Send test
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
