"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  Server,
  Plus,
  Search,
  RefreshCw,
  Copy,
  Check,
  Trash2,
  Edit2,
  Download,
  Upload,
  Activity,
  CheckCircle2,
  Clock,
  Sparkles,
  FileCode,
  ShieldCheck,
  Mail,
  Network,
  Globe,
  ExternalLink,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { useDnsRecords } from "@/hooks/useDnsRecords";
import { useDnsMode } from "@/hooks/useDnsMode";
import { DnsHostingOptIn } from "@/components/domains/DnsHostingOptIn";
import { cn } from "@/lib/utils";
import { refreshIconClassName } from "@/hooks/useRefreshAnimation";
import type {
  DomainResponse,
  DnsRecordResponse,
  DnsRecordType,
  DnsPropagationResponse,
} from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// Type badge configurations
// ---------------------------------------------------------------------------

const TYPE_CONFIG: Record<
  DnsRecordType,
  { label: string; className: string; placeholder: string; helper: string }
> = {
  A: {
    label: "A",
    className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    placeholder: "192.0.2.1",
    helper: "IPv4 address target",
  },
  AAAA: {
    label: "AAAA",
    className: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
    placeholder: "2001:db8::1",
    helper: "IPv6 address target",
  },
  CNAME: {
    label: "CNAME",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    placeholder: "target.example.com",
    helper: "Canonical domain name alias (cannot be apex @)",
  },
  MX: {
    label: "MX",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    placeholder: "mail.example.com",
    helper: "Mail exchange server hostname",
  },
  TXT: {
    label: "TXT",
    className: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
    placeholder: "v=spf1 include:_spf.example.com ~all",
    helper: "Arbitrary text, SPF, DKIM, or verification tokens",
  },
  NS: {
    label: "NS",
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
    placeholder: "ns1.vexlyx.com",
    helper: "Authoritative nameserver for zone delegation",
  },
  SRV: {
    label: "SRV",
    className: "bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20",
    placeholder: "sipserver.example.com",
    helper: "Service locator target hostname",
  },
};

const TTL_PRESETS = [
  { label: "1 min (60s)", value: 60 },
  { label: "5 min (300s)", value: 300 },
  { label: "30 min (1800s)", value: 1800 },
  { label: "1 hour (3600s)", value: 3600 },
  { label: "1 day (86400s)", value: 86400 },
];

