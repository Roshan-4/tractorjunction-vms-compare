# TractorJunction vs VMS — daily compare

Checks every used-tractor listing on the public tractorjunction.com "Assured Used Tractors" page against VMS (the source of truth) and reports:

| Status | Meaning |
|---|---|
| `MISMATCH` | Matched by registration number, but year / price / make / model / location differ |
| `SOLD_STILL_LISTED` | Sold in VMS, still on the site without a Sold badge |
| `BOOKED_STILL_LISTED` | Booked in VMS, still on the site without a Booked badge (info only) |
| `NO_VMS_MATCH` | Site tractor with no VMS lead |
| `MISSING_FROM_SITE` | LISTED in VMS but not on today's site scan |

VMS and TractorJunction name locations differently, so VMS centres are mapped onto TractorJunction's location master (districts / tehsils) before a location is flagged — see `data/location-match.js`.
The map lives in `data/location-map.json` (gitignored), exported with `npm run location:export` from a network that can reach the DB; CI rebuilds it from the `LOCATION_MAP_GZ_B64` secret (`npm run location:secret` updates it).

Each run:
1. Fetches all VMS leads and re-scans the live site (no cached site data).
2. Writes CSVs + a summary to `output/` (gitignored — contains VMS data).
3. Replaces the tabs of the report Google Sheet (`auth/google-sheet.js`).
4. Posts the summary + sheet link to a Zoho Cliq channel (`auth/zoho-cliq.js`).

## Run locally

```sh
npm ci
cp .env.example .env   # fill in values
npm run daily:tractor-vs-vms
```

## Scheduled run

`.github/workflows/daily-compare.yml` runs every day at 09:30 IST (and on demand from the Actions tab). All configuration comes from GitHub Actions secrets with the same names as in `.env.example`. It posts to Cliq when the run fails and warns 3 days before the VMS token expires.
