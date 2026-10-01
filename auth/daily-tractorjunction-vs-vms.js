// @ts-check
// Daily verification: used-tractors on tractorjunction.com vs VMS (source of truth).
//
// Flow:
//   1. Fetches ALL leads from VMS (source of truth).
//   2. Enumerates every used-tractor card on the public listing + fetches each PDP.
//   3. Matches each site tractor to a VMS lead by RTO (registration) number
//      (falls back to tjListingId when the site PDP has no readable RTO).
//   4. Compares year / price / make / model and buckets every tractor as:
//        OK                    — VMS and website match (incl. VMS-SOLD/BOOKED
//                                tractors the site itself also marks Sold/Booked)
//        MISMATCH              — matched by RTO but some detail differs
//        SOLD_STILL_LISTED     — VMS says SOLD but tractor is still on the
//                                website with NO Sold badge shown on the PDP
//        BOOKED_STILL_LISTED   — VMS says BOOKED but tractor is still on the
//                                website with NO Booked badge shown on the PDP
//        NO_VMS_MATCH          — no VMS lead found for this RTO
//        MISSING_FROM_SITE     — VMS shows it LISTED (website listing + inventory
//                                LISTED) but no card exists on today's live site
//                                scan; sold/booked/pending absences are not logged
//   5. Writes into output/:
//        tractorjunction-vs-vms-YYYY-MM-DD.csv     (total result, every site tractor)
//        tractorjunction-vs-vms-issues-YYYY-MM-DD.csv (only MISMATCH/SOLD/NO_VMS_MATCH/
//                                MISSING_FROM_SITE — BOOKED stays in the total CSV only)
//        tractorjunction-vs-vms-detail-YYYY-MM-DD.csv (one row per mismatched FIELD:
//                                REG, Tractor, URL, Site Value, VMS Value, Mismatch Type)
//        tractorjunction-vs-vms-sold-YYYY-MM-DD.csv (same columns; SOLD in VMS
//                                but still listed on the site — Type "SOLD but listed")
//        tractorjunction-vs-vms-YYYY-MM-DD.txt     (summary)
//   6. Replaces the Google Sheet tabs (auth/google-sheet.js) and posts the
//      summary + sheet link to Zoho Cliq (auth/zoho-cliq.js) when configured.
//
// Run:  node auth/daily-tractorjunction-vs-vms.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getVmsLeads, buildLeadMaps, normalizeRegNo } from '../data/vms-leads.js';
import { parseCardsFromHtml } from '../pages/tractorjunction/assured-used-tractors-listing.page.js';
import { parsePdpHtml } from '../pages/tractorjunction/used-tractor-pdp.page.js';
import { buildDetailRows, buildSoldRows, writeDetailCsv } from '../data/issue-detail.js';
import { buildLocationResolver, readLocationMap, samePlace } from '../data/location-match.js';
import { chromium } from 'playwright';
import { isCliqConfigured, sendReport } from './zoho-cliq.js';
import { isSheetConfigured, updateSheet } from './google-sheet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LISTING_URL = 'https://www.tractorjunction.com/assured-used-tractors-for-sell/';
// Upper safety bound only — scanning stops at the first page with no cards,
// since the number of listing pages changes as the site refreshes daily.
const MAX_LISTING_PAGES = 500;
const SITE_DELAY_MS = Number(process.env.SITE_DELAY_MS || (process.env.HEADED === '1' ? 400 : 120));
const MAX_SITE_FETCHES = Number(process.env.MAX_SITE_FETCHES || Infinity);
const OUT_DIR = path.resolve(ROOT, 'output');
const USE_BROWSER = process.env.HEADED === '1';
// Headed mode drives a real browser window and page.goto for each PDP.
// Cloudflare's managed challenge auto-solves in a real browser, so fetches
// wait it out instead of bombing. Set EDGE_PROFILE=1 to instead drive the
// user's real Edge profile (channel msedge + persistent context) so its
// existing clearance cookies apply.
const USE_EDGE_PROFILE = USE_BROWSER && process.env.EDGE_PROFILE === '1';
const EDGE_USER_DATA_DIR = process.env.EDGE_USER_DATA_DIR || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
const EDGE_PROFILE_DIR = process.env.EDGE_PROFILE_DIR || 'Default';

