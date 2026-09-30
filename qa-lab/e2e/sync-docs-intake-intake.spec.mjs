// Email intake journeys: what a physician forwards to the app's addresses and
// what the app does with it. The mail arrives through the lab's inbound
// endpoint (stored for the Receiving API, then a Svix-signed email.received to
// email-inbound); every email the functions send is captured by the mock
// Resend. The understanding step's model reading of each forward is scripted
// on the mock Anthropic, matched to that forward's own text; the host's checks
// (every ask must quote the sender, every fact must be in the email) run as
// they do live.
//   * INTAKE-004  the Home request banner: Review, Approve and send, Next
//                 request / Done, "and N more waiting", a self-addressed request;
//   * INTAKE-005  More > Requests: tabs, Refresh, Review in full, reply by email
//                 with chosen documents and an edited note, Dismiss and back,
//                 Ask Vera;
//   * INTAKE-006  the intake-notes banner on Home;
//   * INTAKE-007  intake-note cards: Add + Undo, Edit + Add, Dismiss, Done;
//   * INTAKE-008  the automatic acknowledgement to a requester, on and off;
//   * INTAKE-009  contacts@: a .vcf with two cards becomes two peer references;
//                 the same file again adds nobody twice;
//   * INTAKE-010  support@ (any other address) is relayed to the owner's inbox
//                 with its attachment and reply-to the sender.
import { test } from './support/fixtures.mjs';
import {
  emailBody, emails, goTab, newMember, openMore, profileOf, row, rows, sleep, stamp, syntheticPdf, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import {
  AUTH_PASS, DOCS, addLicense, forwardedText, inbound, inboundRow, intakeModelRoutedLocally, pageText, productAddress, qaMailbox, scriptReading,
  useUpIntakeAllowance, vcards,
} from './support/sync-docs-intake-helpers.mjs';

const BLS_ASK = 'Please send a copy of your current BLS card.';
// The understanding step's model call reaches the lab's mock only when the lab sets
// ANTHROPIC_BASE_URL for the edge runtime (see intakeModelRoutedLocally; the lab does since
// 2026-09-30). On a lab without it every member here has its day's model reads used up first,
// so the product reads each forward with its rules and nothing is sent to any model; what needs
// the model's reading is then recorded blocked.
const MODEL_LOCAL = intakeModelRoutedLocally();
const MODEL_GAP = 'Lab gap: this lab\'s edge runtime has no ANTHROPIC_BASE_URL, so email-inbound\'s understanding step (_shared/intakeModelCall.ts, an Anthropic SDK client with no baseURL) would reach api.anthropic.com; these journeys therefore use up the member\'s model allowance and the forwards are read by the rules, which never offer one tap. qa-lab/lib/functions-env.mjs sets it since 2026-09-30: restart the lab (npm run qa:e2e -- --fresh)';

/** A credentialer's request for the BLS card, forwarded from the physician's own mailbox (its model reading scripted when the lab routes the model to the mock). */
async function forwardRequest(user, { requesterName, requesterAddr, subject, auth = true, ask = BLS_ASK, extra = '' }) {
  const ref = `Ref ${stamp('req')}`;
  const body = `Hello Dr. ${user.lastName},\n\n${ask}\n\n${extra}Thank you,\n${requesterName}\nQA Credentialing Office\n${ref}`;
  if (MODEL_LOCAL) {
    await scriptReading(ref, { intent: 'request', confidence: 'high', summary: 'a request for the BLS card',
      asks: ask === BLS_ASK ? [{ quote: BLS_ASK, kind: 'bls', who: 'physician' }] : [] });
  }
  const res = await inbound({
    from: `${user.firstName} ${user.lastName} <${user.email}>`, to: [DOCS], subject: `Fwd: ${subject}`,
    text: forwardedText({ fromName: requesterName, fromAddr: requesterAddr, subject, to: `${user.firstName} ${user.lastName} <${user.email}>`, body }),
    headers: auth ? AUTH_PASS() : {},
  });
  const ledger = await inboundRow(`from_addr = '${user.email}' and subject = 'Fwd: ${subject.replace(/'/g, "''")}'`);
  const req = row(`select * from public.document_requests where inbound_ledger_id = '${ledger?.id}'`);
  return { res, ledger, req, ref };
}

async function blsMember(page, who) {
  const m = await newMember(page, who);
  if (!MODEL_LOCAL) useUpIntakeAllowance(m.profile.id);
  const { lic, doc } = await addLicense(page, m.profile.id, { type: 'BLS Certification', name: 'QA BLS Card', number: `QA-BLS-${Date.now() % 100000}`, state: null, expires: '2028-08-31',
    file: { name: 'qa-bls-card.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`QA synthetic BLS card ${m.user.id}`) } });
  return { ...m, lic, doc };
}

test('Home request banner: one-tap packet, Review, Next request, a self-addressed request; the requester acknowledgement on and off', {
  tag: ['@INTAKE-004', '@INTAKE-008'],
}, async ({ page, qa }) => {
  const { user, profile, doc } = await blsMember(page, { firstName: 'Harper', lastName: 'Homebanner' });
  qa.check('the BLS card is on file with its document', !!doc?.storage_path);
  const cred1 = qaMailbox('credentialer-one');
  const cred2 = qaMailbox('credentialer-two');
  let r1, r2;

  await qa.feature('INTAKE-008', 'With acknowledgements on, the requester gets one short receipt note that promises nothing', async () => {
    qa.check('acknowledgements are on by default (profiles.ack_requests)', profileOf(user.id).ack_requests === true);
    r1 = await forwardRequest(user, { requesterName: 'Casey Credentialer', requesterAddr: cred1, subject: 'Credentialing file: BLS card needed' });
    qa.check('email-inbound accepted it and wrote a document_requests row with a proposal', !!r1.req?.proposal, `${r1.ledger?.status}: ${(r1.ledger?.detail || '').slice(0, 200)}`);
    const acks = await waitFor('the acknowledgement', async () => { const m = await emails({ to: cred1 }); return m.length ? m : null; }, { timeoutMs: 20000 }).catch(() => []);
    const ack = acks[0] ? await emailBody(acks[0].id) : null;
    qa.check('the requester receives exactly one note', acks.length === 1, `${acks.length}: ${acks.map((a) => a.subject).join(' | ')}`);
    qa.check('it comes from docs@ with the physician\'s name, reply-to the physician', !!ack && /docs@credentialdomd\.com/.test(ack.from) && /Harper/.test(ack.from) && JSON.stringify(ack.reply_to || ack.replyTo || '').includes(user.email), ack ? `${ack.from} reply-to ${JSON.stringify(ack.reply_to || ack.replyTo)}` : 'none');
    qa.check('it promises nothing about what will be sent', !!ack && !/will be sent|will send|attached are|enclosed/i.test(ack.text || ''), (ack?.text || '').slice(0, 300));
    qa.check('document_requests.ack_sent_at is stamped', !!r1.req?.ack_sent_at);
  });

  await qa.feature('INTAKE-004', 'Banner: summary and match; Review opens the request; back', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Home');
    const review = page.getByRole('button', { name: 'Review', exact: true }).first();
    await review.waitFor({ timeout: 30000 }).catch(() => {});
    const text = await pageText(page);
    await qa.shot('request banner');
    qa.check('the banner summarizes the ask and its match (requester, BLS card, 1 document ready)', /Casey Credentialer/.test(text) && /Asked for: BLS card/.test(text) && /1 document ready/.test(text), text.match(/Casey Credentialer.{0,200}/)?.[0]);
    const oneTap = await page.getByRole('button', { name: /^Approve and send/ }).count();
    if (MODEL_LOCAL) {
      qa.check('the banner offers "Approve and send" (every ask matched, read by the model with high confidence)', oneTap > 0);
    } else {
      // Read by the rules: never one tap, and the banner says why (requestPacket oneTapReady).
      qa.check('a keyword reading offers Review, not one tap, and says why', oneTap === 0 && /read by keyword matching, so check the draft before it goes/.test(text));
      qa.blocked('INTAKE-004', `The one-tap path (Approve and send on Home, "Sent to ... with N attachments", Next request / Done) needs the model's reading. ${MODEL_GAP}`);
    }
    await review.click();
    await sleep(1500);
    const req = await pageText(page);
    qa.check('Review opens More > Requests on that request', /‹ All requests/.test(req) && /Credentialing file: BLS card needed/.test(req));
    await goTab(page, 'Home');
  });

  await qa.feature('INTAKE-004', 'A second request: "and 1 more waiting"' + (MODEL_LOCAL ? '; Approve and send; Next request; Done' : ''), async () => {
    r2 = await forwardRequest(user, { requesterName: 'Devon Verifier', requesterAddr: cred2, subject: 'Reappointment: BLS card please' });
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Home');
    const more = page.getByRole('button', { name: /and 1 more waiting/ });
    const hasMore = await more.waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('"and 1 more waiting" is offered', hasMore);
    qa.check('the banner shows the newest request first', /Devon Verifier/.test(await pageText(page)));
    if (hasMore) {
      await more.click();
      await sleep(1000);
      qa.check('it opens the Requests list', /Requests/.test(await pageText(page)) && /(New \(2\))/.test(await pageText(page)), (await pageText(page)).match(/New \(\d+\)/)?.[0]);
      await goTab(page, 'Home');
    }
    if (!MODEL_LOCAL) return;
    const approve = page.getByRole('button', { name: /^Approve and send/ }).first();
    await approve.waitFor({ timeout: 20000 });
    await approve.click();
    const sent = page.getByText(/Sent to .+ with \d+ attachments?\./).first();
    const ok = await sent.waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('sent');
    const line = ok ? await sent.innerText() : '';
    qa.check('the banner says "Sent to <requester> with 1 attachment."', /Sent to .*with 1 attachment\./.test(line) && line.includes(cred2), line);
    const mail = await waitFor('the packet email', async () => {
      for (const m of await emails({ to: cred2 })) { const full = await emailBody(m.id); if ((full.attachments || []).length) return full; }
      return null;
    }, { timeoutMs: 30000 }).catch(() => null);
    qa.check('the requester receives the packet with the BLS card attached', !!mail && mail.attachments.length === 1, mail ? `${mail.subject}: ${mail.attachments.map((a) => a.filename).join(', ')}` : 'none');
    const replied = row(`select status, replied_at, reply_email_id from public.document_requests where id = '${r2.req?.id}'`);
    qa.check('document_requests.status = replied, with the reply email id', replied?.status === 'replied' && !!replied.reply_email_id, JSON.stringify(replied));
    qa.check('a share_log row (method email)', rows(`select id from public.share_log where user_id = '${profile.id}' and method = 'email'`).length >= 1);
    qa.check('a send_reservations row (the hourly cap ledger)', rows(`select id from public.send_reservations where user_id = '${profile.id}'`).length >= 1);
    const next = page.getByRole('button', { name: /Next request \(1 waiting\)/ });
    qa.check('"Next request (1 waiting)" is offered', await next.isVisible().catch(() => false), (await pageText(page)).match(/Next request[^)]*\)|Done/)?.[0]);
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await sleep(800);
      qa.check('the banner moves to the other request, not the one just sent', /Casey Credentialer/.test(await pageText(page)) && !/Devon Verifier/.test((await pageText(page)).slice(0, 2000)));
      await page.getByRole('button', { name: /^Approve and send/ }).first().click();
      await page.getByText(/Sent to .+ with \d+ attachments?\./).first().waitFor({ timeout: 60000 }).catch(() => {});
      const done = page.getByRole('button', { name: 'Done', exact: true });
      qa.check('after the last one, "Done"', await done.isVisible().catch(() => false));
      await done.click().catch(() => {});
      await sleep(800);
      qa.check('no request banner offers a sent request again', !(await page.getByRole('button', { name: /^Approve and send/ }).count()));
    }
  });

  await qa.feature('INTAKE-004', 'A request that names the physician\'s own address as requester is not sent to them (read by the rules)', async () => {
    // Read by the rules, as a forward is once the model is over the day's allowance or unavailable:
    // the path the banner bug below was found and verified on. (Read by the model, with the lab
    // routing it to the mock, the banner said "Requester not found" on 2026-09-30.)
    if (MODEL_LOCAL) useUpIntakeAllowance(profile.id);
    const r3 = await forwardRequest(user, { requesterName: `${user.firstName} ${user.lastName}`, requesterAddr: user.email, subject: 'Self-addressed: BLS card' });
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Home');
    await sleep(2000);
    const text = await pageText(page);
    const shot = await qa.shot('self-addressed banner');
    const bannerLine = text.match(/(Requester not found|\S+ \S+, qa\.credentialdomd\.test) Asked for: BLS card \d+ documents? ready/)?.[0] || text.slice(0, 200);
    const notFound = /Requester not found|Requester's address not found/.test(text);
    qa.check('the banner says the requester was not found (it does not offer to send to yourself)', notFound, bannerLine);
    if (!notFound && new RegExp(`${user.firstName} ${user.lastName}, qa\\.credentialdomd\\.test`).test(text)) {
      qa.bug({
        title: 'Home request banner names the physician as the requester of a request forwarded with their own address as From',
        step: 'Forward to docs@ a request whose forwarded From: line is the physician\'s own name and address; open Home',
        expected: '"Requester not found" (checklist INTAKE-004), as the Requests detail treats it',
        actual: `The banner's requester line reads "${bannerLine}". RequestPacket.js requesterLine returns "Requester not found" only when the row has no from_name (line 104: if (!name && requesterMissing(...))), so a named self-addressed request shows the physician's own name and domain in the slot that says who asked. Nothing is sent to the physician (the send is guarded) and Review asks for the address`,
        severity: 'low', screenshot: shot,
      });
    }
    await page.getByRole('button', { name: 'Review', exact: true }).first().click();
    await sleep(1500);
    const detail = await pageText(page);
    await qa.shot('self-addressed detail');
    qa.check('Review opens it and asks for the requester\'s address instead of sending to the physician', /Requester's email/i.test(detail) && /could not tell who asked|Type their address/.test(detail), detail.match(/Requester's email.{0,160}/i)?.[0] || detail.slice(0, 200));
    await goTab(page, 'Home');
    const approve = page.getByRole('button', { name: /^Approve and send/ }).first();
    const enabled = (await approve.count()) && await approve.isEnabled().catch(() => false);
    if (enabled) await approve.click();
    await sleep(4000);
    const toSelf = [];
    for (const m of await emails({ to: user.email })) { const full = await emailBody(m.id); if ((full.attachments || []).length) toSelf.push(full.subject); }
    qa.check('no packet email went to the physician\'s own address', toSelf.length === 0, toSelf.join(' | '));
    qa.check('the request stays new', row(`select status from public.document_requests where id = '${r3.req?.id}'`)?.status === 'new');
    qa.check('no acknowledgement went to the physician\'s own address from this request', !/ack sent/.test(r3.ledger?.detail || ''), (r3.ledger?.detail || '').slice(0, 160));
  });

  await qa.feature('INTAKE-008', 'Turn acknowledgements off; reload; a new request: nothing goes to the requester', async () => {
    await openMore(page, 'Profile & settings');
    const toggle = page.getByRole('switch', { name: 'Acknowledge document requests automatically' });
    qa.check('the switch reads on', await toggle.getAttribute('aria-checked') === 'true');
    await toggle.click();
    const off = await waitFor('ack_requests false', async () => profileOf(user.id).ack_requests === false || null, { timeoutMs: 15000 }).catch(() => false);
    qa.check('profiles.ack_requests is false', !!off);
    await page.reload();
    await waitForMemberApp(page);
    qa.check('still off after a reload', profileOf(user.id).ack_requests === false);
    const cred4 = qaMailbox('credentialer-four');
    const r4 = await forwardRequest(user, { requesterName: 'Morgan Quiet', requesterAddr: cred4, subject: 'Quiet request: BLS card' });
    qa.check('the request is saved', !!r4.req);
    await sleep(5000);
    const got = await emails({ to: cred4 });
    qa.check('nothing is sent to the requester', got.length === 0, got.map((m) => m.subject).join(' | '));
    qa.check('the ledger says why ("acknowledgements are off")', /acknowledgements are off/.test(r4.ledger?.detail || ''), (r4.ledger?.detail || '').slice(0, 200));
  });
});

