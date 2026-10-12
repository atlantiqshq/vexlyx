import { z } from "zod";

export const GitHubAccountTypeSchema = z.enum(["User", "Organization"]);
export const GitHubRepositorySelectionSchema = z.enum(["all", "selected"]);
export const GitHubConnectionStatusSchema = z.enum([
  "CONNECTED",
  "DISCONNECTED",
  "SUSPENDED",
  "REPOSITORY_REMOVED",
]);

export const GitHubAppStatusSchema = z.object({
  configured: z.boolean(),
  appId: z.string().nullable(),
  slug: z.string().nullable(),
  clientId: z.string().nullable(),
  publicUrlReady: z.boolean(),
  publicUrlError: z.string().nullable(),
});
export type GitHubAppStatus = z.infer<typeof GitHubAppStatusSchema>;

export const ConfigureGitHubAppSchema = z.object({
  appId: z.coerce.string().regex(/^\d+$/, "App ID must be numeric"),
  slug: z.string().trim().min(1).max(100),
  clientId: z.string().trim().min(1).max(255),
  clientSecret: z.string().min(1),
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(1),
});
export type ConfigureGitHubAppInput = z.infer<typeof ConfigureGitHubAppSchema>;

export const GitHubInstallationSchema = z.object({
  id: z.string(),
  installationId: z.string(),
  accountId: z.string(),
  accountLogin: z.string(),
  accountType: GitHubAccountTypeSchema,
  repositorySelection: GitHubRepositorySelectionSchema,
  status: GitHubConnectionStatusSchema,
  suspendedAt: z.string().datetime().nullable(),
  disconnectedAt: z.string().datetime().nullable(),
});
export type GitHubInstallation = z.infer<typeof GitHubInstallationSchema>;

export const GitHubSelectableRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
  defaultBranch: z.string(),
  updatedAt: z.string().datetime().nullable(),
});
export type GitHubRepository = z.infer<typeof GitHubSelectableRepositorySchema>;

export const GitHubRepositoryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(30),
  search: z.string().trim().max(100).optional(),
});
export type GitHubRepositoryListQuery = z.infer<typeof GitHubRepositoryListQuerySchema>;

export const GitHubRepositoryListSchema = z.object({
  repositories: z.array(GitHubSelectableRepositorySchema),
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
});
export type GitHubRepositoryList = z.infer<typeof GitHubRepositoryListSchema>;

export const GitHubBranchSchema = z.object({
  name: z.string(),
  protected: z.boolean(),
});
export type GitHubBranch = z.infer<typeof GitHubBranchSchema>;

export const ConnectGitHubRepositorySchema = z.object({
  installationId: z.string().min(1),
  repositoryId: z.string().regex(/^\d+$/, "Repository ID must be numeric"),
  branch: z.string().min(1).max(255),
});
export type ConnectGitHubRepositoryInput = z.infer<typeof ConnectGitHubRepositorySchema>;

export const GitHubCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  installation_id: z.coerce.string().regex(/^\d+$/),
  setup_action: z.string().optional(),
});
export type GitHubCallbackQuery = z.infer<typeof GitHubCallbackQuerySchema>;
