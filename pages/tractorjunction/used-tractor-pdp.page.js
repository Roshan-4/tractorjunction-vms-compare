// @ts-check
// Page object for a used-tractor PDP (product detail page) on tractorjunction.com.
import { normalizeRegNo } from '../../data/vms-leads.js';

export class UsedTractorPdpPage {
  /**
   * @param {import('@playwright/test').Page} page
   */
  constructor(page) {
    this.page = page;
  }

  /**
   * Opens a PDP by its tjListing href.
   * @param {string} href
   */
  async open(href) {
    await this.page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Spec block renders server-side; give any lazy scripts a moment.
    await this.page.waitForTimeout(1500);
  }

  /** Extracts the key-spec value by label from the rendered DOM. Returns '' if absent. */
  async getSpecValue(label) {
    const cols = this.page.locator('.key-Specification-col');
    for (let i = 0; i < (await cols.count()); i++) {
      const lab = (await cols.nth(i).locator('.card-tag-name').textContent()) || '';
      if (lab.trim().toLowerCase() === label.toLowerCase()) {
        return ((await cols.nth(i).locator('.title-name').textContent()) || '').trim();
      }
    }
    return '';
  }

  /** @returns {Promise<{location: string, enginePower: string, purchaseYear: string, rtoNo: string, tyreConditions: string, engineConditions: string, financierNoc: string, rc: string}>} */
  async getKeySpecifications() {
    return {
      location: await this.getSpecValue('Location'),
      enginePower: await this.getSpecValue('Engine Power'),
      purchaseYear: await this.getSpecValue('Purchase Year'),
      rtoNo: await this.getSpecValue('RTO NO.'),
      tyreConditions: await this.getSpecValue('Tyre Conditons'), // typo on the site
      engineConditions: await this.getSpecValue('Engine Conditions'),
      financierNoc: await this.getSpecValue('Financier / NOC'),
      rc: await this.getSpecValue('RC'),
    };
  }

  /** @returns {Promise<string>} normalized registration number */
  async getRegNo() {
    const raw = await this.getSpecValue('RTO NO.');
    return normalizeRegNo(raw);
  }

  /** Display price shown under the title (e.g. "₹ 5,60,000"). The .LoanAmount variant is the EMI-backed loan figure. */
  async getDisplayedPrice() {
    const p = this.page.locator('.rang-price:not(.LoanAmount)').first();
    if (await p.count()) {
      const m = ((await p.textContent()) || '').match(/₹\s?[\d,]+/);
      return m ? m[0] : '';
    }
    return '';
  }

  /**
   * Certified (assured) listings render the "Tractor Inspection Checklist" and the
   * "We Offer" block; plain listings have neither. The red "Certified" chips on the
   * page belong to the Change Tractor / similar-tractor cards, so they don't count.
   */
  async isCertified() {
    const checklist = await this.page.locator('.inspection-checklist-wrapper').count();
    const weOffer = await this.page.locator('.weOffersTractor').count();
    return { certified: checklist > 0 && weOffer > 0, inspectionChecklist: checklist > 0, weOfferBlock: weOffer > 0 };
  }

  /** Listing UID shown above the title, e.g. "TJN255928" → "255928". */
  async getUid() {
    const uid = this.page.locator('.uid-report b').first();
    return (await uid.count()) ? ((await uid.textContent()) || '').replace(/\D/g, '') : '';
  }

  async getCanonical() {
    const link = this.page.locator('link[rel="canonical"]').first();
    return (await link.count()) ? (await link.getAttribute('href')) || '' : '';
  }

  /** Red "Sold" ribbon text on the main listing, '' when not sold. */
  async getSoldBadge() {
    const badge = this.page.locator('.sold-top').first();
    return (await badge.count()) ? ((await badge.textContent()) || '').trim() : '';
  }

  /** The PDP title, e.g. "2023 Massey Ferguson 244 DI In Jhunjhunu, Rajasthan". */
  async getTitle() {
    const h1 = this.page.locator('h1');
    return (await h1.count()) ? ((await h1.first().textContent()) || '').trim() : '';
  }
}

/**
 * Parses the server-rendered PDP HTML directly (no browser needed — the whole
 * spec block, RTO number, and price are present in the initial HTML response).
 * @param {string} html
 */
export function parsePdpHtml(html) {
  const titleM = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleM ? clean(titleM[1]) : '';

  const priceRaw = (html.match(/class="rang-price[^"]*"[^>]*>([\s\S]*?)<\/p>/gi) || [])
    .map((m) => {
      const ru = (m.match(/₹\s?[\d,]+/) || [])[0];
      return ru ? Number(ru.replace(/[₹,\s]/g, '')) : 0;
    })
    .filter((n) => n > 0)
    .sort((a, b) => b - a)[0];
  const price = priceRaw ? `₹ ${priceRaw.toLocaleString('en-IN')}` : '';

  const specs = {};
  const colRe = /class="key-Specification-col[\s\S]*?<p class="card-tag-name[^"]*"[^>]*>([\s\S]*?)<\/p>[\s\S]*?<p class="title-name[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = colRe.exec(html)) !== null) {
    const label = clean(m[1]);
    const value = clean(m[2]);
    if (label) specs[label] = value;
  }

  // The sold/booked state the site itself shows on the PDP (e.g. the red
  // <span class="sold-top ...">Sold</span> ribbon, or the blue Sold button).
  const badgeM = html.match(/class="sold-top[^"]*"[^>]*>\s*([^<]*)</i);
  const soldBadge = badgeM ? clean(badgeM[1]) : '';

  return {
    title,
    price,
    location: specs['Location'] || '',
    enginePower: specs['Engine Power'] || '',
    purchaseYear: specs['Purchase Year'] || '',
    rtoNo: normalizeRegNo(specs['RTO NO.'] || ''),
    tyreConditions: specs['Tyre Conditons'] || specs['Tyre Conditions'] || '',
    engineConditions: specs['Engine Conditions'] || '',
    financierNoc: specs['Financier / NOC'] || '',
    rc: specs['RC'] || '',
    soldBadge,
  };
}

function clean(text) {
  return String(text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}