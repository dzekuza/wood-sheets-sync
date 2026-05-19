// Google Sheets API v4 — uses native fetch, no extra SDK required.
// Requires GOOGLE_SHEETS_API_KEY in process.env.

const BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";

function getApiKey(): string {
  const key = process.env.GOOGLE_SHEETS_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_SHEETS_API_KEY environment variable is not set.");
  }
  return key;
}

/**
 * Fetch the header row (A1:Z1) from the given sheet.
 * Returns an array of column name strings, or [] if the sheet is empty.
 */
export async function fetchSheetHeaders(
  spreadsheetId: string,
  sheetName: string
): Promise<string[]> {
  const apiKey = getApiKey();
  const range = `'${sheetName}'!A1:Z1`;
  const url = `${BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}?key=${apiKey}&valueRenderOption=FORMATTED_VALUE`;

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Google Sheets API error fetching headers (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as { values?: string[][] };
  return data.values?.[0] ?? [];
}

/**
 * Fetch all rows (A:Z) from the given sheet.
 * rows[0] = headers, rows[1..] = data rows.
 * Returns [] if the sheet is empty.
 */
export async function fetchSheetRows(
  spreadsheetId: string,
  sheetName: string
): Promise<string[][]> {
  const apiKey = getApiKey();
  const range = `'${sheetName}'!A:Z`;
  const url = `${BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}?key=${apiKey}&valueRenderOption=FORMATTED_VALUE`;

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Google Sheets API error fetching rows (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as { values?: string[][] };
  return data.values ?? [];
}