/**
 * Step 2a: capture every listing card, each with its embedded PDP URL.
 * The public listing is refreshed daily, so every listing page is
 * re-scanned on every run — cards are never cached between runs.
 * Plain HTTP trips Cloudflare's bot protection (429 + captcha), so headed
 * mode drives a real Chromium window with throttled, limited requests.
 */
async function getCards() {
  const cards = USE_BROWSER ? await captureCardsViaBrowser() : await captureCardsViaHttp();
  console.log(`  Site cards: ${cards.length}`);
  return cards;
}

/**
 * Launch the site browser and return an object wrapping both the persistable
 * BrowserContext and the owning Browser so callers can fully close it.
 */
async function launchSiteContext() {
  if (USE_EDGE_PROFILE) {
    // Only the normal Edge flag selecting the profile is passed; Playwright's
    // injected automation switches (--enable-automation, --no-sandbox, ...) are
    // stripped so the browser session is as close to a real one as possible.
    const ctx = await chromium.launchPersistentContext(EDGE_USER_DATA_DIR, {
      channel: 'msedge',
      headless: false,
      viewport: { width: 1366, height: 768 },
      args: [`--profile-directory=${EDGE_PROFILE_DIR}`],
      ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
    });
    return { context: ctx, close: () => ctx.close() };
  }
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  return { context, close: () => browser.close() };
}

