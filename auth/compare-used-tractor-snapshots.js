/**
 * Diffs two used-tractor snapshots written by auth/non-certified-used-tractors.js and
 * reports, per listing ID (the stable last number in the URL), what changed:
 *   SLUG_CHANGED      same ID, different URL slug (e.g. swaraj-717-242361 -> swaraj-717-251473)
 *   REMOVED           ID was on the listing before, not now
 *   NEW               ID is on the listing now, not before
 *   CERTIFIED_CHANGED badge appeared or disappeared
 * By default only tractors that were non-certified in either snapshot are reported;
 * pass --all for every tractor. With --check-old, each changed slug's old URL is
 * requested (no redirect follow) to record whether it now 404s, redirects or still loads.
 *
 * Usage: node auth/compare-used-tractor-snapshots.js [old.json new.json] [--all] [--check-old]
 * Without file arguments the two latest non-certified/used-tractors-snapshot-*.json are used.
 */
import fs from 'node:fs';
import path from 'node:path';

// Kept out of output/, which is cleared before every VMS compare run.
const OUT_DIR = path.resolve('non-certified');
const args = process.argv.slice(2);
const includeAll = args.includes('--all');
const checkOld = args.includes('--check-old');
let [oldPath, newPath] = args.filter((a) => !a.startsWith('--'));

if (!oldPath || !newPath) {
  const snaps = fs.readdirSync(OUT_DIR).filter((f) => /^used-tractors-snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (snaps.length < 2) {
    console.error(`Need two snapshots in ${OUT_DIR}; found ${snaps.length}. Run auth/non-certified-used-tractors.js on another day first.`);
    process.exit(1);
  }
  [oldPath, newPath] = snaps.slice(-2).map((f) => path.join(OUT_DIR, f));
}

const load = (p) => new Map(JSON.parse(fs.readFileSync(p, 'utf8')).tractors.map((t) => [t.tjId, t]));
const before = load(oldPath);
const after = load(newPath);
const dateOf = (p) => (path.basename(p).match(/\d{4}-\d{2}-\d{2}/) || [path.basename(p)])[0];
const [oldDate, newDate] = [dateOf(oldPath), dateOf(newPath)];

const slugOf = (url) => (url.match(/\/used-tractor\/[^/]+\/([^/]+)\/\d+\/?$/) || [])[1] || '';

const rows = [];
for (const id of new Set([...before.keys(), ...after.keys()])) {
  const a = before.get(id);
  const b = after.get(id);
  if (!includeAll && (a ? a.certified : true) && (b ? b.certified : true)) continue;
  const base = { tjId: id, title: (b || a).title, oldUrl: a?.url || '', newUrl: b?.url || '', oldCertified: a ? a.certified : '', newCertified: b ? b.certified : '' };
  if (a && !b) rows.push({ change: 'REMOVED', ...base });
  else if (!a && b) rows.push({ change: 'NEW', ...base });
  else {
    if (a.url !== b.url) rows.push({ change: 'SLUG_CHANGED', ...base, oldSlug: slugOf(a.url), newSlug: slugOf(b.url) });
    if (a.certified !== b.certified) rows.push({ change: 'CERTIFIED_CHANGED', ...base });
  }
}

async function headStatus(url) {
  for (let t = 1; t <= 5; t++) {
    try {
      const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (t - 1)));
        continue;
      }
      return { status: res.status, location: res.headers.get('location') || '' };
    } catch (e) {
      if (t === 5) return { status: `ERR ${e.message}`, location: '' };
    }
  }
  return { status: 429, location: '' };
}

if (checkOld) {
  const changed = rows.filter((r) => r.change === 'SLUG_CHANGED');
  console.log(`Checking ${changed.length} old URLs ...`);
  for (const r of changed) {
    const { status, location } = await headStatus(r.oldUrl);
    r.oldUrlStatus = status;
    r.oldUrlRedirect = location;
    await new Promise((res) => setTimeout(res, 150));
  }
}

const order = { SLUG_CHANGED: 0, CERTIFIED_CHANGED: 1, REMOVED: 2, NEW: 3 };
rows.sort((x, y) => order[x.change] - order[y.change] || Number(x.tjId) - Number(y.tjId));

const header = ['change', 'tjId', 'title', 'oldSlug', 'newSlug', 'oldUrl', 'newUrl', 'oldCertified', 'newCertified', ...(checkOld ? ['oldUrlStatus', 'oldUrlRedirect'] : [])];
const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const outPath = path.join(OUT_DIR, `used-tractor-url-changes-${oldDate}_to_${newDate}.csv`);
fs.writeFileSync(outPath, '﻿' + [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\n'));

const count = (c) => rows.filter((r) => r.change === c).length;
console.log(`${oldDate} (${before.size} tractors) -> ${newDate} (${after.size} tractors)${includeAll ? '' : ', non-certified only'}`);
console.log(`  SLUG_CHANGED ${count('SLUG_CHANGED')}  CERTIFIED_CHANGED ${count('CERTIFIED_CHANGED')}  REMOVED ${count('REMOVED')}  NEW ${count('NEW')}`);
if (checkOld) {
  const byStatus = {};
  for (const r of rows.filter((x) => x.change === 'SLUG_CHANGED')) byStatus[r.oldUrlStatus] = (byStatus[r.oldUrlStatus] || 0) + 1;
  console.log(`  Old URL status: ${Object.entries(byStatus).map(([s, n]) => `${s}=${n}`).join('  ') || '-'}`);
}
console.log(`Wrote ${outPath}`);
