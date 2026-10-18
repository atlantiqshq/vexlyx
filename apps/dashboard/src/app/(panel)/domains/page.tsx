"use client";

import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  Globe,
  Plus,
  Search,
  RefreshCw,
  ExternalLink,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  FolderGit2,
  HelpCircle,
  Layers,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Server,
  Lock,
  Unlock,
} from "lucide-react";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TooltipProvider,
} from "@/components/ui/tooltip";
import { useDomains } from "@/hooks/useDomains";
import { DomainConnectInstructions } from "@/components/domains/DomainConnectInstructions";
import { useProjects } from "@/hooks/useProjects";
import { useUsage } from "@/hooks/useUsage";
import { QuotaBadge, isQuotaAtLimit } from "@/components/quota/QuotaBadge";
import { SubdomainModal } from "@/components/domains/SubdomainModal";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/datetime";
import { useTimezone } from "@/hooks/useSystemSettings";
import { refreshIconClassName } from "@/hooks/useRefreshAnimation";
import type { DomainResponse, DomainStatus } from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// Helpers & Types
// ---------------------------------------------------------------------------

function formatDate(date: Date | string, timezone?: string) {
  return formatDateTime(date, timezone);
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

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function DomainListSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="border border-border">
          <CardHeader className="space-y-2 pb-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-6 w-3/4" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <div className="pt-2 flex justify-between">
              <Skeleton className="h-8 w-24 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function DomainsPage() {
  const {
    domains,
    isLoading,
    isRefreshing,
    refresh,
    createDomain,
    updateDomain,
    verifyDomain,
    deleteDomain,
  } = useDomains();

  const { projects } = useProjects();
  const { usage, isLoading: isUsageLoading } = useUsage();
  const timezone = useTimezone();

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [projectFilter, setProjectFilter] = useState<string>("ALL");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");

  // Add root domain modal state
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newHostname, setNewHostname] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("none");
  const [isAdding, setIsAdding] = useState(false);

  // Subdomain modal state
  const [subdomainModalOpen, setSubdomainModalOpen] = useState(false);
  const [subdomainParentId, setSubdomainParentId] = useState<string | undefined>();

  // Accordion state for expanded domains (to see subdomains)
  const [expandedDomainIds, setExpandedDomainIds] = useState<Record<string, boolean>>({});

  // Instructions modal state
  const [instructionsDomain, setInstructionsDomain] = useState<DomainResponse | null>(null);
  const [instructionsModalOpen, setInstructionsModalOpen] = useState(false);

  // Verification in-progress state
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  // Delete modal state
  const [deleteTarget, setDeleteTarget] = useState<DomainResponse | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [assignmentTarget, setAssignmentTarget] = useState<DomainResponse | null>(null);
  const [assignmentProjectId, setAssignmentProjectId] = useState("none");
  const [isAssigning, setIsAssigning] = useState(false);
  const openAssignment = (domain: DomainResponse) => {
    setAssignmentTarget(domain);
    setAssignmentProjectId(domain.projectId ?? "none");
  };
  const handleAssignment = async () => {
    if (!assignmentTarget) return;
    setIsAssigning(true);
    try {
      await updateDomain(assignmentTarget.id, { projectId: assignmentProjectId === "none" ? null : assignmentProjectId });
      toast.success("Domain project updated");
      setAssignmentTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update domain project");
    } finally {
      setIsAssigning(false);
    }
  };

  const toggleExpand = (domainId: string) => {
    setExpandedDomainIds((prev) => ({
      ...prev,
      [domainId]: !prev[domainId],
    }));
  };

  // Filtered domains list
  const filteredDomains = useMemo(() => {
    return domains.filter((domain) => {
      // Search filter
      if (
        searchQuery &&
        !domain.hostname.toLowerCase().includes(searchQuery.toLowerCase())
      ) {
        return false;
      }

      // Status filter
      if (statusFilter !== "ALL" && domain.status !== statusFilter) {
        return false;
      }

      // Project filter
      if (projectFilter !== "ALL") {
        if (projectFilter === "UNASSIGNED") {
          if (domain.projectId) return false;
        } else if (domain.projectId !== projectFilter) {
          return false;
        }
      }

      // Type filter
      if (typeFilter !== "ALL") {
        const isWild = domain.hostname.startsWith("*.");
        if (typeFilter === "ROOT" && (domain.parentId || isWild)) return false;
        if (typeFilter === "SUBDOMAIN" && !domain.parentId) return false;
        if (typeFilter === "WILDCARD" && !isWild) return false;
      }


      return true;
    });
  }, [domains, searchQuery, statusFilter, projectFilter, typeFilter]);

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
        projectId: selectedProjectId === "none" ? undefined : selectedProjectId,
      });

      toast.success(`Domain "${cleanHostname}" created`);
      setNewHostname("");
      setSelectedProjectId("none");
      setAddModalOpen(false);

      // Open instructions modal if verification is needed
      if (created.status !== "ACTIVE") {
        setInstructionsDomain(created);
        setInstructionsModalOpen(true);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to add domain";
      toast.error(msg);
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
      const msg = err instanceof Error ? err.message : "Verification failed";
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
      const msg = err instanceof Error ? err.message : "Failed to remove domain";
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  };

  const openSubdomainModalFor = (parentId?: string) => {
    setSubdomainParentId(parentId);
    setSubdomainModalOpen(true);
  };

  return (
    <TooltipProvider delayDuration={200}>
    <div className="space-y-6">
      {/* ── Page Header ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Domains &amp; Subdomains
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage custom domain names, wildcard routes (`*.domain.com`), and automatic Traefik traffic proxies.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <QuotaBadge label="Domains" usage={usage?.domain} isLoading={isUsageLoading} className="mr-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={isRefreshing || isLoading}
            className="h-9 gap-1.5 text-xs font-medium"
          >
            <RefreshCw className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")} />
            Refresh
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => openSubdomainModalFor()}
            className="h-9 gap-1.5 text-xs font-medium"
          >
            <Layers className="h-3.5 w-3.5 text-primary" />
            Add Subdomain
          </Button>

          <Button
            id="add-domain-btn"
            size="sm"
            onClick={() => setAddModalOpen(true)}
            className="h-9 gap-1.5 text-xs font-medium"
            disabled={isQuotaAtLimit(usage?.domain)}
            title={isQuotaAtLimit(usage?.domain) ? "You've reached your domain limit" : undefined}
          >
            <Plus className="h-3.5 w-3.5" />
            Add Domain
          </Button>
        </div>
      </div>

      <Separator />

      {/* ── Filter Bar ────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search domains or subdomains…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-9 text-xs"
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Type filter */}
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 w-full sm:w-35 text-xs">
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Types</SelectItem>
              <SelectItem value="ROOT">Apex Domains</SelectItem>
              <SelectItem value="SUBDOMAIN">Subdomains</SelectItem>
              <SelectItem value="WILDCARD">Wildcards</SelectItem>
            </SelectContent>
          </Select>

          {/* Status filter */}
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-full sm:w-37.5 text-xs">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Statuses</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="ERROR">Verification Failed</SelectItem>
            </SelectContent>
          </Select>

          {/* Project filter */}
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="h-9 w-full sm:w-40 text-xs">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Projects</SelectItem>
              <SelectItem value="UNASSIGNED">Unassigned</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Domains List ──────────────────────────────────────────────────── */}
      {isLoading ? (
        <DomainListSkeleton />
      ) : filteredDomains.length === 0 ? (
        <Card className="border border-dashed border-border py-12 text-center">
          <CardContent className="flex flex-col items-center justify-center p-0">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Globe className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-sm font-semibold text-foreground">
              {searchQuery || statusFilter !== "ALL" || projectFilter !== "ALL" || typeFilter !== "ALL"
                ? "No matching domains found"
                : "No custom domains or subdomains yet"}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground max-w-sm">
              {searchQuery || statusFilter !== "ALL" || projectFilter !== "ALL" || typeFilter !== "ALL"
                ? "Try adjusting your search or filters."
                : "Attach a custom domain or configure subdomains to route traffic directly to your projects."}
            </p>
            {!searchQuery && statusFilter === "ALL" && projectFilter === "ALL" && typeFilter === "ALL" && (
              <div className="flex items-center gap-2 mt-4">
                <Button
                  size="sm"
                  onClick={() => setAddModalOpen(true)}
                  className="h-8 text-xs font-medium"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add Your First Domain
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredDomains.map((domain) => {
            const statusCfg = STATUS_CONFIG[domain.status] ?? STATUS_CONFIG.PENDING;
            const StatusIcon = statusCfg.icon;
            const isVerifying = verifyingId === domain.id;
            const isWildcard = domain.hostname.startsWith("*.");
            const hasSubdomains = Boolean(domain.subdomains && domain.subdomains.length > 0);
            const isExpanded = Boolean(expandedDomainIds[domain.id]);

            return (
              <Card
                key={domain.id}
                className="border border-border flex flex-col justify-between hover:border-border/80 transition-colors"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge
                        variant="outline"
                        className={cn("gap-1 text-[10px] font-medium py-0.5 px-2", statusCfg.className)}
                      >
                        <StatusIcon className="h-3 w-3" />
                        {statusCfg.label}
                      </Badge>

                      {isWildcard && (
                        <Badge
                          variant="secondary"
                          className="gap-1 text-[10px] bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20"
                        >
                          <Sparkles className="h-2.5 w-2.5" />
                          Wildcard
                        </Badge>
                      )}

                      {domain.parentId && (
                        <Badge
                          variant="outline"
                          className="text-[10px] text-blue-600 dark:text-blue-400 border-blue-500/20"
                        >
                          Subdomain
                        </Badge>
                      )}

                      {domain.sslEnabled ? (
                        <Badge
                          variant="outline"
                          className={cn(
                            "gap-1 text-[10px] font-medium py-0.5 px-2",
                            domain.certificate?.isExpiringSoon
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                              : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
                          )}
                        >
                          <Lock className="h-2.5 w-2.5" />
                          {domain.certificate?.isExpiringSoon ? "SSL Expiring" : "SSL Active"}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="gap-1 text-[10px] font-medium py-0.5 px-2 bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20"
                        >
                          <Unlock className="h-2.5 w-2.5" />
                          No SSL
                        </Badge>
                      )}
                    </div>

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget(domain)}
                      className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Delete domain"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  <div className="mt-2 flex items-center gap-1.5">
                    <CardTitle className="font-mono text-base font-semibold truncate">
                      {domain.hostname}
                    </CardTitle>

                    {domain.status === "ACTIVE" && !isWildcard && (
                      <a
                        href={`http://${domain.hostname}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-primary transition-colors shrink-0"
                        title="Open domain"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>

                  {domain.parent && (
                    <div className="text-[11px] text-muted-foreground font-mono">
                      ↳ of {domain.parent.hostname}
                    </div>
                  )}

                  <CardDescription className="text-xs flex items-center gap-1.5 mt-1">
                    <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {domain.project ? (
                      <Link
                        href={`/projects/${domain.project.id}`}
                        className="truncate text-foreground hover:underline font-medium"
                      >
                        {domain.project.name}
                      </Link>
                    ) : (
                      <span className="italic text-muted-foreground">Unassigned</span>
                    )}
                  </CardDescription>
                  <Button variant="outline" size="sm" onClick={() => openAssignment(domain)}>
                    {domain.projectId ? "Change project" : "Assign to project"}
                  </Button>
                </CardHeader>

                <CardContent className="space-y-3 pt-0">
                  <div className="rounded-md border border-border bg-muted/30 p-2.5 text-[11px] space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Traefik Routing:</span>
                      <span className="font-medium text-foreground">
                        {domain.status === "ACTIVE" && domain.projectId
                          ? isWildcard
                            ? "Wildcard Priority 10"
                            : "Direct Priority 100"
                          : "Disabled"}
                      </span>
                    </div>
                    {domain.pathPrefix && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Path Prefix:</span>
                        <span className="font-mono text-foreground">{domain.pathPrefix}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Added:</span>
                      <span className="text-foreground">{formatDate(domain.createdAt, timezone)}</span>
                    </div>
                  </div>

                  {/* Subdomains section if this is a parent domain */}
                  {!domain.parentId && !isWildcard && (
                    <div className="rounded-md border border-border/80 p-2 text-xs space-y-2 bg-card">
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => toggleExpand(domain.id)}
                          className="flex items-center gap-1 text-[11px] font-medium text-foreground hover:text-primary transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                          <span>Subdomains ({domain.subdomains?.length ?? 0})</span>
                        </button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openSubdomainModalFor(domain.id)}
                          className="h-6 px-1.5 text-[10px] text-primary hover:text-primary gap-1"
                        >
                          <Plus className="h-3 w-3" />
                          Add Subdomain
                        </Button>
                      </div>

                      {isExpanded && (
                        <div className="pt-1 space-y-1.5 border-t border-border/60">
                          {hasSubdomains ? (
                            domain.subdomains!.map((sub) => (
                              <div
                                key={sub.id}
                                className="flex items-center justify-between gap-1 text-[11px] rounded bg-muted/40 p-1.5"
                              >
                                <div className="truncate font-mono font-medium">
                                  {sub.hostname}
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  {sub.project && (
                                    <span className="text-[10px] text-muted-foreground">
                                      {sub.project.name}
                                    </span>
                                  )}
                                  <Button variant="ghost" size="sm" onClick={() => openAssignment(sub)}>
                                    {sub.projectId ? "Change project" : "Assign"}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setDeleteTarget(sub)}
                                    className="h-5 w-5 text-muted-foreground hover:text-destructive"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className="text-[11px] text-muted-foreground italic py-1">
                              No subdomains yet. Click &ldquo;Add Subdomain&rdquo; to attach subdomains or wildcards.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-col gap-2 pt-1">
                    <div className="flex items-center justify-between gap-2">
                      {domain.dnsMode === "MANAGED" && (
                        <Button
                          asChild
                          variant="outline"
                          size="sm"
                          className="h-8 flex-1 text-xs gap-1.5 font-medium hover:text-primary"
                        >
                          <Link href={`/domains/${domain.id}/dns`}>
                            <Server className="h-3.5 w-3.5 text-indigo-500" />
                            DNS Records
                          </Link>
                        </Button>
                      )}

                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="h-8 flex-1 text-xs gap-1.5 font-medium hover:text-primary"
                      >
                        <Link href={`/domains/${domain.id}/ssl`}>
                          <Lock className="h-3.5 w-3.5 text-emerald-500" />
                          Manage SSL
                        </Link>
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setInstructionsDomain(domain);
                          setInstructionsModalOpen(true);
                        }}
                        className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
                        title="DNS Verification Challenge"
                      >
                        <HelpCircle className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    {domain.status !== "ACTIVE" && (
                      <Button
                        size="sm"
                        onClick={() => void handleVerify(domain)}
                        disabled={isVerifying}
                        className="h-8 w-full text-xs"
                      >
                        {isVerifying ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Verifying…
                          </>
                        ) : (
                          "Verify"
                        )}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Subdomain Modal ────────────────────────────────────────────────── */}
      <SubdomainModal
        open={subdomainModalOpen}
        onOpenChange={setSubdomainModalOpen}
        parentDomains={domains}
        projects={projects}
        defaultParentId={subdomainParentId}
        createDomain={createDomain}
        onCreated={() => void refresh()}
      />

      {/* ── Add Domain Modal ──────────────────────────────────────────────── */}
      <Dialog open={Boolean(assignmentTarget)} onOpenChange={(open) => !isAssigning && !open && setAssignmentTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{assignmentTarget?.projectId ? "Change project" : "Assign to project"}</DialogTitle>
            <DialogDescription>
              Update the project for {assignmentTarget?.hostname}. Saving changes web traffic routing.
              DNS records, verification, certificates, and mail stay attached to this domain.
              {assignmentTarget?.projectId && ` Current project: ${assignmentTarget.project?.name ?? assignmentTarget.projectId}.`}
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="assignment-project">Project</Label>
          <select id="assignment-project" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={assignmentProjectId} onChange={(e) => setAssignmentProjectId(e.target.value)} disabled={isAssigning}>
            <option value="none">None (Unassigned)</option>
            {projects.filter((p) => p.status !== "DELETED").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <DialogFooter>
            <Button variant="outline" disabled={isAssigning} onClick={() => setAssignmentTarget(null)}>Cancel</Button>
            <Button disabled={isAssigning || assignmentProjectId === (assignmentTarget?.projectId ?? "none")} onClick={() => void handleAssignment()}>
              {isAssigning ? "Saving..." : "Save project assignment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={addModalOpen} onOpenChange={setAddModalOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleAddDomain}>
            <DialogHeader>
              <DialogTitle>Add Custom Domain</DialogTitle>
              <DialogDescription>
                Connect an apex domain or custom domain to route incoming web requests to one of your projects.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="global-domain-hostname">Domain Name</Label>
                <Input
                  id="global-domain-hostname"
                  placeholder="e.g. example.com or app.mycompany.com"
                  value={newHostname}
                  onChange={(e) => setNewHostname(e.target.value)}
                  disabled={isAdding}
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground">
                  Do not include http://, https://, or slashes.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="global-project-select">Target Project</Label>
                <Select
                  value={selectedProjectId}
                  onValueChange={setSelectedProjectId}
                  disabled={isAdding}
                >
                  <SelectTrigger id="global-project-select">
                    <SelectValue placeholder="Select target project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (Unassigned)</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Traefik routes requests on this domain directly to the selected project&rsquo;s container.
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
              Add these DNS records at your registrar (e.g. Cloudflare, Namecheap, GoDaddy).
            </DialogDescription>
          </DialogHeader>

          {instructionsDomain && (
            <DomainConnectInstructions domain={instructionsDomain} showDnsHostingLink />
          )}

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
            <DialogTitle>Delete Domain</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove &ldquo;{deleteTarget?.hostname}&rdquo;?
              Traffic routing via Traefik will be disabled immediately.
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
              Delete Domain
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}
