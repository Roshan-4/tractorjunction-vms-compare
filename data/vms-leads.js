// @ts-check
// VMS lead data helper — the source of truth for the used-tractor verification.
// Fetches (or reads a cached copy of) all VMS leads and exposes matching helpers.
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env'), quiet: true });

// VMS production API base (kept out of source; set in .env / CI secrets).
const API_BASE = process.env.VMS_API_BASE || '';
const CACHE_PATH = path.resolve(import.meta.dirname, '..', 'data', 'vms-leads.json');

/**
 * A lead is an active site listing when it was listed on the website and is not sold.
 * Listing is a one-way pipeline: LISTING_ON_WEBSITE -> LISTED_ON_WEBSITE.
 * @param {object} lead
 */
export function isActiveListedLead(lead) {
  const listed = ['LISTED_ON_WEBSITE', 'LISTING_ON_WEBSITE_EDITED'].includes(lead.listingStatus);
  const notSold = lead.inventoryStatus !== 'SOLD';
  const hasReg = Boolean(lead.regNo && lead.regNo !== 'UNG');
  return listed && notSold && hasReg;
}

/**
 * Fetches all leads from VMS (read-only search query per the admin SPA).
 * @param {{ useCache?: boolean }} [opts]
 * @returns {Promise<object[]>} array of lean lead objects
 */
export async function getVmsLeads({ useCache = true } = {}) {
  if (useCache && fs.existsSync(CACHE_PATH)) {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  }
  const token = process.env.PROD_VMS_TOKEN;
  if (!token) throw new Error('PROD_VMS_TOKEN is not set in .env');
  const res = await fetch(`${API_BASE}/leads?search=&needExcel=false`, {
    method: 'POST',
    headers: { Authorization: token, 'X-Request-Source': 'WEB', 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {} }),
  });
  if (res.status !== 200) throw new Error(`VMS /leads returned ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const lean = (body.data || []).map((l) => ({
    _id: l._id,
    tjListingId: l.tjListingId ?? null,
    regNo: l.regNo ?? '',
    make: l.make?.name ?? '',
    model: l.model?.name ?? '',
    manufacturingYear: l.manufacturingYear ?? '',
    source: l.source ?? '',
    listingStatus: l.listingStatus ?? '',
    inventoryStatus: l.inventoryStatus ?? '',
    leadCurrentStatus: l.leadCurrentStatus ?? '',
    listingPrice: l.listingPrice ?? null,
    sellingPrice: l.sellingPrice ?? null,
    centre: l.centre?.name ?? '',
    centreCity: l.centre?.city ?? '',
    centreState: l.centre?.state ?? '',
    registrationState: l.registrationState ?? '',
    createdAt: l.createdAt ?? '',
    updatedAt: l.updatedAt ?? '',
  }));
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(lean));
  return lean;
}

/** Builds lookup maps usable by the verification spec. */
export function buildLeadMaps(leads) {
  const byTjId = new Map();
  const byRegNo = new Map();
  // A tractor can be sold and later re-bought and re-listed, so VMS holds BOTH
  // records under the same registration (one LISTED, one old SOLD). When the
  // same reg / listing id appears twice, keep the lead that is actually live on
  // the website now (non-SOLD, carries a tjListingId) — never the stale SOLD one.
  const keepIfBetter = (map, key, lead) => {
    const current = map.get(key);
    if (!current || leadRank(lead) > leadRank(current)) map.set(key, lead);
  };
  for (const lead of leads) {
    if (lead.tjListingId) keepIfBetter(byTjId, String(lead.tjListingId), lead);
    if (lead.regNo) keepIfBetter(byRegNo, normalizeRegNo(lead.regNo), lead);
  }
  return { byTjId, byRegNo };
}

/** Higher = more likely the live website listing. Non-SOLD beats SOLD; a lead with a tjListingId beats one without. */
function leadRank(lead) {
  let rank = 0;
  if (lead.inventoryStatus !== 'SOLD') rank += 100;
  if (lead.tjListingId) rank += 10;
  return rank;
}

/** Normalizes a registration number for reliable matching (strip spaces/punct, uppercase). */
export function normalizeRegNo(regNo) {
  return String(regNo || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}