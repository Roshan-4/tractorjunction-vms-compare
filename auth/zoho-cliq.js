// @ts-check
// Posts the TractorJunction-vs-VMS report (summary + Google Sheet link, or CSV
// attachments when the sheet is not configured) to a
// Zoho Cliq channel through the Cliq REST API (OAuth, scope ZohoCliq.Webhooks.CREATE).
//
// One-time setup (see .env.example for the keys):
//   1. Create a Self Client at https://api-console.zoho.in and put its
//      CLIQ_CLIENT_ID / CLIQ_CLIENT_SECRET in .env (plus ZOHO_ACCOUNTS_DC, CLIQ_API_BASE).
//   2. Generate a grant code there with scope ZohoCliq.Webhooks.CREATE, then run
//        npm run cliq:token -- <grant code>
//      which exchanges it and saves CLIQ_REFRESH_TOKEN into .env.
//
// Run:  npm run cliq:send            (posts the newest report in output/)
//       npm run cliq:send -- 2026-10-01
//       node auth/zoho-cliq.js notify <text>   (plain message, used by CI)
// The daily compare script also calls sendReport() automatically when the
// refresh token is configured.
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';
import { isSheetConfigured, sheetUrl } from './google-sheet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.resolve(ROOT, '.env');
const OUT_DIR = path.resolve(ROOT, 'output');
dotenv.config({ path: ENV_FILE, quiet: true });

const ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_DC || 'https://accounts.zoho.in';
// e.g. https://cliq.<your-domain>/company/<org id>
const CLIQ_URL = process.env.CLIQ_API_BASE || 'https://cliq.zoho.in';
const CHANNEL = process.env.ZOHO_CLIQ_CHANNEL || '';

export const isCliqConfigured = () =>
  Boolean(process.env.CLIQ_CLIENT_ID && process.env.CLIQ_CLIENT_SECRET && process.env.CLIQ_REFRESH_TOKEN);

async function oauthToken(params) {
  const res = await fetch(`${ACCOUNTS_URL}/oauth/v2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: process.env.CLIQ_CLIENT_ID || '',
      client_secret: process.env.CLIQ_CLIENT_SECRET || '',
      ...params,
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Zoho OAuth error: ${json.error}`);
  return json;
}

/** Exchange a one-time grant code for a refresh token and store it in .env. */
async function saveRefreshToken(grantCode) {
  const { refresh_token: refreshToken } = await oauthToken({ grant_type: 'authorization_code', code: grantCode });
  if (!refreshToken) throw new Error('Zoho returned no refresh_token — generate a fresh grant code and retry.');
  let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  env = /^CLIQ_REFRESH_TOKEN=.*$/m.test(env)
    ? env.replace(/^CLIQ_REFRESH_TOKEN=.*$/m, `CLIQ_REFRESH_TOKEN=${refreshToken}`)
    : `${env.replace(/\s*$/, '')}\nCLIQ_REFRESH_TOKEN=${refreshToken}\n`;
  fs.writeFileSync(ENV_FILE, env);
  console.log('Saved CLIQ_REFRESH_TOKEN to .env');
}

async function getAccessToken() {
  const { access_token: accessToken } = await oauthToken({
    grant_type: 'refresh_token',
    refresh_token: process.env.CLIQ_REFRESH_TOKEN || '',
  });
  return accessToken;
}

async function cliqPost(accessToken, endpoint, body, headers = {}) {
  const res = await fetch(`${CLIQ_URL}/api/v2/channelsbyname/${CHANNEL}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, ...headers },
    body,
  });
  if (!res.ok) throw new Error(`Cliq ${endpoint} failed: ${res.status} ${await res.text()}`);
}

/** Pull the bucket counts back out of the daily summary .txt. */
function readCounts(txtFile) {
  const txt = fs.readFileSync(txtFile, 'utf8');
  const num = (label) => Number((txt.match(new RegExp(`${label}\\s*:\\s*(\\d+)`)) || [])[1] || 0);
  return {
    siteTotal: num('Site tractors checked'),
    ok: num('OK'),
    mismatch: num('MISMATCH'),
    sold: num('SOLD_STILL_LISTED'),
    booked: num('BOOKED_STILL_LISTED'),
    noMatch: num('NO_VMS_MATCH'),
    missing: num('MISSING_FROM_SITE'),
    issues: num('Total issues'),
  };
}

function latestStamp() {
  const stamps = fs.readdirSync(OUT_DIR)
    .map((f) => (f.match(/^tractorjunction-vs-vms-(\d{4}-\d{2}-\d{2})\.txt$/) || [])[1])
    .filter(Boolean)
    .sort();
  if (!stamps.length) throw new Error(`No report found in ${OUT_DIR} — run npm run daily:tractor-vs-vms first.`);
  return stamps[stamps.length - 1];
}

/** Post a plain text message (used by CI for failure / token-expiry alerts). */
export async function notify(text) {
  await cliqPost(await getAccessToken(), 'message', JSON.stringify({ text }), { 'Content-Type': 'application/json' });
  console.log(`  Cliq  -> posted notice to channel "${CHANNEL}"`);
}

/** Post the summary message, then attach each report CSV for that date. */
export async function sendReport(stamp = latestStamp()) {
  const file = (suffix) => path.join(OUT_DIR, `tractorjunction-vs-vms${suffix}-${stamp}`);
  const c = readCounts(`${file('')}.txt`);
  const useSheet = isSheetConfigured();
  const text = [
    `*TractorJunction vs VMS — Daily Verification (${stamp})*`,
    `Fresh live scan of the website | Site tractors checked: *${c.siteTotal}*`,
    '',
    `✅ OK: *${c.ok}*`,
    `⚠️ MISMATCH (year/price/make/model differs): *${c.mismatch}*`,
    `🔴 SOLD in VMS but still listed: *${c.sold}*`,
    `🟡 BOOKED still listed: *${c.booked}* (info only)`,
    `❓ No VMS match: *${c.noMatch}*`,
    `📭 Missing from site: *${c.missing}*`,
    '',
    `*Total issues: ${c.issues}* (booked excluded)`,
    useSheet ? `📊 Full report (Google Sheet): ${sheetUrl()}` : 'Reports attached below.',
  ].join('\n');

  const accessToken = await getAccessToken();
  await cliqPost(accessToken, 'message', JSON.stringify({ text }), { 'Content-Type': 'application/json' });
  // The Google Sheet carries the same data, so CSVs are only attached without it.
  if (useSheet) return console.log(`  Cliq  -> posted report ${stamp} + sheet link to channel "${CHANNEL}"`);
  for (const suffix of ['-issues', '-detail', '-sold', '']) {
    const csv = `${file(suffix)}.csv`;
    if (!fs.existsSync(csv)) continue;
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(csv)], { type: 'text/csv' }), path.basename(csv));
    await cliqPost(accessToken, 'files', form);
  }
  console.log(`  Cliq  -> posted report ${stamp} to channel "${CHANNEL}"`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  const run = async () => {
    if (cmd === 'notify') return notify(process.argv.slice(3).join(' '));
    if (cmd !== 'token') return sendReport(cmd);
    if (!arg) throw new Error('Usage: npm run cliq:token -- <grant code>');
    return saveRefreshToken(arg);
  };
  run().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
