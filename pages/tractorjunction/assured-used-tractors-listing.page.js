// @ts-check
// Page object for the public "Assured Used Tractors for Sale" listing page on tractorjunction.com.
import { normalizeRegNo } from '../../data/vms-leads.js';

const LISTING_URL = 'https://www.tractorjunction.com/assured-used-tractors-for-sell/';
const CARDS_PAGE_SIZE = 8;

export class AssuredUsedTractorsListingPage {
  /**
   * @param {import('@playwright/test').APIRequestContext} request
   */
  constructor(request) {
    this.request = request;
  }

  /**
   * Enumerates every listed tractor by walking the server-side ?page=N pagination.
   * @returns {Promise<Array<{tjId: string, href: string, title: string, yearLoc: string, price: string, emi: string}>>}
   */
  async getAllTractorCards(lastPage = 112) {
    const all = new Map();
    for (let p = 1; p <= lastPage; p++) {
      const res = await this.request.get(`${LISTING_URL}?page=${p}`);
      if (!res.ok()) continue;
      const html = await res.text();
      const cards = parseCardsFromHtml(html);
      for (const card of cards) all.set(card.tjId, card);
    }
    return [...all.values()];
  }
}

/**
 * Parses tractor cards strictly from the #tractorResponse block of the listing HTML.
 * @param {string} html
 */
export function parseCardsFromHtml(html) {
  const blockMatch = html.match(/<div[^>]*id="tractorResponse"[^>]*>([\s\S]*?)(?:<p class="viewall|<\/div>\s*<\/div>\s*<!-- Old Tractor|<!-- Old Tractor)/);
  const block = blockMatch ? blockMatch[1] : html;
  const cards = block.match(/<div class="tjcol[^>]*data-images="[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>[\s\S]*?<\/div>\s*<\/div>/g) || [];
  const result = [];
  for (const card of cards) {
    const hrefM = card.match(/href="([^"]*\/used-tractor\/[^"]*\/)"/);
    if (!hrefM) continue;
    const idM = hrefM[1].match(/\/(\d+)\/$/);
    if (!idM) continue;
    const titleM = card.match(/usedTractors_title[^>]*>\s*([^<]+)/);
    const yearLocM = card.match(/yearLocation[^>]*>\s*([^<]+)/);
    const priceM = card.match(/priceWrp[^>]*>\s*([^<]+)/);
    const emiM = card.match(/emiWrp[^>]*>\s*EMI at\s*<span>([^<]+)<\/span>/);
    result.push({
      tjId: idM[1],
      href: hrefM[1],
      title: titleM ? titleM[1].trim() : '',
      yearLoc: yearLocM ? yearLocM[1].trim() : '',
      price: priceM ? priceM[1].trim() : '',
      emi: emiM ? emiM[1].trim() : '',
      regNo: '', // filled in from the PDP
    });
  }
  return result;
}

/** Utility: extract the normalized reg number from a raw PDP string. */
export function extractRegNoFromText(text) {
  const m = String(text).match(/[A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{3,4}/i);
  return m ? normalizeRegNo(m[0]) : '';
}