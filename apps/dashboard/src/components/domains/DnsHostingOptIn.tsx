"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Check, Copy, Loader2, Network, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDnsMode } from "@/hooks/useDnsMode";
import { cn } from "@/lib/utils";
import type { DomainResponse } from "@vexlyx/shared";

interface DnsHostingOptInProps {
  domain: DomainResponse;
  onEnabled: () => void;
}

export function DnsHostingOptIn({ domain, onEnabled }: DnsHostingOptInProps) {
  const { delegation, isChecking, isSwitching, checkDelegation, setMode } = useDnsMode(domain.id);
  const [copied, setCopied] = useState<string | null>(null);

  const isVerified = domain.status === "ACTIVE";
  const canEnable = isVerified && delegation?.delegated === true;

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(text);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(null), 2000);
  };

  const handleCheck = async () => {
    try {
      const result = await checkDelegation();
      if (result?.delegated) {
        toast.success("Nameservers are pointed at Vexlyx");
      } else {
        toast.info("Nameservers not detected yet. Changes can take a while to propagate.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to check nameservers");
    }
  };

  const handleEnable = async () => {
    try {
      await setMode("MANAGED");
      toast.success("Vexlyx is now hosting DNS for this domain");
      onEnabled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to enable DNS hosting");
    }
  };

  const handlePrepare = async () => {
    try {
      await setMode("MANAGED", true);
      toast.success("Zone prepared. Switch your nameservers when you're ready.");
      onEnabled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to prepare the DNS zone");
    }
  };

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link
          href="/domains"
          className="flex items-center gap-1 hover:text-foreground transition-colors font-medium"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Domains
        </Link>
        <span>/</span>
        <span className="font-mono text-foreground font-semibold">{domain.hostname}</span>
        <span>/</span>
        <span className="text-foreground">Host DNS on Vexlyx</span>
      </div>

      <Card className="border border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4 text-indigo-500" />
            Host DNS on Vexlyx (optional)
          </CardTitle>
          <CardDescription className="leading-relaxed">
            {domain.hostname} is currently connected only: its DNS stays with your registrar or DNS
            provider, and the records you added there already route it to your project. You don&rsquo;t
            need to do anything on this page for that to keep working.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Only continue if you want Vexlyx to run <span className="font-medium text-foreground">all</span>{" "}
            DNS for this domain, including email records. You&rsquo;ll point your nameservers at Vexlyx,
            then manage every record from here.
          </p>

          {delegation?.configured === false ? (
            <div
              role="status"
              className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-700 dark:text-amber-400"
            >
              <p className="font-medium">DNS hosting is not set up on this server.</p>
              <p className="mt-1">
                No nameservers have been configured, so {domain.hostname} cannot be delegated to
                Vexlyx. Keep DNS at your current provider and add an A record there pointing to this
                server; your project keeps working as it does now.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <h2 className="text-sm font-medium text-foreground">
                  1. Set these nameservers at your registrar
                </h2>
                {delegation ? (
                  <div className="flex flex-wrap gap-2">
                    {delegation.expected.map((ns) => (
                      <Badge key={ns} variant="outline" className="gap-1.5 font-mono text-xs py-1 px-2">
                        {ns}
                        <button
                          type="button"
                          onClick={() => copyText(ns)}
                          aria-label={`Copy ${ns}`}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {copied === ns ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <Skeleton className="h-7 w-64" />
                )}
              </div>

              <div className="space-y-2">
                <h2 className="text-sm font-medium text-foreground">2. Check that they&rsquo;ve propagated</h2>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCheck()}
                    disabled={isChecking}
                    className="h-8 text-xs gap-1.5"
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", isChecking && "animate-spin")} />
                    Check nameservers
                  </Button>
                  {delegation && (
                    <span
                      className={cn(
                        "text-xs",
                        delegation.delegated
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground",
                      )}
                    >
                      {delegation.delegated
                        ? "Delegated to Vexlyx"
                        : delegation.found.length > 0
                          ? `Currently: ${delegation.found.join(", ")}`
                          : "No nameservers detected yet"}
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <h2 className="text-sm font-medium text-foreground">3. Enable DNS hosting</h2>
                {!isVerified && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Verify domain ownership on the Domains page first.
                  </p>
                )}
                <Button
                  size="sm"
                  onClick={() => void handleEnable()}
                  disabled={!canEnable || isSwitching}
                  className="h-8 text-xs"
                >
                  {isSwitching && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Enable DNS hosting
                </Button>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Moving a live site or mail? Prepare the zone first: load and check your records here
                  before you change nameservers, so nothing goes down during the switch.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePrepare()}
                  disabled={!isVerified || isSwitching}
                  className="h-8 text-xs"
                >
                  Prepare zone before switching
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
