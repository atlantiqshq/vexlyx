"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Database,
  Plus,
  ExternalLink,
  Copy,
  Check,
  Eye,
  EyeOff,
  Trash2,
  Activity,
  Server,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchAPI, ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  useRefreshAnimation,
  refreshIconClassName,
} from "@/hooks/useRefreshAnimation";
import type { DatabaseDetail, DatabaseType, Project } from "@vexlyx/shared";

interface DatabasePanelProps {
  project: Project;
  onProjectUpdate?: () => void;
}

export function DatabasePanel({
  project,
  onProjectUpdate,
}: DatabasePanelProps) {
  const [databases, setDatabases] = useState<DatabaseDetail[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { isRefreshing, refresh } = useRefreshAnimation();

  // Create modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState<DatabaseType>("POSTGRESQL");
  const [createAutoInject, setCreateAutoInject] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  // Credentials modal state
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

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------

  const fetchDatabases = useCallback(
    async (quiet = false) => {
      if (!quiet) setIsLoading(true);

      try {
        const res = await fetchAPI<{ databases: DatabaseDetail[] }>(
          `/api/databases?projectId=${project.id}`,
        );
        setDatabases(res.databases ?? []);
      } catch (err) {
        toast.error(
          err instanceof ApiRequestError
            ? err.message
            : "Failed to load project databases",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [project.id],
  );

  const handleRefresh = () =>
    refresh(async () => {
      await fetchDatabases(true);
      toast.success("Project databases refreshed");
    });

  useEffect(() => {
    void fetchDatabases();
  }, [fetchDatabases]);

  // ---------------------------------------------------------------------------
  // Copy helper
  // ---------------------------------------------------------------------------

  const handleCopy = (text: string, field: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedField(null), 2000);
  };

  // ---------------------------------------------------------------------------
  // Create database
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
          projectId: project.id,
          autoInjectEnv: createAutoInject,
        }),
      });

      toast.success(`Database "${created.name}" provisioned and linked`);
      setCreateModalOpen(false);
      setCreateName("");
      setCreateType("POSTGRESQL");
      void fetchDatabases(true);
      onProjectUpdate?.();

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
  // Test connection
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
  // Delete database
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
      void fetchDatabases(true);
      onProjectUpdate?.();
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

  return (
    <Card className="border border-border">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Database className="h-4 w-4 text-primary" />
            Provisioned Databases
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            PostgreSQL &amp; MySQL instances attached to this project.
          </CardDescription>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing || isLoading}
            aria-label="Refresh project databases"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw
              className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")}
            />
          </Button>

          <Button
            id="add-project-db-btn"
            size="sm"
            onClick={() => {
              const defaultName =
                `${project.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_db`.slice(
                  0,
                  30,
                );
              setCreateName(defaultName);
              setCreateModalOpen(true);
            }}
            className="flex items-center gap-1.5 text-xs h-8"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Database
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ) : databases.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/80 p-6 text-center">
            <Database className="mx-auto h-8 w-8 text-muted-foreground/60 mb-2" />
            <p className="text-sm font-medium text-foreground">
              No databases attached yet
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-sm mx-auto">
              Provision a database for this project to automatically inject
              connection credentials.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const defaultName =
                  `${project.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_db`.slice(
                    0,
                    30,
                  );
                setCreateName(defaultName);
                setCreateModalOpen(true);
              }}
              className="mt-3 text-xs"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Provision Database
            </Button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {databases.map((db) => {
              const isPg = db.type === "POSTGRESQL";
              const test = testResult?.id === db.id ? testResult : null;

              return (
                <div
                  key={db.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-border/80"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-foreground truncate">
                        {db.name}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] uppercase font-semibold px-1.5 py-0",
                          isPg
                            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
                            : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
                        )}
                      >
                        {isPg ? "PostgreSQL" : "MySQL"}
                      </Badge>

                      {test && (
                        <span
                          className={cn(
                            "flex items-center gap-1 text-[11px] font-medium",
                            test.connected
                              ? "text-emerald-500"
                              : "text-rose-500",
                          )}
                        >
                          {test.connected ? (
                            <>
                              <CheckCircle2 className="h-3 w-3" />
                              {test.latencyMs}ms
                            </>
                          ) : (
                            <>
                              <XCircle className="h-3 w-3" />
                              Failed
                            </>
                          )}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1 font-mono">
                        <Server className="h-3 w-3 shrink-0" />
                        {db.internalHost}:{db.port}
                      </span>
                      <span>•</span>
                      <span className="font-mono">User: {db.dbUser}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs h-7 px-2 border-border hover:bg-muted"
                      onClick={() =>
                        handleCopy(db.internalConnectionString, `uri_${db.id}`)
                      }
                    >
                      {copiedField === `uri_${db.id}` ? (
                        <Check className="mr-1 h-3 w-3 text-emerald-500" />
                      ) : (
                        <Copy className="mr-1 h-3 w-3 text-muted-foreground" />
                      )}
                      Copy URI
                    </Button>

                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs h-7 px-2 border-border hover:bg-muted"
                      onClick={() => {
                        setSelectedDb(db);
                        setShowPassword(false);
                        setCredentialsModalOpen(true);
                      }}
                    >
                      Credentials
                    </Button>

                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7 border-border hover:bg-muted"
                      title="Test Connection"
                      disabled={testingDbId === db.id}
                      onClick={() => void handleTestConnection(db)}
                    >
                      {testingDbId === db.id ? (
                        <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      ) : (
                        <Activity className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                      )}
                    </Button>

                    {db.adminerUrl && (
                      <Button
                        asChild
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 border-border hover:bg-muted"
                        title="Open in Adminer"
                      >
                        <a
                          href={db.adminerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                        </a>
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7 border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                      title="Delete Database"
                      onClick={() => setDeleteDb(db)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* ── Create Modal ──────────────────────────────────────────────────── */}
      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-foreground">
                <Database className="h-5 w-5 text-primary" />
                Add Project Database
              </DialogTitle>
              <DialogDescription>
                Provisions an isolated database for &ldquo;{project.name}
                &rdquo;.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Engine Selection */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Engine
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <div
                    onClick={() => setCreateType("POSTGRESQL")}
                    className={cn(
                      "cursor-pointer rounded-lg border p-3 transition-all text-center select-none",
                      createType === "POSTGRESQL"
                        ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                        : "border-border bg-card hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <div className="font-semibold text-sm text-foreground">
                      PostgreSQL
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Port 5432
                    </div>
                  </div>

                  <div
                    onClick={() => setCreateType("MYSQL")}
                    className={cn(
                      "cursor-pointer rounded-lg border p-3 transition-all text-center select-none",
                      createType === "MYSQL"
                        ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                        : "border-border bg-card hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <div className="font-semibold text-sm text-foreground">
                      MySQL
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Port 3306
                    </div>
                  </div>
                </div>
              </div>

              {/* Database Name */}
              <div className="space-y-1.5">
                <Label
                  htmlFor="project-db-name"
                  className="text-xs font-medium text-foreground"
                >
                  Database Name
                </Label>
                <Input
                  id="project-db-name"
                  placeholder="e.g. app_db"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  className="font-mono text-sm bg-card border-border"
                  required
                />
              </div>

              {/* Auto Inject Toggle */}
              <div className="flex items-start gap-2.5 rounded-lg border border-border/80 bg-muted/30 p-3">
                <input
                  type="checkbox"
                  id="project-auto-inject-env"
                  checked={createAutoInject}
                  onChange={(e) => setCreateAutoInject(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <Label
                  htmlFor="project-auto-inject-env"
                  className="text-xs leading-relaxed text-foreground cursor-pointer"
                >
                  <span className="font-semibold block">
                    Auto-inject environment variables
                  </span>
                  Sets{" "}
                  <code className="text-primary font-mono text-[11px]">
                    DATABASE_URL
                  </code>{" "}
                  and DB credentials into this project&apos;s environment
                  configuration.
                </Label>
              </div>
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
                Provision
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Credentials Dialog ────────────────────────────────────────────── */}
      <Dialog
        open={credentialsModalOpen}
        onOpenChange={setCredentialsModalOpen}
      >
        <DialogContent className="sm:max-w-xl">
          {selectedDb && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between pr-4">
                  <DialogTitle className="flex items-center gap-2 text-foreground">
                    <Database className="h-5 w-5 text-primary" />
                    {selectedDb.name}
                  </DialogTitle>
                  <Badge variant="outline">{selectedDb.type}</Badge>
                </div>
                <DialogDescription>
                  Connection strings and credentials for this database.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-3 text-sm">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Internal Docker Connection String
                    </Label>
                    <button
                      onClick={() =>
                        handleCopy(
                          selectedDb.internalConnectionString,
                          "modal_internal_uri",
                        )
                      }
                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      {copiedField === "modal_internal_uri" ? (
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
                </div>

                <div className="rounded-lg border border-border divide-y divide-border bg-card">
                  <div className="flex items-center justify-between p-2.5 text-xs">
                    <span className="text-muted-foreground">Username</span>
                    <span className="font-mono text-foreground font-medium">
                      {selectedDb.dbUser}
                    </span>
                  </div>

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
                        title={showPassword ? "Hide password" : "Show password"}
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
                            handleCopy(selectedDb.dbPassword!, "modal_pw")
                          }
                          className="text-muted-foreground hover:text-foreground"
                          title="Copy password"
                        >
                          {copiedField === "modal_pw" ? (
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

      {/* ── Delete Modal ──────────────────────────────────────────────────── */}
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
              This will drop the database and remove the user{" "}
              <code className="font-mono text-foreground">
                {deleteDb?.dbUser}
              </code>{" "}
              from {deleteDb?.type}. Data will be permanently lost.
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
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
