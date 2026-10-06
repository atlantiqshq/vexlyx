import { z } from "zod";

// ---------------------------------------------------------------------------
// Engine Enums & Primitives
// ---------------------------------------------------------------------------

export const DatabaseTypeEnum = z.enum(["POSTGRESQL", "MYSQL"]);
export type DatabaseType = z.infer<typeof DatabaseTypeEnum>;

/**
 * Validates database names.
 * Standard rule: 2-63 characters, alphanumeric, underscores, and hyphens.
 */
export const DatabaseNameSchema = z
  .string()
  .trim()
  .min(2, "Database name must be at least 2 characters")
  .max(63, "Database name must be 63 characters or fewer")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    "Database name must start with a letter or number and contain only letters, numbers, underscores, or hyphens (e.g. app_db or my-app-db)",
  );

// ---------------------------------------------------------------------------
// Request Schemas
// ---------------------------------------------------------------------------

/** Schema for creating a new database instance */
export const CreateDatabaseSchema = z.object({
  name: DatabaseNameSchema,
  type: DatabaseTypeEnum.default("POSTGRESQL"),
  projectId: z.string().optional().nullable(),
  autoInjectEnv: z.boolean().default(true),
});

export type CreateDatabaseInput = z.infer<typeof CreateDatabaseSchema>;

/** Schema for querying databases */
export const DatabaseListQuerySchema = z.object({
  projectId: z.string().optional(),
  type: DatabaseTypeEnum.optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export type DatabaseListQuery = z.infer<typeof DatabaseListQuerySchema>;

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

export interface DatabaseDetail {
  id: string;
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  internalHost: string;
  dbUser: string;
  dbPassword?: string;
  connectionString: string;
  internalConnectionString: string;
  adminerUrl?: string;
  userId: string;
  projectId: string | null;
  project?: {
    id: string;
    name: string;
  } | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface AdminerAvailability {
  enabled: boolean;
  url?: string;
  disabledReason?: string;
}

export interface DatabaseListResponse {
  databases: DatabaseDetail[];
  adminer: AdminerAvailability;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface DatabaseConnectionTestResult {
  connected: boolean;
  latencyMs?: number;
  error?: string;
  database?: string;
  user?: string;
}
