import { useEffect, useRef, useState } from 'react';
import { Modal } from '../shared';
import { adminControlRequest, submitAdminControl } from '../../utils/adminControls';
import { supabase } from '../../lib/supabase';

export default function AdminAccessChange({ change, T, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const pending = useRef(null);
  const mounted = useRef(true);
  const reasonRef = useRef(null);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const previous = typeof document !== 'undefined' ? document.activeElement : null;
    const input = reasonRef.current;
    input?.focus();
    const dialog = input?.closest('[role="dialog"]');
    const trap = event => {
      if (event.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener('keydown', trap);
    return () => { mounted.current = false; dialog?.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus(); };
  }, []);
  const title = change.action === 'remove' ? 'Remove invitation' : change.status === 'revoked' ? 'Pause app access' : change.status === 'pending' ? 'Return account to pending' : change.kind === 'invite' ? 'Restore invitation' : 'Approve app access';
  const save = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (!pending.current) {
        const requestId = crypto.randomUUID();
        adminControlRequest(change, reason, requestId);
        pending.current = { change: { ...change, row: { ...change.row } }, reason: reason.trim(), requestId };
        setSubmitted(true);
      }
      const reviewed = pending.current;
      const receipt = await submitAdminControl(supabase, reviewed.change, reviewed.reason, reviewed.requestId);
      if (mounted.current) { onSaved(receipt); onClose(); }
    } catch (failure) { if (mounted.current) setError(failure.message || 'Could not save this change.'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  return <Modal open onClose={() => { if (!inFlight.current) onClose(); }} title={title}>
    <div style={{ color: T.text, fontSize: 14, lineHeight: 1.5 }}>
      <p><strong>{change.row.name || change.row.email || 'Account'}</strong><br />{change.row.email}</p>
      <p>{change.action === 'remove' ? 'This removes an unclaimed invitation.' : `App access will change from ${change.row.access_status || change.row.status} to ${change.status}.`}</p>
      <p style={{ color: T.textMuted }}>This changes the app access gate. Membership entitlement is checked separately. It does not cancel billing, issue a refund, or grant lifetime membership.</p>
      <label htmlFor="admin-control-reason" style={{ display: 'block', fontWeight: 700 }}>Reason for this change</label>
      <textarea ref={reasonRef} id="admin-control-reason" value={reason} onChange={event => setReason(event.target.value)} disabled={busy || submitted} minLength={10} maxLength={500} rows={4} style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, padding: 10, borderRadius: 8, background: T.input, color: T.text, border: `1px solid ${T.border}` }} />
      <p style={{ color: T.textMuted, fontSize: 12 }}>Use 10–500 characters. The reason and before/after state are recorded in Control history. Do not include passwords or clinical details.</p>
      {submitted && error && <p>Retry sends the same reviewed change and reason. If this record has changed, close this dialog and refresh the section before reviewing a new change.</p>}
      {error && <p role="alert" style={{ color: T.danger || '#ef4444' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || reason.trim().length < 10} onClick={save} style={{ padding: '8px 12px', background: T.accent, color: '#fff', border: 0, borderRadius: 8 }}>{busy ? 'Saving…' : `Confirm: ${title.toLowerCase()}`}</button>
      </div>
    </div>
  </Modal>;
}
