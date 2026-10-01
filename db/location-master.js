// @ts-check
// Loads TractorJunction's location master (new_states / new_districts /
// new_tehsils) plus the old_tractors district ids of tractors that also exist
// in VMS (joined on registration number), so VMS location names can be mapped
// onto the TJ districts the website shows. The DB is STAGING: its location
// tables are accurate, but its tractor data is not current, so it is used only
// to learn location names — never to compare tractor details. Read-only;
// used by db/export-location-map.js.
import { getRootDbConnection } from './root-connection.js';

/**
 * @param {string[]} regNos registration numbers, already normalized (A-Z0-9 only)
 */
export async function loadLocationMaster(regNos) {
  const db = await getRootDbConnection();
  try {
    const [states] = await db.query('SELECT id, state_name FROM new_states');
    const [districts] = await db.query('SELECT id, district_name, state_id FROM new_districts');
    const [tehsils] = await db.query('SELECT id, tehsil_name, district_id, state_id FROM new_tehsils');
    const [oldTractors] = regNos.length
      ? await db.query(
          `SELECT REPLACE(REPLACE(UPPER(rto), ' ', ''), '-', '') AS regNo, new_district_id
             FROM old_tractors
            WHERE new_district_id IS NOT NULL
              AND REPLACE(REPLACE(UPPER(rto), ' ', ''), '-', '') IN (?)`,
          [regNos],
        )
      : [[]];
    return {
      states: /** @type {any[]} */ (states),
      districts: /** @type {any[]} */ (districts),
      tehsils: /** @type {any[]} */ (tehsils),
      oldTractors: /** @type {any[]} */ (oldTractors),
    };
  } finally {
    await db.end();
  }
}