test('More > Requests: tabs, refresh, reply by email with chosen documents and an edited note, dismiss and back, Ask Vera', { tag: ['@INTAKE-005'] }, async ({ page, qa }) => {
  const { user, profile } = await blsMember(page, { firstName: 'Rowan', lastName: 'Requests' });
  await addLicense(page, profile.id, { name: 'QA Montana License', number: 'QA-MT-5005', state: 'MT', expires: '2029-07-31',
    file: { name: 'qa-montana-license.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`QA synthetic Montana license ${user.id}`) } });
  const credA = qaMailbox('credentialer-alpha');
  const credB = qaMailbox('credentialer-bravo');
  const rA = await forwardRequest(user, { requesterName: 'Alex Alpha', requesterAddr: credA, subject: 'Alpha Health: BLS card' });
  const rB = await forwardRequest(user, { requesterName: 'Blair Bravo', requesterAddr: credB, subject: 'Bravo Clinic: BLS card' });
  const tabCount = async (name) => Number((new RegExp(`${name} \\((\\d+)\\)`).exec(await pageText(page)) || [])[1] || 0);

  await qa.feature('INTAKE-005', 'Tabs and Refresh; open a request; Review in full; send the reply with two documents and an edited note', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await openMore(page, 'Requests');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await sleep(1500);
    qa.check('New (2)', await tabCount('New') === 2, `${await tabCount('New')}`);
    await page.getByText('Alpha Health: BLS card').first().click();
    await page.getByRole('button', { name: '‹ All requests' }).waitFor({ timeout: 10000 });
    await qa.shot('request detail');
    await page.getByRole('button', { name: 'Review in full' }).click();
    const modal = page.getByRole('dialog', { name: 'Reply by email' });
    await modal.waitFor({ timeout: 10000 });
    const to = modal.locator('input[type="email"]').first(); // the To field
    const prefilled = await waitFor('the To field', async () => (await to.inputValue()).trim() || null, { timeoutMs: 5000, intervalMs: 250 }).catch(() => '');
    qa.check('the To field holds the requester', prefilled.toLowerCase() === credA, prefilled || '(empty)');
    await to.fill(credA);
    // Tick the Montana license as well.
    const montana = modal.locator('label').filter({ hasText: /Montana|qa-montana-license/ }).first();
    if (!(await montana.locator('input').isChecked().catch(() => false))) await montana.click();
    const message = modal.locator('textarea').first();
    await message.fill(`${await message.inputValue()}\n\nQA edited note: both documents attached.`);
    await qa.shot('reply modal');
    await modal.getByRole('button', { name: /^Send \d+ documents?$|^Send$/ }).click();
    await modal.getByText(/Sent to .+ with \d+ attachments?\./).waitFor({ timeout: 60000 }).catch(() => {});
    const mail = await waitFor('the reply', async () => {
      for (const m of await emails({ to: credA })) { const full = await emailBody(m.id); if ((full.attachments || []).length) return full; }
      return null;
    }, { timeoutMs: 30000 }).catch(() => null);
    qa.check('the reply reaches the requester with both documents', !!mail && mail.attachments.length === 2, mail ? mail.attachments.map((a) => a.filename).join(', ') : 'none');
    qa.check('it carries the edited note', !!mail && /QA edited note: both documents attached\./.test(mail.text || mail.html || ''));
    const r = row(`select status, reply_email_id, doc_ids from public.document_requests where id = '${rA.req?.id}'`);
    qa.check('the request moves to replied, with the reply email id', r?.status === 'replied' && !!r.reply_email_id, JSON.stringify(r));
    qa.check('a share_log row for the reply', rows(`select id from public.share_log where user_id = '${profile.id}' and method = 'email'`).length >= 1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '‹ All requests' }).click().catch(() => {});
    await sleep(1000);
    await page.getByRole('button', { name: /^Replied/ }).click();
    qa.check('Replied (1) lists it', await tabCount('Replied') === 1 && /Alpha Health: BLS card/.test(await pageText(page)));
  });

  await qa.feature('INTAKE-005', 'Dismiss, then Move back to New; Ask Vera to build the packet instead', async () => {
    await page.getByRole('button', { name: /^New/ }).click();
    await page.getByText('Bravo Clinic: BLS card').first().click();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await sleep(1500);
    qa.check('the request is dismissed (document_requests.status)', row(`select status from public.document_requests where id = '${rB.req?.id}'`)?.status === 'dismissed');
    await page.getByRole('button', { name: '‹ All requests' }).click().catch(() => {});
    await page.getByRole('button', { name: /^Dismissed/ }).click();
    qa.check('Dismissed (1) lists it', await tabCount('Dismissed') === 1 && /Bravo Clinic: BLS card/.test(await pageText(page)));
    await page.getByText('Bravo Clinic: BLS card').first().click();
    await page.getByRole('button', { name: 'Move back to New' }).click();
    await sleep(1500);
    qa.check('Move back to New restores it', row(`select status from public.document_requests where id = '${rB.req?.id}'`)?.status === 'new');
    await page.getByRole('button', { name: 'Ask Vera to build the packet instead' }).click();
    await sleep(2000);
    const vera = await pageText(page);
    await qa.shot('vera with request');
    qa.check('Vera opens with the request\'s context (requester or subject)', /Vera/.test(vera) && /(Bravo|credentialer-bravo|Bravo Clinic)/i.test(vera), vera.slice(0, 240));
  });
});

test('intake notes: the Home banner, then Add + Undo, Edit + Add, Dismiss and Done on the notes\' cards', { tag: ['@INTAKE-006', '@INTAKE-007'] }, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Noor', lastName: 'Notes' });
  // The rules read these letters (the model allowance is used up first, so no model is asked):
  // an agency's malpractice limits for the physician, stated and asking for nothing, are the
  // one fact the rules enter (intakeFacts.mjs rulesRecords). Forwarded without an
  // Authentication-Results pass, each fact is offered on a card rather than written.
  useUpIntakeAllowance(profile.id);
  const agencies = ['QA Harbor Staffing', 'QA Summit Locums', 'QA Ridge Physicians'];
  const letter = (agency) => `Dr. ${user.lastName},\n\nI checked with our risk team: the ${agency} malpractice policy covers the emergency care you give while you are on an assignment with us.\n\nThe limits are $1,000,000 per incident and $3,000,000 aggregate, as set out in Section 7.2 of your professional services agreement.\n\nJordan Sample`;
  const notes = () => rows(`select id, sender, summary, verified, status, items from public.intake_proposals where user_id = '${profile.id}' order by created_at`);
  const forward = async (agency, i) => {
    const subject = `Your malpractice coverage with ${agency}`;
    await inbound({ from: `${user.firstName} ${user.lastName} <${user.email}>`, to: [DOCS], subject: `Fwd: ${subject}`,
      text: forwardedText({ fromName: 'Jordan Sample', fromAddr: qaMailbox(`jordan-sample-${i}`), subject, body: letter(agency) }) });
    return inboundRow(`from_addr = '${user.email}' and subject = 'Fwd: ${subject}'`);
  };

  await qa.feature('INTAKE-006', 'Informational forwards: the newest note on Home, and Review opens Requests', async () => {
    const ledgers = [];
    for (const [i, agency] of agencies.entries()) ledgers.push(await forward(agency, i));
    const list = notes();
    qa.check('each forward is entered as a note (inbound_emails done, read as informational)', ledgers.every((l) => l?.status === 'done' && /informational/.test(l.detail || '')), ledgers.map((l) => `${l?.status}: ${(l?.detail || '').slice(0, 110)}`).join(' || '));
    qa.check('three intake_proposals rows, not verified, status new, each offering the insurance fact', list.length === 3 && list.every((n) => n.verified === false && n.status === 'new' && (n.items || []).some((it) => it.kind === 'record' && it.state === 'proposed')),
      list.map((n) => `${n.sender} | ${n.summary} | ${(n.items || []).map((it) => `${it.kind}:${it.section || ''}:${it.state}`).join(', ')}`).join(' || '));
    const mailed = (await emails({ to: user.email })).filter((m) => /malpractice coverage with QA/i.test(m.subject));
    qa.check('nobody was emailed about them (not the sender, not the physician)', mailed.length === 0, mailed.map((m) => m.subject).join(' | '));
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Home');
    const headline = page.getByText(/From Jordan Sample/).first();
    const shown = await headline.waitFor({ timeout: 30000 }).then(() => true, () => false);
    const home = await pageText(page);
    await qa.shot('intake banner');
    qa.check('Home shows the newest note ("From Jordan Sample: ...") and "and 2 more"', shown && /QA Ridge Physicians/.test(home.match(/From Jordan Sample.{0,160}/)?.[0] || '') && /and 2 more/.test(home), home.match(/From Jordan Sample.{0,160}/)?.[0]);
    await page.getByRole('button', { name: 'Review', exact: true }).first().click();
    await sleep(1500);
    const req = await pageText(page);
    qa.check('Review opens More > Requests, where every note is listed', /Requests/.test(req) && agencies.every((a) => req.includes(a)));
  });

  await qa.feature('INTAKE-007', 'Add then Undo; Edit then Add; Dismiss; Done', async () => {
    // One note card per letter; each holds one offered fact.
    const card = (agency) => page.locator('div').filter({ hasText: new RegExp(`From Jordan Sample.*${agency}`) }).filter({ has: page.getByRole('button', { name: /^(Add|Undo|Done|Dismiss)$/ }) }).last();
    const insuranceRows = () => rows(`select id, name, provider, coverage_per_claim, coverage_aggregate from public.insurance where user_id = '${profile.id}'`);
    // 1. Add, then Undo.
    const first = card(agencies[0]);
    await first.getByRole('button', { name: 'Add', exact: true }).click();
    const added = await waitFor('the insurance record', async () => insuranceRows().find((r) => /QA Harbor Staffing/.test(`${r.name} ${r.provider}`)) || null, { timeoutMs: 20000 }).catch(() => null);
    qa.check('Add enters the record through the app (insurance: provider, $1,000,000 / $3,000,000)', !!added && String(added.coverage_per_claim).replace(/\D/g, '') === '1000000' && String(added.coverage_aggregate).replace(/\D/g, '') === '3000000', JSON.stringify(added));
    const dialogs = qa.report.dialogs.length;
    await first.getByRole('button', { name: 'Undo' }).click();
    await sleep(2500);
    qa.check('Undo asks first', qa.report.dialogs.length > dialogs, qa.report.dialogs.slice(dialogs).join(' | ') || 'no confirm');
    qa.check('Undo removes the record', !!added && !row(`select id from public.insurance where id = '${added.id}'`));
    // 2. Edit, then Add.
    const second = card(agencies[1]);
    await second.getByRole('button', { name: 'Edit', exact: true }).click();
    const nameInput = second.locator('label', { hasText: /^Name/ }).locator('input').first();
    const hasName = await nameInput.count();
    if (hasName) await nameInput.fill('QA Summit Locums malpractice (edited)');
    await second.getByRole('button', { name: 'Add', exact: true }).first().click();
    const edited = await waitFor('the edited record', async () => insuranceRows().find((r) => /QA Summit Locums/.test(`${r.name} ${r.provider}`)) || null, { timeoutMs: 20000 }).catch(() => null);
    qa.check('Edit then Add enters the record with the edit', !!edited && (!hasName || /\(edited\)/.test(edited.name || '')), JSON.stringify(edited));
    // 3. Dismiss.
    const third = card(agencies[2]);
    await third.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await sleep(2000);
    qa.check('Dismiss enters nothing', !insuranceRows().some((r) => /QA Ridge Physicians/.test(`${r.name} ${r.provider}`)));
    await qa.shot('notes after answers');
    const states = notes().map((n) => (n.items || []).filter((i) => i.kind === 'record').map((i) => i.state).join('+'));
    qa.check('each card\'s state is recorded on its note (undone, added, dismissed)', states.join(',') === 'undone,added,dismissed', states.join(', '));
    const corrections = rows(`select action from public.intake_corrections where user_id = '${profile.id}'`);
    qa.check('the answers are recorded as intake corrections', corrections.length >= 1, corrections.map((c) => c.action).join(', '));
    // 4. Done on each.
    let dones = 0;
    for (let i = 0; i < 3; i++) {
      const done = page.getByRole('button', { name: 'Done', exact: true }).first();
      if (!(await done.isVisible().catch(() => false))) break;
      await done.click();
      dones++;
      await sleep(1500);
    }
    qa.check('each answered note offers Done', dones === 3, `${dones}`);
    const after = notes().map((n) => n.status);
    qa.check('Done clears every note (status no longer new)', after.every((s2) => s2 !== 'new'), after.join(', '));
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Home');
    qa.check('the Home banner no longer shows them', !(await page.getByText(/From Jordan Sample/).count()));
  });
});

