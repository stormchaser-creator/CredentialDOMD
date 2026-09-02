/**
 * CallSync sync: the ANMG on-call schedule, pulled onto the Forecast calendar.
 *
 * CallSync (the scheduling app for Arrowhead Neurosurgical Medical Group)
 * publishes each provider's shifts as a calendar subscription: one full-day
 * event per published slot the provider is primary or backup on, titled
 * "ON CALL <dash> ARMC NSx (Primary)", three months back to twelve ahead,
 * from PUBLISHED schedule periods only. The link carries a per-user token
 * and is copied from CallSync's Dashboard, under Calendar Subscription.
 *
 * Here each shift becomes one scheduleDays entry on the ANMG agreement:
 * kind "call", expected = that hospital's grid rate for the role (the
 * contract's Appendix A table), source "callsync", sourceKey =
 * date|hospital|coverage|role. A re-sync matches on the key, so nothing is
 * ever duplicated; a future shift that leaves the published schedule (a
 * swap, an unpublished month) comes off the calendar; a day the physician
 * entered by hand has no source and is never touched.
 *
 * Pure: no React, no storage, no network. Unit-tested by
 * scripts/callsync.test.mjs under plain node.
 */
import { gridRate } from "./dutyPay.js";
import { iso } from "./forecast.js";

export { iso };

export const CALLSYNC_SOURCE = "callsync";
export const CALLSYNC_HOSTS = [
  "anmg-callsync-production.up.railway.app",
  "callsync.anmg-ca.com",
];
/** Where a bare token is sent when the physician pastes only the token. */
export const CALLSYNC_DEFAULT_HOST = CALLSYNC_HOSTS[0];
export const AUTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Failed attempts (offline, server down) retry no sooner than this. */
export const RETRY_INTERVAL_MS = 15 * 60 * 1000;

const TOKEN_SHAPE = /^[A-Za-z0-9-]{8,128}$/;

/**
 * The feed URL to sync from, or null when the input is not a CallSync
 * calendar link. Accepts the URL CallSync's dashboard copies (with or
 * without the scheme) or just the token itself.
 */
export function parseFeedUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (TOKEN_SHAPE.test(raw) && !raw.includes("/") && !raw.includes(".")) {
    return `https://${CALLSYNC_DEFAULT_HOST}/api/ical?token=${raw}`;
  }
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!CALLSYNC_HOSTS.includes(host)) return null;
  if (u.pathname.replace(/\/+$/, "") !== "/api/ical") return null;
  const token = u.searchParams.get("token") || "";
  if (!TOKEN_SHAPE.test(token)) return null;
  return `https://${host}/api/ical?token=${token}`;
}

// ─── iCal parsing ─────────────────────────────────────────────
// RFC 5545: CRLF line ends, continuation lines start with a space or tab,
// and text values escape backslash, comma, semicolon and newline.

function unfold(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function unescapeText(v) {
  // One pass, so an escaped backslash followed by "n" stays a backslash + n.
  return String(v || "").replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N") ? "\n" : c);
}

/** VEVENTs as plain objects: { uid, summary, description, categories, dtstart, date }. */
export function parseICS(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT$/i.test(line.trim())) { cur = {}; continue; }
    if (/^END:VEVENT$/i.test(line.trim())) { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(";")[0].trim().toUpperCase();
    const value = line.slice(colon + 1);
    switch (name) {
      case "UID": cur.uid = value.trim(); break;
      case "SUMMARY": cur.summary = unescapeText(value).trim(); break;
      case "DESCRIPTION": cur.description = unescapeText(value); break;
      case "CATEGORIES": cur.categories = unescapeText(value).trim(); break;
      case "DTSTART": {
        cur.dtstart = value.trim();
        const m = cur.dtstart.match(/^(\d{4})(\d{2})(\d{2})/);
        if (m) cur.date = `${m[1]}-${m[2]}-${m[3]}`;
        break;
      }
      default: break;
    }
  }
  return events;
}

// ─── Shifts ───────────────────────────────────────────────────

const norm = (s) => String(s || "").trim().replace(/\s+/g, " ");

