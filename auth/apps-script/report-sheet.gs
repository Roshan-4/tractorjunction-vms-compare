// Google Apps Script bound to the "TractorJunction vs VMS - Daily Report" sheet.
// Receives the daily compare CSVs from auth/google-sheet.js and replaces each
// tab's data in the sheet whose ID is sent with the request (SHEET_ID). Setup: Extensions > Apps Script, paste this file, add the Script
// Property SECRET (= SHEET_WEBAPP_SECRET from .env), then Deploy > New
// deployment > Web app (Execute as: Me, Who has access: Anyone) and put the
// web app URL in .env as SHEET_WEBAPP_URL.
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || body.secret !== secret) return json({ ok: false, error: 'unauthorized' });

    // Opened by ID so this works whether or not the script is bound to the sheet.
    const ss = SpreadsheetApp.openById(body.sheetId);
    body.tabs.forEach(function (tab) {
      const rows = Utilities.parseCsv(tab.csv.charCodeAt(0) === 0xFEFF ? tab.csv.slice(1) : tab.csv);
      const sheet = ss.getSheetByName(tab.name) || ss.insertSheet(tab.name);
      sheet.clear();
      if (!rows.length) return;
      const width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
      const grid = rows.map(function (r) { return r.concat(new Array(width - r.length).fill('')); });
      sheet.getRange(1, 1, grid.length, width).setNumberFormat('@').setValues(grid);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, width).setFontWeight('bold');
    });

    // Drop the blank default tab once real tabs exist.
    const blank = ss.getSheetByName('Sheet1');
    if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);
    return json({ ok: true, url: ss.getUrl() });
  } catch (err) {
    return json({ ok: false, error: String(err && err.stack || err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor (select "authorize" > Run) to grant the
// spreadsheet permission the web app needs.
function authorize() {
  SpreadsheetApp.getActiveSpreadsheet();
}
