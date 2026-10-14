-- CreateEnum
CREATE TYPE "PasswordResetSource" AS ENUM ('SELF_SERVICE', 'ADMIN', 'CLI');

-- AlterTable
ALTER TABLE "password_reset_tokens" ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "source" "PasswordResetSource" NOT NULL DEFAULT 'SELF_SERVICE';

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