function formatTtl(ttl: number): string {
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

export default function DomainDnsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const domainId = params?.id;

  // Domain details state
  const [domain, setDomain] = useState<DomainResponse | null>(null);
  const [isDomainLoading, setIsDomainLoading] = useState(true);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  // Hook for DNS records
  const {
    records,
    isLoading: isRecordsLoading,
    isRefreshing,
    refresh,
    createRecord,
    updateRecord,
    deleteRecord,
    initializeDefaults,
    exportZone,
    importZone,
    checkPropagation,
  } = useDnsRecords({
    domainId,
    autoFetch: Boolean(domainId) && domain?.dnsMode === "MANAGED",
  });

  const isManaged = domain?.dnsMode === "MANAGED";
  const { delegation, isSwitching, setMode } = useDnsMode(isManaged ? domainId : undefined);
  const [stopDialogOpen, setStopDialogOpen] = useState(false);

  // Filter & Search states
  const [selectedType, setSelectedType] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  // Record Form Modal (Add / Edit)
  const [formOpen, setFormOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<DnsRecordResponse | null>(null);
  const [formType, setFormType] = useState<DnsRecordType>("A");
  const [formName, setFormName] = useState("@");
  const [formValue, setFormValue] = useState("");
  const [formTtl, setFormTtl] = useState(3600);
  const [formPriority, setFormPriority] = useState<number | undefined>(10);
  const [formWeight, setFormWeight] = useState<number | undefined>(10);
  const [formPort, setFormPort] = useState<number | undefined>(5060);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Propagation Modal
  const [propagationModalOpen, setPropagationModalOpen] = useState(false);
  const [propagationResult, setPropagationResult] = useState<DnsPropagationResponse | null>(null);
  const [isCheckingPropagation, setIsCheckingPropagation] = useState(false);

  // Zone Import Modal
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [zoneText, setZoneText] = useState("");
  const [importStrategy, setImportStrategy] = useState<"skip" | "replace">("skip");
  const [isImporting, setIsImporting] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<DnsRecordResponse | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Fetch domain details
  const fetchDomain = useCallback(async () => {
    if (!domainId) return;
    setIsDomainLoading(true);
    try {
      const data = await fetchAPI<DomainResponse>(`/api/domains/${domainId}`);
      setDomain(data);
    } catch (err) {
      const msg = err instanceof ApiRequestError ? err.message : "Failed to load domain";
      toast.error(msg);
      router.push("/domains");
    } finally {
      setIsDomainLoading(false);
    }
  }, [domainId, router]);

  useEffect(() => {
    void fetchDomain();
  }, [fetchDomain]);

  // Copy helper
  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedValue(text);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedValue(null), 2000);
  };

  // Filtered records
  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      if (selectedType !== "ALL" && r.type !== selectedType) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          r.name.toLowerCase().includes(q) ||
          r.value.toLowerCase().includes(q) ||
          r.type.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [records, selectedType, searchQuery]);

  // Metric helpers
  const primaryA = records.find((r) => r.type === "A" && r.name === "@");
  const mxCount = records.filter((r) => r.type === "MX").length;

  // Handlers
  const openCreateModal = () => {
    setEditingRecord(null);
    setFormType("A");
    setFormName("@");
    setFormValue("");
    setFormTtl(3600);
    setFormPriority(10);
    setFormWeight(10);
    setFormPort(5060);
    setFormOpen(true);
  };

  const openEditModal = (rec: DnsRecordResponse) => {
    setEditingRecord(rec);
    setFormType(rec.type);
    setFormName(rec.name);
    setFormValue(rec.value);
    setFormTtl(rec.ttl);
    setFormPriority(rec.priority ?? 10);
    setFormWeight(rec.weight ?? 10);
    setFormPort(rec.port ?? 5060);
    setFormOpen(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formValue.trim()) {
      toast.error("Please enter a record value");
      return;
    }

    setIsSubmitting(true);
    try {
      if (editingRecord) {
        await updateRecord(editingRecord.id, {
          name: formName.trim(),
          value: formValue.trim(),
          ttl: formTtl,
          priority: formType === "MX" || formType === "SRV" ? formPriority : null,
          weight: formType === "SRV" ? formWeight : null,
          port: formType === "SRV" ? formPort : null,
        });
        toast.success(`Updated ${formType} record for ${formName}`);
      } else {
        await createRecord({
          type: formType,
          name: formName.trim(),
          value: formValue.trim(),
          ttl: formTtl,
          priority: formType === "MX" || formType === "SRV" ? formPriority : null,
          weight: formType === "SRV" ? formWeight : null,
          port: formType === "SRV" ? formPort : null,
        });
        toast.success(`Added ${formType} record for ${formName}`);
      }
      setFormOpen(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save DNS record");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteRecord = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteRecord(deleteTarget.id);
      toast.success(`Deleted ${deleteTarget.type} record "${deleteTarget.name}"`);
      setDeleteTarget(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete record");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleInitDefaults = async () => {
    try {
      await initializeDefaults();
      toast.success("Recommended DNS records configured (Apex A, www CNAME, NS)");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to initialize default records");
    }
  };

  const handleExportZone = async () => {
    try {
      const content = await exportZone();
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${domain?.hostname || "zone"}.zone`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Zone file downloaded");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to export zone file");
    }
  };

  const handleImportSubmit = async () => {
    if (!zoneText.trim()) {
      toast.error("Please paste zone file content");
      return;
    }
    setIsImporting(true);
    try {
      const res = await importZone(zoneText, importStrategy);
      toast.success(`Successfully imported ${res.importedCount} DNS records`);
      if (res.errors.length > 0) {
        toast.warning(`${res.errors.length} non-critical lines skipped`);
      }
      setZoneText("");
      setImportModalOpen(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to import zone file");
    } finally {
      setIsImporting(false);
    }
  };

  const handleTestPropagation = async (rec: DnsRecordResponse) => {
    setIsCheckingPropagation(true);
    setPropagationModalOpen(true);
    setPropagationResult(null);
    try {
      const res = await checkPropagation(rec.id);
      setPropagationResult(res);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Propagation test failed");
    } finally {
      setIsCheckingPropagation(false);
    }
  };

  const handleStopHosting = async () => {
    try {
      await setMode("CONNECTED");
      toast.success("DNS is back with your own provider");
      setStopDialogOpen(false);
      await fetchDomain();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to stop DNS hosting");
    }
  };

  if (isDomainLoading || !domain) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-28 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (domain.dnsMode !== "MANAGED") {
    return <DnsHostingOptIn domain={domain} onEnabled={() => void fetchDomain()} />;
  }

  return (
    <div className="space-y-6 pb-12">
      {/* ----------------------------------------------------------------- */}
      {/* Breadcrumb Navigation */}
      {/* ----------------------------------------------------------------- */}
      <div className="flex items-center justify-between">
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
          <span className="text-foreground">DNS Zone Management</span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={isRefreshing || isRecordsLoading}
            className="h-8 text-xs gap-1.5"
          >
            <RefreshCw className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")} />
            Refresh
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleExportZone}
            className="h-8 text-xs gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Export Zone
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportModalOpen(true)}
            className="h-8 text-xs gap-1.5"
          >
            <Upload className="h-3.5 w-3.5" />
            Import Zone
          </Button>

          <Button
            size="sm"
            onClick={openCreateModal}
            className="h-8 text-xs gap-1.5 font-medium bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Record
          </Button>
        </div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Page Header Banner */}
      {/* ----------------------------------------------------------------- */}
      <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                <Server className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold font-mono tracking-tight text-foreground">
                    {domain.hostname}
                  </h1>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => copyText(domain.hostname)}
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    title="Copy hostname"
                  >
                    {copiedValue === domain.hostname ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <a
                    href={`http://${domain.hostname}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-primary transition-colors"
                    title="Visit domain"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
                <p className="text-xs text-muted-foreground">
                  Authoritative DNS zone served by Vexlyx&rsquo;s CoreDNS nameservers.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="rounded-md border border-border bg-muted/40 p-2 text-xs flex items-center gap-2">
              <span className="text-muted-foreground font-medium">Nameservers:</span>
              {(delegation?.expected ?? []).map((ns) => (
                <Badge key={ns} variant="outline" className="font-mono text-[11px] py-0 px-1.5">
                  {ns}
                </Badge>
              ))}
            </div>

            <Badge
              variant="secondary"
              className="gap-1.5 text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 py-1 px-2.5"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              CoreDNS Authoritative
            </Badge>
          </div>
        </div>
      </div>

      {delegation?.configured && !delegation.delegated && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-700 dark:text-amber-400">
          <span className="font-medium">Not live yet.</span> Nameservers for {domain.hostname} still
          point at {delegation.found.length > 0 ? delegation.found.join(", ") : "another provider"}.
          Records below are served only after you set your registrar&rsquo;s nameservers to{" "}
          <span className="font-mono">{delegation.expected.join(", ")}</span>.
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Hosting status + opt-out */}
      {/* ----------------------------------------------------------------- */}
      <div className="flex flex-col gap-3 rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <Network className="h-4 w-4 shrink-0 text-indigo-500 mt-0.5" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Vexlyx is the authoritative DNS host for {domain.hostname}. If you&rsquo;d rather keep
            DNS at your own registrar or provider, you can stop hosting here.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setStopDialogOpen(true)}
          className="h-8 shrink-0 text-xs"
        >
          Stop hosting DNS
        </Button>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Zone Overview Metric Cards */}
      {/* ----------------------------------------------------------------- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border border-border bg-card">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-medium flex items-center gap-1.5">
              <FileCode className="h-3.5 w-3.5 text-indigo-500" />
              Total Records
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono">
              {records.length}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[11px] text-muted-foreground">
              Configured resource records in zone file
            </p>
          </CardContent>
        </Card>

        <Card className="border border-border bg-card">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-medium flex items-center gap-1.5">
              <Network className="h-3.5 w-3.5 text-blue-500" />
              Apex A Record
            </CardDescription>
            <CardTitle className="text-base font-bold font-mono truncate" title={primaryA?.value || "Not Set"}>
              {primaryA ? primaryA.value : "Unassigned"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[11px] text-muted-foreground">
              {primaryA ? `Resolves @ to host IP (TTL ${formatTtl(primaryA.ttl)})` : "No root @ A record found"}
            </p>
          </CardContent>
        </Card>

        <Card className="border border-border bg-card">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-medium flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5 text-amber-500" />
              Mail Routing (MX)
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono">
              {mxCount}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[11px] text-muted-foreground">
              {mxCount > 0 ? `${mxCount} mail exchange servers configured` : "Email routing not configured"}
            </p>
          </CardContent>
        </Card>

        <Card className="border border-border bg-card">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-medium flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-emerald-500" />
              Zone Reload Status
            </CardDescription>
            <CardTitle className="text-base font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              Synchronized
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[11px] text-muted-foreground">
              Auto-reloaded to CoreDNS within 5s
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Records Table Section */}
      {/* ----------------------------------------------------------------- */}
      <Card className="border border-border bg-card shadow-sm">
        <CardHeader className="pb-4 border-b border-border">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            {/* Filter Pills */}
            <div className="flex flex-wrap items-center gap-1 w-full lg:w-auto">
              {["ALL", "A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"].map((type) => {
                const isSelected = selectedType === type;
                return (
                  <button
                    key={type}
                    onClick={() => setSelectedType(type)}
                    type="button"
                    className={cn(
                      "px-3 py-1.5 text-xs rounded-md font-medium transition-colors whitespace-nowrap",
                      isSelected
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80",
                    )}
                  >
                    {type}
                    {type !== "ALL" && (
                      <span className="ml-1 text-[10px] opacity-70">
                        ({records.filter((r) => r.type === type).length})
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Search Bar & Default Preset Button */}
            <div className="flex flex-wrap gap-2 w-full lg:w-auto">
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search records by name/value..."
                  className="h-8 pl-8 text-xs bg-background"
                />
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={handleInitDefaults}
                className="h-8 w-full sm:w-auto text-xs gap-1.5"
                title="Initialize baseline web & NS records"
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                Recommended Defaults
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {isRecordsLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : records.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center justify-center">
              <FileCode className="h-12 w-12 text-muted-foreground mb-3 opacity-50" />
              <h3 className="text-base font-semibold text-foreground">No DNS records in zone</h3>
              <p className="text-xs text-muted-foreground max-w-md mt-1 mb-5">
                This domain has no DNS records configured on Vexlyx CoreDNS nameservers yet.
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleInitDefaults} className="h-8 text-xs gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-amber-300" />
                  Setup Recommended Records
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={openCreateModal}
                  className="h-8 text-xs"
                >
                  Add Custom Record
                </Button>
              </div>
            </div>
          ) : filteredRecords.length === 0 ? (
            <div className="p-12 text-center text-xs text-muted-foreground">
              No records matching filter &ldquo;{selectedType}&rdquo; or search query &ldquo;{searchQuery}&rdquo;.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-muted-foreground font-medium">
                    <th className="py-3 px-4 w-24">Type</th>
                    <th className="py-3 px-4 w-48">Name (Host)</th>
                    <th className="py-3 px-4">Value / Target</th>
                    <th className="py-3 px-4 w-28">TTL</th>
                    <th className="py-3 px-4 w-44 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {filteredRecords.map((record) => {
                    const cfg = TYPE_CONFIG[record.type] ?? TYPE_CONFIG.A;
                    // Most records store a zone-relative name (e.g. "www"), but some
                    // (like the auto-created verification TXT record) already store the
                    // full hostname — appending the domain suffix again would duplicate it.
                    const isFullyQualified =
                      record.name === domain.hostname || record.name.endsWith(`.${domain.hostname}`);
                    return (
                      <tr
                        key={record.id}
                        className="hover:bg-muted/20 transition-colors group align-top"
                      >
                        {/* Type */}
                        <td className="py-3 px-4">
                          <Badge
                            variant="outline"
                            className={cn("text-[10px] font-mono font-semibold px-2 py-0.5", cfg.className)}
                          >
                            {record.type}
                          </Badge>
                        </td>

                        {/* Name */}
                        <td className="py-3 px-4 font-mono font-medium text-foreground break-all">
                          <span>{record.name}</span>
                          {record.name !== "@" && !isFullyQualified && (
                            <span className="text-muted-foreground font-normal text-[11px]">
                              .{domain.hostname}
                            </span>
                          )}
                        </td>

                        {/* Value */}
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2 max-w-lg">
                            <span
                              className="font-mono truncate text-foreground text-xs select-all"
                              title={record.value}
                            >
                              {record.value}
                            </span>

                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => copyText(record.value)}
                              className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                              title="Copy value"
                            >
                              {copiedValue === record.value ? (
                                <Check className="h-3 w-3 text-emerald-500" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </Button>

                            {(record.type === "MX" || record.type === "SRV") && (
                              <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-mono shrink-0">
                                pri:{record.priority}
                                {record.port ? ` port:${record.port}` : ""}
                              </Badge>
                            )}
                          </div>
                        </td>

                        {/* TTL */}
                        <td className="py-3 px-4 text-muted-foreground font-mono">
                          {formatTtl(record.ttl)}
                        </td>

                        {/* Actions */}
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void handleTestPropagation(record)}
                              className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                              title="Test live DNS propagation"
                            >
                              <Activity className="h-3 w-3" />
                              Test
                            </Button>

                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openEditModal(record)}
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              title="Edit record"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </Button>

                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setDeleteTarget(record)}
                              className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              title="Delete record"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------- */}
      {/* Add / Edit Record Dialog */}
      {/* ------------------------------------------------------------------- */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-md p-6">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {editingRecord ? `Edit ${formType} Record` : `Add DNS Record`}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Configure zone record details for {domain.hostname}.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleFormSubmit} className="space-y-4 pt-2">
            {/* Record Type */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Record Type</Label>
              <Select
                value={formType}
                onValueChange={(val) => setFormType(val as DnsRecordType)}
                disabled={Boolean(editingRecord)}
              >
                <SelectTrigger className="h-9 text-xs font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"] as DnsRecordType[]).map((t) => (
                    <SelectItem key={t} value={t} className="text-xs font-mono">
                      <span className="font-bold mr-2">{t}</span>
                      <span className="text-muted-foreground text-[11px]">
                        ({TYPE_CONFIG[t]?.helper})
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Name */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">Name (Host)</Label>
                <span className="text-[11px] text-muted-foreground">Use @ for apex root</span>
              </div>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="@, www, mail, or _sip._tcp"
                className="h-9 text-xs font-mono"
                required
              />
            </div>

            {/* Value */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Value (Target / Content)</Label>
              {formType === "TXT" ? (
                <Textarea
                  value={formValue}
                  onChange={(e) => setFormValue(e.target.value)}
                  placeholder={TYPE_CONFIG[formType]?.placeholder}
                  className="min-h-[80px] text-xs font-mono"
                  required
                />
              ) : (
                <Input
                  value={formValue}
                  onChange={(e) => setFormValue(e.target.value)}
                  placeholder={TYPE_CONFIG[formType]?.placeholder}
                  className="h-9 text-xs font-mono"
                  required
                />
              )}
              <p className="text-[10px] text-muted-foreground">
                {TYPE_CONFIG[formType]?.helper}
              </p>
            </div>

            {/* MX Specific: Priority */}
            {formType === "MX" && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Priority</Label>
                <Input
                  type="number"
                  min="0"
                  max="65535"
                  value={formPriority ?? 10}
                  onChange={(e) => setFormPriority(parseInt(e.target.value, 10))}
                  placeholder="10"
                  className="h-9 text-xs font-mono"
                  required
                />
              </div>
            )}

            {/* SRV Specific: Priority, Weight, Port */}
            {formType === "SRV" && (
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">Priority</Label>
                  <Input
                    type="number"
                    min="0"
                    max="65535"
                    value={formPriority ?? 10}
                    onChange={(e) => setFormPriority(parseInt(e.target.value, 10))}
                    className="h-8 text-xs font-mono"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Weight</Label>
                  <Input
                    type="number"
                    min="0"
                    max="65535"
                    value={formWeight ?? 10}
                    onChange={(e) => setFormWeight(parseInt(e.target.value, 10))}
                    className="h-8 text-xs font-mono"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Port</Label>
                  <Input
                    type="number"
                    min="1"
                    max="65535"
                    value={formPort ?? 5060}
                    onChange={(e) => setFormPort(parseInt(e.target.value, 10))}
                    className="h-8 text-xs font-mono"
                    required
                  />
                </div>
              </div>
            )}

            {/* TTL */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">TTL (Time to Live)</Label>
              <Select
                value={formTtl.toString()}
                onValueChange={(val) => setFormTtl(parseInt(val, 10))}
              >
                <SelectTrigger className="h-9 text-xs font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTL_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value.toString()} className="text-xs font-mono">
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setFormOpen(false)}
                className="h-8 text-xs"
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isSubmitting} className="h-8 text-xs font-medium">
                {isSubmitting ? "Saving..." : editingRecord ? "Update Record" : "Create Record"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------------------- */}
      {/* Propagation Check Dialog */}
      {/* ------------------------------------------------------------------- */}
      <Dialog open={propagationModalOpen} onOpenChange={setPropagationModalOpen}>
        <DialogContent className="max-w-md p-6">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-indigo-500" />
              <DialogTitle className="text-base font-semibold">DNS Propagation Check</DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground">
              Querying public resolvers across the internet to verify live resolution.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {isCheckingPropagation ? (
              <div className="space-y-2 py-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : propagationResult ? (
              <>
                <div className="rounded-md border border-border p-3 bg-muted/30 text-xs space-y-1 font-mono">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Target FQDN:</span>
                    <span className="text-foreground font-semibold">
                      {propagationResult.recordName === "@"
                        ? domain.hostname
                        : `${propagationResult.recordName}.${domain.hostname}`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Expected Value:</span>
                    <span className="text-foreground">{propagationResult.expectedValue}</span>
                  </div>
                  <div className="flex justify-between items-center pt-1">
                    <span className="text-muted-foreground">Global Status:</span>
                    {propagationResult.isFullyPropagated ? (
                      <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[10px] gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Fully Propagated
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-[10px] gap-1">
                        <Clock className="h-3 w-3" /> Propagating / In Progress
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium">Resolver Results</Label>
                  <div className="space-y-1.5">
                    {propagationResult.resolvers.map((res, i) => (
                      <div
                        key={i}
                        className="rounded-md border border-border p-2.5 flex items-center justify-between text-xs"
                      >
                        <div>
                          <div className="font-medium text-foreground">{res.resolver}</div>
                          <div className="text-[11px] font-mono text-muted-foreground">
                            {res.detectedValues.length > 0
                              ? res.detectedValues.join(", ")
                              : res.error || "No answer returned"}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {res.latencyMs}ms
                          </span>
                          {res.status === "MATCH" ? (
                            <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[10px] py-0">
                              Match
                            </Badge>
                          ) : res.status === "MISMATCH" ? (
                            <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-[10px] py-0">
                              Mismatch
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px] py-0">
                              Pending
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPropagationModalOpen(false)}
              className="h-8 text-xs"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------------------- */}
      {/* Zone File Import Dialog */}
      {/* ------------------------------------------------------------------- */}
      <Dialog open={importModalOpen} onOpenChange={setImportModalOpen}>
        <DialogContent className="max-w-lg p-6">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Import RFC 1035 Zone File</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Paste standard BIND/RFC 1035 zone file content to import records into {domain.hostname}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Zone File Content</Label>
              <Textarea
                value={zoneText}
                onChange={(e) => setZoneText(e.target.value)}
                placeholder={`; Paste zone text here\n$ORIGIN ${domain.hostname}.\n$TTL 3600\n@ IN A 192.0.2.1\nwww IN CNAME @\nmail IN A 192.0.2.2\n@ IN MX 10 mail`}
                className="min-h-[160px] text-xs font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Conflict Resolution</Label>
              <Select
                value={importStrategy}
                onValueChange={(val) => setImportStrategy(val as "skip" | "replace")}
              >
                <SelectTrigger className="h-9 text-xs font-medium">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip" className="text-xs">
                    Skip existing (merge with existing records)
                  </SelectItem>
                  <SelectItem value="replace" className="text-xs">
                    Replace all (clear zone and import new records)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImportModalOpen(false)}
                className="h-8 text-xs"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleImportSubmit}
                disabled={isImporting}
                className="h-8 text-xs font-medium"
              >
                {isImporting ? "Importing..." : "Import Zone Records"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------------------- */}
      {/* Delete Record Confirmation Dialog */}
      {/* ------------------------------------------------------------------- */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm p-6">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-destructive">
              Delete DNS Record
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Are you sure you want to delete this {deleteTarget?.type} record for &ldquo;{deleteTarget?.name}&rdquo;? Traffic relying on this record will stop resolving.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteTarget(null)}
              className="h-8 text-xs"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteRecord}
              disabled={isDeleting}
              className="h-8 text-xs"
            >
              {isDeleting ? "Deleting..." : "Delete Record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stopDialogOpen} onOpenChange={setStopDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Stop hosting DNS on Vexlyx?</DialogTitle>
            <DialogDescription>
              Vexlyx will stop serving DNS for {domain.hostname}. Before confirming, point your
              nameservers back at your own provider and recreate any records you need there, or the
              domain will stop resolving. Your records here are kept if you enable hosting again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button type="button" variant="outline" onClick={() => setStopDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleStopHosting()}
              disabled={isSwitching}
            >
              Stop hosting DNS
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