async function captureCardsViaBrowser() {
  console.log(`  (headed ${USE_EDGE_PROFILE ? `msedge profile ${EDGE_PROFILE_DIR}` : 'Chromium'})`);
  const { context, close } = await launchSiteContext();
  const page = await context.newPage();
  const cards = [];
  for (let p = 1; p <= MAX_LISTING_PAGES; p++) {
    try {
      await page.goto(`${LISTING_URL}?page=${p}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const pageCards = parseCardsFromHtml(await page.content());
      if (!pageCards.length) break;
      cards.push(...pageCards);
    } catch (e) {
      console.log(`    [FAIL] listing page ${p}: ${e.message}`);
    }
    await sleep(SITE_DELAY_MS);
  }
  await close();
  return cards;
}

async function captureCardsViaHttp() {
  const cards = [];
  for (let p = 1; p <= MAX_LISTING_PAGES; p++) {
    const html = await getWithRetry(`${LISTING_URL}?page=${p}`);
    if (html) {
      const pageCards = parseCardsFromHtml(html);
      if (!pageCards.length) break;
      cards.push(...pageCards);
    }
    await sleep(SITE_DELAY_MS);
  }
  return cards;
}

/**
 * Step 2b: visit each card's URL and read the PDP, which carries the RTO
 * (registration) number, price, year, location and other required details.
 */
async function visitCards(cards) {
  const transport = USE_BROWSER ? new BrowserTransport() : null;
  const siteTractors = [];
  for (let i = 0; i < cards.length; i++) {
    if (siteTractors.length >= MAX_SITE_FETCHES) break;
    const card = cards[i];
    const url = `https://www.tractorjunction.com${card.href.replace(/^https?:\/\/www\.tractorjunction\.com/, '')}`;
    let html;
    try {
      html = transport ? await transport.goto(url) : await getWithRetry(url);
    } catch (e) {
      html = '';
      if (USE_BROWSER) console.log(`    [ERR] ${card.tjId} ${card.title}: ${e.message.slice(0, 200)}`);
    }
    if (!html) {
      console.log(`    [FAIL] ${card.tjId} ${card.title}`);
      continue;
    }
    siteTractors.push({ tjId: card.tjId, href: card.href, cardTitle: card.title, ...parsePdpHtml(html) });
    await sleep(SITE_DELAY_MS);
  }
  if (transport) await transport.close();
  console.log(`  Visited ${siteTractors.length}/${cards.length} URLs -- Captured PDPS: ${siteTractors.length}`);
  return siteTractors;
}

/** Thin headed-browser wrapper so PDP visits share one long-lived context. */
class BrowserTransport {
  constructor() {
    this.active = true;
    this.init = (async () => {
      this.launch = await launchSiteContext();
      this.context = this.launch.context;
      this.page = await this.context.newPage();
    })();
  }

  async goto(url, maxTries = 4) {
    if (!this.page) await this.init;
    for (let t = 1; t <= maxTries; t++) {
      let res;
      try {
        res = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) {
        const backoff = 2000 * Math.pow(2, t - 1);
        console.log(`    nav error on ${url.slice(-40)} — retry ${t}/${maxTries} in ${backoff}ms (${e.message.slice(0, 120)})`);
        await sleep(backoff);
        continue;
      }
      // A real browser auto-solves Cloudflare's managed challenge via JS, so a
      // challenge page just needs time. Poll until the real content appears.
      for (let w = 0; w < 12; w++) {
        const html = await this.page.content();
        const status = res ? res.status() : 200;
        const challenged = status === 429 || status === 403 || /just a moment|cf-challenge|attention required|enable javascript and cookies/i.test(html);
        if (!challenged) return html;
        console.log(`    challenge (${status}) on ${url.slice(-40)} — waiting ${w + 1}/12`);
        await this.page.waitForTimeout(4000);
        res = null;
      }
      console.log(`    challenge not cleared on ${url.slice(-40)} — retry ${t}/${maxTries}`);
    }
    return '';
  }

  async close() {
    if (this.launch && this.active) {
      this.active = false;
      await this.launch.close();
    }
  }
}

async function main() {
  const started = new Date();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. VMS leads — source of truth.
  console.log('Step 1/3: fetching VMS leads...');
  const leads = await getVmsLeads({ useCache: false });
  const { byRegNo, byTjId } = buildLeadMaps(leads);

  // TJ location map (exported from the staging DB's location master by
  // npm run location:export; restored from a GitHub secret in CI) so VMS
  // place names are mapped to the TJ district the site shows.
  const locationMap = readLocationMap();
  if (locationMap) {
    resolveLeadDistricts = buildLocationResolver(locationMap);
    console.log(`  TJ location map: ${locationMap.districts.length} districts, ${locationMap.tehsils.length} tehsils (exported ${locationMap.generatedAt})`);
  } else {
    console.log('  [WARN] data/location-map.json missing (run npm run location:export on the office network) — location falls back to name matching');
  }
  console.log(`  VMS leads: ${leads.length}`);

  // 2. Website: enumerate every card (with its embedded URL), then visit each URL.
  console.log('Step 2/3: capturing cards -> visiting card URLs (PDPs)...');
  const cards = await getCards();
  const siteTractors = await visitCards(cards);

  // 3. Compare.
  console.log('Step 3/3: comparing VMS vs website...');
  const report = buildReport(siteTractors, cards, leads, byRegNo, byTjId);

  // Write outputs. Local date (not UTC, which would split an 11:30pm run
  // across two filenames and separate the total / issues / summary files).
  const stamp = localStamp();
  const csvTotal = path.join(OUT_DIR, `tractorjunction-vs-vms-${stamp}.csv`);
  const csvIssues = path.join(OUT_DIR, `tractorjunction-vs-vms-issues-${stamp}.csv`);
  const csvDetail = path.join(OUT_DIR, `tractorjunction-vs-vms-detail-${stamp}.csv`);
  const csvSold = path.join(OUT_DIR, `tractorjunction-vs-vms-sold-${stamp}.csv`);
  const txt = path.join(OUT_DIR, `tractorjunction-vs-vms-${stamp}.txt`);

  writeCsv(csvTotal, report.all);
  writeCsv(csvIssues, report.all.filter((r) => r.status !== 'OK' && r.status !== 'BOOKED_STILL_LISTED'));
  writeDetailCsv(csvDetail, buildDetailRows(report.all));
  writeDetailCsv(csvSold, buildSoldRows(report.all));
  writeSummary(txt, report, started, new Date(), csvTotal, csvIssues, csvDetail, csvSold);

  // 4. Replace the Google Sheet tabs with today's data, then share the
  //    summary + sheet link in Zoho Cliq.
  if (isSheetConfigured()) await updateSheet(stamp);
  else console.log('  Sheet -> skipped (SHEET_WEBAPP_URL / SHEET_WEBAPP_SECRET not set; see auth/google-sheet.js)');
  if (isCliqConfigured()) await sendReport(stamp);
  else console.log('  Cliq  -> skipped (CLIQ_REFRESH_TOKEN not set; see auth/zoho-cliq.js)');
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function buildReport(siteTractors, cards, leads, byRegNo, byTjId) {
  const rows = [];
  for (const s of siteTractors) {
    const regNo = normalizeRegNo(s.rtoNo);
    const lead = (regNo && byRegNo.get(regNo)) || byTjId.get(s.tjId);
    const issues = lead ? diffLeadVsSite(lead, s) : [];

    // The site itself may already show the sold/booked state as a badge on the
    // PDP (e.g. class="sold-top ...">Sold</span>). When it does, the site is
    // consistent with VMS — only a VMS-SOLD/BOOKED tractor that the site still
    // shows WITHOUT that badge is a real "still listed" problem.
    const siteBadge = String(s.soldBadge || '').trim();
    const status = !lead
      ? 'NO_VMS_MATCH'
      : lead.inventoryStatus === 'SOLD'
        ? (/sold/i.test(siteBadge) ? 'OK' : 'SOLD_STILL_LISTED')
        : lead.inventoryStatus === 'BOOKED'
          ? (/book/i.test(siteBadge) ? 'OK' : 'BOOKED_STILL_LISTED')
          : issues.length
            ? 'MISMATCH'
            : 'OK';

    const vms = lead
      ? {
          regNo: lead.regNo,
          make: lead.make,
          model: lead.model,
          manufacturingYear: lead.manufacturingYear,
          listingPrice: lead.listingPrice,
          sellingPrice: lead.sellingPrice,
          centre: lead.centre,
          centreCity: lead.centreCity,
          centreState: lead.centreState,
          registrationState: lead.registrationState,
          listingStatus: lead.listingStatus,
          inventoryStatus: lead.inventoryStatus,
          leadCurrentStatus: lead.leadCurrentStatus,
        }
      : {};

    const siteData = {
      title: s.title,
      cardTitle: s.cardTitle,
      price: s.price,
      purchaseYear: s.purchaseYear,
      location: s.location,
      enginePower: s.enginePower,
      tyreConditions: s.tyreConditions,
      engineConditions: s.engineConditions,
      financierNoc: s.financierNoc,
      rc: s.rc,
      soldBadge: s.soldBadge,
    };

    rows.push({
      regNo,
      tractor: s.cardTitle || s.title,
      url: s.href,
      status,
      vmsStatus: lead ? `${lead.listingStatus} / ${lead.inventoryStatus}` : 'NO_VMS_LEAD',
      vmsData: JSON.stringify(vms),
      siteData: JSON.stringify(siteData),
      issues: issues.join(' | '),
    });
  }

// Inverse check: VMS leads shown as LISTED (website listing + inventory LISTED)
// that have NO card on today's live site scan. Sold/booked/pending tractors
// being absent is normal and is not logged.
// Presence is judged against the full card capture (874), independent of how
// many PDPs were visited, so capped runs still catch every missing tractor.
  const siteTjIds = new Set(cards.map((c) => String(c.tjId)));
  const visitedRegNos = new Set(siteTractors.map((s) => normalizeRegNo(s.rtoNo)).filter(Boolean));
  for (const lead of leads) {
    if (!isWebsiteListedActiveLead(lead)) continue;
    const regNo = normalizeRegNo(lead.regNo);
    const onSite = siteTjIds.has(String(lead.tjListingId)) || (regNo && visitedRegNos.has(regNo));
    if (onSite) continue; // already captured (and compared) via a site row

    const vms = {
      tjListingId: lead.tjListingId,
      regNo: lead.regNo,
      make: lead.make,
      model: lead.model,
      manufacturingYear: lead.manufacturingYear,
      listingPrice: lead.listingPrice,
      sellingPrice: lead.sellingPrice,
      centre: lead.centre,
      centreCity: lead.centreCity,
      centreState: lead.centreState,
      registrationState: lead.registrationState,
      listingStatus: lead.listingStatus,
      inventoryStatus: lead.inventoryStatus,
      leadCurrentStatus: lead.leadCurrentStatus,
    };
    rows.push({
      regNo,
      tractor: `${lead.make} ${lead.model}`.trim() || `lead ${lead._id}`,
      url: '',
      status: 'MISSING_FROM_SITE',
      vmsStatus: `${lead.listingStatus} / ${lead.inventoryStatus}`,
      vmsData: JSON.stringify(vms),
      siteData: '{}',
      issues: 'LISTED in VMS, but no card on the public site',
    });
  }

  const count = (st) => rows.filter((r) => r.status === st).length;
  return {
    all: rows,
    siteTotal: rows.length,
    ok: count('OK'),
    mismatch: count('MISMATCH'),
    sold: count('SOLD_STILL_LISTED'),
    booked: count('BOOKED_STILL_LISTED'),
    noMatch: count('NO_VMS_MATCH'),
    missing: count('MISSING_FROM_SITE'),
  };
}

/** Website-listed in VMS with an ACTIVE (non-empty, not-sold) inventory status and a reg number. */
// Only a lead VMS currently shows as LISTED (listing on website + inventory
// LISTED) must be on the site. SOLD / BOOKED / STOCK_IN_PENDING tractors may
// legitimately be off the site, so they are never MISSING_FROM_SITE.
function isWebsiteListedActiveLead(lead) {
  const listed = ['LISTED_ON_WEBSITE', 'LISTING_ON_WEBSITE_EDITED'].includes(lead.listingStatus);
  const active = lead.inventoryStatus === 'LISTED';
  const hasReg = Boolean(lead.regNo && lead.regNo !== 'UNG');
  return listed && active && hasReg;
}

function diffLeadVsSite(lead, s) {
  const issues = [];
  if (lead.manufacturingYear && s.purchaseYear && String(lead.manufacturingYear) !== String(s.purchaseYear)) {
    issues.push(`YEAR VMS=${lead.manufacturingYear} SITE=${s.purchaseYear}`);
  }
  const leadPrice = lead.listingPrice ?? lead.sellingPrice;
  const sitePrice = Number(String(s.price || '').replace(/[₹,\s]/g, ''));
  if (leadPrice && sitePrice && Number(leadPrice) !== Number(sitePrice)) {
    issues.push(`PRICE VMS=${leadPrice} SITE=${sitePrice}`);
  }
  const title = String(s.cardTitle || s.title || '').trim();
  if (lead.make && !title.toLowerCase().startsWith(String(lead.make).trim().toLowerCase())) {
    issues.push(`MAKE VMS=${lead.make} SITE=${title}`);
  }
  if (lead.model) {
    const t = ` ${title.toLowerCase()} `;
    const modelWords = String(`${lead.make} ${lead.model}`).trim().toLowerCase().split(/\s+/);
    if (!modelWords.every((w) => t.includes(` ${w} `))) issues.push(`MODEL VMS=${lead.make} ${lead.model} SITE=${title}`);
  }
  const loc = locationDiff(lead, s.location);
  if (loc) issues.push(`LOCATION VMS=${loc.vms} SITE=${loc.site}`);
  return issues;
}

/**
 * The listing location on the website must match the VMS stock location.
 * VMS and TJ name places through different location APIs, so the VMS
 * centre/centreCity is first mapped onto TJ's location master
 * (data/location-match.js): "Chopda" is a tehsil of Jalgaon, "Agar" is
 * Agar-Malwa, "Ashok Nagar" is Ashoknagar, "Bhopal Biapass" is Bhopal. Only a
 * site district outside that mapping is flagged (e.g. VMS=Neemuch, site=Dhar).
 *
 * EXCEPTION — the VMS splits a few states into numbered partitions that are
 * the SAME state: Rajasthan is Rajasthan 1 / Rajasthan 2 / Rajasthan 3. The
 * website always shows the un-partitioned name ("Rajasthan"), so a state
 * token "Rajasthan 1" must compare equal to "Rajasthan".
 */
/** @type {((lead: any) => Set<string> | null) | null} set in main() from the TJ location master */
let resolveLeadDistricts = null;

function stripStatePartition(state) {
  return String(state || '').trim().replace(/\s+\d+\s*$/, '');
}

function locationDiff(lead, siteLoc) {
  const city = String(lead.centreCity || lead.centre || '').trim();
  const state = stripStatePartition(String(lead.centreState || lead.registrationState || '').trim());
  const vmsLabel = `${city}${state ? `, ${state}` : ''}`;

  // Site shows "District , State".
  const siteParts = String(siteLoc || '').split(',').map((p) => p.trim()).filter(Boolean);
  const accepted = resolveLeadDistricts && resolveLeadDistricts(lead);
  if (accepted && siteParts.length >= 2) {
    const siteDistrict = siteParts[0];
    const siteState = siteParts[siteParts.length - 1];
    const districtOk = [...accepted].some((d) => samePlace(d, siteDistrict));
    const stateOk = !state || samePlace(state, siteState);
    return districtOk && stateOk ? null : { vms: vmsLabel, site: siteLoc };
  }

  // Fallback (master unavailable / VMS place unknown to TJ): word matching.
  const siteWords = withAliases(normalizeLocation(siteLoc).trim().split(/\s+/).filter(Boolean));
  if ((!city && !state) || !siteWords.length) return null;
  const tokens = [city, state].filter(Boolean);
  for (const t of tokens) {
    const words = normalizeLocation(t).trim().split(/\s+/).filter((w) => w && !/^\d+$/.test(w));
    if (!words.length) continue;
    const missing = words.filter((w) => !withAliases([w]).some((a) => wordMatches(a, siteWords)));
    if (missing.length) return { vms: vmsLabel, site: siteLoc };
  }
  return null;
}

/** Spelling variants that are the same place. */
const LOC_ALIASES = {
  jhunjhunun: ['jhunjhunu'],
  chittaurgarh: ['chittorgarh'],
  jalore: ['jalor'],
  sriganganagar: ['ganganagar'],
};

function withAliases(words) {
  const out = [...words];
  for (const w of words) for (const a of LOC_ALIASES[w] || []) out.push(a);
  return out;
}

/** A word matches when identical, or a near-spelling variant (lev distance or shared prefix). */
function wordMatches(w, siteWords) {
  if (siteWords.includes(w)) return true;
  return siteWords.some((sw) => levDistance(w, sw) <= 1 || (sw.length >= 4 && w.length >= 4 && commonPrefixLen(w, sw) / Math.max(w.length, sw.length) >= 0.7));
}

function commonPrefixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function levDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function normalizeLocation(s) {
  return ` ${String(s || '').toLowerCase().replace(/[(),."]/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

// ---------------------------------------------------------------------------
// HTTP helpers (with 429 rate-limit retries)
// ---------------------------------------------------------------------------

async function getWithRetry(url, maxTries = 5) {
  let html = '';
  for (let t = 1; t <= maxTries; t++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    if (res.status === 200) {
      html = await res.text();
      break;
    }
    if (res.status === 429) {
      const backoff = 2000 * Math.pow(2, t - 1);
      console.log(`    429 on ${url.slice(-40)} — retry ${t}/${maxTries} in ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    console.log(`    ${res.status} on ${url.slice(-40)}`);
    break;
  }
  return html;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Local-date stamp YYYY-MM-DD — matches the machine's own calendar day. */
function localStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------

const HEADER = ['REG Number', 'Tractor', 'URL', 'Website Status', 'VMS Status', 'VMS data', 'Site data', 'Issues'];

function writeCsv(file, rows) {
  const lines = [HEADER, ...rows.map((r) => [r.regNo, r.tractor, r.url, r.status, r.vmsStatus, r.vmsData, r.siteData, r.issues].map(csvCell).join(','))];
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n'), 'utf8');
  console.log(`  CSV   -> ${file}  (${rows.length} rows)`);
}

function csvCell(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeSummary(file, report, startedAt, finishedAt, csvTotal, csvIssues, csvDetail, csvSold) {
  const lines = [
    'TRACTORJUNCTION vs VMS — DAILY VERIFICATION',
    '============================================',
    `Generated : ${finishedAt.toLocaleString('en-IN')}`,
    `Started   : ${startedAt.toLocaleString('en-IN')}`,
    `Duration  : ${((finishedAt - startedAt) / 1000).toFixed(0)}s`,
    '',
    `Site tractors checked : ${report.siteTotal}`,
    `  OK                  : ${report.ok}`,
    `  MISMATCH            : ${report.mismatch}`,
    `  SOLD_STILL_LISTED   : ${report.sold}`,
    `  BOOKED_STILL_LISTED : ${report.booked}`,
    `  NO_VMS_MATCH        : ${report.noMatch}`,
    `  MISSING_FROM_SITE   : ${report.missing}`,
    `  Total issues        : ${report.siteTotal - report.ok - report.booked} (BOOKED excluded — booked stays in the total CSV only)`,
    '',
    `Files:`,
    `  ${csvTotal}`,
    `  ${csvIssues}`,
    `  ${csvDetail}`,
    `  ${csvSold}`,
    ``,
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  console.log(`  TXT   -> ${file}`);
  console.log(`\nSummary: ${report.siteTotal} rows | ${report.ok} OK | ${report.mismatch} MISMATCH | ${report.sold} SOLD | ${report.booked} BOOKED | ${report.noMatch} NO_MATCH | ${report.missing} MISSING_FROM_SITE`);
}

// Run only when executed directly (not when an external tool imports helpers from this file).
export const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
export { diffLeadVsSite };