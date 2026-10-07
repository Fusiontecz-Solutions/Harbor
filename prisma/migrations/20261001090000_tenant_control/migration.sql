-- CreateTable
CREATE TABLE IF NOT EXISTS "TenantControl" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "sendingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantControl_pkey" PRIMARY KEY ("id")
);
