// The QA lab's sign-in panel, shown where Clerk's <SignIn> would be.
// Pick a test physician, or create one (name + an address on the reserved
// qa.credentialdomd.test domain). No password, no email code: the mock Clerk
// opens a session and the app continues exactly as after a real sign-in.
import { useEffect, useState } from 'react';
import { qaApi } from './qa-clerk.js';

const DOMAIN = 'qa.credentialdomd.test';
const box = { width: '100%', boxSizing: 'border-box', background: '#fff', color: '#1f2933', border: '1px solid #d9dee3', borderRadius: 16, padding: 20, boxShadow: '0 6px 24px rgba(0,0,0,0.06)', fontSize: 14 };
const input = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1px solid #cbd2d9', borderRadius: 10, fontSize: 15, fontFamily: 'inherit', minHeight: 44 };
const button = { padding: '10px 14px', borderRadius: 10, border: '1px solid #0f766e', background: '#0f766e', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', minHeight: 44, fontFamily: 'inherit' };
const ghost = { ...button, background: '#fff', color: '#0f766e' };

export default function QaSignIn({ clerk }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', emailLocal: '', verified: true });

  useEffect(() => {
    let live = true;
    qaApi('/qa/users').then(
      (data) => { if (live) setUsers(data.users); },
      (e) => { if (live) { setError(`The QA lab mock server is not answering: ${e.message}`); setUsers([]); } },
    );
    return () => { live = false; };
  }, []);

  const signIn = async (userId) => {
    setBusy(true); setError('');
    try { await clerk.signInAs(userId); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  const create = async (event) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const local = form.emailLocal.trim().toLowerCase();
      const { user } = await qaApi('/qa/users', { method: 'POST', body: {
        firstName: form.firstName.trim() || 'Test', lastName: form.lastName.trim() || 'Physician',
        ...(local ? { email: `${local}@${DOMAIN}` } : {}), verified: form.verified,
      } });
      await clerk.signInAs(user.id);
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <div data-testid="qa-signin" style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ background: '#fef3c7', color: '#92400e', borderRadius: 6, padding: '2px 8px', fontWeight: 800, fontSize: 12, letterSpacing: '0.04em' }}>QA LAB</span>
        <strong style={{ fontSize: 16 }}>Sign in as a test physician</strong>
      </div>
      <p style={{ margin: '0 0 14px', color: '#52606d', lineHeight: 1.5 }}>
        Local test accounts only, on @{DOMAIN}. No password. This screen exists only in QA-lab builds.
      </p>

      {error && <p role="alert" data-testid="qa-signin-error" style={{ color: '#b91c1c', margin: '0 0 12px' }}>{error}</p>}

      <section aria-label="Test physicians" style={{ marginBottom: 16 }}>
        {users === null ? <p style={{ color: '#52606d' }}>Loading test physicians…</p>
          : users.length === 0 ? <p style={{ color: '#52606d', margin: 0 }}>No test physicians yet. Create one below.</p>
          : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 260, overflowY: 'auto', display: 'grid', gap: 8 }}>
              {users.map((u) => (
                <li key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', border: '1px solid #e4e7eb', borderRadius: 10, padding: '8px 10px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{u.firstName} {u.lastName}</div>
                    <div style={{ color: '#52606d', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}{u.verified ? '' : ' (unverified)'}</div>
                  </div>
                  <button type="button" disabled={busy} style={ghost} data-testid="qa-signin-as" data-email={u.email} data-user-id={u.id} onClick={() => signIn(u.id)}>Sign in</button>
                </li>
              ))}
            </ul>
          )}
      </section>

      <form onSubmit={create} aria-label="Create a test physician" style={{ display: 'grid', gap: 10, borderTop: '1px solid #e4e7eb', paddingTop: 14 }}>
        <strong>Create a test physician</strong>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4 }}>First name<input style={input} data-testid="qa-create-first" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} placeholder="Test" autoComplete="off" /></label>
          <label style={{ display: 'grid', gap: 4 }}>Last name<input style={input} data-testid="qa-create-last" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} placeholder="Physician" autoComplete="off" /></label>
        </div>
        <label style={{ display: 'grid', gap: 4 }}>Email (optional)
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input style={input} data-testid="qa-create-email" value={form.emailLocal} onChange={(e) => setForm({ ...form, emailLocal: e.target.value.replace(/@.*/, '') })} placeholder="generated if blank" autoComplete="off" />
            <span style={{ color: '#52606d', whiteSpace: 'nowrap' }}>@{DOMAIN}</span>
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" data-testid="qa-create-verified" checked={form.verified} onChange={(e) => setForm({ ...form, verified: e.target.checked })} />
          Email address verified
        </label>
        <button type="submit" disabled={busy} style={button} data-testid="qa-create-submit">{busy ? 'Signing in…' : 'Create and sign in'}</button>
      </form>
    </div>
  );
}
