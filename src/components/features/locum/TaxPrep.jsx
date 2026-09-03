import { memo, useMemo, useState } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import Field from "../../shared/Field";
import Modal from "../../shared/Modal";
import DeskTable from "../../shared/DeskTable";
import { generateId, formatDate } from "../../../utils/helpers";
import { incomeByState, deductionTotal, estimate } from "../../../utils/taxEngine";
import { allDeductions } from "../../../utils/deductions";
import { paymentsForYear, collectedByState, jurisdictionRows, incomeTableRows, ledgerTotals } from "../../../utils/taxLedger";
import { FED, CA, CO, TAX_YEAR, VERIFIED_NOTE, FILING_STATUSES, TAX_STATES, MODELED_STATES } from "../../../utils/taxConstants";
import { STATE_NAMES } from "../../../constants/states";
import { EditIcon, TrashIcon } from "../../shared/Icons";
import StatementImport from "./StatementImport";

const money = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const money2 = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const stateName = (st) => STATE_NAMES[st] || st;
const fsLabel = (id) => FILING_STATUSES.find(f => f.id === id)?.label || "";
const DASH = "—";

/**
 * TaxPrep: what you'll owe, to whom, from money actually collected.
 * Cash-basis income allocated by work state, S-corp aware, with a
 * payment ledger per jurisdiction so "estimated minus paid = remaining"
 * is always on screen. Nothing is estimated until the filing profile
 * (resident state + filing status) is set.
 *
 * Phone: the figures are stacked mini-cards and the ledger is one card per
 * jurisdiction. Desk width: the same figures as two tables (income by
 * jurisdiction with a totals row, then the payments ledger) with the profit
 * and per-jurisdiction breakdown cards in a grid between them. Both read
 * the rows from utils/taxLedger, so the numbers cannot differ.
 */
