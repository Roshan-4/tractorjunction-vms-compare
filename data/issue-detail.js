// @ts-check
// Shared helper for the per-mismatch detail export. The daily comparison emits
// a "Issues" string per site row like "PRICE VMS=410000 SITE=382000" or
// "LOCATION VMS=Behror, Rajasthan SITE=Alwar, Rajasthan". This module turns
// those strings into one row per mismatched field with the exact site and VMS
// values, ready for a detail CSV.
import fs from 'fs';

export const DETAIL_HEADER = ['REG Number', 'Tractor', 'URL', 'Site Value', 'VMS Value', 'Mismatch Type'];

/** Parses "TYPE VMS=<v> SITE=<s>" into { type, vms, site }; null when not parseable. */
export function parseIssue(issue) {
  const m = String(issue || '').match(/^([^ ]+) VMS=(.*) SITE=(.*)$/);
  return m ? { type: m[1], vms: m[2], site: m[3] } : null;
}

/**
 * Expands rows that carry a "status" + "issues" string (report.all rows or CSV
 * rows read from the total CSV) into one detail row per mismatched field.
 * Non-MISMATCH statuses (incl. BOOKED_STILL_LISTED) are skipped.
 * @param {Array<{status?: string, issues?: string, regNo?: string, tractor?: string, url?: string}>} rows
 */
export function buildDetailRows(rows) {
  const out = [];
  for (const r of rows) {
    if (r.status !== 'MISMATCH') continue;
    for (const issue of String(r.issues || '').split(' | ')) {
      const p = parseIssue(issue);
      if (!p) continue;
      out.push({ regNo: r.regNo, tractor: r.tractor, url: r.url, ...p });
    }
  }
  return out;
}

/**
 * Rows for tractors VMS marked SOLD but still published on the site. Same
 * columns as the per-field detail export; the Site Value shows what is live on
 * the site (price/year/location) and the VMS Value the SOLD inventory status.
 * @param {Array<{status?: string, siteData?: string, vmsData?: string, regNo?: string, tractor?: string, url?: string}>} rows
 */
export function buildSoldRows(rows) {
  const out = [];
  for (const r of rows) {
    if (r.status !== 'SOLD_STILL_LISTED') continue;
    const site = safeJson(r.siteData, {});
    const vms = safeJson(r.vmsData, {});
    const parts = [String(site.price || '').trim(), String(site.purchaseYear || '').trim(), String(site.location || '').trim()].filter(Boolean);
    out.push({
      regNo: r.regNo,
      tractor: r.tractor,
      url: r.url,
      site: parts.length ? `Listed on site: ${parts.join(' · ')}` : 'Listed on site',
      vms: String(vms.inventoryStatus || 'SOLD'),
      type: 'SOLD but listed',
    });
  }
  return out;
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function writeDetailCsv(file, rows) {
  const lines = [DETAIL_HEADER, ...rows.map((r) => [r.regNo, r.tractor, r.url, r.site, r.vms, r.type].map(csvCell).join(','))];
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n'), 'utf8');
  console.log(`  CSV   -> ${file}  (${rows.length} rows)`);
  return rows.length;
}

export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Minimal CSV line parser — matches csvCell's quoting (cells quoted only when needed, "" escapes). */
export function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}