/**
 * Google Apps Script Web App — serves dashboard data as JSON.
 *
 * DEPLOY INSTRUCTIONS:
 *   1. Open your Google Sheet → Extensions → Apps Script
 *   2. Paste this entire file into the editor
 *   3. Click Deploy → New deployment
 *   4. Type: Web app
 *   5. Execute as: Me
 *   6. Who has access: Anyone
 *   7. Click Deploy → Copy the /exec URL
 *   8. Paste that URL into config.js as window.DASHBOARD_REMOTE_URL
 *
 * The 'payload' sheet must have the full data.json content in cell A1.
 * upload_to_gsheets.py writes to that cell on every daily run.
 */

function doGet(e) {
  try {
    var sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('payload');
    var payload = sheet.getRange('A1').getValue();

    if (!payload) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'No data in payload sheet' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Validate it's parseable JSON before returning
    JSON.parse(payload);

    return ContentService
      .createTextOutput(payload)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
