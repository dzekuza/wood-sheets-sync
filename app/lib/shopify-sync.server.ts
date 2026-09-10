import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "~/db.server";
import { fetchSheetRows } from "~/lib/google-sheets.server";
import {
  findVariantBySku,
  findProductByTitle,
  findProductByHandle,
  findVariantByOptions,
  updateProductFields,
  updateVariantFields,
  updateAllVariantsFields,
  createProduct,
  attachProductImages,
  upsertProductOption,
  syncVariantCombinations,
} from "~/lib/shopify-graphql.server";
import { createSyncLog, updateSyncLog } from "~/lib/sync-logger.server";

// Shopify field names that map to product-level vs variant-level mutations
const PRODUCT_FIELDS = new Set([
  "title",
  "handle",
  "body_html",
  "vendor",
  "product_type",
  "tags",
  "status",
]);

const VARIANT_FIELDS = new Set(["price", "compare_at_price", "sku", "barcode"]);

// Per-variant price fields — same as VARIANT_FIELDS but only update the
// specific variant matched by SKU, not all variants on the product.
const VARIANT_SPECIFIC_PRICE_FIELDS = new Set([
  "variant_price",
  "variant_compare_at_price",
]);

// "images" (pipe-separated) or image_1 … image_10
const IMAGE_FIELDS = new Set([
  "images",
  ...Array.from({ length: 10 }, (_, i) => `image_${i + 1}`),
]);

