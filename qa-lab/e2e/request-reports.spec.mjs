// Owner ticket c3f23aa8 (2026-10-29): a request for references and case logs
// arrives prepared, so one approval sends it. A credentialer asks for both;
// the member's references go in the note and the case log for the asked range
// is attached as a PDF; nothing "follows separately". Synthetic records only.
import { test } from './support/fixtures.mjs';
import { emailBody, labExec, newMember, openMore, row, sleep, stamp, waitFor, waitForEmail, waitForMemberApp } from './support/lab.mjs';
import { AUTH_PASS, DOCS, forwardedText, inbound, inboundRow, intakeModelRoutedLocally, pageText, qaMailbox, scriptReading } from './support/sync-docs-intake-helpers.mjs';

const ASK_REFS = 'Could you send me your references?';
const ASK_LOGS = 'We also need your case logs from 01/2026 to present.';

test('a request for references and case logs arrives prepared and one approval sends both', { tag: ['@INTAKE-005'] }, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Reese', lastName: 'Reports', profession: 'MD' });
  const pid = profile.id;
  labExec(`insert into public.peer_references (user_id, name, degree, institution, relationship, email, phone)
    values ('${pid}', 'Quinn Synthetic', 'MD', 'QA General Hospital', 'Colleague', 'quinn.synthetic@qa.credentialdomd.test', '(555) 010-2233');
    insert into public.case_logs (user_id, category, title, date, role) values
    ('${pid}', 'Cranial', 'QA synthetic case in range', '2026-03-04', 'Primary Surgeon'),
    ('${pid}', 'Spine', 'QA synthetic case before range', '2025-11-20', 'Primary Surgeon');`);

  const requester = qaMailbox('credentialer-reports');
  const ref = `Ref ${stamp('rep')}`;
  const subject = 'Delta Health: references and case logs';
  const body = `Hello Dr. ${user.lastName},\n\n${ASK_REFS} ${ASK_LOGS}\n\nThank you,\nDana Delta\nQA Credentialing Office\n${ref}`;
  if (intakeModelRoutedLocally()) {
    await scriptReading(ref, { intent: 'request', confidence: 'high', summary: 'references and case logs',
      asks: [{ quote: ASK_REFS, kind: 'references', who: 'physician' }, { quote: ASK_LOGS, kind: 'case_logs', who: 'physician' }] });
  }
  await inbound({
    from: `${user.firstName} ${user.lastName} <${user.email}>`, to: [DOCS], subject: `Fwd: ${subject}`,
    text: forwardedText({ fromName: 'Dana Delta', fromAddr: requester, subject, to: `${user.firstName} ${user.lastName} <${user.email}>`, body }),
    headers: AUTH_PASS(),
  });
  const ledger = await inboundRow(`from_addr = '${user.email}' and subject = 'Fwd: ${subject}'`);
  const req = await waitFor('the request row', async () => row(`select id, status from public.document_requests where inbound_ledger_id = '${ledger?.id}'`), { timeoutMs: 30000, intervalMs: 500 });

  await qa.feature('INTAKE-005', 'References and case logs are prepared from the records; Approve sends both', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await openMore(page, 'Requests');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await sleep(1500);
    await page.getByText(subject).first().click();
    await page.getByRole('button', { name: '‹ All requests' }).waitFor({ timeout: 10000 });
    const view = await pageText(page);
    await qa.shot('prepared request');
    qa.check('the request screen says the reports are prepared, not following separately', /prepared from your records/i.test(view) && !/follows? separately/i.test(view), view.slice(0, 400));
    const since = new Date(Date.now() - 1000).toISOString();
    await page.getByRole('button', { name: /^Approve/ }).first().click();
    const sent = await waitForEmail({ to: requester, since }, 60000).catch(() => null);
    qa.check('one email went to the requester', !!sent);
    const full = sent ? await emailBody(sent.id) : null;
    const text = JSON.stringify(full || {});
    qa.check('the note carries the reference', /Quinn Synthetic/.test(text) && /quinn\.synthetic@qa\.credentialdomd\.test/.test(text));
    qa.check('the note does not say anything follows separately', !/follow separately/i.test(text));
    const pdfs = (full?.attachments || []).filter((a) => /\.pdf$/i.test(a.filename || '') && /case/i.test(a.filename || ''));
    qa.check('a case log PDF is attached', pdfs.length === 1, JSON.stringify((full?.attachments || []).map((a) => a.filename)));
    const r = await waitFor('the request replied', async () => { const x = row(`select status from public.document_requests where id = '${req.id}'`); return x?.status === 'replied' ? x : null; }, { timeoutMs: 20000, intervalMs: 500 }).catch(() => null);
    qa.check('the request moved to Replied', r?.status === 'replied');
  });
});
