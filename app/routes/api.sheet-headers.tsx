import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { fetchSheetHeaders } from "~/lib/google-sheets.server";
import { extractSpreadsheetId } from "~/lib/validators";

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const { sheetUrl, sheetName } = (await request.json()) as {
    sheetUrl: string;
    sheetName?: string;
  };
  try {
    const spreadsheetId = extractSpreadsheetId(sheetUrl);
    const headers = await fetchSheetHeaders(
      spreadsheetId,
      sheetName || "Sheet1",
    );
    return json({ headers });
  } catch (e: unknown) {
    return json({ error: (e as Error).message }, { status: 400 });
  }
};