function TaxPrep() {
  const { data, updateSettings, addItem, editItem, deleteItem, theme: T, isDesktop } = useApp();
  const iS = useInputStyle();
  const year = TAX_YEAR;
  const tp = useMemo(() => data.settings.taxPrep || {}, [data.settings.taxPrep]);
  const setTp = (patch) => updateSettings({ taxPrep: { ...tp, ...patch } });

  const contracts = data.locumContracts || [];
  const income = useMemo(() => incomeByState(data.invoices || [], contracts, year), [data.invoices, contracts, year]);
  const dedItems = useMemo(() => allDeductions(data, year), [data, year]);
  const deductions = useMemo(() => deductionTotal(dedItems), [dedItems]);
  const est = useMemo(() => estimate({ income, deductions, tp }), [income, deductions, tp]);
  const ready = est.ready;
  const fs = tp.filingStatus;
  const res = tp.residentState;
  const isScorp = (tp.entity || "scorp") !== "soleprop";

  // This year's payments, the ledger rows (one per jurisdiction: estimate,
  // paid, remaining), the collected-by-state lines and the headline totals
  // all come from utils/taxLedger; the phone cards and the desk tables read
  // the same objects.
  const payments = useMemo(() => paymentsForYear(data.taxPayments, year), [data.taxPayments, year]);
  const byState = useMemo(() => collectedByState(income), [income]);
  const jurisdictions = useMemo(() => jurisdictionRows({ est, income, isScorp, payments }), [est, income, isScorp, payments]);
  const totals = useMemo(() => ledgerTotals({ est, income, payments }), [est, income, payments]);
  const labelOf = (jid) => jurisdictions.find(j => j.id === jid)?.label || jid || "";

  const today = new Date().toISOString().slice(0, 10);
  const nextDue = FED.QUARTERLY_DUE.find(d => d >= today);

  const [payFor, setPayFor] = useState(null);
  const [editPay, setEditPay] = useState(null); // desk ledger only: the payment row being edited
  const [payForm, setPayForm] = useState({});
  const openRecord = (jid) => { setPayFor(jid); setPayForm({ date: today, amount: "" }); };
  const openEdit = (p) => { setEditPay(p); setPayForm({ date: p.date, amount: String(p.amount ?? ""), note: p.note || "" }); };
  const closePay = () => { setPayFor(null); setEditPay(null); };
  const savePayment = () => {
    const amt = parseFloat(payForm.amount);
    if (editPay) {
      if (!amt) return;
      editItem("taxPayments", { ...editPay, date: payForm.date || editPay.date, amount: amt, note: (payForm.note || "").trim() });
      setEditPay(null); setPayForm({});
      return;
    }
    if (!amt || !payFor) return;
    addItem("taxPayments", {
      id: generateId(), jurisdiction: payFor, date: payForm.date || today,
      amount: amt, taxYear: String(year), note: (payForm.note || "").trim(),
    });
    setPayFor(null); setPayForm({});
  };
  const removePayment = (p) => { if (window.confirm("Remove this payment record?")) deleteItem("taxPayments", p.id); };

  const card = (children, style = {}, key) => (
    <div key={key} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1, marginBottom: 10, ...style }}>{children}</div>
  );
  const heading = (text) => (
    <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{text}</div>
  );
  const line = (label, value, opts = {}) => (
    <div key={opts.key} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", fontSize: opts.big ? 15 : 13 }}>
      <span style={{ color: opts.muted ? T.textDim : T.textMuted, fontWeight: opts.big ? 800 : 500 }}>{label}</span>
      <span style={{ color: opts.color || T.text, fontWeight: opts.big ? 800 : 700, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{value}</span>
    </div>
  );
  const notModeled = (st) => (
    <div style={{ fontSize: 12.5, color: T.textMuted, padding: "5px 0" }}>State model not loaded yet for {st}. Income sourced here is shown, no tax is estimated.</div>
  );

  const [showAssumptions, setShowAssumptions] = useState(!tp.scorpSalary);
  const [showImport, setShowImport] = useState(false);

  const profileSummary = ready
    ? `${stateName(res)} resident · ${fsLabel(fs).toLowerCase()} · ${isScorp ? `S-corp, salary ${money(tp.scorpSalary || 0)}` : "sole proprietor"} · cash basis (paid invoices)`
    : null;

  // At desk width the breakdown cards sit in a grid whose gap stands in for
  // the stacking margin. On the phone this is an empty override.
  const cardGap = isDesktop ? { marginBottom: 0 } : {};

  // Income and profit. The per-state lines render here on the phone; at desk
  // they are the income table's rows, so the card keeps only the derivation.
  const incomeCard = card(<>
    {heading(isDesktop ? `Net business profit, ${year}` : `Collected income by work state, ${year}`)}
    {!isDesktop && byState.map(r => (
      line(r.state === "Unassigned" ? "⚠ No work state on contract" : `${r.state}, ${stateName(r.state)}`, `${money2(r.amount)} (${r.pct}%)`, r.state === "Unassigned" ? { color: T.warning, key: r.state } : { key: r.state })
    ))}
    {line("Gross collected", money2(income.total), { big: true })}
    {line("Deductions (ledger, meals at 50%)", `− ${money2(est.deductions)}`)}
    <button onClick={() => setShowImport(true)} style={{
      width: "100%", margin: "6px 0", padding: "10px", borderRadius: 10,
      border: `1px dashed ${T.accent}`, backgroundColor: "transparent",
      color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer",
    }}>Upload card statement, import deductions</button>
    {line("Net business profit", money2(est.profit), { big: true })}
    {income.unassignedInvoices.length > 0 && (
      <div style={{ fontSize: 12, color: T.warning, fontWeight: 600, marginTop: 6 }}>
        Set a work state on the contract for: {income.unassignedInvoices.join(", ")} (Contracts, edit).
      </div>
    )}
    {income.total === 0 && (
      <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 4 }}>
        Nothing collected yet in {year}. The estimate fills in as payments get recorded on invoices.
      </div>
    )}
  </>, cardGap);

  // Federal
  const federalCard = ready ? card(<>
    {heading("Federal")}
    {isScorp ? (<>
      {line("W-2 salary from S-corp", money2(est.salary))}
      {line(est.k1 < 0 ? "K-1 loss passed through (after payroll + franchise)" : (est.franchise > 0 ? "K-1 distribution (after payroll + franchise)" : "K-1 distribution (after payroll)"), money2(est.k1))}
      {line("Payroll taxes, employee side", money2(est.employeePayroll))}
      {line("Payroll taxes, company side (deducted)", money2(est.employerPayroll), { muted: true })}
    </>) : (
      line("Self-employment tax", money2(est.seTax))
    )}
    {est.qbiDed > 0 ? (<>
      {line(`Taxable income before QBI (${fsLabel(fs)}, after ${money(FED.STD_DEDUCTION[fs])} std deduction)`, money2(est.fedTaxable + est.qbiDed))}
      {line("QBI deduction (Sec. 199A, 20%)", `− ${money2(est.qbiDed)}`)}
      {line("Taxable income", money2(est.fedTaxable), { big: true })}
    </>) : (
      line(`Taxable income (${fsLabel(fs)}, after ${money(FED.STD_DEDUCTION[fs])} std deduction)`, money2(est.fedTaxable))
    )}
    {line("Federal income tax", money2(est.fedIncomeTax))}
    {line("Federal total", money2(est.fedTotal), { big: true, color: T.warning })}
  </>, cardGap) : null;

  // Resident state
  const residentCard = ready && est.resident ? card(<>
    {heading(`${stateName(est.resident.state)}, resident`)}
    {!est.resident.modeled ? (<>
      {line(`${est.resident.state}-source income`, money2(est.resident.source))}
      {notModeled(est.resident.state)}
    </>) : est.resident.noIncomeTax ? (<>
      {line(`${est.resident.state} income tax`, "$0.00 (no state income tax on wages or business income)")}
    </>) : (<>
      {line(`${est.resident.state} tax before credits (${est.resident.label})`, money2(est.resident.grossTax))}
      {est.nonresident.some(n => n.modeled) && line("Credit for tax paid to work states", `− ${money2(est.resident.credit)}`)}
      {est.resident.state === "CA" && line("CA SDI on salary", money2(est.sdi))}
      {line(`${est.resident.state} personal total`, money2(est.resident.owed + est.sdi), { big: true, color: T.warning })}
      {est.resident.state === "CA" && isScorp && line(`S-corp franchise tax (${(CA.SCORP_FRANCHISE_RATE * 100).toFixed(1)}%, min ${money(CA.SCORP_FRANCHISE_MIN)}, Form 100S)`, money2(est.franchise), { color: T.warning })}
      {est.resident.state === "CA" && (
        <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 4 }}>
          Ask your CPA about the CA PTET election, extended for 2026 to 2030 (SB 132, 9.3% entity-level with a matching credit): it restores the federal deduction the SALT cap removes. June 15 prepayment (greater of $1,000 or 50% of last year's PTET); missing it now trims the credit 12.5% instead of voiding the election.
        </div>
      )}
    </>)}
  </>, cardGap) : null;

  // Nonresident work states
  const nonresidentBody = (n) => (<>
    {heading(`${stateName(n.state)}, nonresident`)}
    {line(`${n.state}-source income`, money2(n.source))}
    {n.modeled
      ? line(`${n.state} tax (${n.label})`, money2(n.owed), { big: true, color: T.warning })
      : notModeled(n.state)}
  </>);
  const nonresidentCards = ready ? est.nonresident.map(n => (
    isDesktop
      ? card(nonresidentBody(n), cardGap, n.state)
      : <div key={n.state}>{card(nonresidentBody(n))}</div>
  )) : null;

  // Payments ledger, phone: one block per jurisdiction with its payments beneath.
  const renderLedgerCard = () => card(<>
    {heading("Estimated payments made")}
    {jurisdictions.map(j => (
      <div key={j.id} style={{ padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>{j.label}</div>
            <div style={{ fontSize: 12, color: T.textDim, fontVariantNumeric: "tabular-nums" }}>
              {j.hasEst
                ? <>est {money(j.owed)} · paid {money(j.paid)} · <b style={{ color: j.remaining > 0 ? T.warning : "#22c55e" }}>{money(j.remaining)} left</b></>
                : <>paid {money(j.paid)}{ready ? " · no estimate (state model not loaded)" : ""}</>}
            </div>
          </div>
          <button onClick={() => openRecord(j.id)} style={{
            padding: "7px 12px", borderRadius: 9, border: "none", backgroundColor: T.accent, color: "#fff",
            fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0,
          }}>Record</button>
        </div>
        {payments.filter(p => p.jurisdiction === j.id).map(p => (
          <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: T.textMuted, paddingLeft: 8, marginTop: 3 }}>
            <span>{formatDate(p.date)}{p.note ? ` · ${p.note}` : ""}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontVariantNumeric: "tabular-nums" }}>
              {money2(p.amount)}
              <button onClick={() => removePayment(p)} style={{ padding: "2px 4px", borderRadius: 6, border: "none", backgroundColor: "transparent", color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
            </span>
          </div>
        ))}
      </div>
    ))}
  </>);

  // Desk width: the two tables. Table 1 is the ledger's jurisdictions (plus
  // the no-work-state income the phone's income card lists) with a totals
  // row that carries the headline figures; Table 2 is every payment this
  // year, newest first, with the card's own record, edit and delete
  // handlers. Phone (renderLedgerCard above) is untouched.
  const renderDeskTables = () => {
    const deskMain = { overflow: "hidden", textOverflow: "ellipsis" };
    const deskSub = { fontSize: 11, color: T.textDim, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis" };
    const deskBtn = {
      width: 26, height: 26, padding: 0, borderRadius: 8, border: "none", cursor: "pointer",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
    };
    const deskGhostBtn = { ...deskBtn, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted };
    const recordBtn = {
      padding: "5px 11px", borderRadius: 8, border: "none", backgroundColor: T.accent, color: "#fff",
      fontSize: 12, fontWeight: 700, cursor: "pointer",
    };
    const deskTitle = (text, sub) => (
      <div style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: T.text }}>{text}</h3>
        {sub && <div style={{ fontSize: 12, color: T.textMuted }}>{sub}</div>}
      </div>
    );
    // An estimate cell: the engine's figure, "no estimate" once the profile
    // is complete but no model covers the jurisdiction, a dash before that.
    const estCell = (j) => (
      j.hasEst ? money(j.owed) : ready ? <span style={{ color: T.textDim }}>no estimate</span> : DASH
    );
    const remainingTone = (rem) => ({ fontWeight: 700, color: rem > 0 ? T.warning : T.success });
    const incomeRows = incomeTableRows(jurisdictions, income);

    return (
      <>
        <div style={{ marginBottom: 16 }}>
          {deskTitle(`Income by jurisdiction, ${year}`, "Cash collected by work state; the estimate, what is paid and what remains for every jurisdiction you owe.")}
          <DeskTable
            items={incomeRows}
            actionsWidth={96}
            groupBy={() => "all"}
            subtotal={() => ({
              label: "Total",
              cells: {
                income: money2(totals.income),
                fed: totals.fed != null ? money(totals.fed) : DASH,
                state: totals.state != null ? money(totals.state) : DASH,
                paid: money(totals.paid),
                remaining: totals.remaining != null
                  ? <span style={remainingTone(totals.remaining)}>{money(totals.remaining)}</span>
                  : DASH,
              },
            })}
            columns={[
              // Percentage widths so the Actions cell never leaves the
              // clipped wrapper in a 1024px window. Calibrated so every
              // figure and the longest label (the CA franchise row) fit at
              // a 1280px window; Jurisdiction takes the remainder.
              { key: "label", label: "Jurisdiction", render: j => (
                <div style={{ ...deskMain, fontWeight: 700, color: j.kind === "unassigned" ? T.warning : T.text }} title={j.label}>{j.label}</div>
              ) },
              { key: "income", label: "Income", type: "number", width: "15%", align: "right", render: j => (
                j.income != null ? (
                  <>
                    <div style={deskMain}>{money2(j.income)}</div>
                    {j.kind === "federal"
                      ? <div style={deskSub}>all work states</div>
                      : j.pct != null && <div style={deskSub}>{j.pct}% of gross</div>}
                  </>
                ) : DASH
              ) },
              { key: "fed", label: "Est. federal", type: "number", width: "12.5%", align: "right",
                value: j => (j.kind === "federal" && j.hasEst ? j.owed : null),
                render: j => (j.kind === "federal" ? estCell(j) : DASH) },
              { key: "state", label: "Est. state", type: "number", width: "12.5%", align: "right",
                value: j => (j.kind !== "federal" && j.hasEst ? j.owed : null),
                render: j => (j.kind === "federal" || j.kind === "unassigned" ? DASH : estCell(j)) },
              { key: "paid", label: "Paid", type: "number", width: "12%", align: "right",
                value: j => (j.kind === "unassigned" ? null : j.paid),
                render: j => (j.kind === "unassigned" ? DASH : money(j.paid)) },
              { key: "remaining", label: "Remaining", type: "number", width: "12%", align: "right",
                value: j => (j.hasEst ? j.remaining : null),
                render: j => (j.hasEst ? <span style={remainingTone(j.remaining)}>{money(j.remaining)}</span> : DASH) },
            ]}
            actions={(j) => (
              j.kind === "unassigned" ? null : (
                <button title={`Record a payment to ${j.label}`} onClick={(e) => { e.stopPropagation(); openRecord(j.id); }} style={recordBtn}>Record</button>
              )
            )}
          />
        </div>

        <div className="cmd-responsive-grid-2" style={{ marginBottom: 16 }}>
          {incomeCard}
          {federalCard}
          {residentCard}
          {nonresidentCards}
        </div>

        <div style={{ marginBottom: 16 }}>
          {deskTitle("Estimated payments made", `Every payment recorded for ${year}, newest first. Record one from its jurisdiction row above; click a row to edit it.`)}
          {payments.length === 0 ? card(
            <div style={{ fontSize: 13.5, color: T.textMuted, fontWeight: 600 }}>
              No estimated payments recorded for {year} yet.
            </div>, { marginBottom: 0 }
          ) : (
            <DeskTable
              items={payments}
              defaultSort={{ key: "date", dir: "desc" }}
              onRowClick={(p) => openEdit(p)}
              actionsWidth={80}
              columns={[
                { key: "date", label: "Date", type: "date", width: "16%", render: p => formatDate(p.date) },
                { key: "jurisdiction", label: "Jurisdiction", value: p => labelOf(p.jurisdiction), render: p => (
                  <div style={{ ...deskMain, fontWeight: 700 }} title={labelOf(p.jurisdiction)}>{labelOf(p.jurisdiction)}</div>
                ) },
                { key: "amount", label: "Amount", type: "number", width: "15%", align: "right", render: p => money2(p.amount) },
                { key: "note", label: "Note", width: "34%", render: p => (p.note ? <span title={p.note}>{p.note}</span> : DASH) },
              ]}
              actions={(p) => (
                <div style={{ display: "inline-flex", gap: 2 }}>
                  <button title="Edit" aria-label="Edit payment" onClick={(e) => { e.stopPropagation(); openEdit(p); }} style={deskGhostBtn}><EditIcon /></button>
                  <button title="Delete" aria-label="Delete payment" onClick={(e) => { e.stopPropagation(); removePayment(p); }} style={{ ...deskBtn, backgroundColor: T.dangerDim, color: T.danger }}><TrashIcon /></button>
                </div>
              )}
            />
          )}
        </div>
      </>
    );
  };

  return (
    <div>
      {/* Filing profile: who is being taxed */}
      {card(<>
        {heading("Filing profile")}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Resident state">
            <select value={res || ""} onChange={e => setTp({ residentState: e.target.value || null })} style={{ ...iS, appearance: "auto" }}>
              <option value="">Select</option>
              {TAX_STATES.map(st => <option key={st} value={st}>{st}, {stateName(st)}</option>)}
            </select>
          </Field>
          <Field label="Filing status">
            <select value={fs || ""} onChange={e => setTp({ filingStatus: e.target.value || null })} style={{ ...iS, appearance: "auto" }}>
              <option value="">Select</option>
              {FILING_STATUSES.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Entity">
          <select value={tp.entity || "scorp"} onChange={e => setTp({ entity: e.target.value })} style={{ ...iS, appearance: "auto" }}>
            <option value="scorp">S-corp / PLLC with S election</option>
            <option value="soleprop">Sole proprietor (Schedule C)</option>
          </select>
        </Field>
        <div style={{ fontSize: 11.5, color: T.textDim }}>
          State models loaded: {MODELED_STATES.map(stateName).join(", ")}, plus the no-income-tax states. Other states show income sourced there with no tax estimate. Federal brackets and standard deduction follow your filing status (Rev. Proc. 2025-32).
        </div>
      </>)}

      {/* Headline: the one number to hold in your head */}
      {!ready ? card(
        <div style={{ fontSize: 13.5, color: T.textMuted, fontWeight: 600 }}>
          Set your resident state and filing status to see estimates.
        </div>
      ) : card(<>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Estimated {year} tax, all jurisdictions</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: T.text, margin: "4px 0", fontVariantNumeric: "tabular-nums" }}>{money(est.totalAll)}</div>
        <div style={{ fontSize: 13, color: T.textDim }}>
          {money(totals.paid)} paid · <b style={{ color: totals.remaining > 0 ? T.warning : "#22c55e" }}>{money(totals.remaining)} remaining</b>
          {" · "}set aside <b>{(est.setAsideRate * 100).toFixed(0)}%</b> of every payment
        </div>
        {isScorp && est.employerPayroll > 0 && (
          <div style={{ marginTop: 4, fontSize: 12, color: T.textMuted }}>
            That set-aside covers income and employee-side payroll taxes. Your company also remits {money(est.employerPayroll)} in employer payroll taxes through payroll, so reserve about <b>{(est.cashReserveRate * 100).toFixed(0)}%</b> of gross to cover the full year's cash.
          </div>
        )}
        {est.unmodeled.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12, color: T.textMuted, fontWeight: 600 }}>
            Excludes state tax for {est.unmodeled.join(", ")} (state model not loaded yet).
          </div>
        )}
        {nextDue && (
          <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 10, backgroundColor: T.warningDim, color: T.warning, fontSize: 12.5, fontWeight: 700 }}>
            Next estimated-payment due date: {formatDate(nextDue)}
            {est.safeHarbor && <span style={{ fontWeight: 500 }}> · safe harbor for the year: {money(est.safeHarbor)} (110% of prior-year tax)</span>}
          </div>
        )}
        {est.notes.map((n, i) => (
          <div key={i} style={{ marginTop: 6, fontSize: 12, color: T.warning, fontWeight: 600 }}>⚠ {n}</div>
        ))}
      </>)}

      {/* Assumptions */}
      {card(<>
        <div onClick={() => setShowAssumptions(v => !v)} style={{ cursor: "pointer", display: "flex", justifyContent: "space-between" }}>
          {heading("Assumptions")}
          <span style={{ fontSize: 12, color: T.textDim }}>{showAssumptions ? "hide" : "edit"}</span>
        </div>
        {!showAssumptions && (
          <div style={{ fontSize: 12.5, color: T.textDim }}>
            {profileSummary || "Filing profile incomplete"}
          </div>
        )}
        {showAssumptions && (
          <>
            {isScorp && (
              <Field label="S-corp W-2 salary ($/yr)" hint="Your reasonable compensation. The IRS expects specialist-physician salary data to support this number; set it with your CPA. Payroll taxes apply to salary; the rest flows as K-1 distribution.">
                <input type="number" inputMode="decimal" value={tp.scorpSalary ?? ""} onChange={e => setTp({ scorpSalary: e.target.value })} style={iS} placeholder="e.g. 450000" />
              </Field>
            )}
            <Field label="Other household taxable income ($/yr)" hint="Spouse W-2, interest, anything outside the locums entity. It sets which bracket the locums income lands in.">
              <input type="number" inputMode="decimal" value={tp.otherIncome ?? ""} onChange={e => setTp({ otherIncome: e.target.value })} style={iS} placeholder="0" />
            </Field>
            <Field label={`Total ${year - 1} tax (for safe harbor)`} hint="Line 24 of last year's 1040. Paying 110% of it in quarterlies avoids underpayment penalties regardless of what this year turns out to be.">
              <input type="number" inputMode="decimal" value={tp.priorYearTax ?? ""} onChange={e => setTp({ priorYearTax: e.target.value })} style={iS} placeholder="optional" />
            </Field>
          </>
        )}
      </>)}

      {isDesktop ? renderDeskTables() : (
        <>
          {incomeCard}
          {federalCard}
          {residentCard}
          {nonresidentCards}
          {renderLedgerCard()}
        </>
      )}

      <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.5, padding: "0 4px 12px" }}>
        Planning estimate. {VERIFIED_NOTE} Assumes revenue-share apportionment, ratio-method nonresident tax, and no PTET election; your CPA's return controls. Colorado at {(CO.FLAT_RATE * 100).toFixed(2)}% flat. Reimbursed travel (expense invoices) is excluded from income; the unreimbursed share of a settled travel expense is deducted instead, and card-import meals are counted at 50%.
      </div>

      <StatementImport open={showImport} onClose={() => setShowImport(false)} />

      <Modal open={!!payFor || !!editPay} onClose={closePay} title={`${editPay ? "Edit" : "Record"} payment, ${labelOf(editPay ? editPay.jurisdiction : payFor)}`}>
        <Field label="Amount ($)"><input type="number" inputMode="decimal" autoFocus value={payForm.amount || ""} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))} style={iS} /></Field>
        <Field label="Date"><input type="date" value={payForm.date || today} onChange={e => setPayForm(f => ({ ...f, date: e.target.value }))} style={iS} /></Field>
        <Field label="Note"><input value={payForm.note || ""} onChange={e => setPayForm(f => ({ ...f, note: e.target.value }))} style={iS} placeholder="e.g. Q3 1040-ES via EFTPS" /></Field>
        <button onClick={savePayment} style={{ width: "100%", marginTop: 10, padding: "13px", borderRadius: 11, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>{editPay ? "Save changes" : "Save payment"}</button>
      </Modal>
    </div>
  );
}

export default memo(TaxPrep);
