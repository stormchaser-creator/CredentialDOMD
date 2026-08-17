import { memo, useRef, useState } from "react";
import { useApp } from "../../../context/AppContext";
import Modal from "../../shared/Modal";
import { generateId } from "../../../utils/helpers";
import { analyzeStatement, categorizeStatementRows } from "../../../utils/documentScanner";
import * as XLSX from "xlsx";

/**
 * StatementImport — turn the business card's statement into deduction lines.
 * CSV parses on-device; PDF/image goes through the AI scanner. Every row
 * lands in a review screen first: auto-categorized, de-duplicated against
 * the existing ledger, credits/payments excluded by default. Nothing is
 * saved until the physician approves the batch.
 */

const CATEGORIES = [
  "Travel — lodging", "Travel — airfare", "Travel — ground / rideshare",
  "Travel — rental car / fuel", "Travel — parking / tolls",
  "Meals (50% deductible)", "License renewal fee", "DEA registration",
  "Board certification / MOC", "Professional society dues", "CME course",
  "Malpractice premium", "Medical supplies / equipment",
  "Software / SaaS (CredentialDoMD, Doximity, etc.)", "Phone / internet",
  "Professional fees (CPA, legal)", "Postage / shipping", "Office supplies",
  "Other deductible expense",
];

// Travel rows can also be billed to a locum agency (Work > Expenses), which
// uses its own category vocabulary — map the ones that carry across.
const BILLABLE_CATEGORY = {
  "Travel — lodging": "Hotel",
  "Travel — airfare": "Airfare",
  "Travel — ground / rideshare": "Rideshare / Taxi",
  "Travel — rental car / fuel": "Rental car",
  "Travel — parking / tolls": "Parking",
};

// Merchant keyword → category. First hit wins; everything else lands in
// "Other" for the physician to reassign in review.
const RULES = [
  [/marriott|hyatt|hilton|westin|sheraton|holiday inn|hampton|residence inn|airbnb|hotel|lodge|inn\b/i, "Travel — lodging"],
  [/united|delta|southwest|american air|alaska air|frontier|jetblue|airline|airfare/i, "Travel — airfare"],
  [/uber|lyft|taxi|shuttle|amtrak/i, "Travel — ground / rideshare"],
  [/hertz|avis|enterprise|budget rent|national car|alamo|shell|chevron|exxon|conoco|sinclair|gas\b|fuel/i, "Travel — rental car / fuel"],
  [/parking|park ?mobile|toll/i, "Travel — parking / tolls"],
  [/restaurant|grill|cafe|coffee|starbucks|chipotle|doordash|grubhub|steakhouse|sushi|pizza|deli|bistro|bakery/i, "Meals (50% deductible)"],
  [/medical board|state board|licens/i, "License renewal fee"],
  [/dea\b|drug enforcement/i, "DEA registration"],
  [/abns|abpn|american board|maintenance of cert/i, "Board certification / MOC"],
  [/\bcns\b|\baans\b|\baoa\b|\bama\b|congress of neuro|society|association dues/i, "Professional society dues"],
  [/cme|conference|symposium|course/i, "CME course"],
  [/apple\.com|google|openai|anthropic|dropbox|microsoft|adobe|doximity|credentialdomd|zoom|github/i, "Software / SaaS (CredentialDoMD, Doximity, etc.)"],
  [/verizon|at&t|t-mobile|comcast|xfinity|spectrum/i, "Phone / internet"],
  [/cpa|accounting|legal|attorney|law office/i, "Professional fees (CPA, legal)"],
  [/usps|fedex|ups\b/i, "Postage / shipping"],
  [/staples|office depot|amazon/i, "Office supplies"],
];
const categorize = (merchant) => (RULES.find(([re]) => re.test(merchant)) || [null, "Other deductible expense"])[1];

// Bank CSV headers vary; find columns by intent. Handles quoted fields.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return parseGrid(rows);
}

/**
 * Excel statements (.xlsx/.xls): every sheet is scanned; the first sheet
 * whose header looks like a statement (date + description/amount) wins.
 * Excel date serials become YYYY-MM-DD; header rows above the table
 * (bank name, account, statement period) are skipped.
 */
function parseExcel(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  const looksLikeHeader = (r) => {
    const h = (r || []).map(x => String(x ?? "").trim().toLowerCase());
    return h.some(x => /date/.test(x)) && h.some(x => /description|merchant|payee|details?$|name|amount|debit/.test(x));
  };
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    let start = grid.findIndex(looksLikeHeader);
    if (start < 0) {
      // No recognizable header: accept a sheet that has date-like first cells.
      const dataRows = grid.filter(r => r && r.length >= 2 && (typeof r[0] === "number" || /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/.test(String(r[0]))));
      if (dataRows.length < 2) continue;
      start = grid.indexOf(dataRows[0]);
      const rows = grid.slice(start).map(r => r.map(cellToText));
      const parsed = parseGrid(rows);
      if (parsed.length) return parsed;
      continue;
    }
    const rows = grid.slice(start).map(r => r.map(cellToText));
    const parsed = parseGrid(rows);
    if (parsed.length) return parsed;
  }
  return [];
}

