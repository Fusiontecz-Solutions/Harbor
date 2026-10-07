-- AlterTable
ALTER TABLE "TenantControl" ADD COLUMN     "prepaidBalance" DECIMAL(14,4),
ADD COLUMN     "prepaidUnitPrice" DECIMAL(12,6),
ADD COLUMN     "prepaidCurrency" TEXT DEFAULT 'USD',
ADD COLUMN     "prepaidChargeBy" TEXT DEFAULT 'messages',
ADD COLUMN     "prepaidUpdatedBy" TEXT,
ADD COLUMN     "prepaidUpdatedAt" TIMESTAMP(3);
