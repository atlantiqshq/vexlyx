"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAPI } from "@/lib/api";
import type {
  ConfigureGitHubAppInput,
  GitHubAppStatus,
  GitHubBranch,
  GitHubInstallation,
  GitHubRepositoryList,
} from "@vexlyx/shared";

export function useGitHubApp() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["github", "app"],
    queryFn: () => fetchAPI<GitHubAppStatus>("/api/github/app"),
  });
  const configure = useMutation({
    mutationFn: (input: ConfigureGitHubAppInput) => fetchAPI<GitHubAppStatus>("/api/github/app", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["github"] }),
  });
  return { status: status.data, isLoading: status.isLoading, configure: configure.mutateAsync, isConfiguring: configure.isPending };
}

export function useGitHubInstallations() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["github", "installations"],
    queryFn: () => fetchAPI<{ installations: GitHubInstallation[] }>("/api/github/installations"),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => fetchAPI<void>(`/api/github/installations/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["github", "installations"] }),
  });
  return {
    installations: query.data?.installations ?? [],
    isLoading: query.isLoading,
    disconnect: disconnect.mutateAsync,
    isDisconnecting: disconnect.isPending,
  };
}

export async function beginGitHubManifest() {
  const result = await fetchAPI<{ url: string; manifest: Record<string, unknown> }>("/api/github/app/manifest", { method: "POST" });
  const form = document.createElement("form");
  form.method = "POST";
  form.action = result.url;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(result.manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

export async function beginGitHubInstallation() {
  const result = await fetchAPI<{ url: string }>("/api/github/installations/connect", { method: "POST" });
  window.location.assign(result.url);
}

export function useGitHubRepositories(installationId: string | null, search: string) {
  return useQuery({
    queryKey: ["github", "repositories", installationId, search],
    queryFn: () => fetchAPI<GitHubRepositoryList>(
      `/api/github/installations/${installationId}/repositories?perPage=100&search=${encodeURIComponent(search)}`,
    ),
    enabled: Boolean(installationId),
  });
}

export function useGitHubBranches(installationId: string | null, repositoryId: string | null) {
  return useQuery({
    queryKey: ["github", "branches", installationId, repositoryId],
    queryFn: () => fetchAPI<{ branches: GitHubBranch[] }>(
      `/api/github/installations/${installationId}/repositories/${repositoryId}/branches`,
    ),
    enabled: Boolean(installationId && repositoryId),
  });
}
