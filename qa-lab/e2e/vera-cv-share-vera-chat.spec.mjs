// Vera's conversation features: a packet built from a credentialing request
// and sent by email (real attachments, from the lab's mock Resend) or through
// the share sheet, the reference-list draft, feedback that becomes a ticket,
// dictation, new chat and archived chats, the source-check line under an
// answer, and Vera on the member's own Anthropic key.
//
// Vera's model is the lab's mock AI (scripted per question). The phone's share
// sheet, clipboard and speech recognition are stand-ins that record what the
// app hands them. The member's own Anthropic key is a lab-generated fake and
// api.anthropic.com is answered by the lab's mock Anthropic.
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, emailBody, goTab, newMember, openMore, pendingOps, row, rows, sleep, syntheticPdf, waitFor, waitForEmail, waitForMemberApp,
} from './support/lab.mjs';
import {
  actionCard, addRecord, answerAnthropicFromMock, askVera, attachToRecord, cardDone, day, deviceLog, installDeviceStandIns, openVera, runTag,
  shareLog, veraBox, waitForDocument,
} from './support/vera-cv-share-helpers.mjs';

/** A stand-in for the browser's speech recognition: every start() hears `transcript`. */
async function installFakeSpeech(context, transcript) {
  await context.addInitScript((heard) => {
    class FakeRecognition {
      start() {
        window.__qaSpeechStarts = (window.__qaSpeechStarts || 0) + 1;
        setTimeout(() => {
          const result = [{ transcript: heard }];
          result.isFinal = true;
          this.onresult?.({ resultIndex: 0, results: [result] });
        }, 300);
      }
      stop() { setTimeout(() => this.onend?.(), 50); }
      abort() { this.stop(); }
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
  }, transcript);
}

test('Vera sends a packet by email and by the share sheet; sign-out has nothing unsynced', {
  tag: ['@VERA-003'],
}, async ({ page, context, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  await installDeviceStandIns(context);
  const { profile, user } = await newMember(page, { firstName: 'Paige', lastName: 'Packet' });
  const pid = profile.id;
  const tag = runTag();
  const recipient = `credentialing-${tag.toLowerCase()}@${LAB_EMAIL_DOMAIN}`;

  await qa.feature('VERA-003', 'Vera builds a packet from a request; Reply by email and Approve (share sheet)', async () => {
    // What the request asks for: a license and a DEA registration, each with its copy.
    await addRecord(page, 'Licenses', { Type: 'State Medical License', 'Display Name': 'QA Colorado Medical License', 'License #': `QA-CO-${tag.slice(-5)}`, State: 'CO', Expires: day(400) }, { dialogName: 'Add' });
    await addRecord(page, 'Licenses', { Type: 'DEA Registration', 'License #': `QA-DEA-${tag.slice(-5)}`, State: 'CO', Expires: day(500) }, { dialogName: 'Add' });
    await attachToRecord(page, 'Licenses', `QA-CO-${tag.slice(-5)}`, { name: `qa-co-license-${tag}.pdf`, mimeType: 'application/pdf', buffer: syntheticPdf(`QA synthetic CO license ${tag}`) });
    await attachToRecord(page, 'Licenses', `QA-DEA-${tag.slice(-5)}`, { name: `qa-dea-${tag}.pdf`, mimeType: 'application/pdf', buffer: syntheticPdf(`QA synthetic DEA registration ${tag}`) });
    const lic = row(`select id from public.licenses where user_id = '${pid}' and license_number = 'QA-CO-${tag.slice(-5)}'`);
    const dea = row(`select id from public.licenses where user_id = '${pid}' and license_number = 'QA-DEA-${tag.slice(-5)}'`);
    const licDoc = lic && await waitForDocument(pid, `qa-co-license-${tag}.pdf`, { linked: lic.id });
    const deaDoc = dea && await waitForDocument(pid, `qa-dea-${tag}.pdf`, { linked: dea.id });
    qa.check('the license and DEA copies are on file', !!licDoc && !!deaDoc);
    if (!licDoc || !deaDoc) return;
    // A fresh load, as the next visit: the files come back to the device from Storage.
    await page.reload();
    await waitForMemberApp(page);

    await openVera(page);
    const cover = `Dr. Paige Packet\nEnclosed: Colorado medical license\nEnclosed: DEA registration\nBoard certificate to follow`;
    const packet = (summary) => ({ kind: 'send_packet', summary, docIds: [licDoc.id, deaDoc.id], coverNote: cover, missing: ['Board certificate'] });
    const shown = await askVera(page, `QA ${tag} send my license and DEA to ${recipient} and they also want my board certificate`, {
      reply: `QA ${tag}: found your Colorado license and DEA registration. Missing: board certificate.`,
      actions: [packet(`Send 2 documents to QA credentialing ${tag}`)],
    });
    await qa.shot('send packet card');
    qa.check('Vera answers with a send-packet card', shown);
    const card = actionCard(page, `Send 2 documents to QA credentialing ${tag}`);
    qa.check('the card counts 2 documents', /Send packet · 2 documents/i.test(await card.card.innerText().catch(() => '')));
    qa.check('the missing item is listed', /Missing from your file: Board certificate/.test(await card.card.innerText().catch(() => '')));

    // Reply by email: the documents go as real attachments from CredentialDOMD.
    await card.replyByEmail.click();
    const modal = page.getByRole('dialog', { name: /Email with attachments|Reply by email/ });
    await modal.waitFor({ timeout: 10000 });
    await modal.locator('label', { hasText: /^To$/ }).first().locator('xpath=..').locator('input').fill(recipient);
    const modalText = await modal.innerText();
    qa.check('the email sheet has both documents ticked', /2 of \d+ selected/.test(modalText), modalText.match(/\d+ of \d+ selected[^\n]*/)?.[0]);
    qa.check('it says replies go to the physician', modalText.includes(user.email), modalText.slice(0, 200));
    await qa.shot('email packet sheet');
    const since = new Date().toISOString();
    await modal.getByRole('button', { name: /^Send 2 documents$/ }).click();
    const sent = await modal.getByText(/Sent to .* with 2 attachments/).waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('the sheet confirms "Sent ... with 2 attachments"', sent, (await modal.innerText().catch(() => '')).slice(-300));
    const mail = await waitForEmail({ to: recipient, since }, 30000).catch(() => null);
    const full = mail ? await emailBody(mail.id) : null;
    qa.check('the email reached the (mock) inbox', !!mail);
    qa.check('it carries both files as attachments', (full?.attachments || []).length === 2, JSON.stringify((full?.attachments || []).map((a) => a.filename)));
    qa.check('it replies to the physician and comes from CredentialDOMD', JSON.stringify(full?.reply_to || full?.replyTo || '').includes(user.email) && /credentialdomd/i.test(full?.from || ''), `${full?.from} reply_to ${JSON.stringify(full?.reply_to || full?.replyTo)}`);
    qa.check('the cover note is in the email', (full?.text || '').includes('Enclosed: DEA registration'), (full?.text || '').slice(0, 300));
    if (mail) await modal.getByRole('button', { name: 'Done' }).click().catch(() => {});
    qa.check('the card says it was emailed', await page.getByText(`Emailed to ${recipient}`).first().isVisible().catch(() => false));
    const emailed = shareLog(pid).find((r) => r.method === 'email');
    qa.check('share_log has the email send', !!emailed && emailed.recipient === recipient, JSON.stringify(emailed));

    // Approve on a second card: the phone's share sheet gets the files.
    const mark = qa.report.console.length;
    await askVera(page, `QA ${tag} share the same two with the agency from my phone`, {
      reply: `QA ${tag}: here is the same packet for your share sheet.`,
      actions: [packet(`Share 2 documents with the agency ${tag}`)],
    });
    await actionCard(page, `Share 2 documents with the agency ${tag}`).approve.click();
    await sleep(3000);
    const log = await deviceLog(page);
    const share = log.shared.at(-1);
    qa.check('the share sheet received both files', (share?.files || []).length === 2 && share.files.every((f) => f.type === 'application/pdf' && f.head === '%PDF-'), JSON.stringify(share?.files));
    qa.check('the cover note is on the clipboard', (log.clipboard.at(-1) || '').includes('Enclosed: Colorado medical license'), (log.clipboard.at(-1) || '').slice(0, 200));
    qa.check('the card turns done', await cardDone(page, 'Send packet · 2 documents'));
    const vera = await waitFor('the Vera packet share_log row', async () => shareLog(pid).find((r) => /^Vera packet/.test(r.item_name || '')) || null, { timeoutMs: 10000 }).catch(() => null);
    const queued = await pendingOps(page);
    const warnings = qa.report.console.slice(mark).filter((l) => /Failed to insert shareLog|shareLog/.test(l));
    qa.check('a share_log row "Vera packet (2 files)" is written', !!vera, JSON.stringify(shareLog(pid)).slice(0, 400));
    qa.check('no write is left queued', queued.length === 0, JSON.stringify(queued).slice(0, 400));
    if (!vera) {
      qa.bug({
        title: 'Vera packet shared through the share sheet is never logged: the share_log insert is refused, queued and refused on every load',
        step: 'More > Vera: ask for a packet; Approve the send-packet card (share sheet)',
        expected: 'A share_log row "Vera packet (2 files)" (method share, section documents, sent_at) and nothing queued',
        actual: `No row; the write is queued (${queued.length} pending op(s)) and the console says ${JSON.stringify(warnings.slice(0, 2)).slice(0, 300)}. AssistantSection.jsx:486-490 adds { itemName, method, sharedAt, recipient }: share_log has no shared_at column and section is NOT NULL, so PostgREST refuses the row. Fixed on fix/qa-docs-vera-intake and release/qa1 (c2e5c7ad)`,
        severity: 'medium',
      });
    }

    // Sign out: the app warns about anything that has not reached the cloud.
    const dialogs = qa.report.dialogs.length;
    qa.onDialog(() => 'dismiss');
    await goTab(page, 'More');
    await page.getByRole('button', { name: /Sign Out/ }).first().click();
    await sleep(2000);
    const prompts = qa.report.dialogs.slice(dialogs);
    await qa.shot('sign out');
    qa.check('Sign out does not warn about unsynced changes', !prompts.some((p) => /not reached the cloud|not synced/i.test(p)), prompts.join(' | '));
    qa.onDialog(null);
  }, { soft: true });
});

test('Vera: reference draft, feedback ticket, dictation, archived chats, source line, own Anthropic key', {
  tag: ['@VERA-006', '@VERA-008', '@VERA-009', '@VERA-010', '@VERA-012', '@VERA-013'],
}, async ({ page, context, qa }) => {
  test.setTimeout(9 * 60 * 1000);
  await installDeviceStandIns(context);
  await installFakeSpeech(context, 'QA dictated which licenses expire this year');
  const { profile } = await newMember(page, { firstName: 'Quinn', lastName: 'Conversation' });
  const pid = profile.id;
  const tag = runTag();

  await qa.feature('VERA-006', 'Reference draft: on-device contacts, an exclusion honoured, copy, dismiss', async () => {
    const people = [
      ['QA Alice Ref', 'alice.ref@qa.credentialdomd.test', '(555) 010-0001'],
      ['QA Bruno Ref', 'bruno.ref@qa.credentialdomd.test', '(555) 010-0002'],
      ['QA Chen Ref', 'chen.ref@qa.credentialdomd.test', '(555) 010-0003'],
    ];
    for (const [name, email, phone] of people) {
      await addRecord(page, 'Peer References', { 'Full Name': name, 'Degree/Credential': 'MD', Specialty: 'Neurosurgery', 'Institution/Hospital': 'QA Mercy Hospital', Relationship: 'Colleague/Peer', Email: email, Phone: phone });
    }
    const refs = rows(`select id, name, email from public.peer_references where user_id = '${pid}' order by name`);
    qa.check('three references on file', refs.length === 3, JSON.stringify(refs.map((r) => r.name)));
    if (refs.length !== 3) return;
    const [alice, bruno, chen] = refs;
    await openVera(page);
    await askVera(page, `QA ${tag} draft my reference list but leave out Chen`, {
      reply: `QA ${tag}: here is a draft with two references. Review it before you send it from your email.`,
      actions: [{ kind: 'draft_references', referenceIds: [alice.id, bruno.id], excludedReferenceIds: [chen.id] }],
    });
    const card = page.getByRole('region', { name: 'Reference draft' }).last();
    await card.waitFor({ timeout: 15000 });
    const draft = await card.getByLabel('Draft text').innerText().catch(() => '');
    await qa.shot('reference draft');
    qa.check('the draft uses the saved contact details of the two included', draft.includes('alice.ref@qa.credentialdomd.test') && draft.includes('(555) 010-0002'), draft.slice(0, 300));
    qa.check('the excluded reference is not in the draft', !draft.includes('Chen'), draft.slice(0, 300));
    qa.check('contact details never went to the model', !JSON.stringify(rows(`select question from public.assistant_log where user_id = '${pid}'`)).includes('alice.ref@'));
    await card.getByRole('button', { name: 'Copy draft' }).click();
    await sleep(500);
    const copied = (await deviceLog(page)).clipboard.at(-1) || '';
    qa.check('Copy puts the draft on the clipboard and says "Copied."', copied.includes('bruno.ref@qa.credentialdomd.test') && await card.getByText('Copied.').isVisible().catch(() => false), copied.slice(0, 120));
    qa.check('the card says nothing has been sent', /Nothing has been sent/.test(await card.innerText()));
    qa.check('Vera\'s reply does not claim a send', !/\b(sent|emailed)\b/i.test((await page.getByText(`QA ${tag}: here is a draft`).first().innerText()).replace(/before you send it/, '')));
    await card.getByRole('button', { name: 'Dismiss' }).click();
    qa.check('Dismiss removes the card', !(await page.getByRole('region', { name: 'Reference draft' }).count()));
  }, { soft: true });

  await qa.feature('VERA-008', 'Feedback card becomes a ticket; File a ticket opens Support', async () => {
    await openVera(page);
    const before = rows(`select id from public.support_tickets where user_id = '${pid}'`).length;
    await askVera(page, `QA ${tag} this is a bug: the QA lab renewal banner overlaps the menu`, {
      reply: `QA ${tag}: that sounds like a layout bug. Approve the card and it goes to the developer.`,
      actions: [{ kind: 'feedback', summary: `QA ${tag} renewal banner overlaps the menu`, category: 'bug', text: 'The QA lab renewal banner overlaps the menu on the phone.' }],
    });
    await actionCard(page, `QA ${tag} renewal banner overlaps the menu`).approve.click();
    qa.check('the feedback card turns done', await cardDone(page, 'Feedback for the developer'));
    const ticket = await waitFor('the ticket', async () => row(`select subject, category, priority, context_page, body from public.support_tickets where user_id = '${pid}' and subject like '%${tag}%'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('a support_tickets row (bug, high, from the assistant)', ticket?.category === 'bug' && ticket?.context_page === 'assistant', JSON.stringify(ticket));
    qa.check('exactly one new ticket', rows(`select id from public.support_tickets where user_id = '${pid}'`).length === before + 1);
    await page.getByRole('button', { name: 'File a ticket' }).click();
    // The Support sheet (SupportModal) is a bottom sheet without a dialog role: its New ticket form.
    const summary = page.getByPlaceholder('Short summary (optional)');
    const opened = await summary.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('file a ticket');
    qa.check('"File a ticket" opens the Support sheet (New ticket form)', opened && await page.getByRole('button', { name: 'Send ticket' }).isVisible().catch(() => false));
    await page.keyboard.press('Escape').catch(() => {});
    if (await summary.isVisible().catch(() => false)) await page.mouse.click(5, 5);
    await summary.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }, { soft: true });

  await qa.feature('VERA-009', 'Dictation fills the question; a browser without speech says so', async () => {
    await openVera(page);
    await veraBox(page).fill('');
    // The mic is named "Dictate" (43341dc1); while it listens it is pressed and shows ◼.
    await page.getByRole('button', { name: 'Dictate', exact: true, pressed: false }).click();
    const filled = await waitFor('the transcript', async () => ((await veraBox(page).inputValue()).includes('QA dictated') ? true : null), { timeoutMs: 5000 }).catch(() => false);
    await page.getByRole('button', { name: 'Dictate', exact: true, pressed: true }).click().catch(() => {});
    qa.check('the transcript fills the input', !!filled, await veraBox(page).inputValue());
    await veraBox(page).fill('');
    // Now a browser with no speech recognition at all.
    await page.evaluate(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
    await page.getByRole('button', { name: 'Dictate', exact: true }).click();
    const msg = await page.getByText('Use the mic key on your keyboard to dictate here.').waitFor({ timeout: 5000 }).then(() => true, () => false);
    await qa.shot('no speech support');
    qa.check('without speech support a message says what to do', msg);
  }, { soft: true });

  await qa.feature('VERA-010', 'New chat, archived chats: view, continue, back, delete', async () => {
    await openVera(page);
    // Put the earlier conversation away first, so the next archive holds only this chat.
    if (await page.getByRole('button', { name: 'New chat' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'New chat' }).click();
    const firstQuestion = `QA ${tag} archive me first`;
    await askVera(page, firstQuestion, { reply: `QA ${tag}: first chat answer.`, actions: [] });
    await page.getByRole('button', { name: 'New chat' }).click();
    await sleep(500);
    qa.check('New chat clears the conversation', !(await page.getByText(`QA ${tag}: first chat answer.`).isVisible().catch(() => false)));
    const archivesButton = page.getByRole('button', { name: /^🗂/ });
    const count = Number(((await archivesButton.innerText().catch(() => '')).match(/\d+/) || [])[0] || 0);
    qa.check('an archives button counts the archived chats', count >= 1, `${count}`);
    await archivesButton.click();
    const list = page.getByRole('dialog', { name: 'Archived chats' });
    await list.waitFor({ timeout: 5000 });
    const entry = list.getByRole('button', { name: new RegExp(firstQuestion.slice(0, 30)) }).first();
    qa.check('the archive is listed by its first question', await entry.isVisible().catch(() => false), (await list.innerText()).slice(0, 200));
    await entry.click();
    const view = page.getByRole('dialog', { name: new RegExp(firstQuestion.slice(0, 20)) });
    const viewed = await view.getByText(`QA ${tag}: first chat answer.`).waitFor({ timeout: 5000 }).then(() => true, () => false);
    qa.check('viewing it shows the old messages', viewed);
    await view.getByRole('button', { name: 'Back' }).click();
    qa.check('Back returns to the list', await list.isVisible().catch(() => false));
    await list.getByRole('button', { name: new RegExp(firstQuestion.slice(0, 30)) }).first().click();
    await view.getByRole('button', { name: 'Continue this chat' }).click();
    await sleep(500);
    qa.check('Continue restores the chat on screen', await page.getByText(`QA ${tag}: first chat answer.`).first().isVisible().catch(() => false));
    // Archive it again, reload (archives are on this device), then delete it.
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.reload();
    await waitForMemberApp(page);
    await openVera(page);
    const afterReload = page.getByRole('button', { name: /^🗂/ });
    qa.check('archives survive a reload on this device', await afterReload.isVisible().catch(() => false));
    await afterReload.click();
    const before = await list.getByRole('button', { name: 'Delete' }).count();
    const dialogs = qa.report.dialogs.length;
    await list.getByRole('button', { name: 'Delete' }).first().click();
    await sleep(500);
    qa.check('Delete asks first', qa.report.dialogs.slice(dialogs).some((d) => /Delete this archived chat/.test(d)), qa.report.dialogs.slice(dialogs).join(' | '));
    const after = await page.getByRole('dialog', { name: 'Archived chats' }).getByRole('button', { name: 'Delete' }).count().catch(() => 0);
    qa.check('the archive is gone', after === before - 1, `${before} -> ${after}`);
    qa.check('archives are not stored in the cloud (no table holds them)', !row(`select 1 as x from information_schema.tables where table_schema = 'public' and table_name ilike '%archive%'`));
    await page.keyboard.press('Escape').catch(() => {});
  }, { soft: true });

  await qa.feature('VERA-012', 'The line under an answer about CME: source check', async () => {
    await openVera(page);
    const calls = [];
    const onRequest = (r) => { if (/\/functions\/v1\/vera-sources/.test(r.url())) calls.push(r.url()); };
    page.on('request', onRequest);
    const before = rows(`select id from public.ai_usage where user_id = '${pid}'`).length;
    const q = `QA ${tag} What CME does Ohio require for my renewal?`;
    await askVera(page, q, { reply: `QA ${tag}: Ohio asks for 50 hours of Category 1 CME each two-year cycle, per the saved reference.`, actions: [] });
    await sleep(1000);
    const bubble = page.locator('div').filter({ hasText: `QA ${tag}: Ohio asks for 50 hours` }).filter({ hasText: /references|source/i }).last();
    const line = (await bubble.innerText().catch(() => '')).split('\n').find((l) => /source|references/i.test(l)) || '';
    await qa.shot('source line');
    qa.check('a source line is shown under the answer', /Saved references; no live source check\.|Official page excerpts retrieved|Source check unavailable/.test(line), line);
    qa.check('with retrieval switched off (production\'s build), no vera-sources call is made', calls.length === 0, calls.join(' '));
    const usage = await waitFor('the metered call', async () => (rows(`select id from public.ai_usage where user_id = '${pid}'`).length > before ? true : null), { timeoutMs: 15000 }).catch(() => false);
    qa.check('the answer is metered in ai_usage', !!usage);
    // Block the source function and ask again: the answer still arrives.
    await page.route('**/functions/v1/vera-sources', (route) => route.abort('blockedbyclient'));
    const q2 = `QA ${tag} and what about Ohio CME renewal for DEA holders?`;
    const answered = await askVera(page, q2, { reply: `QA ${tag}: Ohio has no separate DEA hours in the saved reference.`, actions: [] });
    const bubble2 = page.locator('div').filter({ hasText: `QA ${tag}: Ohio has no separate DEA hours` }).filter({ hasText: /references|source/i }).last();
    const line2 = (await bubble2.innerText().catch(() => '')).split('\n').find((l) => /source|references/i.test(l)) || '';
    qa.check('with vera-sources blocked, Vera still answers', answered);
    qa.check('and the line still reads as saved references', /Saved references|Source check unavailable/.test(line2), line2);
    page.off('request', onRequest);
    qa.check('vera_source_admission stays empty (retrieval off)', rows('select 1 as x from public.vera_source_admission limit 1').length === 0);
  }, { soft: true });

  await qa.feature('VERA-013', 'Vera with the member\'s own Anthropic key', async () => {
    const anthropic = await answerAnthropicFromMock(page);
    const cspErrors = () => qa.report.console.filter((l) => /Content Security Policy|violates/.test(l) && /anthropic/.test(l));
    await openMore(page, 'Profile & settings');
    const keyInput = page.getByPlaceholder('sk-ant-...');
    await keyInput.waitFor({ timeout: 15000 });
    // A lab-generated fake key: the lab's mock Anthropic answers it, nothing reaches Anthropic.
    await keyInput.fill(`sk-ant-qalab-${tag.toLowerCase()}-notarealkey`);
    await sleep(800);
    // First with "Vera answers with" left on Gemini (the default).
    await openVera(page);
    const badge = await page.getByRole('heading', { name: /Vera/ }).first().innerText().catch(() => '');
    const usage0 = rows(`select id from public.ai_usage where user_id = '${pid}'`).length;
    await askVera(page, `QA ${tag} gemini default with my own key, which licenses do I have?`, { reply: `QA ${tag}: answered while set to Gemini.`, actions: [] });
    await sleep(1500);
    const usage1 = rows(`select id from public.ai_usage where user_id = '${pid}'`).length;
    qa.check('with the key but "Vera answers with" on Gemini, the header does not claim Opus', !/Opus/.test(badge) || anthropic.length > 0, `header "${badge}", anthropic calls ${anthropic.length}, ai_usage ${usage0} -> ${usage1}`);
    if (/Opus/.test(badge) && anthropic.length === 0) {
      qa.bug({
        title: 'Vera shows an "Opus" badge as soon as an own Anthropic key is pasted, while every answer still comes from Gemini on the shared key',
        step: 'Settings > AI: paste an own Anthropic key, leave "Vera answers with" on Gemini; open Vera and ask',
        expected: 'The header says what answers (no Opus badge), or the key is used',
        actual: `Header "${badge.replace(/\s+/g, ' ')}"; the answer went through ai-proxy to Gemini (ai_usage ${usage0} -> ${usage1}, ${anthropic.length} calls to api.anthropic.com). AssistantSection.jsx:~592 shows the badge on data.settings.anthropicApiKey alone, while assistant.js assistantTurn uses Claude only when settings.assistantModel === "opus". Fixed on fix/qa-docs-vera-intake and release/qa1 (adc1d969)`,
        severity: 'low',
      });
    }
    // Now "Vera answers with: Claude Opus".
    await openMore(page, 'Profile & settings');
    await page.locator('label', { hasText: 'Vera answers with' }).first().locator('xpath=..').locator('select').selectOption('opus');
    await sleep(800);
    await openVera(page);
    const q = `QA ${tag} own key question which licenses do I have`;
    const before = rows(`select id from public.ai_usage where user_id = '${pid}'`).length;
    const answered = await askVera(page, q, { reply: `QA ${tag}: answered by Claude on your own key.`, actions: [] }, { provider: 'anthropic' });
    await sleep(1500);
    const call = anthropic.find((c) => c.body.includes(q));
    qa.check('Vera answers', answered);
    qa.check('the question went straight to api.anthropic.com with the member\'s key', !!call && call.key.startsWith('sk-ant-qalab'), JSON.stringify(anthropic.map((c) => ({ path: c.path, key: c.key }))));
    qa.check('no Content Security Policy error for api.anthropic.com', cspErrors().length === 0, cspErrors().join(' | '));
    qa.check('no ai_usage row is billed for it', rows(`select id from public.ai_usage where user_id = '${pid}'`).length === before, `${before} -> ${rows(`select id from public.ai_usage where user_id = '${pid}'`).length}`);
    // Remove the key and ask again: the shared route (ai-proxy) answers and is metered.
    await openMore(page, 'Profile & settings');
    await page.getByPlaceholder('sk-ant-...').fill('');
    await sleep(800);
    await openVera(page);
    const q2 = `QA ${tag} no key question which licenses do I have`;
    const calls = anthropic.length;
    const answered2 = await askVera(page, q2, { reply: `QA ${tag}: answered through the shared route.`, actions: [] });
    const metered = await waitFor('the metered call', async () => (rows(`select id from public.ai_usage where user_id = '${pid}'`).length > before ? true : null), { timeoutMs: 15000 }).catch(() => false);
    qa.check('without the key Vera still answers', answered2);
    qa.check('without the key nothing goes to api.anthropic.com', anthropic.length === calls);
    qa.check('without the key the call goes through ai-proxy (an ai_usage row)', !!metered);
    await qa.shot('own key');
  }, { soft: true });
});