// Excel serial dates -> "YYYY-MM-DD"; everything else -> trimmed text.
function cellToText(v) {
  if (v == null) return "";
  if (typeof v === "number" && v > 20000 && v < 80000 && Number.isInteger(v)) {
    // Excel serial day count from 1899-12-30 (the 1900 leap-year bug included).
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function parseGrid(rows) {
  if (!rows.length) return [];

  const header = rows[0].map(h => String(h ?? "").trim().toLowerCase());
  const idx = (res) => header.findIndex(h => res.some(r => r.test(h)));
  let dateI = idx([/^date$/, /transaction date/, /^trans/, /date/]);
  let descI = idx([/description/, /merchant/, /payee/, /details?$/, /name/]);
  let amtI = idx([/^amount$/, /amount/, /^debit/]);
  const creditI = idx([/^credit/]);
  const hasHeader = dateI >= 0 && (descI >= 0 || amtI >= 0);
  const body = hasHeader ? rows.slice(1) : rows;
  if (!hasHeader) { dateI = 0; descI = 1; amtI = rows[0].length - 1; }

  const out = [];
  for (const r of body) {
    const rawDate = (r[dateI] || "").trim();
    const desc = (r[descI] || "").trim();
    let amt = parseFloat(String(r[amtI] || "").replace(/[$,()]/g, ""));
    const wasParen = /\(.*\)/.test(r[amtI] || "");
    if (creditI >= 0 && !amt) amt = -parseFloat(String(r[creditI] || "").replace(/[$,]/g, "")) || 0;
    if (!rawDate || isNaN(amt) || amt === 0) continue;
    // Normalize MM/DD/YYYY and YYYY-MM-DD
    let date = rawDate;
    const us = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (us) {
      const yr = us[3].length === 2 ? "20" + us[3] : us[3];
      date = `${yr}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    }
    // Card exports disagree on sign: Chase charges are negative, Amex positive.
    // Majority sign wins as "charge" below; parentheses always mean negative.
    out.push({ date, merchant: desc, amount: wasParen ? -Math.abs(amt) : amt });
  }
  if (!out.length) return [];
  const negs = out.filter(t => t.amount < 0).length;
  const chargesAreNegative = negs > out.length / 2;
  return out.map(t => ({
    date: t.date,
    merchant: t.merchant,
    amount: Math.abs(t.amount),
    isCharge: chargesAreNegative ? t.amount < 0 : t.amount > 0,
  }));
}

function StatementImport({ open, onClose }) {
  const { data, addItem, theme: T } = useApp();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState(null); // review set
  const [done, setDone] = useState(null);
  const agencies = [...new Set((data.locumContracts || []).map(c => c.agency).filter(Boolean))];

  const dedupKey = (d, a, m) => `${d}|${(parseFloat(a) || 0).toFixed(2)}|${String(m).toLowerCase().slice(0, 20)}`;
  const existing = new Set((data.deductibles || []).map(x => dedupKey(x.date, x.amount, x.merchant || x.description)));

  const toReview = async (txns) => {
    const seen = new Set();
    const rs = txns
      .filter(t => t.date && (parseFloat(t.amount) || 0) > 0)
      .map(t => {
        const dup = existing.has(dedupKey(t.date, t.amount, t.merchant)) || seen.has(dedupKey(t.date, t.amount, t.merchant));
        seen.add(dedupKey(t.date, t.amount, t.merchant));
        return {
          ...t,
          category: categorize(t.merchant || ""),
          include: t.isCharge !== false && !dup,
          duplicate: dup,
          alsoBill: false,
          agency: agencies[0] || "",
        };
      })
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    if (!rs.length) { setError("No transactions found in that file."); return; }
    // AI pass: the keyword map is the floor; the model assigns the rest so
    // the ledger reaches the CPA properly categorized, not a wall of Other.
    if (data.settings.apiKey) {
      try {
        const ai = await categorizeStatementRows(
          rs.map(r => ({ merchant: r.merchant, amount: r.amount })), CATEGORIES, data.settings.apiKey
        );
        if (ai) for (const { i, category } of ai) {
          if (rs[i] && CATEGORIES.includes(category)) rs[i] = { ...rs[i], category };
        }
      } catch { /* keyword categories stand */ }
    }
    setRows(rs);
  };

  const handleFile = async (file) => {
    setError(null); setDone(null); setBusy(true);
    try {
      if (/csv|text/.test(file.type) || /\.csv$/i.test(file.name)) {
        await toReview(parseCsv(await file.text()));
      } else if (/spreadsheet|ms-excel|officedocument\.spreadsheetml/.test(file.type) || /\.(xlsx|xls|xlsm)$/i.test(file.name)) {
        const parsed = parseExcel(await file.arrayBuffer());
        if (!parsed.length) throw new Error("No transactions found in that workbook. Export the statement as CSV, or make sure the sheet has Date, Description, and Amount columns.");
        await toReview(parsed);
      } else {
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result); r.onerror = rej;
          r.readAsDataURL(file);
        });
        await toReview(await analyzeStatement(dataUrl, data.settings.apiKey));
      }
    } catch (e) {
      setError(e.message || "Could not read that file.");
    } finally { setBusy(false); }
  };

  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r));
  const included = (rows || []).filter(r => r.include);
  const total = included.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  const saveBatch = () => {
    let billed = 0;
    for (const r of included) {
      addItem("deductibles", {
        id: generateId(),
        date: r.date,
        category: r.category,
        description: r.merchant,
        merchant: r.merchant,
        amount: parseFloat(r.amount) || 0,
        taxYear: String(r.date || "").slice(0, 4),
        source: "card import",
      });
      if (r.alsoBill && BILLABLE_CATEGORY[r.category] && (r.agency || "").trim()) {
        addItem("travelExpenses", {
          id: generateId(),
          date: r.date,
          amount: parseFloat(r.amount) || 0,
          category: BILLABLE_CATEGORY[r.category],
          vendor: r.merchant,
          agency: r.agency.trim(),
          notes: "Imported from statement",
        });
        billed++;
      }
    }
    setDone({ count: included.length, billed });
    setRows(null);
  };

  const money = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <Modal open={open} onClose={() => { setRows(null); setDone(null); setError(null); onClose(); }} title="Import card statement">
      {!rows && (
        <>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
            Upload the business card's statement: CSV or Excel reads instantly on-device; PDF or a photo goes through the AI scanner. You review and categorize every line before anything is saved, and rows already in the ledger are flagged as duplicates.
          </div>
          <input type="file" ref={fileRef} accept=".csv,text/csv,.xlsx,.xls,.xlsm,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf,image/*" style={{ display: "none" }}
            onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; }} />
          <button onClick={() => fileRef.current?.click()} disabled={busy} style={{
            width: "100%", padding: "14px", borderRadius: 12, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.6 : 1,
          }}>{busy ? "Reading statement…" : "Choose statement file"}</button>
          {done != null && (
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#22c55e", marginTop: 12 }}>
              Added {done.count} deduction line{done.count === 1 ? "" : "s"} to the ledger. They're in the Deductions list and the tax estimate now.
              {done.billed > 0 && ` Also added ${done.billed} to Work Expenses to invoice.`}
            </div>
          )}
          {error && <div style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 12 }}>{error}</div>}
        </>
      )}

      {rows && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 8 }}>
            {included.length} of {rows.length} lines selected · {money(total)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "50vh", overflowY: "auto" }}>
            {rows.map((r, i) => (
              <div key={i} style={{
                padding: "8px 10px", borderRadius: 10, border: `1px solid ${T.border}`,
                backgroundColor: r.include ? T.input : "transparent", opacity: r.include ? 1 : 0.55,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" checked={r.include} onChange={e => setRow(i, { include: e.target.checked })} style={{ width: 17, height: 17, flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.merchant || "—"}
                      {r.duplicate && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: T.warning, textTransform: "uppercase" }}>already in ledger</span>}
                      {r.isCharge === false && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: T.textDim, textTransform: "uppercase" }}>payment / credit</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: T.textDim }}>{r.date}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{money(r.amount)}</div>
                </div>
                {r.include && (
                  <select value={r.category} onChange={e => setRow(i, { category: e.target.value })} style={{
                    width: "100%", marginTop: 6, padding: "7px 10px", borderRadius: 8, fontSize: 12.5,
                    border: `1px solid ${T.border}`, backgroundColor: T.card, color: T.text, appearance: "auto",
                  }}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
                {r.include && BILLABLE_CATEGORY[r.category] && (
                  <div style={{ marginTop: 6 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.textMuted, cursor: "pointer" }}>
                      <input type="checkbox" checked={r.alsoBill} onChange={e => setRow(i, { alsoBill: e.target.checked })} style={{ width: 15, height: 15, flexShrink: 0 }} />
                      Also bill to agency (Work Expenses)
                    </label>
                    {r.alsoBill && (
                      <>
                        <input list={`import-agencies-${i}`} value={r.agency} onChange={e => setRow(i, { agency: e.target.value })}
                          placeholder="Agency name" style={{
                            width: "100%", marginTop: 6, padding: "7px 10px", borderRadius: 8, fontSize: 12.5,
                            border: `1px solid ${T.border}`, backgroundColor: T.card, color: T.text,
                          }} />
                        <datalist id={`import-agencies-${i}`}>
                          {agencies.map(a => <option key={a} value={a} />)}
                        </datalist>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => setRows(null)} style={{ padding: "12px 16px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Back</button>
            <button onClick={saveBatch} disabled={!included.length} style={{
              flex: 1, padding: "12px 16px", borderRadius: 10, border: "none",
              backgroundColor: included.length ? T.accent : T.border, color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer",
            }}>Add {included.length} to deductions — {money(total)}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export default memo(StatementImport);
