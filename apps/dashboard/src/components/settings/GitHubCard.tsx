"use client";

import { useState } from "react";
import { Github, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { beginGitHubInstallation, beginGitHubManifest, useGitHubApp, useGitHubInstallations } from "@/hooks/useGitHub";

const EMPTY_FORM = { appId: "", slug: "", clientId: "", clientSecret: "", privateKey: "", webhookSecret: "" };

export function GitHubCard() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const { status, isLoading, configure, isConfiguring } = useGitHubApp();
  const { installations, disconnect, isDisconnecting } = useGitHubInstallations();
  const [manualOpen, setManualOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const handleManifest = async () => {
    try {
      await beginGitHubManifest();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to start GitHub App setup");
    }
  };

  const handleConfigure = async () => {
    try {
      await configure(form);
      setManualOpen(false);
      setForm(EMPTY_FORM);
      toast.success("GitHub App configured");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to configure GitHub App");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Github className="h-4 w-4" />GitHub</CardTitle>
        <CardDescription>Connect accounts and deploy repositories through a least-privilege GitHub App.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : (
          <>
            {isAdmin && !status?.configured && (
              <div className="rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">Panel GitHub App</p>
                      <Badge variant="secondary">Setup required</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Configure the panel once. Users will then connect GitHub directly.</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void handleManifest()} disabled={!status?.publicUrlReady}>
                      Set up GitHub
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setManualOpen(true)}>Use existing App</Button>
                  </div>
                </div>
                {!status?.publicUrlReady && (
                  <div className="mt-3 flex gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
                    <TriangleAlert className="h-4 w-4 shrink-0" />{status?.publicUrlError}
                  </div>
                )}
              </div>
            )}

            {!isAdmin && !status?.configured && (
              <div className="flex gap-2 rounded-lg border p-4 text-sm text-muted-foreground">
                <TriangleAlert className="h-4 w-4 shrink-0" />An administrator must finish GitHub setup before accounts can be connected.
              </div>
            )}

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div><p className="text-sm font-medium">Connected accounts</p><p className="text-xs text-muted-foreground">Connect once, choose repositories on GitHub, and deploy without entering credentials.</p></div>
                <Button size="sm" onClick={() => void beginGitHubInstallation()} disabled={!status?.configured}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />Connect GitHub
                </Button>
              </div>
              {installations.length === 0 ? <p className="text-sm text-muted-foreground">No GitHub accounts connected.</p> : installations.map((installation) => (
                <div key={installation.id} className="flex items-center justify-between rounded-lg border px-3 py-2">
                  <div><p className="text-sm font-medium">{installation.accountLogin}</p><p className="text-xs text-muted-foreground">{installation.accountType} · {installation.repositorySelection} repositories</p></div>
                  <div className="flex items-center gap-2">
                    <Badge variant={installation.status === "CONNECTED" ? "default" : "secondary"}>{installation.status.toLowerCase()}</Badge>
                    <Button variant="ghost" size="icon" aria-label={`Disconnect ${installation.accountLogin}`} disabled={isDisconnecting} onClick={() => void disconnect(installation.id)}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>Use an existing GitHub App</DialogTitle><DialogDescription>Credentials are encrypted before storage and are never returned by the API.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            {(["appId", "slug", "clientId", "clientSecret", "webhookSecret"] as const).map((field) => (
              <div key={field} className="space-y-1.5"><Label htmlFor={`github-${field}`}>{field}</Label><Input id={`github-${field}`} type={field.toLowerCase().includes("secret") ? "password" : "text"} value={form[field]} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} /></div>
            ))}
            <div className="space-y-1.5"><Label htmlFor="github-private-key">Private key (PEM)</Label><Textarea id="github-private-key" rows={7} value={form.privateKey} onChange={(event) => setForm((current) => ({ ...current, privateKey: event.target.value }))} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setManualOpen(false)}>Cancel</Button><Button onClick={() => void handleConfigure()} disabled={isConfiguring}>{isConfiguring && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save App</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
