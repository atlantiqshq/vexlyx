"use client";

import { useEffect, useState } from "react";
import { Github, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { beginGitHubInstallation, useGitHubBranches, useGitHubInstallations, useGitHubRepositories } from "@/hooks/useGitHub";

export interface GitHubRepoSelection {
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  branch: string;
}

interface GitHubRepoPickerProps {
  value: GitHubRepoSelection | null;
  onChange: (selection: GitHubRepoSelection | null) => void;
  disabled?: boolean;
}

export function GitHubRepoPicker({ value, onChange, disabled }: GitHubRepoPickerProps) {
  const { installations, isLoading } = useGitHubInstallations();
  const [installationId, setInstallationId] = useState(value?.installationId ?? "");
  const [repositoryId, setRepositoryId] = useState(value?.repositoryId ?? "");
  const [search, setSearch] = useState("");
  const repositories = useGitHubRepositories(installationId || null, search);
  const branches = useGitHubBranches(installationId || null, repositoryId || null);

  useEffect(() => {
    if (!installationId && installations.length === 1 && installations[0]?.status === "CONNECTED") {
      setInstallationId(installations[0].id);
    }
  }, [installationId, installations]);

  const selectRepository = (id: string) => {
    setRepositoryId(id);
    const repository = repositories.data?.repositories.find((item) => item.id === id);
    if (!repository) return onChange(null);
    onChange({
      installationId,
      repositoryId: id,
      repositoryFullName: repository.fullName,
      branch: repository.defaultBranch,
    });
  };

  if (!isLoading && installations.filter((item) => item.status === "CONNECTED").length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center">
        <Github className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
        <p className="mb-3 text-sm text-muted-foreground">Connect a GitHub account before selecting a repository.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void beginGitHubInstallation()}>
          Connect GitHub
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>GitHub account or organization</Label>
        <Select value={installationId} onValueChange={(id) => { setInstallationId(id); setRepositoryId(""); onChange(null); }} disabled={disabled || isLoading}>
          <SelectTrigger><SelectValue placeholder="Select an account" /></SelectTrigger>
          <SelectContent>
            {installations.filter((item) => item.status === "CONNECTED").map((item) => (
              <SelectItem key={item.id} value={item.id}>{item.accountLogin}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="github-repository-search">Repository</Label>
        <Input id="github-repository-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search repositories" disabled={disabled || !installationId} />
        <Select value={repositoryId} onValueChange={selectRepository} disabled={disabled || !installationId || repositories.isLoading}>
          <SelectTrigger><SelectValue placeholder={repositories.isLoading ? "Loading repositories…" : "Select a repository"} /></SelectTrigger>
          <SelectContent>
            {repositories.data?.repositories.map((repository) => (
              <SelectItem key={repository.id} value={repository.id} disabled={repository.archived}>
                {repository.fullName}{repository.private ? " (private)" : ""}{repository.archived ? " (archived)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Branch</Label>
        <Select
          value={value?.branch ?? ""}
          onValueChange={(branch) => value && onChange({ ...value, branch })}
          disabled={disabled || !repositoryId || branches.isLoading}
        >
          <SelectTrigger><SelectValue placeholder={branches.isLoading ? "Loading branches…" : "Select a branch"} /></SelectTrigger>
          <SelectContent>
            {branches.data?.branches.map((branch) => <SelectItem key={branch.name} value={branch.name}>{branch.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {(repositories.isLoading || branches.isLoading) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
    </div>
  );
}