// option1_name, option1_values, option2_name, option2_values, option3_name, option3_values
const OPTION_FIELDS = new Set([
  "option1_name",
  "option1_values",
  "option1_value",
  "option2_name",
  "option2_values",
  "option2_value",
  "option3_name",
  "option3_values",
  "option3_value",
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type OptionData = {
  option1Name?: string;
  option1Values?: string[];
  option2Name?: string;
  option2Values?: string[];
  option3Name?: string;
  option3Values?: string[];
};

// Upserts option1/2/3 definitions on the product, then ensures the desired
// variant combination(s) exist — shared by the create-product and
// update-existing-product paths, which otherwise duplicate this verbatim.
async function applyProductOptions(
  admin: AdminApiContext,
  productId: string,
  optionData: OptionData,
  variantSku: string | undefined,
  price: string | undefined,
  compareAtPrice: string | undefined | null,
  barcode: string | undefined,
): Promise<string[]> {
  const errors: string[] = [];
  if (!optionData.option1Name || !optionData.option1Values?.length) {
    return errors;
  }

  for (const [name, values] of [
    [optionData.option1Name, optionData.option1Values],
    [optionData.option2Name, optionData.option2Values],
    [optionData.option3Name, optionData.option3Values],
  ] as const) {
    if (name && values?.length) {
      errors.push(
        ...(await upsertProductOption(admin, productId, name, values)),
      );
    }
  }

  const varErrors = await syncVariantCombinations(
    admin,
    productId,
    optionData.option1Name,
    optionData.option1Values,
    optionData.option2Name,
    optionData.option2Values,
    price,
    optionData.option1Values.length === 1
      ? [
          {
            option1Value: optionData.option1Values[0],
            option2Value: optionData.option2Values?.[0],
            option3Value: optionData.option3Values?.[0],
            sku: variantSku,
            price,
            compareAtPrice,
            barcode,
          },
        ]
      : [],
    optionData.option3Name,
    optionData.option3Values,
  );
  errors.push(...varErrors);

  return errors;
}

function splitImageUrls(value: string): string[] {
  return value
    .split(/[|,]/)
    .map((url) => url.trim())
    .filter((url) => url.startsWith("http"));
}

function getCell(
  row: string[],
  headerIndex: Map<string, number>,
  header: string,
): string {
  const index = headerIndex.get(header);
  return index === undefined ? "" : (row[index] ?? "").toString().trim();
}

async function recordProductResult(
  logId: string,
  shop: string,
  productId: string,
  productTitle: string,
  handle: string,
  status: "updated" | "skipped" | "error",
  syncedFields: string[],
  errorMessage?: string,
) {
  try {
    await prisma.syncProductResult.create({
      data: {
        syncLogId: logId,
        shop,
        productId,
        productTitle,
        handle,
        status,
        syncedFields:
          syncedFields.length > 0 ? JSON.stringify(syncedFields) : null,
        errorMessage: errorMessage ?? null,
      },
    });
  } catch {
    // non-fatal — don't interrupt the sync
  }
}

export async function runSync(
  shop: string,
  triggeredBy: "manual" | "scheduled",
  admin: AdminApiContext,
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

    // 5. Resolve the identifier column index
    const matchField = config.matchField ?? "sku";
    const identifierColumnIndex =
      config.skuColumn != null ? headerIndex.get(config.skuColumn) : undefined;
    if (identifierColumnIndex === undefined) {
      await updateSyncLog(logId, {
        status: "failed",
        totalRows,
        updatedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        errorMessages: [
          `Identifier column "${config.skuColumn}" not found in sheet headers: [${headers.join(", ")}]`,
        ],
        completedAt: new Date(),
      });
      return { logId, updatedCount: 0, skippedCount: 0, errorCount: 1 };
    }

    // Clear any stale cancel flag before starting
    await prisma.syncCancel.deleteMany({ where: { shop } });

    // 6. Process each data row
    for (const row of dataRows) {
      // Check for cancellation request
      const cancelRequest = await prisma.syncCancel.findUnique({
        where: { shop },
      });
      if (cancelRequest) {
        await prisma.syncCancel.delete({ where: { shop } });
        await updateSyncLog(logId, {
          status: "partial",
          totalRows,
          updatedCount,
          skippedCount,
          errorCount,
          errorMessages: [...errorMessages, "Sync stopped by user."],
          completedAt: new Date(),
        });
        return { logId, updatedCount, skippedCount, errorCount };
      }

      const identifier = row[identifierColumnIndex]?.trim() ?? "";
      const rowHandle = getCell(row, headerIndex, "Handle");

      if (!identifier) {
        skippedCount++;
        continue;
      }

      // Fields written this row (for diff display)
      const syncedFields: string[] = [];

      // Build update payload from field mappings
      const productPayload: Partial<{
        title: string;
        handle: string;
        bodyHtml: string;
        vendor: string;
        productType: string;
        tags: string[];
        status: string;
      }> = {};

      const variantPayload: Partial<{
        price: string;
        compareAtPrice: string | null;
        barcode: string;
      }> = {};
      let variantSku = matchField === "sku" ? identifier : undefined;
      let hasMappedVariantSku = false;

      // Per-variant price — updates only the specific variant matched by SKU
      const variantSpecificPrice: Partial<{
        price: string;
        compareAtPrice: string | null;
      }> = {};

      // Ordered image URLs (image_1 first, then image_2, …)
      const imageUrls: (string | null)[] = Array(10).fill(null);

      // Option data collected from mapped columns
      const optionData: {
        option1Name?: string;
        option1Values?: string[];
        option2Name?: string;
        option2Values?: string[];
        option3Name?: string;
        option3Values?: string[];
      } = {};

      for (const mapping of config.mappings) {
        const colIndex = headerIndex.get(mapping.sheetColumn);
        if (colIndex === undefined) continue;

        const rawValue = (row[colIndex] ?? "").toString().trim();

        if (rawValue) syncedFields.push(mapping.shopifyField);
        if (!rawValue && PRODUCT_FIELDS.has(mapping.shopifyField)) continue;

        if (PRODUCT_FIELDS.has(mapping.shopifyField)) {
          switch (mapping.shopifyField) {
            case "title":
              productPayload.title = rawValue;
              break;
            case "handle":
              productPayload.handle = rawValue;
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
            case "status": {
              const s = rawValue.toLowerCase();
              productPayload.status =
                s === "draft" || s === "archived" ? s : "active";
              break;
            }
          }
        } else if (VARIANT_FIELDS.has(mapping.shopifyField)) {
          switch (mapping.shopifyField) {
            case "price":
              variantPayload.price = rawValue;
              break;
            case "compare_at_price": {
              variantPayload.compareAtPrice =
                rawValue === "" || rawValue === "0" ? null : rawValue;
              break;
            }
            case "barcode":
              variantPayload.barcode = rawValue;
              break;
            case "sku":
              variantSku = rawValue || variantSku;
              hasMappedVariantSku = Boolean(rawValue);
              break;
          }
        } else if (IMAGE_FIELDS.has(mapping.shopifyField)) {
          if (mapping.shopifyField === "images") {
            // Supports pipe or comma-separated lists: "url1|url2" or "url1,url2".
            splitImageUrls(rawValue).forEach((url, i) => {
              if (i < 10) imageUrls[i] = url;
            });
          } else {
            // image_1 … image_10 → slot 0 … 9
            const slot =
              parseInt(mapping.shopifyField.replace("image_", ""), 10) - 1;
            if (rawValue.startsWith("http")) imageUrls[slot] = rawValue;
          }
        } else if (VARIANT_SPECIFIC_PRICE_FIELDS.has(mapping.shopifyField)) {
          switch (mapping.shopifyField) {
            case "variant_price":
              variantSpecificPrice.price = rawValue;
              break;
            case "variant_compare_at_price":
              variantSpecificPrice.compareAtPrice =
                rawValue === "" || rawValue === "0" ? null : rawValue;
              break;
          }
        } else if (OPTION_FIELDS.has(mapping.shopifyField)) {
          switch (mapping.shopifyField) {
            case "option1_name":
              optionData.option1Name = rawValue;
              break;
            case "option1_values":
              optionData.option1Values = rawValue
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean);
              break;
            case "option1_value":
              if (rawValue) optionData.option1Values = [rawValue];
              break;
            case "option2_name":
              optionData.option2Name = rawValue;
              break;
            case "option2_values":
              optionData.option2Values = rawValue
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean);
              break;
            case "option2_value":
              if (rawValue) optionData.option2Values = [rawValue];
              break;
            case "option3_name":
              optionData.option3Name = rawValue;
              break;
            case "option3_values":
              optionData.option3Values = rawValue
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean);
              break;
            case "option3_value":
              if (rawValue) optionData.option3Values = [rawValue];
              break;
          }
        }
      }

      // Collect valid (non-null) image URLs in slot order
      const validImageUrls = imageUrls.filter((u): u is string => u !== null);

      // Find the product/variant in Shopify using the configured match field
      let variant: { variantId: string; productId: string } | null = null;
      if (matchField === "title") {
        variant = await findProductByTitle(admin, identifier);
      } else if (matchField === "handle") {
        variant = await findProductByHandle(admin, identifier);
      } else {
        variant = await findVariantBySku(admin, identifier);
      }
      if (!variant && rowHandle) {
        variant = await findProductByHandle(admin, rowHandle);
      }
      if (!variant && productPayload.title) {
        variant = await findProductByTitle(admin, productPayload.title);
      }

      if (!variant) {
        if (config.updateOnly) {
          skippedCount++;
          continue;
        }
        // No existing product — create one
        const title = productPayload.title ?? identifier;
        const sku = matchField === "sku" ? identifier : undefined;
        const result = await createProduct(admin, {
          title,
          handle:
            productPayload.handle ||
            rowHandle ||
            (matchField === "handle" ? identifier : undefined),
          bodyHtml: productPayload.bodyHtml,
          vendor: productPayload.vendor,
          productType: productPayload.productType,
          tags: productPayload.tags,
          status: productPayload.status?.toUpperCase(),
          sku: variantSku ?? sku,
          price: variantPayload.price,
          compareAtPrice: variantPayload.compareAtPrice,
          barcode: variantPayload.barcode,
        });

        if ("errors" in result) {
          errorMessages.push(
            ...result.errors.map((e) => `[create ${identifier}] ${e}`),
          );
          errorCount++;
          await recordProductResult(
            logId,
            shop,
            "",
            title,
            "",
            "error",
            [],
            result.errors.join("; "),
          );
        } else {
          // Attach images and options to the newly-created product
          const newProductId = result.productId;

          if (validImageUrls.length > 0) {
            const imgErrors = await attachProductImages(
              admin,
              newProductId,
              validImageUrls,
              title,
            );
            if (imgErrors.length > 0) {
              errorMessages.push(...imgErrors);
            }
          }

          const optionErrors = await applyProductOptions(
            admin,
            newProductId,
            optionData,
            variantSku,
            variantPayload.price ?? variantSpecificPrice.price,
            variantPayload.compareAtPrice ??
              variantSpecificPrice.compareAtPrice,
            variantPayload.barcode,
          );
          if (optionErrors.length > 0) errorMessages.push(...optionErrors);

          await recordProductResult(
            logId,
            shop,
            newProductId,
            title,
            "",
            "updated",
            syncedFields,
          );
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
          productPayload,
        );
        rowErrors.push(...productErrors);
      }

      // Apply variant-level updates across ALL variants (not just the default one)
      const hasVariantFields = Object.keys(variantPayload).length > 0;
      const isShopifyCsvVariantRow =
        Boolean(rowHandle) &&
        (headerIndex.has("Option1 Value") ||
          headerIndex.has("Option2 Value") ||
          headerIndex.has("Option3 Value"));
      if (hasVariantFields && !isShopifyCsvVariantRow) {
        const variantErrors = await updateAllVariantsFields(
          admin,
          variant.productId,
          variantPayload,
        );
        rowErrors.push(...variantErrors);
      }

      // Apply per-variant price — updates ONLY the specific variant matched by SKU
      const rowVariantPrice =
        variantSpecificPrice.price ??
        (isShopifyCsvVariantRow ? variantPayload.price : undefined);
      const rowVariantCompareAtPrice =
        variantSpecificPrice.compareAtPrice ??
        (isShopifyCsvVariantRow ? variantPayload.compareAtPrice : undefined);
      const hasVariantSpecificPrice =
        rowVariantPrice !== undefined || rowVariantCompareAtPrice !== undefined;
      const hasRowVariantFields =
        hasVariantSpecificPrice || hasMappedVariantSku;
      if (hasRowVariantFields) {
        if (isShopifyCsvVariantRow || matchField !== "sku") {
          const option1Value = optionData.option1Values?.[0];
          const option2Value = optionData.option2Values?.[0];
          const option3Value = optionData.option3Values?.[0];
          if (!optionData.option1Name || !option1Value) {
            rowErrors.push(
              "[variant row] Updating a specific variant without SKU matching requires option name/value columns.",
            );
          } else {
            const optionVariantId = await findVariantByOptions(
              admin,
              variant.productId,
              optionData.option1Name,
              option1Value,
              optionData.option2Name,
              option2Value,
              optionData.option3Name,
              option3Value,
            );

            if (optionVariantId) {
              const specificErrors = await updateVariantFields(
                admin,
                optionVariantId,
                variant.productId,
                {
                  sku: variantSku,
                  price: rowVariantPrice,
                  compareAtPrice: rowVariantCompareAtPrice,
                },
              );
              rowErrors.push(...specificErrors);
            }
          }
        } else {
          const specificErrors = await updateVariantFields(
            admin,
            variant.variantId,
            variant.productId,
            {
              sku: variantSku,
              price: rowVariantPrice,
              compareAtPrice: rowVariantCompareAtPrice,
            },
          );
          rowErrors.push(...specificErrors);
        }
      }

      // Attach images (skips URLs already on the product)
      if (validImageUrls.length > 0) {
        const imgErrors = await attachProductImages(
          admin,
          variant.productId,
          validImageUrls,
          productPayload.title ?? "",
        );
        rowErrors.push(...imgErrors);
      }

      // Upsert variant options and sync the desired combination(s)
      const optionErrors = await applyProductOptions(
        admin,
        variant.productId,
        optionData,
        variantSku,
        variantPayload.price ?? rowVariantPrice,
        variantPayload.compareAtPrice ?? rowVariantCompareAtPrice,
        variantPayload.barcode,
      );
      rowErrors.push(...optionErrors);

      if (rowErrors.length > 0) {
        errorCount++;
        errorMessages.push(`${identifier}: ${rowErrors.join("; ")}`);
        await recordProductResult(
          logId,
          shop,
          variant.productId,
          productPayload.title ?? identifier,
          "",
          "error",
          syncedFields,
          rowErrors.join("; "),
        );
      } else {
        updatedCount++;
        await recordProductResult(
          logId,
          shop,
          variant.productId,
          productPayload.title ?? identifier,
          "",
          "updated",
          syncedFields,
        );
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
