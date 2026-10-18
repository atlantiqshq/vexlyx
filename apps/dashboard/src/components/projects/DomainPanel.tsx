"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Globe,
  Plus,
  ExternalLink,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  RefreshCw,
  HelpCircle,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDomains } from "@/hooks/useDomains";
import { DomainConnectInstructions } from "@/components/domains/DomainConnectInstructions";
import { cn } from "@/lib/utils";
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { refreshIconClassName } from "@/hooks/useRefreshAnimation";
import type { DomainResponse, DomainStatus, Project } from "@vexlyx/shared";

interface DomainPanelProps {
  project: Project;
  onProjectUpdate?: () => void;
}

const STATUS_CONFIG: Record<
  DomainStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  ACTIVE: {
    label: "Active",
    icon: CheckCircle2,
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  },
  PENDING: {
    label: "Pending Verification",
    icon: Clock,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  },
  ERROR: {
    label: "Verification Failed",
    icon: AlertCircle,
    className: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  },
};

export function DomainPanel({ project }: DomainPanelProps) {
  const {
    domains,
    isLoading,
    isRefreshing,
    refresh,
    createDomain,
    updateDomain,
    verifyDomain,
    deleteDomain,
  } = useDomains({ projectId: project.id });

  // Add domain modal state
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newHostname, setNewHostname] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [attachTarget, setAttachTarget] = useState<DomainResponse | null>(null);

  // Verification instructions modal state
  const [instructionsDomain, setInstructionsDomain] = useState<DomainResponse | null>(null);
  const [instructionsModalOpen, setInstructionsModalOpen] = useState(false);

  // Verifying state per domain ID
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  // Delete confirmation modal state
  const [deleteTarget, setDeleteTarget] = useState<DomainResponse | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanHostname = newHostname.trim().toLowerCase();
    if (!cleanHostname) {
      toast.error("Please enter a domain name");
      return;
    }

    setIsAdding(true);
    try {
      const created = await createDomain({
        hostname: cleanHostname,
        projectId: project.id,
      });

      if (created.status === "ACTIVE") {
        toast.success(`Domain "${cleanHostname}" attached and actively routing traffic via Traefik!`);
        setNewHostname("");
        setAddModalOpen(false);
      } else {
        toast.success(`Domain "${cleanHostname}" attached. DNS TXT verification required.`);
        setNewHostname("");
        setAddModalOpen(false);
        setInstructionsDomain(created);
        setInstructionsModalOpen(true);
      }
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.code === "DOMAIN_ALREADY_EXISTS") {
        try {
          const existing = await fetchAPI<DomainResponse[]>(`/api/domains?search=${encodeURIComponent(cleanHostname)}&limit=100`);
          const owned = existing.find((domain) => domain.hostname === cleanHostname);
          if (owned && owned.projectId !== project.id) {
            setAttachTarget(owned);
            setAddModalOpen(false);
            return;
          }
        } catch (lookupError) {
          toast.error(lookupError instanceof Error ? lookupError.message : "Failed to find existing domain");
          return;
        }
      }
      const msg = err instanceof Error ? err.message : "Failed to add domain";
      toast.error(msg);
    } finally {
      setIsAdding(false);
    }
  };

  const handleAttach = async () => {
    if (!attachTarget) return;
    setIsAdding(true);
    try {
      const attached = await updateDomain(attachTarget.id, { projectId: project.id });
      toast.success(`Domain "${attached.hostname}" attached`);
      setAttachTarget(null);
      setNewHostname("");
      if (attached.status !== "ACTIVE") {
        setInstructionsDomain(attached);
        setInstructionsModalOpen(true);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to attach domain");
    } finally {
      setIsAdding(false);
    }
  };

  const handleVerify = async (domain: DomainResponse) => {
    setVerifyingId(domain.id);
    try {
      const res = await verifyDomain(domain.id);
      if (res.verified) {
        toast.success(res.message);
        setInstructionsModalOpen(false);
      } else {
        toast.error(res.message);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Verification attempt failed";
      toast.error(msg);
    } finally {
      setVerifyingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteDomain(deleteTarget.id);
      toast.success(`Domain "${deleteTarget.hostname}" removed`);
      setDeleteTarget(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete domain";
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Card className="border border-border">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pb-4">
        <div>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Globe className="h-4 w-4 text-primary" />
            Custom Domains
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground mt-0.5">
            Attach custom domain names to route web traffic to this project via Traefik.
          </CardDescription>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={isRefreshing || isLoading}
            className="h-8 px-2 text-muted-foreground hover:text-foreground"
            title="Refresh domains"
          >
            <RefreshCw className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")} />
          </Button>

          <Button
            size="sm"
            onClick={() => setAddModalOpen(true)}
            className="h-8 gap-1.5 text-xs font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Domain
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : domains.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-8 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Globe className="h-5 w-5 text-muted-foreground" />
            </div>
            <h4 className="mt-3 text-sm font-medium text-foreground">No custom domains attached</h4>
            <p className="mt-1 text-xs text-muted-foreground max-w-sm">
              Point your domain&rsquo;s DNS to this server and verify ownership with a TXT record.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddModalOpen(true)}
              className="mt-4 h-8 text-xs font-medium"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Attach Domain
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {domains.map((domain) => {
              const statusCfg = STATUS_CONFIG[domain.status] ?? STATUS_CONFIG.PENDING;
              const StatusIcon = statusCfg.icon;
              const isVerifying = verifyingId === domain.id;

              return (
                <div
                  key={domain.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start sm:items-center gap-3 min-w-0">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Globe className="h-4 w-4" />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium text-foreground truncate">
                          {domain.hostname}
                        </span>

                        {domain.status === "ACTIVE" && (
                          <a
                            href={`https://${domain.hostname}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-primary transition-colors"
                            title="Visit domain"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <Badge
                          variant="outline"
                          className={cn("gap-1 text-[10px] font-medium py-0 px-1.5", statusCfg.className)}
                        >
                          <StatusIcon className="h-3 w-3" />
                          {statusCfg.label}
                        </Badge>

                        {domain.hostname.startsWith("*.") && (
                          <Badge
                            variant="secondary"
                            className="gap-1 text-[10px] bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20 py-0 px-1.5"
                          >
                            <Sparkles className="h-2.5 w-2.5" />
                            Wildcard
                          </Badge>
                        )}

                        {domain.parentId && (
                          <Badge
                            variant="outline"
                            className="text-[10px] text-blue-600 dark:text-blue-400 border-blue-500/20 py-0 px-1.5"
                          >
                            Subdomain
                          </Badge>
                        )}


                        {domain.status !== "ACTIVE" && (
                          <button
                            type="button"
                            onClick={() => {
                              setInstructionsDomain(domain);
                              setInstructionsModalOpen(true);
                            }}
                            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors underline-offset-2 hover:underline"
                          >
                            <HelpCircle className="h-3 w-3" />
                            DNS Instructions
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                    {domain.status !== "ACTIVE" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleVerify(domain)}
                        disabled={isVerifying}
                        className="h-8 text-xs"
                      >
                        {isVerifying ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Verifying…
                          </>
                        ) : (
                          "Verify Now"
                        )}
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget(domain)}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Remove domain"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* ── Add Domain Modal ──────────────────────────────────────────────── */}
      <Dialog open={Boolean(attachTarget)} onOpenChange={(open) => !isAdding && !open && setAttachTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{attachTarget?.projectId ? "Move existing domain" : "Attach existing domain"}</DialogTitle>
            <DialogDescription>
              {attachTarget?.projectId
                ? `Move ${attachTarget.hostname} from ${attachTarget.project?.name ?? "its current project"} to ${project.name}? Web traffic will route to this project.`
                : `Attach ${attachTarget?.hostname} to ${project.name}?`}
              {" "}DNS records, verification, certificates, and mail are preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={isAdding} onClick={() => setAttachTarget(null)}>Cancel</Button>
            <Button disabled={isAdding} onClick={() => void handleAttach()}>{isAdding ? "Attaching..." : attachTarget?.projectId ? "Move domain" : "Attach domain"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={addModalOpen} onOpenChange={setAddModalOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleAddDomain}>
            <DialogHeader>
              <DialogTitle>Attach Custom Domain</DialogTitle>
              <DialogDescription>
                Add a custom domain or subdomain to route traffic to &ldquo;{project.name}&rdquo;.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="domain-hostname">Domain Name</Label>
                <Input
                  id="domain-hostname"
                  placeholder="e.g. app.mycompany.com or example.com"
                  value={newHostname}
                  onChange={(e) => setNewHostname(e.target.value)}
                  disabled={isAdding}
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground">
                  Do not include protocol (http://) or path. You must own this domain to verify DNS records.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddModalOpen(false)}
                disabled={isAdding}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isAdding}>
                {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Domain
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── DNS Instructions Modal ────────────────────────────────────────── */}
      <Dialog open={instructionsModalOpen} onOpenChange={setInstructionsModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" />
              Verify Domain Ownership
            </DialogTitle>
            <DialogDescription>
              Configure this DNS TXT record with your domain registrar (e.g. Cloudflare, Namecheap, GoDaddy).
            </DialogDescription>
          </DialogHeader>

          {instructionsDomain && <DomainConnectInstructions domain={instructionsDomain} />}

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setInstructionsModalOpen(false)}
            >
              Close
            </Button>
            {instructionsDomain && instructionsDomain.status !== "ACTIVE" && (
              <Button
                type="button"
                onClick={() => void handleVerify(instructionsDomain)}
                disabled={verifyingId === instructionsDomain.id}
              >
                {verifyingId === instructionsDomain.id && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Verify DNS Records
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation Modal ────────────────────────────────────── */}
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove Domain</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove &ldquo;{deleteTarget?.hostname}&rdquo;?
              Traefik routing for this domain will be deleted immediately.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove Domain
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