/** One shift from one event, or null when the event is not a call shift. */
export function shiftFromEvent(ev) {
  if (!ev?.date) return null;
  let hospital = "", coverage = "", role = "";
  const m = norm(ev.summary).match(/^ON CALL\s*[\u2014\u2013-]*\s*(.+?)\s*\((primary|backup)\)$/i);
  if (m) {
    const parts = m[1].split(" ");
    hospital = parts[0];
    coverage = parts.slice(1).join(" ");
    role = m[2].toLowerCase();
  } else {
    // Fallback on the description ("<coverage> at <hospital>" / "Role: Primary")
    // and the category, in case the title format ever changes.
    const d = String(ev.description || "");
    const at = d.match(/^(.+?)\s+at\s+(\S+)\s*$/m);
    if (at) { coverage = norm(at[1]); hospital = norm(at[2]); }
    const r = d.match(/Role:\s*(primary|backup)/i) || String(ev.categories || "").match(/(primary|backup)/i);
    if (r) role = r[1].toLowerCase();
  }
  if (!hospital || !role) return null;
  const key = [ev.date, hospital.toLowerCase(), coverage.toLowerCase(), role].join("|");
  return {
    key, date: ev.date, hospital, coverage, role,
    label: [hospital, coverage].filter(Boolean).join(" "),
    uid: ev.uid || "",
  };
}

/** Every call shift in a feed, unique by key, date order. */
export function shiftsFromICS(text) {
  const byKey = new Map();
  for (const ev of parseICS(text)) {
    const s = shiftFromEvent(ev);
    if (s && !byKey.has(s.key)) byKey.set(s.key, s);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ─── Contract + money ─────────────────────────────────────────

const isArchived = (c) => !!c?.customFields?.archivedAt;

/** The ANMG agreement, by short name or facility; active ones first. */
export function detectContract(contracts) {
  const list = (contracts || []).filter(Boolean);
  const matches = (c) => /^\s*anmg\s*$/i.test(c.shortName || "") || /arrowhead|anmg/i.test(c.facility || "");
  return list.find(c => !isArchived(c) && matches(c)) || list.find(matches) || null;
}

const initials = (name) =>
  String(name || "").replace(/\(.*?\)/g, "").split(/\s+/)
    .filter(w => w && !/^(of|the|and|at|for)$/i.test(w))
    .map(w => w[0]).join("").toUpperCase();

/**
 * The contract's rate-grid row for a hospital abbreviation from the feed.
 * A logged duty day stores the grid's own hospital string, and the grid is
 * titled by the physician ("Arrowhead Regional Medical Center (ARMC)"), so
 * match the parenthesized abbreviation, the whole string, a whole word, or
 * the initials, in that order.
 */
export function gridHospitalFor(contract, abbr) {
  const grid = contract?.callRateGrid;
  if (!Array.isArray(grid) || !abbr) return null;
  const a = String(abbr).trim().toLowerCase();
  const paren = (h) => (String(h || "").match(/\(([^)]+)\)\s*$/) || [])[1]?.toLowerCase() || null;
  const row = grid.find(r => paren(r.hospital) === a)
    || grid.find(r => String(r.hospital || "").trim().toLowerCase() === a)
    || grid.find(r => new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(String(r.hospital || "")))
    || grid.find(r => initials(r.hospital).toLowerCase() === a)
    || null;
  return row ? row.hospital : null;
}

/** What a shift is expected to pay: the grid rate for that hospital and role, else the call stipend. */
export function expectedForShift(contract, shift) {
  if (!contract || !shift) return 0;
  const hospital = gridHospitalFor(contract, shift.hospital);
  const rate = hospital ? gridRate(contract, hospital, shift.role) : 0;
  if (rate > 0) return Math.round(rate);
  return Math.round(parseFloat(contract.callStipend) || 0);
}

export function noteForShift(shift) {
  return `${shift.label} ${shift.role} call (CallSync)`;
}

// ─── Planning ─────────────────────────────────────────────────

/**
 * The dates CallSync's feed covers as of `now` (three months back to twelve
 * ahead), pulled in by a couple of days so a clock or timezone difference
 * at the edge can never read as "this shift vanished".
 */
export function syncWindow(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth() - 3, 3);
  const end = new Date(now.getFullYear(), now.getMonth() + 13, -2);
  return { start: iso(start), end: iso(end) };
}

