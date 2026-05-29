-- CreateTable
CREATE TABLE "SyncProductResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "syncLogId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "syncedFields" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncProductResult_syncLogId_fkey" FOREIGN KEY ("syncLogId") REFERENCES "SyncLog" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SyncProductResult_syncLogId_idx" ON "SyncProductResult"("syncLogId");
CREATE INDEX "SyncProductResult_shop_idx" ON "SyncProductResult"("shop");
