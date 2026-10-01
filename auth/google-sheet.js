// @ts-check
// Replaces the tabs of the "TractorJunction vs VMS - Daily Report" Google Sheet
// with the latest compare CSVs, via the Apps Script web app bound to that sheet
// (source: auth/apps-script/report-sheet.gs). Needs SHEET_ID, SHEET_WEBAPP_URL
// and SHEET_WEBAPP_SECRET in .env.
//
// Run:  npm run sheet:update            (newest report in output/)
//       npm run sheet:update -- 2026-10-01
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, 'output');
dotenv.config({ path: path.resolve(ROOT, '.env'), quiet: true });

// Tab name -> report CSV suffix (tractorjunction-vs-vms<suffix>-<date>.csv).
const TABS = [
  ['Issues', '-issues'],
  ['Mismatch Detail', '-detail'],
  ['Sold Still Listed', '-sold'],
  ['All Tractors', ''],
];

export const isSheetConfigured = () =>
  Boolean(process.env.SHEET_ID && process.env.SHEET_WEBAPP_URL && process.env.SHEET_WEBAPP_SECRET);

export const sheetUrl = () => `https://docs.google.com/spreadsheets/d/${process.env.SHEET_ID}/edit`;

/** Overwrite every report tab with the CSVs for `stamp`; returns the sheet URL. */
export async function updateSheet(stamp) {
  const tabs = TABS.map(([name, suffix]) => ({
    name,
    csv: fs.readFileSync(path.join(OUT_DIR, `tractorjunction-vs-vms${suffix}-${stamp}.csv`), 'utf8'),
  }));
  const res = await fetch(process.env.SHEET_WEBAPP_URL || '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: process.env.SHEET_WEBAPP_SECRET, sheetId: process.env.SHEET_ID, tabs }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Sheet web app returned non-JSON (${res.status}) — check the deployment access is "Anyone".`);
  }
  if (!json.ok) throw new Error(`Sheet update failed: ${json.error}`);
  console.log(`  Sheet -> replaced ${tabs.length} tabs for ${stamp}: ${sheetUrl()}`);
  return sheetUrl();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stamp = process.argv[2] || fs.readdirSync(OUT_DIR)
    .map((f) => (f.match(/^tractorjunction-vs-vms-(\d{4}-\d{2}-\d{2})\.txt$/) || [])[1])
    .filter(Boolean)
    .sort()
    .pop();
  updateSheet(stamp || '').catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