test('contacts@ turns a shared .vcf into peer references once; support@ is relayed to the owner with its file and reply-to the sender', {
  tag: ['@INTAKE-009', '@INTAKE-010'],
}, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Cody', lastName: 'Contacts' });
  const people = [
    { first: 'Avery', last: 'Colleague', org: 'QA Teaching Hospital', title: 'Neurosurgeon', email: qaMailbox('avery'), phone: '+1 555 010 0001' },
    { first: 'Blake', last: 'Mentor', org: 'QA University', title: 'Program Director', email: qaMailbox('blake'), phone: '+1 555 010 0002' },
  ];
  const vcf = Buffer.from(vcards(people));
  const send = (subject) => inbound({ from: `${user.firstName} ${user.lastName} <${user.email}>`, to: [productAddress('contacts')], subject, text: 'Two contacts for my references.',
    headers: AUTH_PASS(), attachments: [{ filename: 'qa-contacts.vcf', content_type: 'text/vcard', content: vcf.toString('base64') }] });

  await qa.feature('INTAKE-009', 'Email a .vcf with two cards to contacts@; the reply names them; resend adds nobody twice', async () => {
    await send('QA contacts one');
    const refs = await waitFor('two peer references', async () => { const r = rows(`select name, relationship, notes from public.peer_references where user_id = '${profile.id}'`); return r.length >= 2 ? r : null; }, { timeoutMs: 30000 }).catch(() => rows(`select name, relationship, notes from public.peer_references where user_id = '${profile.id}'`));
    qa.check('one peer_references row per card, relationship "Other", a note saying where it came from', refs.length === 2 && refs.every((r) => r.relationship === 'Other' && /email|contacts@|shared|vcf|card/i.test(r.notes || '')), JSON.stringify(refs).slice(0, 300));
    const ledger = await inboundRow(`from_addr = '${user.email}' and subject = 'QA contacts one'`);
    qa.check('inbound_emails row (route contacts)', ledger?.route === 'contacts', `${ledger?.route} ${ledger?.status}`);
    const reply = await waitFor('the reply', async () => (await emails({ to: user.email })).find((m) => /contacts one/i.test(m.subject)) || null, { timeoutMs: 20000 }).catch(() => null);
    const replyText = reply ? (await emailBody(reply.id)).text || '' : '';
    qa.check('the reply names who was added', /Avery Colleague/.test(replyText) && /Blake Mentor/.test(replyText), replyText.slice(0, 240));
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Credentials');
    await page.getByRole('navigation').filter({ hasText: 'Active Credentials' }).getByRole('button', { name: /Peer References/ }).first().click();
    const shown = await pageText(page);
    qa.check('Credentials > Peer References lists both', /Avery Colleague/.test(shown) && /Blake Mentor/.test(shown));
    await send('QA contacts two');
    await inboundRow(`from_addr = '${user.email}' and subject = 'QA contacts two'`);
    await sleep(2000);
    const again = rows(`select name from public.peer_references where user_id = '${profile.id}'`);
    const reply2 = (await emails({ to: user.email })).find((m) => /contacts two/i.test(m.subject));
    const reply2Text = reply2 ? (await emailBody(reply2.id)).text || '' : '';
    qa.check('sending the same file again adds nobody twice (or the reply says they are on file)', again.length === 2 || /already/i.test(reply2Text), `${again.length} rows; reply: ${reply2Text.slice(0, 160)}`);
    if (again.length > 2 && !/already/i.test(reply2Text)) {
      qa.bug({
        title: 'contacts@: the same contact card sent twice creates duplicate peer references',
        step: 'Email the same .vcf (two cards) to contacts@ twice from a confirmed, authenticated address',
        expected: 'Two peer references, and the second reply says they are already on file',
        actual: `${again.length} peer_references rows (${again.map((r) => r.name).join(', ')}); the second reply: "${reply2Text.slice(0, 160)}". email-inbound handleContacts inserts one row per card without looking for the person already on file`,
        severity: 'low',
      });
    }
  });

  await qa.feature('INTAKE-010', 'A labelled QA message with a small PDF to support@ reaches the owner\'s inbox', async () => {
    const sender = qaMailbox('support-visitor');
    const subject = `QA lab relay check ${stamp()}`;
    await inbound({ from: `QA Visitor <${sender}>`, to: [productAddress('support')], subject, text: 'QA lab test message. Please ignore: this checks the support@ relay in the lab.',
      headers: AUTH_PASS(), attachments: [{ filename: 'qa-support-attachment.pdf', content_type: 'application/pdf', content: syntheticPdf('QA synthetic support attachment').toString('base64') }] });
    const ledger = await inboundRow(`from_addr = '${sender}'`);
    qa.check('inbound_emails row with the relay route (forward), done', ledger?.route === 'forward' && ledger.status === 'done', `${ledger?.route} ${ledger?.status} ${(ledger?.detail || '').replace(/\S+@\S+/g, '<owner>').slice(0, 120)}`);
    const relay = await waitFor('the relay', async () => (await emails({ subject })).find((m) => m.subject.startsWith('[credentialdomd.com support]')) || null, { timeoutMs: 20000 }).catch(() => null);
    const full = relay ? await emailBody(relay.id) : null;
    qa.check('the owner inbox receives "[credentialdomd.com support] <subject>"', !!full && full.subject === `[credentialdomd.com support] ${subject}`, full?.subject || 'none');
    qa.check('it goes to the owner, not back to the sender', !!full && (Array.isArray(full.to) ? full.to : [full.to]).length === 1 && !JSON.stringify(full.to).includes(sender));
    qa.check('with the attachment', !!full && (full.attachments || []).some((a) => a.filename === 'qa-support-attachment.pdf'), (full?.attachments || []).map((a) => a.filename).join(', '));
    qa.check('reply-to is the original sender', !!full && JSON.stringify(full.reply_to || full.replyTo || '').includes(sender), JSON.stringify(full?.reply_to || full?.replyTo));
    qa.check('the original headers are in the body', !!full && (full.text || '').includes(sender) && (full.text || '').includes(subject));
    qa.blocked('INTAKE-010', 'Replying from the owner\'s inbox is the owner\'s mail client (outside the app); the lab checks the relay\'s reply-to instead');
  });
});
