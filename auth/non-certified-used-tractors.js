/**
 * Lists the URL of every used tractor on https://www.tractorjunction.com/used-tractors-for-sell/
 * whose listing card does NOT carry the red "Certified" badge.
 *
 * Scans the live listing page by page, reads each card (`.UsedTractor_mainWrapper`)
 * and checks for the `.certifired_tag` badge. Past the last page the site does not
 * return an empty page but a fixed fallback page, so the scan stops at the first
 * page whose tractors match that fallback (fetched up front from a huge page number).
 * Writes non-certified/non-certified-used-tractors-<date>.csv (and .txt with bare URLs) plus
 * non-certified/used-tractors-snapshot-<date>.json with every tractor, for
 * auth/compare-used-tractor-snapshots.js to diff URL slugs between days.
 *
 * Usage: node auth/non-certified-used-tractors.js
 */
import fs from 'node:fs';
import path from 'node:path';

const LISTING_URL = 'https://www.tractorjunction.com/used-tractors-for-sell/';
const WORKERS = Number(process.env.WORKERS || 3);
const DELAY_MS = Number(process.env.SITE_DELAY_MS || 150);
// Kept out of output/, which is cleared before every VMS compare run.
const OUT_DIR = path.resolve('non-certified');

function parseCards(html) {
  const chunks = html.split('UsedTractor_mainWrapper').slice(1);
  const cards = [];
  for (const chunk of chunks) {
    const m = chunk.match(/href="(https:\/\/www\.tractorjunction\.com\/used-tractor\/[^"]+\/(\d+)\/)"\s+title="([^"]*)"/);
    if (!m) continue;
    const year = (chunk.match(/class="yearLocation">\s*(\d{4})/) || [])[1] || '';
    const location = ((chunk.match(/class="yearLocation">\s*\d{4}\s*\|\s*([^<]*)</) || [])[1] || '').trim();
    const price = ((chunk.match(/class="priceWrp">([^<]*)</) || [])[1] || '').trim();
    cards.push({ tjId: m[2], url: m[1], title: m[3], year, location, price, certified: chunk.includes('certifired_tag') });
  }
  return cards;
}

async function getWithRetry(url, maxTries = 6) {
  for (let t = 1; t <= maxTries; t++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
      if (res.status === 200) return await res.text();
      if (res.status !== 429 && res.status < 500) {
        console.log(`    ${res.status} on ${url}`);
        return '';
      }
      console.log(`    ${res.status} on ${url} — retry ${t}/${maxTries}`);
    } catch (e) {
      console.log(`    ${e.message} on ${url} — retry ${t}/${maxTries}`);
    }
    await sleep(2000 * Math.pow(2, t - 1));
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const idKey = (cards) => cards.map((c) => c.tjId).join(',');

async function main() {
  const fallbackHtml = await getWithRetry(`${LISTING_URL}?page=999999`);
  const fallbackKey = fallbackHtml ? idKey(parseCards(fallbackHtml)) : '';
  const byId = new Map();
  const failedPages = [];
  let nextPage = 1;
  let lastPage = Infinity;

  async function worker() {
    while (true) {
      const p = nextPage++;
      if (p > lastPage) return;
      const html = await getWithRetry(`${LISTING_URL}?page=${p}`);
      if (html === null) {
        failedPages.push(p);
        continue;
      }
      const cards = parseCards(html);
      if (!cards.length || idKey(cards) === fallbackKey) {
        lastPage = Math.min(lastPage, p - 1);
        return;
      }
      for (const c of cards) if (!byId.has(c.tjId)) byId.set(c.tjId, c);
      if (p % 50 === 0) console.log(`  page ${p}: ${byId.size} tractors so far`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`Scanning ${LISTING_URL} ...`);
  await Promise.all(Array.from({ length: WORKERS }, worker));

  // Retry pages that failed every attempt, one at a time.
  for (const p of failedPages.splice(0)) {
    const html = await getWithRetry(`${LISTING_URL}?page=${p}`);
    if (html === null) failedPages.push(p);
    else for (const c of parseCards(html)) if (!byId.has(c.tjId)) byId.set(c.tjId, c);
  }

  const all = [...byId.values()];
  const nonCertified = all.filter((c) => !c.certified);
  const stamp = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const csvPath = path.join(OUT_DIR, `non-certified-used-tractors-${stamp}.csv`);
  const txtPath = path.join(OUT_DIR, `non-certified-used-tractors-${stamp}.txt`);
  const header = ['tjId', 'title', 'year', 'location', 'price', 'url'];
  fs.writeFileSync(csvPath, '﻿' + [header.join(','), ...nonCertified.map((c) => header.map((h) => csvCell(c[h])).join(','))].join('\n'));
  fs.writeFileSync(txtPath, nonCertified.map((c) => c.url).join('\n') + '\n');
  const snapshotPath = path.join(OUT_DIR, `used-tractors-snapshot-${stamp}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify({ scannedAt: new Date().toISOString(), failedPages, tractors: all }, null, 1));

  console.log(`\nListing pages scanned: ${lastPage === Infinity ? '?' : lastPage}`);
  console.log(`Unique tractors: ${all.length} (certified ${all.length - nonCertified.length}, non-certified ${nonCertified.length})`);
  if (failedPages.length) console.log(`Pages that could not be fetched: ${failedPages.join(', ')}`);
  console.log(`Wrote ${csvPath}\nWrote ${txtPath}\nWrote ${snapshotPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
