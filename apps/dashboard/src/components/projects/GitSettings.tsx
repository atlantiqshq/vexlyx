"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  GitBranch,
  KeyRound,
  Link2,
  Loader2,
  Copy,
  Check,
  RefreshCw,
  RotateCw,
  Eye,
  EyeOff,
  ShieldCheck,
  Github,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useGitSettings } from "@/hooks/useGitSettings";
import { useRefreshAnimation, refreshIconClassName } from "@/hooks/useRefreshAnimation";
import { ConnectRepoSchema } from "@vexlyx/shared";
import { Badge } from "@/components/ui/badge";
import { GitHubRepoPicker, type GitHubRepoSelection } from "./GitHubRepoPicker";

// ---------------------------------------------------------------------------
// Small copy-to-clipboard button
// ---------------------------------------------------------------------------

function CopyButton({ value, id }: { value: string; id: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      id={id}
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0"
      onClick={() => void handleCopy()}
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Git URL + branch form validation
// ---------------------------------------------------------------------------

interface FormState {
  gitUrl: string;
  branch: string;
}

interface FormErrors {
  gitUrl?: string;
  branch?: string;
}

function validateGitForm(form: FormState): FormErrors {
  const result = ConnectRepoSchema.safeParse({ gitUrl: form.gitUrl, branch: form.branch });
  if (result.success) return {};
  const errors: FormErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as keyof FormErrors;
    if (field === "gitUrl" || field === "branch") {
      errors[field] = issue.message;
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GitSettingsProps {
  projectId: string;
  /** Initial gitUrl from the parent project record, if any */
  initialGitUrl?: string | null;
  /** Initial branch from the parent project record */
  initialBranch?: string;
  /** Callback to refresh parent project data when repository is connected */
  onProjectUpdate?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GitSettings({
  projectId,
  initialGitUrl,
  initialBranch = "main",
  onProjectUpdate,
}: GitSettingsProps) {
  const { state, fetchMetadata, connectRepo, connectGitHub, disconnectGitHub, generateSshKey, rotateWebhookSecret } =
    useGitSettings(projectId);

  const [form, setForm] = useState<FormState>({
    gitUrl: initialGitUrl ?? "",
    branch: initialBranch,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [isConnecting, setIsConnecting] = useState(false);
  const [isGeneratingKey, setIsGeneratingKey] = useState(false);
  const [isRotatingSecret, setIsRotatingSecret] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [githubSelection, setGitHubSelection] = useState<GitHubRepoSelection | null>(null);
  const { isRefreshing, refresh } = useRefreshAnimation();

  const handleRefresh = () =>
    refresh(async () => {
      await fetchMetadata();
      toast.success("Git settings refreshed");
    });

  // Fetch git metadata on mount so SSH key + webhook URL are populated.
  useEffect(() => {
    void fetchMetadata();
  }, [fetchMetadata]);

  // Sync form with fetched metadata (e.g. after a successful connect).
  useEffect(() => {
    if (state.data?.gitUrl) {
      setForm((prev) => ({
        gitUrl: state.data!.gitUrl ?? prev.gitUrl,
        branch: state.data!.branch ?? prev.branch,
      }));
    }
  }, [state.data]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateGitForm(form);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }
    setErrors({});
    setIsConnecting(true);
    try {
      await connectRepo({
        gitUrl: form.gitUrl.trim(),
        branch: form.branch.trim() || "main",
        isPrivate: state.data?.isPrivate ?? false,
      });
      toast.success("Repository connected successfully");
      if (onProjectUpdate) onProjectUpdate();
    } catch {
      toast.error("Failed to connect repository");
    } finally {
      setIsConnecting(false);
    }
  };

  const handleGenerateKey = async () => {
    setIsGeneratingKey(true);
    try {
      await generateSshKey();
      toast.success("SSH key generated — copy the public key to your repo's Deploy Keys");
    } catch {
      toast.error("Failed to generate SSH key");
    } finally {
      setIsGeneratingKey(false);
    }
  };

  const handleRotateSecret = async () => {
    setIsRotatingSecret(true);
    try {
      await rotateWebhookSecret();
      toast.success("Webhook secret regenerated — remember to update GitHub settings!");
    } catch {
      toast.error("Failed to regenerate webhook secret");
    } finally {
      setIsRotatingSecret(false);
    }
  };

  const metadata = state.data;

  const handleGitHubConnect = async () => {
    if (!githubSelection) return;
    setIsConnecting(true);
    try {
      await connectGitHub({
        installationId: githubSelection.installationId,
        repositoryId: githubSelection.repositoryId,
        branch: githubSelection.branch,
      });
      toast.success("GitHub repository connected");
      onProjectUpdate?.();
    } catch {
      toast.error("Failed to connect GitHub repository");
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="space-y-4">
      {metadata?.githubInstallationId ? (
        <Card className="border border-border">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Github className="h-4 w-4" />{metadata.githubRepoFullName}</CardTitle><CardDescription>Connected through your GitHub App installation.</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2"><Badge variant={metadata.githubConnectionStatus === "CONNECTED" ? "default" : "secondary"}>{metadata.githubConnectionStatus?.toLowerCase()}</Badge><Badge variant="outline">{metadata.branch}</Badge><Button type="button" size="sm" variant="outline" onClick={() => void disconnectGitHub()}>Switch to manual URL</Button>{metadata.githubDisconnectReason && <p className="w-full text-sm text-destructive">{metadata.githubDisconnectReason}</p>}</CardContent>
        </Card>
      ) : (
        <Card className="border border-border">
          <CardHeader><CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Github className="h-3.5 w-3.5" />Import from GitHub</CardTitle><CardDescription className="text-xs">Select an authorized repository without configuring a deploy key or webhook.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><GitHubRepoPicker value={githubSelection} onChange={setGitHubSelection} disabled={isConnecting} /><Button size="sm" type="button" disabled={!githubSelection || isConnecting} onClick={() => void handleGitHubConnect()}>{isConnecting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Connect GitHub Repository</Button></CardContent>
        </Card>
      )}

      {/* ── Section A: Repository connection ── */}
      {!metadata?.githubInstallationId && <Card className="border border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <GitBranch className="h-3.5 w-3.5" />
              Repository
            </CardTitle>
            <Button
              id={`refresh-git-${projectId}`}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Refresh repository metadata"
              title="Refresh repository metadata"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing || state.isLoading}
            >
              <RefreshCw className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")} />
            </Button>
          </div>
          <CardDescription className="text-xs">
            Connect a GitHub, GitLab, or Bitbucket repository to this project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id={`git-connect-form-${projectId}`}
            onSubmit={(e) => void handleConnect(e)}
            className="space-y-4"
          >
            {/* Git URL */}
            <div className="space-y-1.5">
              <Label htmlFor={`git-url-${projectId}`}>
                Git URL <span className="text-destructive">*</span>
              </Label>
              <Input
                id={`git-url-${projectId}`}
                placeholder={metadata?.sshPublicKey ? "git@github.com:user/repo.git" : "https://github.com/user/repo"}
                value={form.gitUrl}
                onChange={(e) => {
                  setForm((prev) => ({ ...prev, gitUrl: e.target.value }));
                  if (errors.gitUrl) setErrors((prev) => ({ ...prev, gitUrl: undefined }));
                }}
                disabled={isConnecting}
                autoComplete="off"
                className={cn(errors.gitUrl && "border-destructive")}
              />
              {errors.gitUrl ? (
                <p className="text-xs text-destructive">{errors.gitUrl}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Use <strong>HTTPS</strong> (<code className="font-mono">https://github.com/...</code>) for public repos, or <strong>SSH</strong> (<code className="font-mono">git@github.com:...</code>) for private repos with Deploy Keys.
                </p>
              )}
            </div>

            {/* Branch */}
            <div className="space-y-1.5">
              <Label htmlFor={`git-branch-${projectId}`}>Branch</Label>
              <Input
                id={`git-branch-${projectId}`}
                placeholder="main"
                value={form.branch}
                onChange={(e) => {
                  setForm((prev) => ({ ...prev, branch: e.target.value }));
                  if (errors.branch) setErrors((prev) => ({ ...prev, branch: undefined }));
                }}
                disabled={isConnecting}
                autoComplete="off"
                className={cn(errors.branch && "border-destructive")}
              />
              {errors.branch && (
                <p className="text-xs text-destructive">{errors.branch}</p>
              )}
            </div>

            <Button
              id={`git-connect-btn-${projectId}`}
              type="submit"
              size="sm"
              disabled={isConnecting}
            >
              {isConnecting ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitBranch className="mr-2 h-3.5 w-3.5" />
              )}
              {metadata?.gitUrl ? "Reconnect Repository" : "Connect Repository"}
            </Button>
          </form>
        </CardContent>
      </Card>}

      {/* ── Section B: SSH Deploy Key ── */}
      {!metadata?.githubInstallationId && <Card className="border border-border">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <KeyRound className="h-3.5 w-3.5" />
            SSH Deploy Key
          </CardTitle>
          <CardDescription className="text-xs">
            For private repositories. Generate a key and add the public key to your repo&rsquo;s
            Deploy Keys (Settings → Deploy Keys).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            id={`git-keygen-btn-${projectId}`}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleGenerateKey()}
            disabled={isGeneratingKey}
          >
            {isGeneratingKey ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <KeyRound className="mr-2 h-3.5 w-3.5" />
            )}
            {metadata?.sshPublicKey ? "Regenerate SSH Key" : "Generate SSH Key"}
          </Button>

          {metadata?.sshPublicKey && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Public Key</Label>
                <CopyButton
                  id={`copy-ssh-key-${projectId}`}
                  value={metadata.sshPublicKey}
                />
              </div>
              <Textarea
                readOnly
                value={metadata.sshPublicKey}
                rows={3}
                className="resize-none font-mono text-xs text-muted-foreground"
                aria-label="SSH public key"
              />
            </div>
          )}
        </CardContent>
      </Card>}

      {/* ── Section C: Webhook Auto-Deploy (only once repo is connected) ── */}
      {metadata?.webhookUrl && (
        <Card className="border border-border">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Link2 className="h-3.5 w-3.5" />
              GitHub Webhook Auto-Deploy
            </CardTitle>
            <CardDescription className="text-xs">
              Automatically redeploy your project whenever code is pushed to your connected repository.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Webhook URL */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium" htmlFor={`webhook-url-${projectId}`}>
                  Payload URL
                </Label>
                <CopyButton
                  id={`copy-webhook-url-${projectId}`}
                  value={metadata.webhookUrl}
                />
              </div>
              <Input
                id={`webhook-url-${projectId}`}
                readOnly
                value={metadata.webhookUrl}
                className="font-mono text-xs text-muted-foreground"
                aria-label="Webhook URL"
              />
            </div>

            {/* Webhook Secret */}
            {metadata.webhookSecret && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs font-medium" htmlFor={`webhook-secret-${projectId}`}>
                      Webhook Secret (HMAC-SHA256)
                    </Label>
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      id={`toggle-webhook-secret-${projectId}`}
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => setShowSecret((v) => !v)}
                      aria-label={showSecret ? "Hide secret" : "Show secret"}
                    >
                      {showSecret ? (
                        <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </Button>
                    <CopyButton
                      id={`copy-webhook-secret-${projectId}`}
                      value={metadata.webhookSecret}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    id={`webhook-secret-${projectId}`}
                    readOnly
                    type={showSecret ? "text" : "password"}
                    value={metadata.webhookSecret}
                    className="font-mono text-xs text-muted-foreground"
                    aria-label="Webhook Secret"
                  />
                  <Button
                    id={`rotate-webhook-secret-${projectId}`}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-xs"
                    onClick={() => void handleRotateSecret()}
                    disabled={isRotatingSecret}
                  >
                    {isRotatingSecret ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Regenerate
                  </Button>
                </div>
              </div>
            )}

            {/* Step-by-step setup guide */}
            <div className="rounded-md border border-border bg-slate-50 dark:bg-slate-900/50 p-3 text-xs space-y-1.5 text-muted-foreground">
              <p className="font-medium text-foreground">GitHub Webhook Setup Instructions:</p>
              <ol className="list-decimal list-inside space-y-1 pl-1">
                <li>Go to your repository on GitHub → <strong>Settings</strong> → <strong>Webhooks</strong> → <strong>Add webhook</strong>.</li>
                <li>Paste the <strong>Payload URL</strong> into the Payload URL field.</li>
                <li>Set <strong>Content type</strong> to <code className="font-mono text-foreground font-semibold">application/json</code>.</li>
                <li>Paste the <strong>Webhook Secret</strong> into the Secret field.</li>
                <li>Select <strong>Just the push event</strong>, ensure <strong>Active</strong> is checked, and click <strong>Add webhook</strong>.</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading / error state */}
      {state.isLoading && !metadata && (
        <p className="text-xs text-muted-foreground">Loading git settings…</p>
      )}
      {state.error && !state.isLoading && (
        <p className="text-xs text-destructive">{state.error}</p>
      )}

      <Separator />
    </div>
  );
}
