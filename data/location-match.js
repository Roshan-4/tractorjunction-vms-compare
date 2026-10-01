// @ts-check
// Maps VMS location names onto TractorJunction's location master so the
// site-vs-VMS compare only flags a LOCATION mismatch when the place is really
// different — not when the two systems merely name it differently.
//
// VMS and TJ use different location APIs:
//   - VMS stores a centre town/tehsil (centre, e.g. "Chopda", "Agar",
//     "Bhopal Biapass") and sometimes a district (centreCity, e.g.
//     "Sri Ganganagar", "Ashok Nagar").
//   - The website shows the TJ district from new_districts
//     (e.g. "Jalgaon", "Agar-Malwa", "Bhopal", "Sriganganagar", "Ashoknagar").
//
// A VMS place resolves to the set of TJ districts it can mean:
//   1. a TJ district with the same name (spacing/spelling tolerant, and
//      "Agar" = "Agar-Malwa", "Bhopal Biapass" = "Bhopal" by leading words);
//   2. a TJ tehsil with that name -> the tehsil's district (Chopda -> Jalgaon);
//   3. only when the master has neither: the district TJ files that VMS
//      centre's tractors under in old_tractors (matched by registration),
//      taken when one district holds most of them (Shikrapur -> Pune).
// The site district must be one of those, otherwise it is a real mismatch.
//
// The TJ DB is reachable only from the office network, so the master and the
// learned centre districts are exported to data/location-map.json
// (npm run location:export). That file is gitignored; CI rebuilds it from the
// LOCATION_MAP_GZ_B64 GitHub secret.
import fs from 'fs';
import path from 'path';

export const LOCATION_MAP_FILE = path.resolve(import.meta.dirname, 'location-map.json');

/** Load data/location-map.json (compact arrays) into the resolver's shape, or null if absent. */
export function readLocationMap(file = LOCATION_MAP_FILE) {
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    generatedAt: m.generatedAt,
    states: m.states.map(([id, state_name]) => ({ id, state_name })),
    districts: m.districts.map(([id, district_name, state_id]) => ({ id, district_name, state_id })),
    tehsils: m.tehsils.map(([id, tehsil_name, district_id, state_id]) => ({ id, tehsil_name, district_id, state_id })),
    learned: m.learned,
  };
}

const OLD_TRACTOR_MIN_SAMPLES = 3;
const OLD_TRACTOR_MIN_SHARE = 0.6;

/** Lowercase words with punctuation/hyphens split out ("Agar-Malwa" -> ["agar","malwa"]). */
function words(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Space-insensitive key; "Shri/Shree/Sri" prefixes unified ("Shri Ganganagar" = "Sriganganagar"). */
function key(name) {
  return words(name).join('').replace(/^(shri|shree|sri)/, 'sri');
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

/** Same word allowing transliteration slips (Vidhisha/Vidisha, Khachrod/Khacharod, Chittaurgarh/Chittorgarh). */
function sameToken(a, b) {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  if (len < 5) return false;
  return levDistance(a, b) <= (len >= 9 ? 2 : 1);
}

/**
 * Two place names are the same place when their space-insensitive keys match,
 * or when the shorter name is the leading word(s) of the longer one
 * ("Agar" / "Agar-Malwa", "Bhopal" / "Bhopal Biapass"). Whole words only, so
 * "Kota" never matches "Kotputli".
 */
export function samePlace(a, b) {
  const ka = key(a);
  const kb = key(b);
  if (!ka || !kb) return false;
  // "Sri Ganganagar" = "Ganganagar" only on an exact remainder, so "Shrigonda" never fuzzes into "Gondia".
  if (sameToken(ka, kb) || ka.replace(/^sri/, '') === kb.replace(/^sri/, '')) return true;
  const wa = words(a);
  const wb = words(b);
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length === long.length || short.join('').length < 4) return false;
  return short.every((w, i) => sameToken(w, long[i]));
}

/** VMS splits some states into numbered partitions ("Rajasthan 1/2/3"); TJ never does. */
export function stripStatePartition(state) {
  return String(state || '').trim().replace(/\s+\d+\s*$/, '');
}

const normalizeRegNo = (r) => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * old_tractors statistics: for each VMS centre (place|state key), the TJ
 * district most of its tractors are filed under, when one district clearly
 * dominates. Stored in the location map so CI needs no DB access.
 * @param {{ districts: any[], oldTractors: any[] }} master
 * @param {any[]} leads
 * @returns {Record<string, string>} "placeKey|stateKey" -> TJ district name
 */
export function learnCentreDistricts(master, leads) {
  const districtName = new Map(master.districts.map((d) => [d.id, d.district_name]));
  const otDistrict = new Map(master.oldTractors.map((o) => [o.regNo, o.new_district_id]));
  /** @type {Map<string, Map<number, number>>} */
  const centreStats = new Map();
  for (const l of leads) {
    const d = otDistrict.get(normalizeRegNo(l.regNo));
    if (!d) continue;
    for (const place of [l.centreCity, l.centre]) {
      if (!key(place)) continue;
      const k = centreKey(place, l.centreState);
      const counts = centreStats.get(k) || new Map();
      counts.set(d, (counts.get(d) || 0) + 1);
      centreStats.set(k, counts);
    }
  }
  /** @type {Record<string, string>} */
  const learned = {};
  for (const [k, counts] of centreStats) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const [topId, topN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (total >= OLD_TRACTOR_MIN_SAMPLES && topN / total >= OLD_TRACTOR_MIN_SHARE && districtName.has(topId)) {
      learned[k] = districtName.get(topId);
    }
  }
  return learned;
}

const centreKey = (place, state) => `${key(place)}|${key(stripStatePartition(state))}`;

/**
 * @param {{ states: any[], districts: any[], tehsils: any[], learned: Record<string, string> }} map
 *   location map — from data/location-map.json (db/export-location-map.js)
 * @returns {(lead: any) => Set<string> | null} TJ district names the lead's
 *   location can mean, or null when nothing in TJ's master resolves it.
 */
export function buildLocationResolver(map) {
  const master = map;
  const districtName = new Map(master.districts.map((d) => [d.id, d.district_name]));
  const stateIdsFor = (vmsState) => {
    const name = stripStatePartition(vmsState);
    const ids = master.states.filter((s) => samePlace(s.state_name, name)).map((s) => s.id);
    return ids.length ? new Set(ids) : null;
  };
  const learnedDistrict = (place, state) => map.learned[centreKey(place, state)] || null;

  const cache = new Map();
  const resolvePlace = (place, state) => {
    const cacheKey = `${place}|${state}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const stateIds = stateIdsFor(state);
    const inState = (row) => !stateIds || stateIds.has(row.state_id);
    const out = new Set();
    for (const d of master.districts) if (inState(d) && samePlace(d.district_name, place)) out.add(d.district_name);
    for (const t of master.tehsils) {
      if (inState(t) && samePlace(t.tehsil_name, place)) out.add(districtName.get(t.district_id));
    }
    if (!out.size) {
      const learned = learnedDistrict(place, state);
      if (learned) out.add(learned);
    }
    out.delete(undefined);
    cache.set(cacheKey, out);
    return out;
  };

  return (lead) => {
    const state = lead.centreState || lead.registrationState;
    const accepted = new Set();
    for (const place of [lead.centreCity, lead.centre]) {
      if (String(place || '').trim()) for (const d of resolvePlace(place, state)) accepted.add(d);
    }
    return accepted.size ? accepted : null;
  };
}
