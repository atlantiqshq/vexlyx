CREATE TYPE "GitHubConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'SUSPENDED', 'REPOSITORY_REMOVED');

CREATE TABLE "github_apps" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "app_id" BIGINT NOT NULL,
    "slug" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "encrypted_client_secret" TEXT NOT NULL,
    "encrypted_private_key" TEXT NOT NULL,
    "encrypted_webhook_secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "github_apps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "github_installations" (
    "id" TEXT NOT NULL,
    "installation_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "account_login" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "repository_selection" TEXT NOT NULL,
    "status" "GitHubConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "suspended_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "projects"
ADD COLUMN "github_installation_id" TEXT,
ADD COLUMN "github_repo_id" BIGINT,
ADD COLUMN "github_repo_full_name" TEXT,
ADD COLUMN "github_connection_status" "GitHubConnectionStatus",
ADD COLUMN "github_disconnect_reason" TEXT;

CREATE UNIQUE INDEX "github_apps_app_id_key" ON "github_apps"("app_id");
CREATE UNIQUE INDEX "github_installations_installation_id_key" ON "github_installations"("installation_id");
CREATE INDEX "github_installations_user_id_idx" ON "github_installations"("user_id");
CREATE INDEX "github_installations_account_id_idx" ON "github_installations"("account_id");
CREATE INDEX "projects_github_installation_id_idx" ON "projects"("github_installation_id");
CREATE INDEX "projects_github_repo_id_idx" ON "projects"("github_repo_id");

ALTER TABLE "github_installations"
ADD CONSTRAINT "github_installations_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projects"
ADD CONSTRAINT "projects_github_installation_id_fkey"
FOREIGN KEY ("github_installation_id") REFERENCES "github_installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
