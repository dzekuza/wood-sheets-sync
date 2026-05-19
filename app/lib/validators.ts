import { z } from "zod";

// ── Schema definitions ────────────────────────────────────────────────────────

export const SheetUrlSchema = z.object({
  sheetUrl: z.string().url(),
  sheetName: z.string().default("Sheet1"),
});

export const FieldMappingSchema = z.object({
  sheetColumn: z.string(),
  shopifyField: z.enum([
    "title",
    "body_html",
    "vendor",
    "product_type",
    "tags",
    "price",
    "compare_at_price",
    "sku",
    "barcode",
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
  { value: "title", label: "Title" },
  { value: "body_html", label: "Description" },
  { value: "vendor", label: "Vendor" },
  { value: "product_type", label: "Product Type" },
  { value: "tags", label: "Tags" },
  { value: "price", label: "Price" },
  { value: "compare_at_price", label: "Compare At Price" },
  { value: "sku", label: "SKU" },
  { value: "barcode", label: "Barcode" },
] as const;
