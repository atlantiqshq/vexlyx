import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums (mirror Prisma — kept in sync manually)
// ---------------------------------------------------------------------------

export const ProjectTypeSchema = z.enum([
  "NODEJS",
  "NEXTJS",
  "PYTHON",
  "REACT",
  "STATIC",
  "PHP",
  "WORDPRESS",
  "DOCKER",
]);

export const ProjectStatusSchema = z.enum([
  "CREATING",
  "ACTIVE",
  "STOPPED",
  "ERROR",
  "DELETED",
]);

// ---------------------------------------------------------------------------
// Project name — shared rule used in create + update
// ---------------------------------------------------------------------------

const projectNameSchema = z
  .string()
  .min(1, "Project name is required")
  .max(60, "Project name must be 60 characters or fewer")
  // Lowercase letters, numbers, and hyphens only (URL-safe)
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/,
    "Name must be lowercase, alphanumeric, and may contain hyphens (e.g. my-app)",
  );

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const CreateProjectSchema = z.object({
  name: projectNameSchema,
  type: ProjectTypeSchema,
  gitUrl: z
    .string()
    .url("Must be a valid URL")
    .optional()
    .or(z.literal("")),
  branch: z.string().min(1).max(255).default("main"),
  buildCmd: z.string().max(500).optional(),
  startCmd: z.string().max(500).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

// ---------------------------------------------------------------------------
// Update — all fields optional
// ---------------------------------------------------------------------------

export const UpdateProjectSchema = z.object({
  name: projectNameSchema.optional(),
  gitUrl: z
    .string()
    .url("Must be a valid URL")
    .optional()
    .or(z.literal("")),
  branch: z.string().min(1).max(255).optional(),
  buildCmd: z.string().max(500).optional(),
  startCmd: z.string().max(500).optional(),
  port: z.number().int().min(1).max(65535).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  "At least one field must be provided for update",
);

export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

// ---------------------------------------------------------------------------
// List query — offset pagination
// ---------------------------------------------------------------------------

export const ProjectListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: ProjectTypeSchema.optional(),
  status: ProjectStatusSchema.optional(),
  search: z.string().max(100).optional(),
});

export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;

// ---------------------------------------------------------------------------
// Git integration (F1.3)
// ---------------------------------------------------------------------------

// Allow-list of supported Git hosts. SSH URLs (git@...) are also supported.
const GIT_URL_REGEX =
  /^(https?:\/\/|git@)(github\.com|gitlab\.com|bitbucket\.org)[:/].+\/.+$/;

export const ConnectRepoSchema = z.object({
  gitUrl: z
    .string()
    .min(1, "Git URL is required")
    .regex(
      GIT_URL_REGEX,
      "Must be a GitHub, GitLab, or Bitbucket URL (HTTPS or SSH format)",
    ),
  branch: z.string().min(1).max(255).default("main"),
  isPrivate: z.boolean().default(false),
});

export type ConnectRepoInput = z.infer<typeof ConnectRepoSchema>;

export interface GitMetadata {
  gitUrl: string | null;
  branch: string;
  sshPublicKey: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  isPrivate: boolean;
  githubInstallationId: string | null;
  githubRepoId: string | null;
  githubRepoFullName: string | null;
  githubConnectionStatus: "CONNECTED" | "DISCONNECTED" | "SUSPENDED" | "REPOSITORY_REMOVED" | null;
  githubDisconnectReason: string | null;
}

// ---------------------------------------------------------------------------
// Build integration (F1.4)
// ---------------------------------------------------------------------------

export const TriggerBuildSchema = z.object({
  buildCmd: z.string().max(500).optional(),
});

export type TriggerBuildInput = z.infer<typeof TriggerBuildSchema>;

export const DeploymentStatusSchema = z.enum([
  "QUEUED",
  "BUILDING",
  "DEPLOYING",
  "RUNNING",
  "FAILED",
  "CANCELLED",
]);

export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

// ---------------------------------------------------------------------------
// Deploy integration (F1.5)
// ---------------------------------------------------------------------------

export const DeployBodySchema = z.object({
  domain: z.string().max(253).optional(),
});

export type DeployBody = z.infer<typeof DeployBodySchema>;

export const ContainerActionSchema = z.object({
  action: z.enum(["start", "stop", "restart", "remove"]),
});

export type ContainerAction = z.infer<typeof ContainerActionSchema>;

