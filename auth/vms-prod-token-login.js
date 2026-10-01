// @ts-check
// VMS Production token login helper.
// Reads PROD_VMS_TOKEN from .env, verifies it against the prod API,
// and stores it ready for use by API tests / scripts.
// Run with: npm run vms:prod-auth
//
// READ-ONLY: this only issues a GET/status call to validate the token.

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env'), quiet: true });

const PROD_VMS_TOKEN = process.env.PROD_VMS_TOKEN;
const VMS_API_BASE = process.env.VMS_API_BASE || '';

async function main() {
  if (!PROD_VMS_TOKEN) {
    console.error('ERROR: PROD_VMS_TOKEN is not set in .env');
    process.exit(1);
  }

  console.log('Verifying VMS production token...');
  console.log(`Token: ${PROD_VMS_TOKEN.slice(0, 40)}...`);

  // Decode JWT payload to show claims
  try {
    const payload = JSON.parse(Buffer.from(PROD_VMS_TOKEN.split('.')[1], 'base64url').toString());
    console.log('JWT claims:');
    console.log(`  email:      ${payload.email}`);
    console.log(`  role:       ${payload.role}`);
    console.log(`  name:       ${payload.name}`);
    console.log(`  isActive:   ${payload.isActive}`);
    console.log(`  issued:     ${new Date(payload.iat * 1000).toISOString()}`);
    console.log(`  expires:    ${new Date(payload.exp * 1000).toISOString()}`);
    const expired = Date.now() > payload.exp * 1000;
    console.log(`  status:     ${expired ? 'EXPIRED' : 'valid'}`);
  } catch {
    console.log('  (token is not a decodable JWT)');
  }

  // Validate against the API (GET only)
  const response = await fetch(`${VMS_API_BASE}/status`, {
    method: 'GET',
    headers: {
      Authorization: PROD_VMS_TOKEN,
      'X-Request-Source': 'WEB',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (response.ok) {
    const body = await response.json();
    console.log('\nToken verified against prod API:');
    console.log(`  message: ${body.message}`);
    console.log(`  version: ${body.version}`);
    console.log('OK — PROD_VMS_TOKEN is working.');
  } else {
    console.error(`\nToken FAILED validation. HTTP ${response.status}`);
    try {
      const err = await response.json();
      console.error('  API error:', err.message || JSON.stringify(err));
    } catch {}
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});