/** Is the once-a-day check due? Never synced, or the last good sync is a day old, and no attempt in the last few minutes. */
export function isDueForAutoSync(record, now = Date.now()) {
  const okAt = record?.lastOkAt ? Date.parse(record.lastOkAt) : NaN;
  const triedAt = record?.lastAttemptAt ? Date.parse(record.lastAttemptAt) : NaN;
  if (Number.isFinite(triedAt) && now - triedAt < RETRY_INTERVAL_MS) return false;
  if (!Number.isFinite(okAt)) return true;
  return now - okAt >= AUTO_SYNC_INTERVAL_MS;
}

/**
 * What a sync would change, without changing anything.
 *
 * @param shifts       shiftsFromICS() output
 * @param scheduleDays every entry on the calendar (hand-made ones included)
 * @param contractId   the agreement synced shifts belong to
 * @param expectedFor  shift => expected dollars
 * @param today        YYYY-MM-DD
 * @param window       syncWindow() output
 * @param makeId       id generator for new entries
 * @returns { adds, updates, removals, unchanged }
 *   adds/updates are full entries; removals are the existing entries to delete.
 */
export function planSync({ shifts, scheduleDays, contractId, expectedFor, today, window, makeId }) {
  const existing = (scheduleDays || []).filter(e => e && e.source === CALLSYNC_SOURCE);
  const byKey = new Map();
  for (const e of existing) {
    if (!e.sourceKey) continue;
    if (!byKey.has(e.sourceKey)) byKey.set(e.sourceKey, []);
    byKey.get(e.sourceKey).push(e);
  }

  const adds = [], updates = [], removals = [];
  let unchanged = 0;
  const seen = new Set();
  for (const shift of shifts || []) {
    if (seen.has(shift.key)) continue;
    seen.add(shift.key);
    const note = noteForShift(shift);
    const entries = byKey.get(shift.key) || [];
    if (entries.length === 0) {
      adds.push({
        id: makeId(), date: shift.date, contractId, kind: "call",
        expected: expectedFor(shift) || 0, note,
        source: CALLSYNC_SOURCE, sourceKey: shift.key,
      });
      continue;
    }
    // One entry per shift: extras (two devices syncing the same minute) go.
    const [keep, ...extra] = entries;
    removals.push(...extra);
    // A dollar figure the physician adjusted by hand stays; only an empty
    // one is filled in from the contract.
    const expected = parseFloat(keep.expected) > 0 ? keep.expected : (expectedFor(shift) || 0);
    const next = { ...keep, date: shift.date, contractId, kind: "call", note, expected, source: CALLSYNC_SOURCE, sourceKey: shift.key };
    const changed = ["date", "contractId", "kind", "note", "expected"].some(f => String(keep[f] ?? "") !== String(next[f] ?? ""));
    if (changed) updates.push(next); else unchanged++;
  }

  // A shift that left the published schedule comes off the calendar, but
  // only ahead of today and inside the feed's window: the past is history
  // (an archived month must not erase what was estimated), and anything
  // beyond the window was never in the feed to begin with.
  for (const e of existing) {
    if (!e.sourceKey || seen.has(e.sourceKey)) continue;
    if (!e.date || e.date < today) continue;
    if (window && (e.date < window.start || e.date > window.end)) continue;
    removals.push(e);
  }

  return { adds, updates, removals, unchanged };
}

/** "14 call days on the calendar (2 added, 1 removed)" */
export function describeSync({ total, added, updated, removed }) {
  const n = Number(total) || 0;
  const head = `${n} call day${n === 1 ? "" : "s"} on the calendar`;
  const bits = [];
  if (added) bits.push(`${added} added`);
  if (updated) bits.push(`${updated} updated`);
  if (removed) bits.push(`${removed} removed`);
  return bits.length ? `${head} (${bits.join(", ")})` : head;
}
