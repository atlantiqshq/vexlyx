-- CreateEnum
CREATE TYPE "SignatureMode" AS ENUM ('INHERIT', 'CUSTOM', 'NONE');

-- CreateEnum
CREATE TYPE "SignatureSenderListMode" AS ENUM ('ALL', 'ONLY_LISTED', 'EXCEPT_LISTED');

-- CreateEnum
CREATE TYPE "SignatureScope" AS ENUM ('DOMAIN', 'MAILBOX');

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "signature_enforcement" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "domain_signatures" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "template" TEXT NOT NULL DEFAULT '',
    "company" TEXT,
    "website" TEXT,
    "logo_url" TEXT,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "enforce_server_side" BOOLEAN NOT NULL DEFAULT false,
    "external_only" BOOLEAN NOT NULL DEFAULT false,
    "new_messages_only" BOOLEAN NOT NULL DEFAULT false,
    "sender_list_mode" "SignatureSenderListMode" NOT NULL DEFAULT 'ALL',
    "sender_list" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "compliance_enabled" BOOLEAN NOT NULL DEFAULT false,
    "compliance_text" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_groups" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailbox_signatures" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "mode" "SignatureMode" NOT NULL DEFAULT 'INHERIT',
    "template" TEXT,
    "group_id" TEXT,
    "display_name" TEXT,
    "title" TEXT,
    "department" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailbox_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_banners" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "group_id" TEXT,
    "text" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_versions" (
    "id" TEXT NOT NULL,
    "scope" "SignatureScope" NOT NULL,
    "target_id" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_by_id" TEXT,
    "created_by_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_assets" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "domain_signatures_domain_id_key" ON "domain_signatures"("domain_id");

-- CreateIndex
CREATE INDEX "signature_groups_domain_id_idx" ON "signature_groups"("domain_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_groups_domain_id_name_key" ON "signature_groups"("domain_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "mailbox_signatures_mailbox_id_key" ON "mailbox_signatures"("mailbox_id");

-- CreateIndex
CREATE INDEX "mailbox_signatures_group_id_idx" ON "mailbox_signatures"("group_id");

-- CreateIndex
CREATE INDEX "signature_banners_domain_id_idx" ON "signature_banners"("domain_id");

-- CreateIndex
CREATE INDEX "signature_versions_scope_target_id_created_at_idx" ON "signature_versions"("scope", "target_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "signature_assets_file_name_key" ON "signature_assets"("file_name");

-- CreateIndex
CREATE INDEX "signature_assets_domain_id_idx" ON "signature_assets"("domain_id");

-- AddForeignKey
ALTER TABLE "domain_signatures" ADD CONSTRAINT "domain_signatures_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_groups" ADD CONSTRAINT "signature_groups_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_signatures" ADD CONSTRAINT "mailbox_signatures_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_signatures" ADD CONSTRAINT "mailbox_signatures_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "signature_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_banners" ADD CONSTRAINT "signature_banners_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_banners" ADD CONSTRAINT "signature_banners_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "signature_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_assets" ADD CONSTRAINT "signature_assets_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

