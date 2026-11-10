const SHEET_ENTRIES = "Entries";
const SHEET_CAPS = "Caps";
const ENTRY_HEADERS = ["id", "date", "user", "amount", "type", "note", "createdAt"];
const CAP_HEADERS = ["effectiveWeek", "cap"];
const ALLOWED_USERS = ["Ethan", "Ken"];
const ALLOWED_TYPES = ["spend", "adjustment"];

// Pseudo-auth: the client sends sha256("budgettracker:" + passcode). The expected
// hash lives in Script Properties (PASS_HASH), never in source.
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const expected = PropertiesService.getScriptProperties().getProperty("PASS_HASH");
    if (!expected || req.hash !== expected) return json_({ ok: false, code: "unauthorized", error: "Unauthorized" });

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      switch (req.action) {
        case "getAll": return json_({ ok: true, entries: readEntries_(), caps: readCaps_() });
        case "add": return json_({ ok: true, entry: addEntry_(req.entry) });
        case "setCap": return json_({ ok: true, caps: setCap_(req.effectiveWeek, req.cap) });
        default: return json_({ ok: false, error: "Unknown action" });
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doGet() {
  return json_({ ok: true, service: "budget-tracker" });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    // Plain text keeps date strings from being converted to Date objects.
    sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat("@");
  }
  return sh;
}

function readEntries_() {
  const rows = sheet_(SHEET_ENTRIES, ENTRY_HEADERS).getDataRange().getValues().slice(1);
  const timezone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return rows
    .filter((r) => r[0] !== "")
    .map((r) => ({
      id: String(r[0]),
      date: r[1] instanceof Date
        ? Utilities.formatDate(r[1], timezone, "yyyy-MM-dd")
        : String(r[1]),
      user: String(r[2]),
      amount: Number(r[3]),
      type: String(r[4]),
      note: String(r[5]),
      createdAt: String(r[6]),
    }));
}

function addEntry_(input) {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Invalid date");
  if (ALLOWED_USERS.indexOf(input.user) < 0) throw new Error("Invalid user");
  if (ALLOWED_TYPES.indexOf(input.type) < 0) throw new Error("Invalid type");
  const amount = Number(input.amount);
  if (!isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) throw new Error("Invalid amount");
  if (input.type === "spend" && amount < 0) throw new Error("Spend must be positive");
  const note = String(input.note || "").slice(0, 120);
  if (input.type === "adjustment" && !note) throw new Error("Adjustment needs a reason");

  const entry = {
    id: Utilities.getUuid(),
    date: input.date,
    user: input.user,
    amount: Math.round(amount * 100) / 100,
    type: input.type,
    note: note,
    createdAt: new Date().toISOString(),
  };
  sheet_(SHEET_ENTRIES, ENTRY_HEADERS).appendRow(ENTRY_HEADERS.map((h) => entry[h]));
  return entry;
}

function readCaps_() {
  const rows = sheet_(SHEET_CAPS, CAP_HEADERS).getDataRange().getValues().slice(1);
  return rows
    .filter((r) => r[0] !== "")
    .map((r) => ({ effectiveWeek: String(r[0]), cap: Number(r[1]) }));
}

function setCap_(effectiveWeek, cap) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveWeek)) throw new Error("Invalid week");
  cap = Number(cap);
  if (!isFinite(cap) || cap < 0) throw new Error("Invalid limit");

  const sh = sheet_(SHEET_CAPS, CAP_HEADERS);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === effectiveWeek) {
      sh.getRange(i + 1, 2).setValue(cap);
      return readCaps_();
    }
  }
  sh.appendRow([effectiveWeek, cap]);
  return readCaps_();
}
