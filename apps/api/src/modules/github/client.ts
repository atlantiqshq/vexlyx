import { createGitHubAppJwt } from "./tokens.js";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code = "GITHUB_API_ERROR",
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

interface GitHubAccount {
  id: number;
  login: string;
  type: "User" | "Organization";
}

export interface GitHubInstallationResponse {
  id: number;
  account: GitHubAccount;
  repository_selection: "all" | "selected";
  suspended_at: string | null;
}

export interface GitHubRepositoryResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  archived: boolean;
  default_branch: string;
  clone_url: string;
  updated_at: string | null;
}

interface RequestOptions extends RequestInit {
  token?: string;
}

async function githubRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { token, headers, ...requestOptions } = options;
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...requestOptions,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });

  if (!response.ok) {
    throw new GitHubApiError(`GitHub request failed with status ${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

export class GitHubClient {
  async getApp(appId: bigint, privateKey: string) {
    return githubRequest<{ id: number; slug: string; client_id: string }>("/app", {
      token: createGitHubAppJwt(appId, privateKey),
    });
  }

  async convertManifest(code: string) {
    return githubRequest<{
      id: number;
      slug: string;
      client_id: string;
      client_secret: string;
      pem: string;
      webhook_secret: string;
    }>(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
  }

  async exchangeUserCode(clientId: string, clientSecret: string, code: string) {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!response.ok) throw new GitHubApiError("GitHub authorization failed", response.status);
    const body = await response.json() as { access_token?: string; error?: string };
    if (!body.access_token) throw new GitHubApiError("GitHub authorization did not return an access token", 401);
    return body.access_token;
  }

  async listUserInstallations(userToken: string) {
    return githubRequest<{ installations: GitHubInstallationResponse[] }>("/user/installations?per_page=100", {
      token: userToken,
    });
  }

  async getInstallation(appId: bigint, privateKey: string, installationId: bigint) {
    return githubRequest<GitHubInstallationResponse>(`/app/installations/${installationId}`, {
      token: createGitHubAppJwt(appId, privateKey),
    });
  }

  async createInstallationToken(appId: bigint, privateKey: string, installationId: bigint) {
    return githubRequest<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST", token: createGitHubAppJwt(appId, privateKey) },
    );
  }

  async listRepositories(token: string, page: number, perPage: number) {
    return githubRequest<{ total_count: number; repositories: GitHubRepositoryResponse[] }>(
      `/installation/repositories?page=${page}&per_page=${perPage}`,
      { token },
    );
  }

  async getRepository(token: string, owner: string, repository: string) {
    return githubRequest<GitHubRepositoryResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
      { token },
    );
  }

  async listBranches(token: string, owner: string, repository: string, page = 1) {
    return githubRequest<Array<{ name: string; protected: boolean }>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches?per_page=100&page=${page}`,
      { token },
    );
  }
}
