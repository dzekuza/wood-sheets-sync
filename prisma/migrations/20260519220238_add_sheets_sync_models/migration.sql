-- CreateTable
CREATE TABLE "SheetConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sheetUrl" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "sheetName" TEXT NOT NULL DEFAULT 'Sheet1',
    "skuColumn" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FieldMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sheetConfigId" TEXT NOT NULL,
    "sheetColumn" TEXT NOT NULL,
    "shopifyField" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FieldMapping_sheetConfigId_fkey" FOREIGN KEY ("sheetConfigId") REFERENCES "SheetConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sheetConfigId" TEXT NOT NULL,
    "intervalHours" INTEGER,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SyncSchedule_sheetConfigId_fkey" FOREIGN KEY ("sheetConfigId") REFERENCES "SheetConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessages" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "SheetConfig_shop_key" ON "SheetConfig"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "FieldMapping_sheetConfigId_sheetColumn_key" ON "FieldMapping"("sheetConfigId", "sheetColumn");

-- CreateIndex
CREATE UNIQUE INDEX "FieldMapping_sheetConfigId_shopifyField_key" ON "FieldMapping"("sheetConfigId", "shopifyField");

-- CreateIndex
CREATE UNIQUE INDEX "SyncSchedule_sheetConfigId_key" ON "SyncSchedule"("sheetConfigId");

-- CreateIndex
CREATE INDEX "SyncLog_shop_startedAt_idx" ON "SyncLog"("shop", "startedAt");
