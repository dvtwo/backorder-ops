-- CreateTable
CREATE TABLE "backorders" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "customerName" TEXT,
    "email" TEXT,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expectedDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backorders_pkey" PRIMARY KEY ("id")
);
