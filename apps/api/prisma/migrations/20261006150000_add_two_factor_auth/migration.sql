-- AlterTable
ALTER TABLE "users"
ADD COLUMN "totp_secret_encrypted" TEXT,
ADD COLUMN "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "totp_verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- AddForeignKey
ALTER TABLE "recovery_codes"
ADD CONSTRAINT "recovery_codes_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
