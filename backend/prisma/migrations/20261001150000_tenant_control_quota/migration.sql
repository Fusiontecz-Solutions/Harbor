-- AlterTable
ALTER TABLE "TenantControl" ADD COLUMN     "limitCountBy" TEXT NOT NULL DEFAULT 'messages',
ADD COLUMN     "limitResetDay" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "limitScope" TEXT NOT NULL DEFAULT 'monthly',
ADD COLUMN     "limitUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "limitUpdatedBy" TEXT,
ADD COLUMN     "messageLimit" INTEGER;
