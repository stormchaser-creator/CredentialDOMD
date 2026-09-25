import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function AdminControlHistory({ T }) {
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    (async () => {
      try {
        const result = await supabase.from('admin_operations_audit')
          .select('id,created_at,actor_profile_id,target_profile_id,invite_id,action,reason,before_state,after_state')
          .order('created_at', { ascending: false }).order('id', { ascending: false }).range(page * 25, page * 25 + 25);
        if (result.error) throw result.error;
        if (!Array.isArray(result.data)) throw new Error('No audit response was returned.');
        if (active) { setRows(result.data.slice(0, 25)); setMore(result.data.length > 25); }
      } catch (failure) { if (active) setError(failure.message || 'Could not load control history.'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [page, revision]);
  return <><section aria-label="Administrative control history" style={{ color: T.text }}>
    <h3>Control history</h3>
    <p style={{ fontSize: 13, color: T.textMuted }}>Recorded account and invitation access changes from the new controls. Existing lifetime and billing audit records remain in their own ledgers.</p>
    <button disabled={loading} onClick={() => { setPage(0); setRevision(n => n + 1); }}>Refresh history</button>
    {loading ? <p role="status">Loading history…</p> : error ? <p role="alert">Control history is unavailable. {error}</p> : <>
      {!rows.length && <p>No changes recorded on this page.</p>}
      {rows.map(row => <article key={row.id} style={{ marginTop: 12, padding: 12, border: `1px solid ${T.border}`, borderRadius: 8, background: T.card, overflowWrap: 'anywhere' }}>
        <strong>{row.action.replaceAll('_', ' ')}</strong>
        <div style={{ color: T.textMuted, fontSize: 12 }}>{new Date(row.created_at).toISOString()} · UTC</div>
        <p>{row.reason}</p>
        <details><summary>Record details</summary>
          <p>Administrator: {row.actor_profile_id}<br />Account: {row.target_profile_id || '—'}<br />Invitation: {row.invite_id || '—'}</p>
          <div>Before: <code>{JSON.stringify(row.before_state)}</code></div>
          <div>After: <code>{JSON.stringify(row.after_state)}</code></div>
          <div>Receipt: <code>{row.id}</code></div>
        </details>
      </article>)}
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button disabled={page === 0} onClick={() => setPage(n => n - 1)}>Previous</button>
        <span>Page {page + 1}</span><button disabled={!more} onClick={() => setPage(n => n + 1)}>Next</button>
      </div>
    </>}
  </section>
  <SupportViewHistory T={T} /></>;
}

/**
 * Every support view of a member's account and every file opened in it
 * (ticket d45e857c, phase 2), newest first. The same rows each member reads
 * in their own Settings; admins read all of them (RLS).
 */
function SupportViewHistory({ T }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await supabase.from('member_view_events')
          .select('id,created_at,profile_id,actor_profile_id,actor_name,event,reason,document_name,session_id')
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50);
        if (result.error) throw result.error;
        if (active) { setRows(Array.isArray(result.data) ? result.data : []); setError(''); }
      } catch (failure) { if (active) setError(failure?.message || 'Could not load support views.'); }
    })();
    return () => { active = false; };
  }, [revision]);
  return <section aria-label="Support views" style={{ color: T.text, marginTop: 24 }}>
    <h3>Support views</h3>
    <p style={{ fontSize: 13, color: T.textMuted }}>Read-only views of a member&apos;s account that the member allowed, and each file opened. Each member sees their own rows in Settings.</p>
    <button onClick={() => setRevision(n => n + 1)}>Refresh support views</button>
    {error ? <p role="alert">Support views are unavailable. {error}</p> : rows === null ? <p role="status">Loading support views…</p> : <>
      {!rows.length && <p>No support views recorded.</p>}
      {rows.map(row => <article key={row.id} style={{ marginTop: 12, padding: 12, border: `1px solid ${T.border}`, borderRadius: 8, background: T.card, overflowWrap: 'anywhere' }}>
        <strong>{row.event === 'file_opened' ? `file opened: ${row.document_name || 'Document'}` : 'account view started'}</strong>
        <div style={{ color: T.textMuted, fontSize: 12 }}>{new Date(row.created_at).toISOString()} · UTC · {row.actor_name}</div>
        <p>{row.reason}</p>
        <div style={{ fontSize: 12, color: T.textMuted }}>Account: {row.profile_id}<br />Visit: {row.session_id}</div>
      </article>)}
    </>}
  </section>;
}
