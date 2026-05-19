import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "~/db.server";
import { fetchSheetRows } from "~/lib/google-sheets.server";
import {
  findVariantBySku,
  updateProductFields,
  updateVariantFields,
  createProduct,
} from "~/lib/shopify-graphql.server";
import {
  createSyncLog,
  updateSyncLog,
} from "~/lib/sync-logger.server";

// Shopify field names that map to product-level vs variant-level mutations
const PRODUCT_FIELDS = new Set([
  "title",
  "body_html",
  "vendor",
  "product_type",
  "tags",
]);

const VARIANT_FIELDS = new Set([
  "price",
  "compare_at_price",
  "sku",
  "barcode",
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSync(
  shop: string,
  triggeredBy: "manual" | "scheduled",
  admin: AdminApiContext
): Promise<{
  logId: string;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
}> {
  // 1. Create a running log entry
  const logId = await createSyncLog(shop, triggeredBy);

  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const errorMessages: string[] = [];

  try {
    // 2. Load SheetConfig with mappings from DB for this shop
    const config = await prisma.sheetConfig.findFirst({
      where: { shop },
      include: { mappings: true },
    });

    if (!config) {
      await updateSyncLog(logId, {
        status: "failed",
        totalRows: 0,
        updatedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        errorMessages: ["No sheet configuration found for this shop."],
        completedAt: new Date(),
      });
      return { logId, updatedCount: 0, skippedCount: 0, errorCount: 1 };
    }

    // 3. Fetch all rows from the sheet (rows[0] = headers, rows[1..] = data)
    const rows = await fetchSheetRows(config.spreadsheetId, config.sheetName);

    if (rows.length < 2) {
      await updateSyncLog(logId, {
        status: "failed",
        totalRows: 0,
        updatedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        errorMessages: [
          "Sheet has no data rows (only a header row or is completely empty).",
        ],
        completedAt: new Date(),
      });
      return { logId, updatedCount: 0, skippedCount: 0, errorCount: 1 };
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);
    const totalRows = dataRows.length;

    // 4. Build header → column index map
    const headerIndex = new Map<string, number>();
    headers.forEach((header: string, idx: number) => {
      headerIndex.set(header, idx);
    });

    // 5. Resolve the SKU column index
    const skuColumnIndex = config.skuColumn != null ? headerIndex.get(config.skuColumn) : undefined;
    if (skuColumnIndex === undefined) {
      await updateSyncLog(logId, {
        status: "failed",
        totalRows,
        updatedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        errorMessages: [
          `SKU column "${config.skuColumn}" not found in sheet headers: [${headers.join(", ")}]`,
        ],
        completedAt: new Date(),
      });
      return { logId, updatedCount: 0, skippedCount: 0, errorCount: 1 };
    }

    // 6. Process each data row
    for (const row of dataRows) {
      const sku = row[skuColumnIndex]?.trim() ?? "";

      if (!sku) {
        skippedCount++;
        continue;
      }

      // Build update payload from field mappings
      const productPayload: Partial<{
        title: string;
        bodyHtml: string;
        vendor: string;
        productType: string;
        tags: string[];
      }> = {};

      const variantPayload: Partial<{
        price: string;
        compareAtPrice: string | null;
        barcode: string;
      }> = {};

      for (const mapping of config.mappings) {
        const colIndex = headerIndex.get(mapping.sheetColumn);
        if (colIndex === undefined) continue;

        const rawValue = row[colIndex] ?? "";

        if (PRODUCT_FIELDS.has(mapping.shopifyField)) {
          switch (mapping.shopifyField) {
            case "title":
              productPayload.title = rawValue;
              break;
            case "body_html":
              productPayload.bodyHtml = rawValue;
              break;
            case "vendor":
              productPayload.vendor = rawValue;
              break;
            case "product_type":
              productPayload.productType = rawValue;
              break;
            case "tags":
              productPayload.tags = rawValue
                .split(",")
                .map((t) => t.trim())
                .filter((t: string) => Boolean(t));
              break;
          }
        } else if (VARIANT_FIELDS.has(mapping.shopifyField)) {
          switch (mapping.shopifyField) {
            case "price":
              variantPayload.price = rawValue;
              break;
            case "compare_at_price": {
              const trimmed = rawValue.trim();
              variantPayload.compareAtPrice =
                trimmed === "" || trimmed === "0" ? null : trimmed;
              break;
            }
            case "barcode":
              variantPayload.barcode = rawValue;
              break;
            // "sku" field in mappings is informational; the SKU is already used for lookup
          }
        }
      }

      // Find the variant in Shopify by SKU
      const variant = await findVariantBySku(admin, sku);

      if (!variant) {
        // No existing product — create one
        const title = productPayload.title ?? sku;
        const result = await createProduct(admin, {
          title,
          bodyHtml: productPayload.bodyHtml,
          vendor: productPayload.vendor,
          productType: productPayload.productType,
          tags: productPayload.tags,
          sku,
          price: variantPayload.price,
          compareAtPrice: variantPayload.compareAtPrice,
          barcode: variantPayload.barcode,
        });

        if ("errors" in result) {
          errorMessages.push(...result.errors.map((e) => `[create ${sku}] ${e}`));
          errorCount++;
        } else {
          updatedCount++;
        }

        await delay(100);
        continue;
      }

      const rowErrors: string[] = [];

      // Apply product-level updates
      const hasProductFields = Object.keys(productPayload).length > 0;
      if (hasProductFields) {
        const productErrors = await updateProductFields(
          admin,
          variant.productId,
          productPayload
        );
        rowErrors.push(...productErrors);
      }

      // Apply variant-level updates
      const hasVariantFields = Object.keys(variantPayload).length > 0;
      if (hasVariantFields) {
        const variantErrors = await updateVariantFields(
          admin,
          variant.variantId,
          variant.productId,
          variantPayload
        );
        rowErrors.push(...variantErrors);
      }

      if (rowErrors.length > 0) {
        errorCount++;
        errorMessages.push(
          `SKU ${sku}: ${rowErrors.join("; ")}`
        );
      } else {
        updatedCount++;
      }

      // Rate-limit: 100ms pause between rows
      await delay(100);
    }

    // 7. Determine final status
    const status =
      errorCount === 0
        ? "success"
        : errorCount === totalRows
        ? "failed"
        : "partial";

    await updateSyncLog(logId, {
      status,
      totalRows,
      updatedCount,
      skippedCount,
      errorCount,
      errorMessages,
      completedAt: new Date(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateSyncLog(logId, {
      status: "failed",
      totalRows: 0,
      updatedCount,
      skippedCount,
      errorCount: errorCount + 1,
      errorMessages: [...errorMessages, `Unhandled error: ${message}`],
      completedAt: new Date(),
    });
  }

  return { logId, updatedCount, skippedCount, errorCount };
}
