import { memo, useMemo, useState } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import Field from "../../shared/Field";
import Modal from "../../shared/Modal";
import { generateId, formatDate } from "../../../utils/helpers";
import { incomeByState, deductionTotal, estimate } from "../../../utils/taxEngine";
import { allDeductions } from "../../../utils/deductions";
import { FED, CA, CO, TAX_YEAR, VERIFIED_NOTE, FILING_STATUSES, TAX_STATES, MODELED_STATES } from "../../../utils/taxConstants";
import { STATE_NAMES } from "../../../constants/states";
import { TrashIcon } from "../../shared/Icons";
import StatementImport from "./StatementImport";

const money = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const money2 = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const stateName = (st) => STATE_NAMES[st] || st;
const fsLabel = (id) => FILING_STATUSES.find(f => f.id === id)?.label || "";

/**
 * TaxPrep: what you'll owe, to whom, from money actually collected.
 * Cash-basis income allocated by work state, S-corp aware, with a
 * payment ledger per jurisdiction so "estimated minus paid = remaining"
 * is always on screen. Nothing is estimated until the filing profile
 * (resident state + filing status) is set.
 */
function TaxPrep() {
  const { data, updateSettings, addItem, deleteItem, theme: T } = useApp();
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

  // Jurisdictions the payments ledger tracks: federal, resident state, each
  // nonresident work state, CA franchise when a CA S-corp. Any jurisdiction
  // that already has a payment recorded stays listed so records never vanish.
  const payments = (data.taxPayments || []).filter(p => p.taxYear === String(year));
  const jurisdictions = useMemo(() => {
    const list = [{ id: "federal", label: "Federal (IRS)", owed: est.fedTotal }];
    if (est.resident) {
      list.push({
        id: est.resident.state,
        label: `${stateName(est.resident.state)} (resident)`,
        owed: est.resident.modeled ? est.resident.owed + est.sdi : null,
      });
    }
    for (const n of est.nonresident) {
      list.push({ id: n.state, label: `${stateName(n.state)} (nonresident)`, owed: n.modeled ? n.owed : null });
    }
    if (est.resident?.state === "CA" && isScorp) {
      list.push({ id: "CA-franchise", label: "CA S-corp franchise (Form 100S)", owed: est.franchise });
    }
    for (const p of payments) {
      if (!list.some(j => j.id === p.jurisdiction)) {
        list.push({ id: p.jurisdiction, label: p.jurisdiction === "CA-franchise" ? "CA S-corp franchise (Form 100S)" : stateName(p.jurisdiction), owed: null });
      }
    }
    return list;
  }, [est, isScorp, payments]);
  const paidTo = (jid) => payments.filter(p => p.jurisdiction === jid).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const totalPaid = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

  const today = new Date().toISOString().slice(0, 10);
  const nextDue = FED.QUARTERLY_DUE.find(d => d >= today);

  const [payFor, setPayFor] = useState(null);
  const [payForm, setPayForm] = useState({});
  const savePayment = () => {
    const amt = parseFloat(payForm.amount);
    if (!amt || !payFor) return;
    addItem("taxPayments", {
      id: generateId(), jurisdiction: payFor, date: payForm.date || today,
      amount: amt, taxYear: String(year), note: (payForm.note || "").trim(),
    });
    setPayFor(null); setPayForm({});
  };

  const card = (children, style = {}) => (
    <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1, marginBottom: 10, ...style }}>{children}</div>
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
          {money(totalPaid)} paid · <b style={{ color: est.totalAll - totalPaid > 0 ? T.warning : "#22c55e" }}>{money(Math.max(0, est.totalAll - totalPaid))} remaining</b>
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

      {/* Income by state */}
      {card(<>
        {heading(`Collected income by work state, ${year}`)}
        {Object.entries(income.by).sort((a, b) => b[1] - a[1]).map(([st, amt]) => (
          line(st === "Unassigned" ? "⚠ No work state on contract" : `${st}, ${stateName(st)}`, `${money2(amt)} (${((amt / income.total) * 100).toFixed(0)}%)`, st === "Unassigned" ? { color: T.warning, key: st } : { key: st })
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
      </>)}

      {ready && (<>
        {/* Federal */}
        {card(<>
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
        </>)}

        {/* Resident state */}
        {est.resident && card(<>
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
        </>)}

        {/* Nonresident work states */}
        {est.nonresident.map(n => (
          <div key={n.state}>
            {card(<>
              {heading(`${stateName(n.state)}, nonresident`)}
              {line(`${n.state}-source income`, money2(n.source))}
              {n.modeled
                ? line(`${n.state} tax (${n.label})`, money2(n.owed), { big: true, color: T.warning })
                : notModeled(n.state)}
            </>)}
          </div>
        ))}
      </>)}

      {/* Payments ledger */}
      {card(<>
        {heading("Estimated payments made")}
        {jurisdictions.map(j => {
          const paid = paidTo(j.id);
          const hasEst = ready && j.owed != null;
          const rem = hasEst ? Math.max(0, j.owed - paid) : null;
          return (
            <div key={j.id} style={{ padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>{j.label}</div>
                  <div style={{ fontSize: 12, color: T.textDim, fontVariantNumeric: "tabular-nums" }}>
                    {hasEst
                      ? <>est {money(j.owed)} · paid {money(paid)} · <b style={{ color: rem > 0 ? T.warning : "#22c55e" }}>{money(rem)} left</b></>
                      : <>paid {money(paid)}{ready ? " · no estimate (state model not loaded)" : ""}</>}
                  </div>
                </div>
                <button onClick={() => { setPayFor(j.id); setPayForm({ date: today, amount: "" }); }} style={{
                  padding: "7px 12px", borderRadius: 9, border: "none", backgroundColor: T.accent, color: "#fff",
                  fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0,
                }}>Record</button>
              </div>
              {payments.filter(p => p.jurisdiction === j.id).map(p => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: T.textMuted, paddingLeft: 8, marginTop: 3 }}>
                  <span>{formatDate(p.date)}{p.note ? ` · ${p.note}` : ""}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontVariantNumeric: "tabular-nums" }}>
                    {money2(p.amount)}
                    <button onClick={() => { if (window.confirm("Remove this payment record?")) deleteItem("taxPayments", p.id); }} style={{ padding: "2px 4px", borderRadius: 6, border: "none", backgroundColor: "transparent", color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </>)}

      <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.5, padding: "0 4px 12px" }}>
        Planning estimate. {VERIFIED_NOTE} Assumes revenue-share apportionment, ratio-method nonresident tax, and no PTET election; your CPA's return controls. Colorado at {(CO.FLAT_RATE * 100).toFixed(2)}% flat. Reimbursed travel (expense invoices) is excluded from income; the unreimbursed share of a settled travel expense is deducted instead, and card-import meals are counted at 50%.
      </div>

      <StatementImport open={showImport} onClose={() => setShowImport(false)} />

      <Modal open={!!payFor} onClose={() => setPayFor(null)} title={`Record payment, ${jurisdictions.find(j => j.id === payFor)?.label || ""}`}>
        <Field label="Amount ($)"><input type="number" inputMode="decimal" autoFocus value={payForm.amount || ""} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))} style={iS} /></Field>
        <Field label="Date"><input type="date" value={payForm.date || today} onChange={e => setPayForm(f => ({ ...f, date: e.target.value }))} style={iS} /></Field>
        <Field label="Note"><input value={payForm.note || ""} onChange={e => setPayForm(f => ({ ...f, note: e.target.value }))} style={iS} placeholder="e.g. Q3 1040-ES via EFTPS" /></Field>
        <button onClick={savePayment} style={{ width: "100%", marginTop: 10, padding: "13px", borderRadius: 11, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>Save payment</button>
      </Modal>
    </div>
  );
}

export default memo(TaxPrep);
