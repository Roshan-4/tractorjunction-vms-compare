# Agents.md

This file records the working conventions for this repository. Whenever the user establishes a new rule about how the project should be structured or how an agent should behave in it, that rule is appended here so future sessions follow it automatically.

## Rules

### 1. Database code is a helper, not a test

Code that connects to a database (`db/root-connection.js`, `db/location-master.js`) is a read-only helper. It must not be wrapped in test blocks. When database access is needed, connect directly through the helper (e.g. a one-off script).

### 2. VMS lead matching prefers the currently-listed lead over stale SOLD duplicates

A tractor can be sold and later re-bought and re-listed, so VMS holds two leads for the same registration (one `LISTED`/active with a `tjListingId`, one old `SOLD`). When the site tractor is matched to VMS by registration, `data/vms-leads.js` `buildLeadMaps()` must keep the lead that is actually live on the website (non-`SOLD`, has a `tjListingId`) — never the stale `SOLD` one — for both the `byRegNo` and `byTjId` maps. `SOLD_STILL_LISTED` is only reported when *every* lead for that registration is `SOLD` while the tractor is still published on the site.

### 3. The site-vs-VMS compare always rescans the live website

The TractorJunction used-tractor listing is refreshed every day, so `auth/daily-tractorjunction-vs-vms.js` must re-scan every listing page and PDP on each run — never reuse cached site data (e.g. the old `data/tractorjunction-cards.json`). The listing is scanned until the first empty page rather than up to a fixed page count. When re-running the compare, clear older results from `output/` first. `MISSING_FROM_SITE` is logged only for leads VMS currently shows as LISTED (website listing + inventory `LISTED`) that are absent from that same-day scan — SOLD/BOOKED/STOCK_IN_PENDING tractors dropping off the site are expected, not issues.

### 4. VMS locations are mapped onto the TJ location master before flagging

VMS and TractorJunction use different location APIs, so a naming difference is not a mismatch. VMS stores a centre town/tehsil (`centre`, e.g. "Chopda", "Agar", "Bhopal Biapass") or district (`centreCity`, e.g. "Shri Ganganagar", "Ashok Nagar"), while the site shows the TJ district from `new_districts`. The compare resolves each VMS place via `data/location-match.js` using `data/location-map.json`, exported from the TJ **staging** DB (`npm run location:export`, office network only; CI restores it from the `LOCATION_MAP_GZ_B64` secret). The staging DB's location tables are accurate but its tractor data is not current, so it is used only for location names, never to compare tractor details. Resolution order: same-named district (spacing/spelling tolerant, "Agar" = "Agar-Malwa"), else tehsil in `new_tehsils` -> its district, else the district `old_tractors` files that VMS centre's tractors under. A LOCATION mismatch is flagged only when the site district is outside that set (e.g. VMS Behror -> TJ Kotputli-Behror, site Alwar stays flagged).

### 5. The repo is public — nothing sensitive is committed

Secrets, internal hosts and IDs live only in `.env` (local) and GitHub Actions secrets (CI): VMS API base/token, DB credentials, Cliq URLs/tokens, sheet ID and web-app URL/secret. `output/`, `data/*.json`, CSVs and logs hold VMS lead data and are gitignored; CI never uploads them as artifacts. Before every push, scan staged files for tokens, hosts, IPs, emails and local paths.

### 6. Non-certified scan results live in `non-certified/`, never `output/`

`output/` is cleared before every VMS compare run, so `auth/non-certified-used-tractors.js` (`npm run tractors:non-certified`) and `auth/compare-used-tractor-snapshots.js` (`npm run tractors:url-changes`) read and write only `non-certified/` (gitignored). Its dated `used-tractors-snapshot-*.json` files are the history used to spot URL slug changes per listing ID, so never delete them when clearing `output/`.
