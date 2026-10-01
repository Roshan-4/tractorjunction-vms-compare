// @ts-check
// Exports TJ's location master + the old_tractors-learned VMS centre districts
// to data/location-map.json, so the daily compare can map VMS locations without
// DB access (the DB is reachable only from the office network). Run from the
// office whenever VMS adds new centres/states:
//
//   npm run location:export
//
// Only districts/tehsils of states with VMS centres are kept, so the gzipped+base64 file fits
// in a GitHub secret (48 KB). It then prints the steps to update the secret.
import fs from 'fs';
import zlib from 'zlib';
import { getVmsLeads, normalizeRegNo } from '../data/vms-leads.js';
import { LOCATION_MAP_FILE, learnCentreDistricts, samePlace, stripStatePartition } from '../data/location-match.js';
import { loadLocationMaster } from './location-master.js';

const leads = await getVmsLeads({ useCache: false });
const master = await loadLocationMaster([...new Set(leads.map((l) => normalizeRegNo(l.regNo)).filter(Boolean))]);

// Districts/tehsils are only needed where VMS has centres; every state name is
// still kept so state checks work for the rest.
const vmsStates = [...new Set(leads.map((l) => stripStatePartition(l.centreState)).filter(Boolean))];
const stateIds = new Set(master.states.filter((s) => vmsStates.some((v) => samePlace(s.state_name, v))).map((s) => s.id));

const map = {
  generatedAt: new Date().toISOString(),
  states: master.states.map((s) => [s.id, s.state_name]),
  districts: master.districts.filter((d) => stateIds.has(d.state_id)).map((d) => [d.id, d.district_name, d.state_id]),
  tehsils: master.tehsils.filter((t) => stateIds.has(t.state_id)).map((t) => [t.id, t.tehsil_name, t.district_id, t.state_id]),
  learned: learnCentreDistricts(master, leads),
};
const json = JSON.stringify(map);
fs.writeFileSync(LOCATION_MAP_FILE, json);
const secretSize = zlib.gzipSync(json, { level: 9 }).toString('base64').length;

console.log(`Location map -> ${LOCATION_MAP_FILE}`);
console.log(`  ${stateIds.size} VMS states, ${map.districts.length} districts, ${map.tehsils.length} tehsils, ${Object.keys(map.learned).length} learned VMS centres`);
console.log(`  gzip+base64 size: ${secretSize} bytes (GitHub secret limit 49152)`);
if (secretSize > 49152) console.log('  [WARN] too large for a GitHub secret');
console.log('Update the CI secret with: npm run location:secret');
