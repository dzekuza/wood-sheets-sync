import { z } from "zod";

// ── Schema definitions ────────────────────────────────────────────────────────

export const SheetUrlSchema = z.object({
  sheetUrl: z.string().url(),
  sheetName: z.string().default("Sheet1"),
});

export const FieldMappingSchema = z.object({
  sheetColumn: z.string(),
  shopifyField: z.enum([
    // Product-level
    "title",
    "body_html",
    "vendor",
    "product_type",
    "tags",
    "status",
    // Variant-level
    "price",
    "compare_at_price",
    "sku",
    "barcode",
    // Images — single pipe-separated column or up to 10 individual columns
    "images",
    "image_1",
    "image_2",
    "image_3",
    "image_4",
    "image_5",
    "image_6",
    "image_7",
    "image_8",
    "image_9",
    "image_10",
    // Variant options
    "option1_name",
    "option1_values",
    "option2_name",
    "option2_values",
  ]),
});

export const SaveSettingsSchema = z.object({
  sheetUrl: z.string().url(),
  sheetName: z.string(),
  skuColumn: z.string(),
  mappings: z.array(FieldMappingSchema),
});

export const ScheduleSchema = z.object({
  intervalHours: z.coerce.number().int().nullable(),
  isEnabled: z.boolean(),
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type SheetUrlInput = z.infer<typeof SheetUrlSchema>;
export type FieldMappingInput = z.infer<typeof FieldMappingSchema>;
export type SaveSettingsInput = z.infer<typeof SaveSettingsSchema>;
export type ScheduleInput = z.infer<typeof ScheduleSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extracts the spreadsheet ID from a Google Sheets URL.
 * e.g. https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
 */
export function extractSpreadsheetId(url: string): string {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match || !match[1]) {
    throw new Error(
      `Could not extract spreadsheet ID from URL: ${url}. ` +
        `Expected a Google Sheets URL containing /spreadsheets/d/<id>.`
    );
  }
  return match[1];
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const SHOPIFY_FIELDS = [
  // ── Product fields ──────────────────────────────────────────────────────────
  { value: "title",            label: "Title" },
  { value: "body_html",        label: "Description" },
  { value: "vendor",           label: "Vendor" },
  { value: "product_type",     label: "Product Type" },
  { value: "tags",             label: "Tags" },
  { value: "status",           label: "Status (active / draft)" },
  // ── Variant fields ──────────────────────────────────────────────────────────
  { value: "price",            label: "Price" },
  { value: "compare_at_price", label: "Compare At Price" },
  { value: "sku",              label: "SKU" },
  { value: "barcode",          label: "Barcode" },
  // ── Images ──────────────────────────────────────────────────────────────────
  { value: "images",           label: "Images (pipe-separated URLs)" },
  { value: "image_1",          label: "Image 1 (URL)" },
  { value: "image_2",          label: "Image 2 (URL)" },
  { value: "image_3",          label: "Image 3 (URL)" },
  { value: "image_4",          label: "Image 4 (URL)" },
  { value: "image_5",          label: "Image 5 (URL)" },
  { value: "image_6",          label: "Image 6 (URL)" },
  { value: "image_7",          label: "Image 7 (URL)" },
  { value: "image_8",          label: "Image 8 (URL)" },
  { value: "image_9",          label: "Image 9 (URL)" },
  { value: "image_10",         label: "Image 10 (URL)" },
  // ── Variant options ─────────────────────────────────────────────────────────
  { value: "option1_name",     label: "Option 1 Name (e.g. Size)" },
  { value: "option1_values",   label: "Option 1 Values (comma-separated)" },
  { value: "option2_name",     label: "Option 2 Name (e.g. Colour)" },
  { value: "option2_values",   label: "Option 2 Values (comma-separated)" },
] as const;
