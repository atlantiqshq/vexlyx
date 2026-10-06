"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Database,
  Plus,
  Search,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  Eye,
  EyeOff,
  Trash2,
  Activity,
  Server,
  Layers,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderGit2,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
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
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { useUsage } from "@/hooks/useUsage";
import { QuotaBadge, isQuotaAtLimit } from "@/components/quota/QuotaBadge";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/datetime";
import { useTimezone } from "@/hooks/useSystemSettings";
import {
  useRefreshAnimation,
  refreshIconClassName,
} from "@/hooks/useRefreshAnimation";
import type {
  AdminerAvailability,
  DatabaseDetail,
  DatabaseListResponse,
  DatabaseType,
  Project,
} from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// Helpers & Types
// ---------------------------------------------------------------------------

function formatDate(date: Date | string, timezone?: string) {
  return formatDateTime(date, timezone);
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function DatabaseListSkeleton() {
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

export default function DatabasesPage() {
  const [databases, setDatabases] = useState<DatabaseDetail[]>([]);
  const [adminer, setAdminer] = useState<AdminerAvailability>({
    enabled: false,
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { isRefreshing, refresh } = useRefreshAnimation();
  const timezone = useTimezone();
  const [search, setSearch] = useState("");
  const [engineFilter, setEngineFilter] = useState<"ALL" | DatabaseType>("ALL");

  // Create modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState<DatabaseType>("POSTGRESQL");
  const [createProjectId, setCreateProjectId] = useState<string>("none");
  const [createAutoInject, setCreateAutoInject] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  // Credentials / detail modal state
  const [selectedDb, setSelectedDb] = useState<DatabaseDetail | null>(null);
  const [credentialsModalOpen, setCredentialsModalOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Connection test state
  const [testingDbId, setTestingDbId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    id: string;
    connected: boolean;
    latencyMs?: number;
    error?: string;
  } | null>(null);

  // Delete modal state
  const [deleteDb, setDeleteDb] = useState<DatabaseDetail | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const { usage, isLoading: isUsageLoading } = useUsage();

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------

  const fetchData = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoading(true);

    try {
      const [dbRes, projRes] = await Promise.all([
        fetchAPI<DatabaseListResponse>("/api/databases"),
        fetchAPI<{ projects: Project[] }>("/api/projects?limit=100").catch(
          () => ({
            projects: [],
          }),
        ),
      ]);
      setDatabases(dbRes.databases ?? []);
      setAdminer(dbRes.adminer);
      setProjects(projRes.projects ?? []);
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.message
          : "Failed to load databases",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleRefresh = () =>
    refresh(async () => {
      await fetchData(true);
      toast.success("Databases refreshed");
    });

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // ---------------------------------------------------------------------------
  // Copy Helper
  // ---------------------------------------------------------------------------

  const handleCopy = (text: string, field: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedField(null), 2000);
  };

  // ---------------------------------------------------------------------------
  // Create Database
  // ---------------------------------------------------------------------------

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) {
      toast.error("Database name is required");
      return;
    }

    setIsCreating(true);
    try {
      const created = await fetchAPI<DatabaseDetail>("/api/databases", {
        method: "POST",
        body: JSON.stringify({
          name: createName.trim(),
          type: createType,
          projectId: createProjectId === "none" ? undefined : createProjectId,
          autoInjectEnv: createProjectId !== "none" ? createAutoInject : false,
        }),
      });

      toast.success(`Database "${created.name}" provisioned successfully`);
      setCreateModalOpen(false);
      setCreateName("");
      setCreateProjectId("none");
      setCreateType("POSTGRESQL");
      void fetchData(true);

      // Open credentials view automatically for convenience
      setSelectedDb(created);
      setShowPassword(true);
      setCredentialsModalOpen(true);
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.message
          : "Failed to provision database",
      );
    } finally {
      setIsCreating(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Test Connection
  // ---------------------------------------------------------------------------

  const handleTestConnection = async (db: DatabaseDetail) => {
    setTestingDbId(db.id);
    setTestResult(null);

    try {
      const res = await fetchAPI<{
        connected: boolean;
        latencyMs?: number;
        error?: string;
      }>(`/api/databases/${db.id}/test`, {
        method: "POST",
      });

      setTestResult({
        id: db.id,
        connected: res.connected,
        latencyMs: res.latencyMs,
        error: res.error,
      });

      if (res.connected) {
        toast.success(`Connection healthy (${res.latencyMs}ms)`);
      } else {
        toast.error(`Connection failed: ${res.error ?? "Unknown error"}`);
      }
    } catch (err) {
      const msg =
        err instanceof ApiRequestError ? err.message : "Connection test failed";
      setTestResult({
        id: db.id,
        connected: false,
        error: msg,
      });
      toast.error(msg);
    } finally {
      setTestingDbId(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Delete Database
  // ---------------------------------------------------------------------------

  const handleDelete = async () => {
    if (!deleteDb) return;
    setIsDeleting(true);

    try {
      await fetchAPI(`/api/databases/${deleteDb.id}`, {
        method: "DELETE",
      });
      toast.success(`Database "${deleteDb.name}" deleted`);
      setDeleteDb(null);
      void fetchData(true);
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.message
          : "Failed to delete database",
      );
    } finally {
      setIsDeleting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Filtered list
  // ---------------------------------------------------------------------------

  const filteredDatabases = databases.filter((db) => {
    const matchesSearch =
      db.name.toLowerCase().includes(search.toLowerCase()) ||
      db.dbUser.toLowerCase().includes(search.toLowerCase()) ||
      (db.project?.name &&
        db.project.name.toLowerCase().includes(search.toLowerCase()));

    const matchesEngine = engineFilter === "ALL" || db.type === engineFilter;

    return matchesSearch && matchesEngine;
  });

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Databases
          </h1>
          <p className="text-sm text-muted-foreground">
            Provision and manage isolated PostgreSQL &amp; MySQL databases.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <QuotaBadge
            label="Databases"
            usage={usage?.database}
            isLoading={isUsageLoading}
          />
          {adminer.enabled && adminer.url ? (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="border-border text-foreground hover:bg-muted"
            >
              <a
                href={adminer.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2"
              >
                <ExternalLink className="h-4 w-4" />
                Open Adminer
              </a>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled
              title={adminer.disabledReason}
            >
              Adminer unavailable
            </Button>
          )}

          <Button
            id="create-database-btn"
            onClick={() => setCreateModalOpen(true)}
            size="sm"
            className="flex items-center gap-2"
            disabled={isQuotaAtLimit(usage?.database)}
            title={
              isQuotaAtLimit(usage?.database)
                ? "You've reached your database limit"
                : undefined
            }
          >
            <Plus className="h-4 w-4" />
            New Database
          </Button>
        </div>
      </div>

      <Separator />

      {/* Filter and search bar */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 items-center gap-3 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search databases, users, or projects…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-card border-border"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Engine filter toggle */}
          <div className="flex items-center rounded-lg border border-border bg-card p-1">
            <button
              onClick={() => setEngineFilter("ALL")}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                engineFilter === "ALL"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              All
            </button>
            <button
              onClick={() => setEngineFilter("POSTGRESQL")}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                engineFilter === "POSTGRESQL"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              PostgreSQL
            </button>
            <button
              onClick={() => setEngineFilter("MYSQL")}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                engineFilter === "MYSQL"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              MySQL
            </button>
          </div>

          {/* Refresh Button */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing || isLoading}
            aria-label="Refresh database list"
            className="border-border text-muted-foreground hover:text-foreground"
          >
            <RefreshCw
              className={refreshIconClassName(isRefreshing, "h-4 w-4")}
            />
          </Button>
        </div>
      </div>

      {/* Main Database Grid */}
      {isLoading ? (
        <DatabaseListSkeleton />
      ) : filteredDatabases.length === 0 ? (
        <Card className="border border-dashed border-border bg-card/50">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-4">
              <Database className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {search || engineFilter !== "ALL"
                ? "No matching databases found"
                : "No databases provisioned yet"}
            </h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {search || engineFilter !== "ALL"
                ? "Try adjusting your search criteria or clearing your active filters."
                : "Create isolated PostgreSQL or MySQL databases for your web applications with 1 click."}
            </p>
            {!search && engineFilter === "ALL" && (
              <Button
                onClick={() => setCreateModalOpen(true)}
                className="mt-6"
                size="sm"
              >
                <Plus className="mr-2 h-4 w-4" />
                Create Your First Database
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredDatabases.map((db) => {
            const isPg = db.type === "POSTGRESQL";
            const test = testResult?.id === db.id ? testResult : null;

            return (
              <Card
                key={db.id}
                className="flex flex-col justify-between border border-border bg-card transition-colors hover:border-border/80"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-xs font-semibold uppercase tracking-wider",
                        isPg
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
                          : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
                      )}
                    >
                      {isPg ? "PostgreSQL 16" : "MySQL 8.0"}
                    </Badge>

                    {test && (
                      <span
                        className={cn(
                          "flex items-center gap-1 text-xs font-medium",
                          test.connected ? "text-emerald-500" : "text-rose-500",
                        )}
                      >
                        {test.connected ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {test.latencyMs}ms
                          </>
                        ) : (
                          <>
                            <XCircle className="h-3.5 w-3.5" />
                            Failed
                          </>
                        )}
                      </span>
                    )}
                  </div>

                  <CardTitle className="pt-2 text-base font-semibold text-foreground flex items-center gap-2">
                    <Database className="h-4 w-4 text-primary shrink-0" />
                    <span className="truncate">{db.name}</span>
                  </CardTitle>

                  <CardDescription className="text-xs text-muted-foreground flex items-center gap-2">
                    <Server className="h-3 w-3 shrink-0" />
                    <span>
                      {db.internalHost}:{db.port}
                    </span>
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4 pt-0">
                  <div className="rounded-md border border-border/60 bg-muted/40 p-2.5 text-xs space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">User:</span>
                      <span className="font-mono text-foreground font-medium truncate max-w-[170px]">
                        {db.dbUser}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Project:</span>
                      {db.project ? (
                        <Link
                          href={`/projects/${db.project.id}`}
                          className="flex items-center gap-1 text-primary hover:underline font-medium truncate max-w-[170px]"
                        >
                          <FolderGit2 className="h-3 w-3 shrink-0" />
                          <span className="truncate">{db.project.name}</span>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground italic">
                          Standalone
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-1 text-[11px] text-muted-foreground border-t border-border/40">
                      <span>Created</span>
                      <span>{formatDate(db.createdAt, timezone)}</span>
                    </div>
                  </div>

                  {/* Actions row */}
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs border-border hover:bg-muted"
                      onClick={() => {
                        setSelectedDb(db);
                        setShowPassword(false);
                        setCredentialsModalOpen(true);
                      }}
                    >
                      <Layers className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
                      Details &amp; URI
                    </Button>

                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0 border-border hover:bg-muted"
                      title="Test Connection"
                      disabled={testingDbId === db.id}
                      onClick={() => void handleTestConnection(db)}
                    >
                      {testingDbId === db.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                      ) : (
                        <Activity className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                      )}
                    </Button>

                    {db.adminerUrl && (
                      <Button
                        asChild
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0 border-border hover:bg-muted"
                        title="Open in Adminer Web UI"
                      >
                        <a
                          href={db.adminerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                        </a>
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0 border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                      title="Delete Database"
                      onClick={() => setDeleteDb(db)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Create Database Dialog ────────────────────────────────────────── */}
      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-foreground">
                <Database className="h-5 w-5 text-primary" />
                Provision New Database
              </DialogTitle>
              <DialogDescription>
                Creates an isolated database instance and secure credentials
                with tailored privileges.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Engine selection */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Database Engine
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <div
                    onClick={() => setCreateType("POSTGRESQL")}
                    className={cn(
                      "cursor-pointer rounded-lg border p-3.5 transition-all text-center select-none",
                      createType === "POSTGRESQL"
                        ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                        : "border-border bg-card hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <div className="font-semibold text-sm text-foreground">
                      PostgreSQL 16
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Port 5432 • ACID
                    </div>
                  </div>

                  <div
                    onClick={() => setCreateType("MYSQL")}
                    className={cn(
                      "cursor-pointer rounded-lg border p-3.5 transition-all text-center select-none",
                      createType === "MYSQL"
                        ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                        : "border-border bg-card hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <div className="font-semibold text-sm text-foreground">
                      MySQL 8.0
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Port 3306 • UTF8MB4
                    </div>
                  </div>
                </div>
              </div>

              {/* Database Name */}
              <div className="space-y-1.5">
                <Label
                  htmlFor="create-db-name"
                  className="text-xs font-medium text-foreground"
                >
                  Database Name
                </Label>
                <Input
                  id="create-db-name"
                  placeholder="e.g. app_production"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  className="font-mono text-sm bg-card border-border"
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  2-48 alphanumeric characters or underscores.
                </p>
              </div>

              {/* Attach to project */}
              <div className="space-y-1.5">
                <Label
                  htmlFor="create-db-project"
                  className="text-xs font-medium text-foreground"
                >
                  Attach to Project (Optional)
                </Label>
                <Select
                  value={createProjectId}
                  onValueChange={(val) => setCreateProjectId(val)}
                >
                  <SelectTrigger
                    id="create-db-project"
                    className="bg-card border-border"
                  >
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      No project (Standalone)
                    </SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Auto-inject env vars checkbox */}
              {createProjectId !== "none" && (
                <div className="flex items-start gap-2.5 rounded-lg border border-border/80 bg-muted/30 p-3">
                  <input
                    type="checkbox"
                    id="auto-inject-env"
                    checked={createAutoInject}
                    onChange={(e) => setCreateAutoInject(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <Label
                    htmlFor="auto-inject-env"
                    className="text-xs leading-relaxed text-foreground cursor-pointer"
                  >
                    <span className="font-semibold block">
                      Auto-inject environment variables
                    </span>
                    Automatically set{" "}
                    <code className="text-primary font-mono text-[11px]">
                      DATABASE_URL
                    </code>{" "}
                    and granular credentials in the selected project.
                  </Label>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateModalOpen(false)}
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isCreating}>
                {isCreating && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Provision Database
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Credentials & Connection Details Dialog ──────────────────────── */}
      <Dialog
        open={credentialsModalOpen}
        onOpenChange={setCredentialsModalOpen}
      >
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
          {selectedDb && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between pr-4">
                  <DialogTitle className="flex items-center gap-2 text-foreground">
                    <Database className="h-5 w-5 text-primary" />
                    {selectedDb.name}
                  </DialogTitle>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs uppercase font-semibold",
                      selectedDb.type === "POSTGRESQL"
                        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
                        : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
                    )}
                  >
                    {selectedDb.type}
                  </Badge>
                </div>
                <DialogDescription>
                  Connection strings and credentials for your application and
                  desktop tools.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-3 text-sm">
                {/* Internal container URI */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Internal Docker URI (For Hosted Apps)
                    </Label>
                    <button
                      onClick={() =>
                        handleCopy(
                          selectedDb.internalConnectionString,
                          "internal_uri",
                        )
                      }
                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      {copiedField === "internal_uri" ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      Copy URI
                    </button>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/60 p-2.5 font-mono text-xs break-all select-all text-foreground">
                    {selectedDb.internalConnectionString}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Use this connection string inside your Vexlyx project
                    containers.
                  </p>
                </div>

                {/* External host URI */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Host URI (For External / Local GUI Tools)
                    </Label>
                    <button
                      onClick={() =>
                        handleCopy(selectedDb.connectionString, "host_uri")
                      }
                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      {copiedField === "host_uri" ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      Copy URI
                    </button>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/60 p-2.5 font-mono text-xs break-all select-all text-foreground">
                    {selectedDb.connectionString}
                  </div>
                </div>

                <Separator />

                {/* Granular Credentials Table */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Granular Credentials
                  </Label>

                  <div className="rounded-lg border border-border divide-y divide-border bg-card">
                    {/* Host */}
                    <div className="flex items-center justify-between p-2.5 text-xs">
                      <span className="text-muted-foreground">Host</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-foreground font-medium">
                          {selectedDb.host}
                        </span>
                        <button
                          onClick={() => handleCopy(selectedDb.host, "host")}
                          className="text-muted-foreground hover:text-foreground"
                          title="Copy host"
                        >
                          {copiedField === "host" ? (
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Port */}
                    <div className="flex items-center justify-between p-2.5 text-xs">
                      <span className="text-muted-foreground">Port</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-foreground font-medium">
                          {selectedDb.port}
                        </span>
                        <button
                          onClick={() =>
                            handleCopy(String(selectedDb.port), "port")
                          }
                          className="text-muted-foreground hover:text-foreground"
                          title="Copy port"
                        >
                          {copiedField === "port" ? (
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Database */}
                    <div className="flex items-center justify-between p-2.5 text-xs">
                      <span className="text-muted-foreground">
                        Database Name
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-foreground font-medium">
                          {selectedDb.name}
                        </span>
                        <button
                          onClick={() => handleCopy(selectedDb.name, "dbname")}
                          className="text-muted-foreground hover:text-foreground"
                          title="Copy db name"
                        >
                          {copiedField === "dbname" ? (
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* User */}
                    <div className="flex items-center justify-between p-2.5 text-xs">
                      <span className="text-muted-foreground">Username</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-foreground font-medium">
                          {selectedDb.dbUser}
                        </span>
                        <button
                          onClick={() => handleCopy(selectedDb.dbUser, "user")}
                          className="text-muted-foreground hover:text-foreground"
                          title="Copy username"
                        >
                          {copiedField === "user" ? (
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Password */}
                    <div className="flex items-center justify-between p-2.5 text-xs">
                      <span className="text-muted-foreground">Password</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-foreground font-medium">
                          {showPassword
                            ? (selectedDb.dbPassword ?? "••••••••")
                            : "••••••••••••••••••••••••"}
                        </span>
                        <button
                          onClick={() => setShowPassword(!showPassword)}
                          className="text-muted-foreground hover:text-foreground mr-1"
                          title={
                            showPassword ? "Hide password" : "Show password"
                          }
                        >
                          {showPassword ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </button>
                        {selectedDb.dbPassword && (
                          <button
                            onClick={() =>
                              handleCopy(selectedDb.dbPassword!, "password")
                            }
                            className="text-muted-foreground hover:text-foreground"
                            title="Copy password"
                          >
                            {copiedField === "password" ? (
                              <Check className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <DialogFooter className="flex sm:justify-between items-center gap-2">
                {selectedDb.adminerUrl && (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="border-border text-foreground hover:bg-muted"
                  >
                    <a
                      href={selectedDb.adminerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                      Open in Adminer
                    </a>
                  </Button>
                )}

                <Button
                  size="sm"
                  onClick={() => setCredentialsModalOpen(false)}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation Dialog ──────────────────────────────────── */}
      <Dialog
        open={!!deleteDb}
        onOpenChange={(open) => !open && setDeleteDb(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Delete Database &ldquo;{deleteDb?.name}&rdquo;?
            </DialogTitle>
            <DialogDescription>
              This will drop the database, terminate all active connections, and
              delete the user{" "}
              <code className="font-mono text-foreground">
                {deleteDb?.dbUser}
              </code>{" "}
              from the {deleteDb?.type} engine. All stored data will be
              permanently erased.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDb(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Database
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
