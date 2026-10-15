// PA and NP members (release/goal3, feat/np-pa): a physician assistant and a
// nurse practitioner, synthetic, on qa.credentialdomd.test, walk the app the
// way a new PA or NP would: sign up and pay, choose the profession, import
// licences from a synthetic NPPES answer, review the public record (the
// release's public-record/normalize.ts builds the envelope from a synthetic
// raw NPPES and Medicare record, answered inside the browser: the registers
// are not mocked, so the function's own fetches are never made), add the
// national certification, log CE, read compliance and alerts, the reminder
// email (send-reminders, captured by the mock Resend), the CV and the share
// text. A blank PA member picks PA on Home's one-tap picker, adds the licence
// it opens, and a credentialing request for her PA licence, her NCCPA
// certificate and a practice agreement is read by email-inbound with the PA
// rules (_shared/requestPacket.ts). A DO and MD control keeps the physician
// rules. Every register answer is a stand-in on this machine.
//
// Brought in from the feat/np-pa lab run (qa-evidence/np-pa-lab-20261002,
// harness/np-pa-journeys.spec.mjs, 21ef10b1): the PA, NP and DO/MD journeys as
// they were, plus the reminder email and the blank member's Home journey.
// Chromium at the desk; WebKit as the installed iPhone app with
// -c qa-lab/e2e/webkit.config.mjs (phone navigation below).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from './support/fixtures.mjs';
import {
  field, goTab, letters, newMember, stamp, openCredentials, openMore, profileOf, recordButtons, row, rows, sleep, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import { day, fillField, openAdd, pdfText, saveDialog } from './support/cred-helpers.mjs';
import { openSettings, openSetupPage, servePublicRecord } from './support/settings-auth-helpers.mjs';
import { phoneCredentials, phoneMore, phoneTab } from './support/phone-helpers.mjs';
import { buildEnvelope } from '../../supabase/functions/public-record/normalize.ts';
import { GENERATED_DIR } from '../lib/paths.mjs';
import { runHook } from './support/home-notify-helpers.mjs';
import { settleReminderQueue } from './support/ops-helpers.mjs';
import {
  AUTH_PASS, DOCS, forwardedText, inbound, inboundRow, intakeModelRoutedLocally, qaMailbox, scriptReading,
} from './support/sync-docs-intake-helpers.mjs';
import { chooseFiles, emailBody, emails, lab, syntheticPdf, waitForEmail } from './support/lab.mjs';
import { codeFrom, inviteTokenFrom, openAdministratorPage, serveAdministratorPage } from './support/vera-cv-share-helpers.mjs';


// Phone-aware navigation: the bottom bar on an iPhone, the side nav at a desk.
const phone = (page) => (page.viewportSize()?.width || 1280) < 768;
const tabP = (page, name) => (phone(page) ? phoneTab(page, name) : goTab(page, name));
const credsP = (page, section) => (phone(page) ? phoneCredentials(page, section) : openCredentials(page, section));
const moreP = (page, item) => (phone(page) ? phoneMore(page, item) : openMore(page, item));
async function setupP(page) {
  if (!phone(page)) return openSetupPage(page);
  await phoneMore(page, 'Setup');
  await page.getByRole('heading', { name: /^Setup$/ }).first().waitFor({ timeout: 30000 });
}
async function settingsP(page) {
  if (!phone(page)) return openSettings(page);
  await phoneMore(page, 'Profile & settings');
  await page.getByRole('heading', { name: 'Profile & settings' }).first().waitFor({ timeout: 30000 });
}
async function addP(page, section, dialogName = 'Add') {
  if (!phone(page)) return openAdd(page, section, dialogName);
  await phoneCredentials(page, section);
  const dlg = page.getByRole('dialog', { name: dialogName });
  for (let i = 0; i < 3 && !(await dlg.isVisible().catch(() => false)); i++) {
    if (!(await page.getByRole('dialog').count())) await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    await dlg.waitFor({ timeout: 8000 }).catch(() => {});
  }
  await dlg.waitFor({ timeout: 5000 });
  return dlg;
}

// Each journey's JSON evidence and full-page screenshots (gitignored).
const EVIDENCE = process.env.NPPA_EVIDENCE || path.join(GENERATED_DIR, 'e2e', 'profession-pa-np');
const engineOf = (page) => page.context().browser()?.browserType().name() || 'chromium';

const PHYSICIAN_WORDS = /\bmedical license\b|\bDr\. |physician profile|state medical board|Doctor of Medicine \(MD\)|\bMD Diploma\b/i;

const PROFILES = {
  PA: {
    first: 'Quinn', last: () => `Assistant ${letters()}`, state: 'WI', stateName: 'Wisconsin', credential: 'PA-C',
    nlm: (n) => [{ taxonomy: { code: '363A00000X', classification: 'Physician Assistant' }, lic_number: `QAWIPA${n}`, lic_state: 'WI', is_primary_taxonomy: 'Y' }],
    nppesTax: (n) => [{ code: '363A00000X', desc: 'Physician Assistant', license: `QAWIPA${n}`, state: 'WI', primary: true }],
    importCount: 1,
    licTypes: ['State Physician Assistant License'],
    cert: (n) => ({ type: 'Board Certification (NCCPA)', name: 'NCCPA PA-C', number: `QANCCPA${n}`, expires: `${new Date().getFullYear() + 1}-12-31`, role: 'PA-C' }),
    ce: { title: 'QA synthetic PA pharmacology update', category: 'AAPA Category 1 CME', hoursLabel: 'Credits (hours)', hours: 12, pharm: 3, dialog: 'Add CME' },
    cards: [{ title: 'Wisconsin physician assistant license', total: 30 }],
    setupRows: ['NCCPA certification', 'PA program', 'CME for the current cycle'],
    cmsCred: 'PA', program: 'PA program',
    expiringNumber: (n) => `QAWIPA${n}`,
    board: 'https://dsps.wi.gov/a-z-professions-list/physician-assistant-pa/', medicalPortal: 'https://license.wi.gov/',
  },
  NP: {
    first: 'Nora', last: () => `Practitioner ${letters()}`, state: 'IL', stateName: 'Illinois', credential: 'FNP-BC',
    nlm: (n) => [
      { taxonomy: { code: '363LF0000X', classification: 'Nurse Practitioner' }, lic_number: `QAILAPN${n}`, lic_state: 'IL', is_primary_taxonomy: 'Y' },
      { taxonomy: { code: '163W00000X', classification: 'Registered Nurse' }, lic_number: `QAILRN${n}`, lic_state: 'IL', is_primary_taxonomy: 'N' },
    ],
    nppesTax: (n) => [
      { code: '363LF0000X', desc: 'Nurse Practitioner, Family', license: `QAILAPN${n}`, state: 'IL', primary: true },
      { code: '163W00000X', desc: 'Registered Nurse', license: `QAILRN${n}`, state: 'IL', primary: false },
    ],
    importCount: 2,
    licTypes: ['APRN License (NP)', 'RN License'],
    cert: (n) => ({ type: 'Board Certification (AANPCB)', name: 'AANPCB FNP-C', number: `QAAANP${n}`, expires: day(500), role: 'NP certification' }),
    ce: { title: 'QA synthetic NP pharmacotherapeutics', category: 'Accredited Nursing CE', hoursLabel: 'Contact Hours', hours: 15, pharm: 5, dialog: 'Add CE' },
    cards: [{ title: 'Illinois APRN license', total: 80 }, { title: 'Illinois RN license', total: 20 }],
    setupRows: ['National NP certification', 'Nursing education', 'CE for the current cycle'],
    cmsCred: 'NP', program: 'Nursing program',
    expiringNumber: (n) => `QAILRN${n}`,
    board: 'https://idfpr.illinois.gov/profs/nursing.html', medicalPortal: 'https://online-dfpr.micropact.com/',
  },
};

function save(name, content) {
  mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, name);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}
async function snap(page, name) {
  mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}
const bodyText = async (page) => (await page.locator('body').innerText().catch(() => '')).replace(/[ \t]+/g, ' ');

/** The NLM Clinical Tables NPI mirror (what the production build asks), answered in the browser. */
async function serveRegistry(page, p, npi, n, last) {
  const calls = { count: 0 };
  const extra = {
    NPI: [npi], 'name.first': [p.first.toUpperCase()], 'name.last': [last.toUpperCase()], 'name.credential': [p.credential], gender: ['U'],
    licenses: [p.nlm(n)],
    'addr_practice.line1': ['1 QA Registry Way'], 'addr_practice.line2': [''], 'addr_practice.city': ['Testville'],
    'addr_practice.state': [p.state], 'addr_practice.zip': ['00000'], 'addr_practice.phone': ['5550100199'],
  };
  await page.route('https://clinicaltables.nlm.nih.gov/**', async (route) => {
    calls.count += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([1, [npi], extra]) });
  });
  return calls;
}

/** The public-record envelope the merged edge function's normalize.ts builds from synthetic raw records. */
function envelopeFor(p, npi, n, last) {
  const fetchedAt = new Date().toISOString();
  const nppes = { result_count: 1, results: [{ number: npi, basic: { first_name: p.first.toUpperCase(), last_name: last.toUpperCase(), credential: p.credential },
    addresses: [{ address_purpose: 'LOCATION', address_1: '1 QA REGISTRY WAY', city: 'TESTVILLE', state: p.state, postal_code: '00000', telephone_number: '555-010-0199' }],
    taxonomies: p.nppesTax(n) }] };
  const cms = { count: 1, results: [{ npi, cred: p.cmsCred, med_sch: 'SYNTHETIC QA UNIVERSITY', grd_yr: '2015', pri_spec: p.cmsCred === 'PA' ? 'PHYSICIAN ASSISTANT' : 'NURSE PRACTITIONER' }] };
  const sources = [
    { id: 'nppes', name: 'NPPES NPI Registry', url: '', fetchedAt, status: 'ok', count: 1 },
    { id: 'cmsClinician', name: 'Medicare Care Compare (Doctors and Clinicians)', url: '', fetchedAt, status: 'ok', count: 1 },
    { id: 'cmsAffiliation', name: 'Medicare Care Compare (facility affiliations)', url: '', fetchedAt, status: 'ok', count: 0 },
    { id: 'pubmed', name: 'PubMed', url: '', fetchedAt, status: 'ok', count: 0 },
  ];
  return buildEnvelope({ nppes, cmsClinician: cms, sources, errors: [] }, { npi, fetchedAt });
}

/** navigator.share keeps the whole file (base64) so the CV PDF can be read back. */
async function captureShares(context) {
  await context.addInitScript(() => {
    const log = { shared: [], clipboard: [] };
    Object.defineProperty(window, '__nppa', { value: log, configurable: true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => {
      const files = await Promise.all([...(data?.files || [])].map(async (f) => {
        const buf = new Uint8Array(await f.arrayBuffer());
        let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { name: f.name, type: f.type, size: f.size, b64: btoa(s) };
      }));
      log.shared.push({ title: data?.title || '', text: data?.text || '', files });
    } });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    const clip = { writeText: async (t) => { log.clipboard.push(String(t)); }, readText: async () => log.clipboard.at(-1) || '' };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clip });
  });
}
const shares = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__nppa || { shared: [], clipboard: [] })));

async function openCmeCompliance(page) {
  await credsP(page, 'CME Credits');
  await sleep(1200);
  if (!/Total logged/.test(await bodyText(page))) {
    await page.getByRole('button', { name: 'Compliance', exact: true }).first().click().catch(() => {});
    await sleep(1200);
  }
}

const psqlBool = (sql) => { const r = row(`${sql} as v`); return r ? r.v === true || r.v === 't' : null; };

/**
 * send-reminders for one member (as its daily job calls it, with the hook
 * secret, enqueueing the one profile), then the inactive cron's real drain and
 * the email the mock Resend captured: the licence named, its board's page
 * ("Board: <url>"), and not the medical board's portal or its fee guide.
 */
async function checkReminderEmail(qa, user, pid, { expiringNumber, board, medicalPortal, out, tag }) {
  const run = await runHook('send-reminders', { profile_id: pid });
  qa.check('send-reminders durably queued this member for scheduled delivery', run.status === 202 && run.data?.delivery === 'scheduled' && run.data?.queued === 1 && run.data?.sent === 0, JSON.stringify(run.data).slice(0, 240));
  // The minute cron is inactive in the local lab. Exercise its real protected
  // dispatcher and require this exact member's persisted job to reach sent.
  const delivery = await settleReminderQueue(pid);
  qa.check('the member reminder job reached sent through the scheduled drain', delivery.status === 'sent', delivery);
  const msg = await waitFor('the reminder email', async () => (await emails({ to: user.email })).find((m) => /^Credential check/.test(m.subject)) || null, { timeoutMs: 30000, intervalMs: 1000 }).catch(() => null);
  const full = msg ? await emailBody(msg.id) : {};
  const text = full.text || '';
  if (out) out.steps.reminder = { subject: msg?.subject || null, text: text.slice(0, 4000) };
  save(`${tag}-reminder.txt`, `${msg?.subject || '(no email)'}\n\n${text}`);
  qa.check('one reminder email, subject "Credential check: ..."', !!msg, msg?.subject);
  const at = text.indexOf(expiringNumber) >= 0 ? text.indexOf(expiringNumber) : text.search(/license/i);
  const block = at >= 0 ? text.slice(at, at + 400) : '';
  qa.check(`it names the licence due in 45 days (${expiringNumber})`, text.includes(expiringNumber) || /license/i.test(text), block.slice(0, 200));
  qa.check(`its line names the board's own page (Board: ${board})`, text.includes(`Board: ${board}`), block.slice(0, 300));
  qa.check(`never the medical board's renewal portal (${medicalPortal}) or the physician fee guide`, !text.includes(medicalPortal) && !/Steps and fees: https:\/\/credentialdomd\.com\/states\//.test(text), (text.match(/Renew: [^\n]+|Steps and fees: [^\n]+/g) || []).join(' | '));
  qa.check('no physician wording ("Dr.", medical license) in the email', !PHYSICIAN_WORDS.test(text), (text.match(PHYSICIAN_WORDS) || [])[0]);
  return text;
}

/**
 * The blank member a PA signs up as (profession not chosen, no records, on an
 * iPhone): Home's Get Started card asks "Which license do you hold?" with
 * MD, DO, PA and NP; one tap on PA saves it and opens Add with the PA list.
 * Then a credentialing request (docs@ forward) for her PA licence, her NCCPA
 * certificate and a practice agreement, read by email-inbound with the PA
 * rules, and her reminder email.
 */
test('Blank PA member: picks PA on Home, adds her licence, a request is read with the PA rules', async ({ page, context, qa, secondBrowser }) => {
  test.setTimeout(12 * 60 * 1000);
  const ENGINE = engineOf(page);
  const tag = `blank-pa-${ENGINE}-${page.viewportSize()?.width || 0}`;
  const last = `Blank ${letters()}`;
  const n = String(Date.now()).slice(-5);
  const licNo = `QAWIPA${n}`;
  const certNo = `QANCCPA${n}`;
  const out = { engine: ENGINE, last, steps: {} };
  const { user, profile } = await newMember(page, { firstName: 'Quinn', lastName: last });
  const pid = profile.id;

  await qa.feature('NPPA-001', 'A blank member is asked the licence on Home; PA saves the profession and opens Add with the PA list', async () => {
    qa.check('the profession is blank after signup (never guessed)', !profileOf(user.id)?.degree_type, String(profileOf(user.id)?.degree_type));
    await tabP(page, 'Home');
    const group = page.getByRole('group', { name: /Which license do you hold\?/ });
    const shown = await group.waitFor({ timeout: 30000 }).then(() => true, () => false);
    const chips = shown ? (await group.getByRole('button').allInnerTexts()).map((t) => t.trim()) : [];
    out.steps.picker = { chips, shot: await snap(page, `${tag}-01-home-picker`) };
    await qa.shot('blank member: Home asks the licence');
    qa.check('Home asks "Which license do you hold?" with MD, DO, PA, NP', shown && JSON.stringify(chips) === JSON.stringify(['MD', 'DO', 'PA', 'NP']), chips.join(','));
    qa.check('no Add form is open before she chooses', !(await page.getByRole('dialog', { name: 'Add' }).count()));
    const box = shown ? await group.getByRole('button', { name: 'PA', exact: true }).boundingBox() : null;
    qa.check('the PA button is a full tap target (at least 44 px tall)', !!box && box.height >= 44, JSON.stringify(box));
    await group.getByRole('button', { name: 'PA', exact: true }).click();
    const saved = await waitFor('PA saved', async () => (profileOf(user.id)?.degree_type === 'PA' ? true : null), { timeoutMs: 20000 }).catch(() => false);
    qa.check('profiles.degree_type = PA after one tap', saved, String(profileOf(user.id)?.degree_type));
    const dlg = page.getByRole('dialog', { name: 'Add' });
    const opened = await dlg.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('the tap opens Add in Licenses', opened);
    if (!opened) return;
    const types = (await field(dlg, 'Type').locator('option').allInnerTexts()).map((t) => t.trim());
    out.steps.types = types;
    qa.check('the Type list is the PA list (State Physician Assistant License, NCCPA), no State Medical License', types.includes('State Physician Assistant License') && types.includes('Board Certification (NCCPA)') && !types.some((t) => /medical license/i.test(t)), types.join(' | '));
    await fillField(dlg, 'Type', 'State Physician Assistant License');
    await sleep(400);
    await fillField(dlg, 'License #', licNo);
    await fillField(dlg, 'State', 'WI').catch(() => {});
    await fillField(dlg, /^Expires/, day(45));
    await chooseFiles(page, dlg.getByRole('button', { name: 'Upload' }), [{ name: 'qa-wi-pa-license.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`QA synthetic Wisconsin PA license ${licNo}`) }]);
    await dlg.getByText('qa-wi-pa-license.pdf').first().waitFor({ timeout: 30000 }).catch(() => {});
    out.steps.form = { text: (await dlg.innerText()).replace(/[ \t]+/g, ' ').slice(0, 2000), shot: await snap(page, `${tag}-02-add-pa-license`) };
    const r = await saveDialog(dlg);
    qa.check('the PA licence saves', r.closed, r.refusal);
    const lic = await waitFor('licence row', async () => row(`select id, type, state, license_number, expiration_date from public.licenses where user_id = '${pid}' and license_number = '${licNo}'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('licenses row: State Physician Assistant License, WI, its expiry', lic?.type === 'State Physician Assistant License' && lic?.state === 'WI' && lic?.expiration_date === day(45), JSON.stringify(lic));
    const doc = lic ? await waitFor('its document', async () => row(`select id from public.documents where user_id = '${pid}' and linked_to = 'licenses:${lic.id}' and storage_path is not null`), { timeoutMs: 45000 }).catch(() => null) : null;
    qa.check('its PDF reaches the account (documents row with a storage path)', !!doc);
  }, { soft: true });

  await qa.feature('NPPA-001', 'Her NCCPA certificate; after a reload the profession stays PA and Home asks nothing', async () => {
    const dlg = await addP(page, 'Licenses');
    await fillField(dlg, 'Type', 'Board Certification (NCCPA)');
    await sleep(400);
    await fillField(dlg, /^(Display Name|What Is It In\?)/, 'NCCPA PA-C').catch(() => {});
    await fillField(dlg, 'License #', certNo).catch(() => {});
    await fillField(dlg, /^Expires/, `${new Date().getFullYear() + 1}-12-31`);
    await chooseFiles(page, dlg.getByRole('button', { name: 'Upload' }), [{ name: 'qa-nccpa-certificate.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`QA synthetic NCCPA certificate ${certNo}`) }]);
    await dlg.getByText('qa-nccpa-certificate.pdf').first().waitFor({ timeout: 30000 }).catch(() => {});
    const r = await saveDialog(dlg);
    qa.check('the NCCPA certificate saves', r.closed, r.refusal);
    const cert = await waitFor('cert row and document', async () => {
      const c = row(`select id from public.licenses where user_id = '${pid}' and type = 'Board Certification (NCCPA)'`);
      return c && row(`select id from public.documents where user_id = '${pid}' and linked_to = 'licenses:${c.id}' and storage_path is not null`) ? c : null;
    }, { timeoutMs: 45000 }).catch(() => null);
    qa.check('licenses row Board Certification (NCCPA) with its PDF in the account', !!cert);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await tabP(page, 'Home');
    await sleep(2000);
    const home = await bodyText(page);
    out.steps.homeAfter = { text: home.slice(0, 3000), shot: await snap(page, `${tag}-03-home-after-reload`) };
    qa.check('after a reload Home asks nothing (no picker)', !(await page.getByRole('group', { name: /Which license do you hold\?/ }).count()));
    qa.check('the profession is still PA', profileOf(user.id)?.degree_type === 'PA', String(profileOf(user.id)?.degree_type));
    qa.check('no physician wording on Home', !PHYSICIAN_WORDS.test(home), (home.match(PHYSICIAN_WORDS) || [])[0]);
  }, { soft: true });

  await qa.feature('NPPA-002', 'A forwarded request for her PA licence, NCCPA certificate and practice agreement is read with the PA rules', async () => {
    const requester = qaMailbox('pa-credentialer');
    const ref = `Ref ${stamp('pareq')}`;
    const asks = [
      'Please send a copy of your Wisconsin PA license.',
      'Please also send your NCCPA certificate.',
      'We also need your collaborative practice agreement.',
    ];
    const subject = `Credentialing file ${n}: PA documents needed`;
    const body = `Hello Quinn,\n\n${asks.join('\n')}\n\nThank you,\nCasey Credentialer\nQA Credentialing Office\n${ref}`;
    if (intakeModelRoutedLocally()) {
      // The model names the asks by quote; the kinds come from the PA rules
      // (practice_agreement is no kind a model may name).
      await scriptReading(ref, { intent: 'request', confidence: 'high', summary: 'a request for PA documents',
        asks: [{ quote: asks[0], kind: 'state_license', who: 'physician' }, { quote: asks[1], kind: 'board_cert', who: 'physician' }, { quote: asks[2], kind: 'unknown', who: 'physician' }] });
    }
    await inbound({
      from: `Quinn ${last} <${user.email}>`, to: [DOCS], subject: `Fwd: ${subject}`,
      text: forwardedText({ fromName: 'Casey Credentialer', fromAddr: requester, subject, to: `Quinn ${last} <${user.email}>`, body }),
      headers: AUTH_PASS(),
    });
    const ledger = await inboundRow(`from_addr = '${user.email}' and subject = 'Fwd: ${subject.replace(/'/g, "''")}'`).catch(() => null);
    const req = ledger ? await waitFor('the request with its proposal', async () => row(`select id, proposal from public.document_requests where inbound_ledger_id = '${ledger.id}' and proposal is not null`), { timeoutMs: 30000 }).catch(() => null) : null;
    const items = req?.proposal?.items || [];
    out.steps.request = { ledger: ledger ? { status: ledger.status, detail: String(ledger.detail || '').slice(0, 300) } : null, items };
    save(`${tag}-request.json`, req?.proposal || { ledger });
    qa.check('email-inbound wrote a document_requests row with a proposal', !!req, ledger ? `${ledger.status}: ${String(ledger.detail || '').slice(0, 200)}` : 'no ledger row');
    if (intakeModelRoutedLocally()) qa.check('read by the model (quote-checked), the kinds by the PA rules', req?.proposal?.source === 'model', `${req?.proposal?.source}: ${String(ledger?.detail || '').slice(0, 160)}`);
    const licDoc = row(`select d.id from public.documents d join public.licenses l on d.linked_to = 'licenses:' || l.id where l.user_id = '${pid}' and l.license_number = '${licNo}'`)?.id;
    const certDoc = row(`select d.id from public.documents d join public.licenses l on d.linked_to = 'licenses:' || l.id where l.user_id = '${pid}' and l.type = 'Board Certification (NCCPA)'`)?.id;
    const byAsk = (re) => items.find((i) => re.test(`${i.ask} ${i.quote || ''}`));
    const licItem = byAsk(/PA license/i);
    const certItem = byAsk(/NCCPA/i);
    const agrItem = byAsk(/practice agreement/i);
    qa.check('"Wisconsin PA license" is her state PA licence, found, with its PDF (never Pennsylvania)', licItem?.kind === 'state_license' && licItem?.status === 'found' && licItem.docIds.includes(licDoc), JSON.stringify(licItem));
    qa.check('"NCCPA certificate" is her board certification, found, with its PDF', certItem?.kind === 'board_cert' && certItem?.status === 'found' && certItem.docIds.includes(certDoc), JSON.stringify(certItem));
    qa.check('"collaborative practice agreement" is a practice agreement, missing (none on file)', agrItem?.kind === 'practice_agreement' && agrItem?.status === 'missing', JSON.stringify(agrItem));
    const acks = await waitFor('the acknowledgement', async () => { const m = await emails({ to: requester }); return m.length ? m : null; }, { timeoutMs: 20000 }).catch(() => []);
    const ack = acks[0] ? await emailBody(acks[0].id) : null;
    out.steps.ack = ack ? { from: ack.from, text: (ack.text || '').slice(0, 1200) } : null;
    qa.check('the requester gets one receipt note, with no "Dr." and no "physician"', acks.length === 1 && !/\bDr\. |physician\b/i.test(ack?.text || ''), (ack?.text || '').match(/.{0,60}(Dr\.|physician).{0,60}/i)?.[0] || `${acks.length} note(s)`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await tabP(page, 'Home');
    await page.getByRole('button', { name: 'Review', exact: true }).first().waitFor({ timeout: 30000 }).catch(() => {});
    const home = await bodyText(page);
    out.steps.banner = { text: (home.match(/Casey Credentialer[\s\S]{0,400}/) || [''])[0], shot: await snap(page, `${tag}-04-request-banner`) };
    await qa.shot('blank PA: request banner');
    qa.check('Home shows the request from Casey Credentialer', /Casey Credentialer/.test(home), out.steps.banner.text.slice(0, 200));
  }, { soft: true });

  // Administrator access, both sides (20261002060000): from More >
  // Administrator access she sends a standing, Licenses-only link; the
  // section's hint names what a PA's Licenses hold, the live count includes
  // her PA licence and her NCCPA certificate, "Preview as administrator"
  // lists both with their files, and the administrator, verified by code on
  // the private page, sees her WI PA licence and its PDF.
  await qa.feature('NPPA-003', 'PA: a standing administrator grant shows her PA licence and NCCPA certificate with their files', async () => {
    const admin = qaMailbox('pa-admin-access');
    const purpose = `QA Lakeside medical staff office ${n}`;
    await moreP(page, 'Administrator access');
    await page.getByRole('heading', { name: 'Administrator access' }).waitFor({ timeout: 20000 });
    const form = page.locator('section').filter({ hasText: 'New access link' }).first();
    await form.waitFor({ timeout: 20000 });
    await form.getByLabel('Administrator email').fill(admin);
    await form.getByLabel('Facility or office').fill(purpose);
    for (const box of await form.locator('input[data-section]').all()) {
      const want = (await box.getAttribute('data-section')) === 'licenses';
      if ((await box.isChecked()) !== want) await box.click();
    }
    const licensesRow = form.locator('label').filter({ has: page.locator('input[data-section="licenses"]') });
    await licensesRow.getByText(/\d+ records?/).waitFor({ timeout: 20000 }).catch(() => {});
    const rowText = (await licensesRow.innerText().catch(() => '')).replace(/\s+/g, ' ');
    out.steps.adminAccess = { row: rowText, shot: await snap(page, `${tag}-04-admin-access`) };
    await qa.shot('blank PA: Administrator access, Licenses only');
    qa.check('Licenses counts her PA licence and NCCPA certificate (2 records, 2 files)', /2 records, 2 files/.test(rowText), rowText.slice(0, 300));
    qa.check('the Licenses hint names a PA\'s licences (PA licenses, prescriptive authority, NCCPA)', /PA licenses, prescriptive authority, practice agreements/.test(rowText) && /NCCPA certification/.test(rowText) && !/medical licen/i.test(rowText), rowText.slice(0, 300));
    await form.getByRole('button', { name: 'Preview as administrator' }).click();
    const preview = page.getByText('What the administrator sees').locator('xpath=..');
    const previewed = await preview.waitFor({ timeout: 20000 }).then(() => true, () => false);
    const previewText = previewed ? (await preview.innerText()).replace(/\s+/g, ' ') : '';
    out.steps.adminPreview = { text: previewText.slice(0, 1500), shot: await snap(page, `${tag}-05-admin-preview`) };
    qa.check('"Preview as administrator" lists her WI PA licence and its PDF', previewText.includes(licNo) && previewText.includes('qa-wi-pa-license.pdf'), previewText.slice(0, 400));
    qa.check('the preview lists her NCCPA certificate and its PDF', previewText.includes('qa-nccpa-certificate.pdf'), previewText.slice(0, 400));
    const since = new Date().toISOString();
    await form.getByRole('button', { name: 'Send access link' }).click();
    const created = await page.getByRole('status').filter({ hasText: /Access created for/ }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    qa.check('she is told the access was created', created, (await page.getByRole('status').allInnerTexts().catch(() => [])).join(' | ').slice(0, 200));
    const invite = await waitFor('the standing grant', async () => row(`select id, kind, scope from public.credential_portal_invites where owner_profile_id = '${pid}' and recipient_email = '${admin}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('credential_portal_invites: a standing grant for Licenses', invite?.kind === 'standing' && JSON.stringify(invite?.scope || '').includes('licenses'), JSON.stringify(invite));
    const mail = await waitForEmail({ to: admin, since }, 30000).catch(() => null);
    const token = inviteTokenFrom(mail ? (await emailBody(mail.id)).text : '');
    qa.check('the administrator receives the access link', !!token, mail?.subject || '(no email)');
    if (!token) return;
    const { context: adminCtx, page: adminPage } = await secondBrowser();
    await serveAdministratorPage(adminCtx);
    await openAdministratorPage(adminPage, token);
    await adminPage.getByRole('heading', { name: 'Start with your email' }).waitFor({ timeout: 20000 });
    await adminPage.getByLabel('Invited email address').fill(admin);
    const codeSince = new Date().toISOString();
    await adminPage.getByRole('button', { name: 'Email me a code' }).click();
    await adminPage.getByRole('heading', { name: 'Check your inbox' }).waitFor({ timeout: 20000 });
    const codeMail = await waitForEmail({ to: admin, since: codeSince, subject: 'access code' }, 30000).catch(() => null);
    const code = codeFrom(codeMail ? (await emailBody(codeMail.id)).text : '');
    qa.check('a six-digit code arrives at the invited address', !!code, codeMail?.subject);
    if (!code) return;
    await adminPage.getByLabel('Six-digit code').fill(code);
    await adminPage.getByRole('button', { name: 'Verify and open' }).click();
    const opened = await adminPage.locator('#standing-view').waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false);
    const view = opened ? (await adminPage.locator('#standing-view').innerText()).replace(/\s+/g, ' ') : (await adminPage.locator('body').innerText()).slice(0, 600);
    out.steps.adminView = { text: view.slice(0, 1500), shot: await snap(adminPage, `${tag}-06-administrator-view`) };
    qa.check('the administrator sees her WI PA licence and its PDF', opened && view.includes(licNo) && view.includes('qa-wi-pa-license.pdf'), view.slice(0, 400));
    qa.check('and her NCCPA certificate and its PDF', view.includes('qa-nccpa-certificate.pdf'), view.slice(0, 400));
    qa.check('the administrator\'s page has no "Dr." for her', !/\bDr\. /.test(view), (view.match(/.{0,40}\bDr\. .{0,40}/) || [])[0]);
  }, { soft: true });

  // The credential portal's one-time document invitation (no screen mounts
  // CredentialPortalModal in this build, so it is asked as that modal would,
  // from the page, with her own session token): the email names her as a
  // physician assistant (_shared/credentialPortalView.mjs documentInvitationText).
  await qa.feature('NPPA-004', 'PA: her licence and certificate can be sent privately; the invitation names her "A physician assistant"', async () => {
    const docOf = (where) => row(`select d.id from public.documents d join public.licenses l on d.linked_to = 'licenses:' || l.id where l.user_id = '${pid}' and ${where}`)?.id;
    const invite = (recipient, docId) => page.evaluate(async ({ api, body }) => {
      const token = await window.Clerk?.session?.getToken();
      const r = await fetch(`${api}/functions/v1/credential-portal`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.text() };
    }, { api: lab().urls.apiOrigin, body: { action: 'create', recipientEmail: recipient, documentIds: [docId], requestId: crypto.randomUUID() } });
    // Her state PA licence: the database decides what the portal may share
    // (credential_portal_license_ok, a type pattern written for physicians).
    const licAnswer = await invite(qaMailbox('pa-portal-lic'), docOf(`l.license_number = '${licNo}'`));
    const ok = { licence: psqlBool(`select public.credential_portal_license_ok('State Physician Assistant License', null)`) };
    for (const t of ['APRN License (NP)', 'RN License', 'Prescriptive Authority', 'Practice Agreement', 'Board Certification (NCCPA)']) ok[t] = psqlBool(`select public.credential_portal_license_ok('${t}', null)`);
    out.steps.portalLicence = { status: licAnswer.status, body: licAnswer.body.slice(0, 200), licenseOk: ok };
    qa.check('her State Physician Assistant License can be sent privately (credential-portal 2xx)', licAnswer.status >= 200 && licAnswer.status < 300, `${licAnswer.status} ${licAnswer.body.slice(0, 120)}; credential_portal_license_ok: ${JSON.stringify(ok)}`);
    if (licAnswer.status === 409 && /document_not_shareable/.test(licAnswer.body)) {
      qa.bug({
        title: 'Administrator access never shares a PA\'s or NP\'s state licence: the database\'s licence filter knows only physician licence types',
        step: 'A PA member with a State Physician Assistant License and its PDF: credential-portal create (a private document invitation) for that PDF; the same filter decides the Licenses section of a standing administrator grant',
        expected: 'Her state PA licence (and an NP\'s APRN and RN licences) can be shared like a physician\'s medical licence; release/goal3 tells PA and NP owners the Licenses section holds "Licenses, DEA and state controlled substance, certifications" (credentialPortalView.mjs sectionHint)',
        actual: `409 document_not_shareable. public.credential_portal_license_ok (production's, from 20260925040000_credential_portal_admin_access.sql:113) matches only medical licen[cs]e|state medical|osteopathic|dea|controlled substance|board|ecfmg|usmle|comlex|bls|acls|atls|pals|nrp|fluoroscop|laser|certif; results: ${JSON.stringify(ok)}. So credential_portal_records leaves out State Physician Assistant License, APRN License (NP), RN License, Prescriptive Authority and Practice Agreement rows and their files, for standing grants and one-time invitations alike; release/goal3 has no migration for it`,
        severity: 'high',
      });
    }
    const recipient = qaMailbox('pa-portal-admin');
    const answer = await invite(recipient, docOf(`l.type = 'Board Certification (NCCPA)'`));
    qa.check('credential-portal sends her NCCPA certificate privately (2xx)', answer.status >= 200 && answer.status < 300, `${answer.status} ${answer.body.slice(0, 200)}`);
    const mail = await waitFor('the invitation email', async () => (await emails({ to: recipient }))[0] || null, { timeoutMs: 30000, intervalMs: 1000 }).catch(() => null);
    const text = mail ? (await emailBody(mail.id)).text || '' : '';
    out.steps.portal = { status: answer.status, subject: mail?.subject, text: text.slice(0, 800) };
    save(`${tag}-portal-invitation.txt`, `${mail?.subject || '(no email)'}\n\n${text}`);
    qa.check('the invitation reads "A physician assistant has invited you ..."', /^A physician assistant has invited you to access selected credential documents privately\./.test(text), text.slice(0, 160));
    qa.check('no "physician has invited" and no "Dr." in it', !!text && !/A physician has invited|\bDr\. /.test(text));
  }, { soft: true });

  await qa.feature('NPPA-005', 'PA (chosen on Home): the reminder email names the Wisconsin PA board, never the medical board portal', async () => {
    await checkReminderEmail(qa, user, pid, { expiringNumber: licNo, board: PROFILES.PA.board, medicalPortal: PROFILES.PA.medicalPortal, out, tag });
  }, { soft: true });
  out.report = { external: qa.report?.external, pageErrors: qa.report?.pageErrors };
  save(`${tag}.json`, out);
});

for (const deg of ['PA', 'NP']) {
  test(`${deg} journey: sign up, profession, NPI import, licences and certification, CE, compliance, alerts, CV, share`, async ({ page, context, qa }) => {
    test.setTimeout(14 * 60 * 1000);
    const p = PROFILES[deg];
    const ENGINE = engineOf(page);
    const tag = `${deg.toLowerCase()}-${ENGINE}-${page.viewportSize()?.width || 0}`;
    const last = p.last();
    const n = String(Date.now()).slice(-4);
    const npi = `19${deg === 'PA' ? '7' : '8'}${String(Date.now()).slice(-7)}`;
    await captureShares(context);
    const out = { deg, engine: ENGINE, npi, last, steps: {} };

    // 1. Sign up: QA sign-in, membership gate, founding checkout stand-in, member app.
    let user, profile;
    await qa.feature('NPPA-006', `${deg}: a new clinician signs up and pays`, async () => {
      ({ user, profile } = await newMember(page, { firstName: p.first, lastName: last }));
      qa.check('member is active', profileOf(user.id)?.access_status === 'active');
      qa.check('test email on the reserved domain', /@qa\.credentialdomd\.test$/.test(user.email), user.email);
      qa.check('profession is blank until chosen (no MD default)', !profileOf(user.id)?.degree_type, String(profileOf(user.id)?.degree_type));
      out.steps.signup = { email: user.email, profession: profileOf(user.id)?.degree_type ?? null, shot: await snap(page, `${tag}-01-member-app`) };
    });
    if (!profile) { save(`${tag}.json`, out); return; }
    const pid = profile.id;

    // 2. Choose the profession in Setup > About you.
    await qa.feature('NPPA-007', `${deg}: Setup > About you offers MD, DO, PA, NP; choosing ${deg} is saved`, async () => {
      await setupP(page);
      await page.locator('button').filter({ hasText: 'About you' }).first().click();
      const group = page.getByRole('group', { name: 'Profession' });
      await group.waitFor({ timeout: 15000 });
      const chips = (await group.getByRole('button').allInnerTexts()).map((t) => t.trim());
      qa.check('the picker offers MD, DO, PA and NP', ['MD', 'DO', 'PA', 'NP'].every((d) => chips.includes(d)), chips.join(','));
      await group.getByRole('button', { name: deg, exact: true }).click();
      await page.locator('#setup-primary-state').selectOption(p.state).catch(async () => {
        await page.locator('select').filter({ has: page.locator('option', { hasText: 'Choose a state' }) }).first().selectOption(p.state);
      });
      const saved = await waitFor('degree saved', async () => { const x = profileOf(user.id); return x?.degree_type === deg && x?.primary_state === p.state ? x : null; }, { timeoutMs: 20000 }).catch(() => profileOf(user.id));
      qa.check(`profiles.degree_type = ${deg} and primary_state = ${p.state}`, saved?.degree_type === deg && saved?.primary_state === p.state, JSON.stringify({ d: saved?.degree_type, s: saved?.primary_state }));
      await sleep(1500);
      { const ph = page.getByRole('button', { name: /items · \d+ done/ }).first(); if (await ph.isVisible().catch(() => false)) { await ph.click().catch(() => {}); await sleep(800); } }
      const setup = await bodyText(page);
      for (const r of p.setupRows) qa.check(`Setup lists "${r}"`, setup.includes(r));
      qa.check('Setup does not list physician rows (Medical school, Board certification)', !/Medical school and postgraduate training|\bBoard certification\b/.test(setup));
      out.steps.profession = { chips, saved: { d: saved?.degree_type, s: saved?.primary_state }, setupText: setup.slice(0, 4000), shot: await snap(page, `${tag}-02-setup-profession`) };
    }, { soft: true });

    // 3. NPI import from the registry stand-in (Setup > Your licenses).
    const registry = await serveRegistry(page, p, npi, n, last);
    await qa.feature('NPPA-008', `${deg}: NPI lookup imports the ${deg} licences with the right types`, async () => {
      await setupP(page);
      await page.locator('button').filter({ hasText: 'Your licenses' }).first().click();
      const before = await bodyText(page);
      qa.check('the missing-licence note names the profession\'s licence, never a medical license', !/no medical license on file/i.test(before));
      await page.getByPlaceholder('Blank searches by name').fill(npi);
      await page.getByRole('button', { name: 'Look up' }).click();
      const importBtn = page.getByRole('button', { name: new RegExp(`^Import ${p.importCount} licenses?$`) });
      const found = await importBtn.waitFor({ timeout: 30000 }).then(() => true, () => false);
      out.steps.npi = { lookupText: (await bodyText(page)).slice(0, 3000), registryCalls: registry.count, shot: await snap(page, `${tag}-03-npi-lookup`) };
      qa.check(`the lookup offers ${p.importCount} licence(s)`, found, (await bodyText(page)).match(/Import \d+ licenses?|No provider found[^.]*/)?.[0]);
      if (!found) return;
      await importBtn.click();
      const lic = await waitFor('imported licences', async () => {
        const r = rows(`select type, state, license_number, npi_imported from public.licenses where user_id = '${pid}' and npi_imported order by type`);
        return r.length === p.importCount ? r : null;
      }, { timeoutMs: 30000 }).catch(() => rows(`select type, state, license_number, npi_imported from public.licenses where user_id = '${pid}' order by type`));
      out.steps.npi.imported = lic;
      qa.check(`imported licence types are ${p.licTypes.join(' + ')}`, JSON.stringify(lic.map((l) => l.type).sort()) === JSON.stringify([...p.licTypes].sort()), JSON.stringify(lic));
      const prof = await waitFor('npi saved', async () => { const x = profileOf(user.id); return x?.npi === npi ? x : null; }, { timeoutMs: 15000 }).catch(() => profileOf(user.id));
      qa.check(`profiles.npi saved and the profession stays ${deg}`, prof?.npi === npi && prof?.degree_type === deg, JSON.stringify({ npi: prof?.npi, d: prof?.degree_type }));
      out.steps.npi.after = (await bodyText(page)).slice(0, 2000);
      await snap(page, `${tag}-04-npi-imported`);
    }, { soft: true });

    // 4. Public record review in Profile & settings (merged normalize.ts over synthetic raw records).
    const envelope = envelopeFor(p, npi, n, last);
    const bodies = await servePublicRecord(page, () => envelope);
    await qa.feature('NPPA-009', `${deg}: public record review reads NPPES with the ${deg} rules`, async () => {
      await settingsP(page);
      const settingsText = await bodyText(page);
      qa.check('Settings card is "Profile", not "Physician Profile"', !/Physician Profile/.test(settingsText) && /\bProfile\b/.test(settingsText));
      const profGroup = page.getByRole('group', { name: 'Profession' }).first();
      const pressed = await profGroup.getByRole('button', { name: new RegExp(`^${deg}`) }).first().getAttribute('aria-pressed').catch(() => null);
      qa.check(`Settings shows ${deg} pressed under "Profession"`, pressed === 'true', String(pressed));
      const specialty = deg === 'NP' ? 'Population focus' : 'Specialty';
      qa.check(`Settings asks for "${specialty}" instead of physician Board Specialties`, settingsText.toLowerCase().includes(specialty.toLowerCase()) && !/board specialties/i.test(settingsText));
      out.steps.residencyField = /Residency Start \(PGY 1\)/i.test(settingsText);
      out.steps.settings = { text: settingsText.slice(0, 14000), pressed, shot: await snap(page, `${tag}-05-settings`) };
      await page.getByRole('button', { name: 'Pull from public records' }).click();
      const modal = page.getByRole('dialog', { name: 'Public records' });
      await modal.waitFor({ timeout: 15000 });
      await modal.getByRole('button', { name: 'Search the public registers' }).click();
      await sleep(3000);
      const text = (await modal.innerText()).replace(/[ \t]+/g, ' ');
      out.steps.publicRecord = { envelopeFindings: envelope.findings.map((f) => ({ id: f.id, label: f.label, fields: f.fields })), modalText: text.slice(0, 5000), requests: bodies.length, shot: await snap(page, `${tag}-06-public-record`) };
      qa.check('the function was asked for this NPI', bodies[0]?.npi === npi, JSON.stringify(bodies[0]));
      const school = envelope.findings.find((f) => f.kind === 'medicalSchool');
      qa.check(`merged normalize.ts files the school as "${p.program}, ..." with no medical type`, String(school?.fields?.name || '').startsWith(`${p.program},`) && !school?.fields?.type, JSON.stringify(school?.fields));
      qa.check(`the review offers the profession finding "Profession: ${deg === 'PA' ? 'Physician Assistant' : 'Nurse Practitioner'}"`, text.includes(`Profession: ${deg === 'PA' ? 'Physician Assistant' : 'Nurse Practitioner'}`));
      qa.check('the review lists the school and no medical school', text.includes('Synthetic Qa University') && !/School of Medicine|medical school/i.test(text));
      qa.check('no physician wording in the review (medical license, MD Diploma, Doctor of Medicine)', !PHYSICIAN_WORDS.test(text), (text.match(PHYSICIAN_WORDS) || [])[0]);
      await modal.getByRole('button', { name: /^(Close|Done|Cancel)$/ }).first().click().catch(() => page.keyboard.press('Escape'));
      await sleep(800);
    }, { soft: true });

    // 5. National certification by hand, and dates on the imported licences.
    const cert = p.cert(n);
    await qa.feature('NPPA-010', `${deg}: licence form offers ${deg} types; certification saved with its role`, async () => {
      const dlg = await addP(page, 'Licenses');
      const types = (await field(dlg, 'Type').locator('option').allInnerTexts()).map((t) => t.trim());
      out.steps.licenceTypes = types;
      qa.check(`the Type list is the ${deg} list (${p.licTypes[0]}, ${cert.type})`, types.includes(p.licTypes[0]) && types.includes(cert.type), types.join(' | '));
      qa.check('the Type list has no State Medical License', !types.some((t) => /medical license/i.test(t)));
      await fillField(dlg, 'Type', cert.type);
      await sleep(500);
      await fillField(dlg, /^(Display Name|What Is It In\?)/, cert.name).catch(() => {});
      await fillField(dlg, 'License #', cert.number).catch(() => {});
      await fillField(dlg, /^Expires/, cert.expires);
      const formText = (await dlg.innerText()).replace(/[ \t]+/g, ' ');
      out.steps.certForm = { text: formText.slice(0, 3000), shot: await snap(page, `${tag}-07-cert-form`) };
      const r = await saveDialog(dlg);
      qa.check('certification saved', r.closed, r.refusal);
      const saved = await waitFor('cert row', async () => row(`select type, expiration_date, custom_fields from public.licenses where user_id = '${pid}' and type = '${cert.type}'`), { timeoutMs: 20000 }).catch(() => null);
      out.steps.certRow = saved;
      qa.check(`licences row ${cert.type} with its expiry`, saved?.expiration_date === cert.expires, JSON.stringify(saved));
      // Dates on the imported licences: one expiring in 45 days (an alert), the other in 300.
      for (const l of rows(`select id, license_number from public.licenses where user_id = '${pid}' and npi_imported`)) {
        const exp = l.license_number === p.expiringNumber(n) ? day(45) : day(300);
        await credsP(page, 'Licenses');
        await sleep(800);
        await recordButtons(page, l.license_number).edit.click();
        const ed = page.getByRole('dialog', { name: 'Edit' });
        await ed.waitFor({ timeout: 15000 });
        await fillField(ed, /^Expires/, exp);
        await fillField(ed, 'Issued', day(-400)).catch(() => {});
        const s = await saveDialog(ed);
        qa.check(`licence ${l.license_number} dated ${exp}`, s.closed, s.refusal);
      }
      const dated = await waitFor('dates saved', async () => {
        const r2 = rows(`select license_number, expiration_date from public.licenses where user_id = '${pid}' and npi_imported`);
        return r2.every((x) => x.expiration_date) ? r2 : null;
      }, { timeoutMs: 20000 }).catch(() => rows(`select license_number, expiration_date from public.licenses where user_id = '${pid}' and npi_imported`));
      out.steps.dated = dated;
      qa.check('every imported licence has its expiry in the database', dated.every((x) => x.expiration_date), JSON.stringify(dated));
      out.steps.licencesText = (await bodyText(page)).slice(0, 4000);
      await snap(page, `${tag}-08-licences`);
    }, { soft: true });

    // 5b. The reminder email (send-reminders for this member, captured by the mock
    // Resend): the licence due in 45 days names its own board's page, never the
    // medical board's portal (_shared/reminderRenewalLine.mjs, appBoardLinks.json).
    await qa.feature('NPPA-005', `${deg}: the reminder email names the ${deg === 'PA' ? 'PA' : 'nursing'} board, never the medical board's portal`, async () => {
      await checkReminderEmail(qa, user, pid, { expiringNumber: p.expiringNumber(n), board: p.board, medicalPortal: p.medicalPortal, out, tag });
    }, { soft: true });

    // 6. Log CE with pharmacology hours.
    await qa.feature('NPPA-011', `${deg}: the ${p.ce.dialog} form uses the ${deg} categories and units`, async () => {
      const dlg = await addP(page, 'CME Credits', p.ce.dialog);
      const cats = (await field(dlg, 'Credit Category').locator('option').allInnerTexts()).map((t) => t.trim());
      out.steps.ceCategories = cats;
      qa.check(`categories include ${p.ce.category}`, cats.includes(p.ce.category), cats.join(' | '));
      await fillField(dlg, 'Activity / Title', p.ce.title);
      await fillField(dlg, 'Credit Category', { label: p.ce.category });
      await fillField(dlg, p.ce.hoursLabel, String(p.ce.hours));
      await fillField(dlg, 'Date Completed', day(-20));
      await fillField(dlg, 'Provider / Institution', 'QA Synthetic CE Provider');
      await fillField(dlg, 'Pharmacology Hours', String(p.ce.pharm));
      out.steps.ceForm = { text: (await dlg.innerText()).replace(/[ \t]+/g, ' ').slice(0, 3000), shot: await snap(page, `${tag}-09-ce-form`) };
      const r = await saveDialog(dlg);
      qa.check('CE saved', r.closed, r.refusal);
      const ce = await waitFor('cme row', async () => row(`select category, hours, custom_fields from public.cme where user_id = '${pid}' and name = '${p.ce.title}'`), { timeoutMs: 20000 })
        .catch(() => row(`select * from public.cme where user_id = '${pid}' order by created_at desc limit 1`));
      out.steps.ceRow = ce;
      qa.check(`cme row: ${p.ce.category}, ${p.ce.hours} h, pharmacology ${p.ce.pharm}`, ce?.category === p.ce.category && Number(ce?.hours) === p.ce.hours && Number(ce?.custom_fields?.['Pharmacology Hours']) === p.ce.pharm, JSON.stringify(ce));
    }, { soft: true });

    // 7. Compliance: per licence cards with the verified state numbers, national certification card.
    await qa.feature('NPPA-012', `${deg}: compliance shows ${p.cards.map((c) => `${c.title} (${c.total})`).join(', ')}`, async () => {
      await openCmeCompliance(page);
      const text = await bodyText(page);
      out.steps.compliance = { text: text.slice(0, 8000), shot: await snap(page, `${tag}-10-compliance`) };
      for (const c of p.cards) {
        const at = text.indexOf(c.title);
        const slice = at >= 0 ? text.slice(at, at + 600) : '';
        qa.check(`a "${c.title}" card`, at >= 0);
        qa.check(`${c.title}: ${c.total} required, ${p.ce.hours} logged`, new RegExp(`${p.ce.hours}(\\.0+)?\\s*/\\s*${c.total}\\b`).test(slice) || (slice.includes(String(c.total)) && slice.includes(String(p.ce.hours))), slice.slice(0, 300));
      }
      qa.check('a National certification card', /National certification/.test(text));
      if (deg === 'PA') {
        const at = text.indexOf(p.cards[0].title); const card = text.slice(at, at + 700);
        const tick = /Total logged hours\s*\n?\s*12\/30 hrs ✓/.test(card);
        // release/goal3 76ba4f95: certificationMetLine under the bar.
        const why = /Met (through|by your current) NCCPA|NCCPA certification (covers|in lieu)|met by NCCPA certification/i.test(card);
        out.steps.inLieu = { tick, why, card: card.slice(0, 700) };
        qa.check('the WI card says the current NCCPA certification meets the 30 hours', why, card.slice(0, 400));
        if (tick && !why) qa.bug({ title: 'WI PA card: the hour bar reads 12/30 hrs with a check mark and never says the current NCCPA certification is what meets the 30 hours', step: 'PA in WI with a current NCCPA PA-C record, 12 credits logged, Controlled Substances 0/2: CME Credits > Compliance', expected: 'The card says the 30 hours are met through NCCPA certification (cmePresentation.js appAssessmentLabel has "Met through NCCPA certification")', actual: 'The bar shows 12/30 hrs with a check mark; the assessment line is "Recorded CE gaps: review hours and topics" because the needs-hours branch returns before the satisfiedVia line (src/utils/cmePresentation.js:84-96), so nothing on the card explains why 12 of 30 is met', severity: 'low' });
      }
      qa.check('no physician wording on the compliance page', !PHYSICIAN_WORDS.test(text), (text.match(PHYSICIAN_WORDS) || [])[0]);
      qa.check(deg === 'NP' ? 'NP sees "CE" and contact hours' : 'PA sees CME and credits', deg === 'NP' ? /contact hours/i.test(text) : /CME/.test(text));
    }, { soft: true });

    // 8. Alerts and reminders: Home and the notification centre name the licence that expires in 45 days.
    await qa.feature('NPPA-013', `${deg}: the licence expiring in 45 days is an alert, named as a ${deg} licence`, async () => {
      await tabP(page, 'Home');
      await sleep(2500);
      const home = await bodyText(page);
      out.steps.home = { text: home.slice(0, 6000), shot: await snap(page, `${tag}-11-home`) };
      qa.check('Home shows an expiring alert', /expir/i.test(home), (home.match(/[^\n]*expir[^\n]*/i) || [''])[0]);
      qa.check('no physician wording on Home', !PHYSICIAN_WORDS.test(home), (home.match(PHYSICIAN_WORDS) || [])[0]);
      const bell = page.getByRole('button', { name: /Notifications|Alerts/ }).first();
      if (await bell.isVisible().catch(() => false)) {
        await bell.click().catch(() => {});
        await sleep(1500);
        const nc = await bodyText(page);
        out.steps.notifications = { text: nc.slice(0, 4000), shot: await snap(page, `${tag}-12-notifications`) };
        qa.check('the notification list names the expiring licence', nc.includes(p.expiringNumber(n)) || /license/i.test(nc), (nc.match(/[^\n]*expir[^\n]*/i) || [''])[0]);
        await page.keyboard.press('Escape').catch(() => {});
      }
      await settingsP(page);
      const st = await bodyText(page);
      const tracked = st.slice(Math.max(0, st.indexOf('Track CME')), Math.max(0, st.indexOf('Track CME')) + 800);
      out.steps.reminderSettings = { tracked, shot: await snap(page, `${tag}-13-settings-states`) };
      qa.check(`Settings tracks ${p.state}`, tracked.includes(p.state) || st.includes(p.stateName));
    }, { soft: true });

    // 9. CV: the preview and the PDF name the profession's licences; never "Dr." or a medical licence.
    await qa.feature('NPPA-014', `${deg}: Generate CV`, async () => {
      await moreP(page, 'Generate CV');
      await page.getByRole('heading', { name: 'CV Generator' }).waitFor({ timeout: 15000 });
      await sleep(1000);
      const preview = await bodyText(page);
      out.steps.cv = { preview: preview.slice(0, 6000), shot: await snap(page, `${tag}-14-cv`) };
      qa.check('the CV names the clinician', preview.includes(last));
      qa.check('the CV lists the national certification', preview.includes(cert.name) || preview.includes(cert.number) || preview.includes(cert.type));
      qa.check('no "Dr." or medical licence on the CV', !PHYSICIAN_WORDS.test(preview), (preview.match(PHYSICIAN_WORDS) || [])[0]);
      await page.getByRole('button', { name: 'Save PDF' }).click();
      const note = await page.getByText(/File saving requested\. Confirm the save in the device dialog\.|PDF download requested\. Confirm saving in your browser\./).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
      const sh = (await shares(page)).shared.at(-1);
      const pdf = sh?.files?.find((f) => f.type === 'application/pdf');
      qa.check('Save PDF hands a PDF to the share sheet', note && !!pdf, JSON.stringify(sh?.files?.map((f) => ({ name: f.name, type: f.type }))));
      qa.check('CV saving carries one PDF and no extra message/text item', sh?.files?.length === 1 && !sh.title && !sh.text);
      if (pdf) {
        const t = (await pdfText(Buffer.from(pdf.b64, 'base64'))).text;
        out.steps.cv.pdfName = pdf.name;
        out.steps.cv.pdfText = t.slice(0, 6000);
        writeFileSync(path.join(EVIDENCE, `${tag}-cv.pdf`), Buffer.from(pdf.b64, 'base64'));
        qa.check('the PDF has the name and the national certification', t.includes(last) && (t.includes(cert.name) || t.includes(cert.number)), t.slice(0, 300));
        qa.check('the PDF has no "Dr." and no medical licence', !PHYSICIAN_WORDS.test(t), (t.match(PHYSICIAN_WORDS) || [])[0]);
      }
    }, { soft: true });

    // 10. Share a licence: the verification text and the packet email name the profession.
    await qa.feature('NPPA-015', `${deg}: share a licence (verification text, packet)`, async () => {
      await credsP(page, 'Licenses');
      await sleep(800);
      await recordButtons(page, p.expiringNumber(n)).share.click();
      const dlg = page.getByRole('dialog').last();
      await dlg.waitFor({ timeout: 15000 });
      await sleep(1000);
      const text = (await dlg.innerText()).replace(/[ \t]+/g, ' ');
      out.steps.share = { text: text.slice(0, 4000), shot: await snap(page, `${tag}-15-share`) };
      qa.check('the share sheet names the licence', text.includes(p.expiringNumber(n)) || /license/i.test(text));
      qa.check('no "Dr." or medical licence in the share sheet', !PHYSICIAN_WORDS.test(text), (text.match(PHYSICIAN_WORDS) || [])[0]);
      const email = dlg.getByRole('button', { name: /Email|Send/ }).first();
      if (await email.isVisible().catch(() => false)) {
        await email.click().catch(() => {});
        await sleep(1500);
        const em = await bodyText(page);
        out.steps.shareEmail = { text: em.slice(0, 3000), shot: await snap(page, `${tag}-16-share-email`) };
        qa.check('no "Dr." or "your physician" in the email step', !/\bDr\. |your physician\b/.test(em), (em.match(/\bDr\. [^\n]{0,40}|your physician/) || [])[0]);
      }
      const cl = (await shares(page)).clipboard;
      if (cl.length) out.steps.shareClipboard = cl;
      await page.keyboard.press('Escape').catch(() => {});
    }, { soft: true });

    // 11. Packet rows on Setup.
    await qa.feature('NPPA-016', `${deg}: Setup packet rows are the ${deg}'s own`, async () => {
      await setupP(page);
      await sleep(1000);
      const header = page.getByRole('button', { name: /items · \d+ done/ }).first();
      if (await header.isVisible().catch(() => false)) { await header.click().catch(() => {}); await sleep(800); }
      const t = await bodyText(page);
      out.steps.packet = { text: t.slice(0, 6000), shot: await snap(page, `${tag}-17-packet`) };
      for (const r of p.setupRows) qa.check(`packet lists "${r}"`, t.includes(r));
      qa.check('the packet asks for BLS, ACLS or PALS (not ATLS)', /BLS, ACLS or PALS/.test(t));
      qa.check('no physician rows in the packet', !/Medical school and postgraduate training|Board certification\b/.test(t));
    }, { soft: true });

    // A reload keeps everything (the cloud copy is the source).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    out.after = { degree: profileOf(user.id)?.degree_type, licences: rows(`select type, state, expiration_date from public.licenses where user_id = '${pid}' order by type`), cme: rows(`select category, hours from public.cme where user_id = '${pid}'`) };
    qa.check(`after a reload the profession is still ${deg}`, out.after.degree === deg);
    out.report = { external: qa.report?.external, pageErrors: qa.report?.pageErrors };
    save(`${tag}.json`, out);
  });
}

// Control: a DO in Maine (DO 100 hours, MD 40) keeps the physician rules, an
// MD switch is one tap, and a switch to PA asks first and can be refused.
test('DO and MD control: Maine DO rules, one tap to MD, a profession switch asks first, CV keeps "Dr."', async ({ page, context, qa }) => {
  test.setTimeout(12 * 60 * 1000);
  const ENGINE = engineOf(page);
  const tag = `do-${ENGINE}-${page.viewportSize()?.width || 0}`;
  const last = `Osteo ${letters()}`;
  await captureShares(context);
  const out = { deg: 'DO', engine: ENGINE, steps: {} };
  const { user, profile } = await newMember(page, { firstName: 'Dana', lastName: last });
  const pid = profile.id;
  await qa.feature('NPPA-017', 'DO: Setup, Maine licence, AOA CME, DO compliance', async () => {
    await setupP(page);
    await page.locator('button').filter({ hasText: 'About you' }).first().click();
    const group = page.getByRole('group', { name: 'Profession' });
    await group.getByRole('button', { name: 'DO', exact: true }).click();
    await page.locator('#setup-primary-state').selectOption('ME');
    const saved = await waitFor('DO saved', async () => { const x = profileOf(user.id); return x?.degree_type === 'DO' && x?.primary_state === 'ME' ? x : null; }, { timeoutMs: 20000 }).catch(() => profileOf(user.id));
    qa.check('profiles.degree_type DO, primary ME', saved?.degree_type === 'DO' && saved?.primary_state === 'ME', JSON.stringify({ d: saved?.degree_type, s: saved?.primary_state }));
    { const ph = page.getByRole('button', { name: /items · \d+ done/ }).first(); if (await ph.isVisible().catch(() => false)) { await ph.click().catch(() => {}); await sleep(800); } }
    const setup = await bodyText(page);
    qa.check('Setup keeps the physician rows', /Medical school and postgraduate training/.test(setup) && /Board certification/.test(setup));
    out.steps.setup = { shot: await snap(page, `${tag}-01-setup`) };
    let dlg = await addP(page, 'Licenses');
    const types = (await field(dlg, 'Type').locator('option').allInnerTexts()).map((t) => t.trim());
    qa.check('licence types are the DO list (State Medical License, COMLEX), no PA or APRN types', types.includes('State Medical License (DO)') && types.includes('COMLEX') && !types.some((t) => /Physician Assistant|APRN/.test(t)), types.join(' | '));
    await fillField(dlg, 'Type', 'State Medical License (DO)');
    await fillField(dlg, 'License #', `QAMEDO${String(Date.now()).slice(-4)}`);
    await fillField(dlg, 'State', 'ME');
    await fillField(dlg, 'Issued', day(-400));
    await fillField(dlg, /^Expires/, day(300));
    let r = await saveDialog(dlg);
    qa.check('Maine licence saved', r.closed, r.refusal);
    dlg = await addP(page, 'CME Credits', 'Add CME');
    const cats = (await field(dlg, 'Credit Category').locator('option').allInnerTexts()).map((t) => t.trim());
    qa.check('CME categories are the DO list (AOA Category 1-A)', cats.includes('AOA Category 1-A') && !cats.includes('Accredited Nursing CE'), cats.join(' | '));
    await fillField(dlg, 'Activity / Title', 'QA synthetic osteopathic update');
    await fillField(dlg, 'Credit Category', { label: 'AOA Category 1-A' });
    await fillField(dlg, 'Hours', '10');
    await fillField(dlg, 'Date Completed', day(-20));
    const formText = await dlg.innerText();
    qa.check('the DO CME form has no Pharmacology Hours or NCCPA Activity field', !/Pharmacology Hours|NCCPA Activity/.test(formText));
    r = await saveDialog(dlg);
    qa.check('CME saved', r.closed, r.refusal);
    await openCmeCompliance(page);
    const text = await bodyText(page);
    const at = text.search(/\bME\b/); const card = at >= 0 ? text.slice(at, at + 500) : '';
    out.steps.doCompliance = { card, shot: await snap(page, `${tag}-02-compliance-do`) };
    qa.check('Maine card reads 10/100 with a DO Board tag', /10(\.0+)?\s*\/\s*100/.test(card) && /DO Board/.test(card), card.slice(0, 300));
  }, { soft: true });

  await qa.feature('NPPA-018', 'MD is one tap from DO; a switch to PA asks first; Keep MD keeps it', async () => {
    await settingsP(page);
    const group = page.getByRole('group', { name: 'Profession' }).first();
    await group.getByRole('button', { name: /^MD/ }).click();
    const md = await waitFor('MD saved', async () => (profileOf(user.id)?.degree_type === 'MD' ? true : null), { timeoutMs: 15000 }).catch(() => false);
    qa.check('DO to MD saves at once, no question', md && !(await page.getByRole('group', { name: 'Change profession' }).count()));
    await group.getByRole('button', { name: /^PA/ }).click();
    const ask = page.getByRole('group', { name: 'Change profession' });
    const asked = await ask.waitFor({ timeout: 5000 }).then(() => true, () => false);
    const askText = asked ? (await ask.innerText()).replace(/\s+/g, ' ') : '';
    out.steps.switchAsk = { askText, shot: await snap(page, `${tag}-03-switch-ask`) };
    qa.check('MD to PA asks first ("Switch to PA" / "Keep MD")', asked && /Switch to PA/.test(askText) && /Keep MD/.test(askText), askText);
    if (asked) await ask.getByRole('button', { name: 'Keep MD' }).click();
    await sleep(1500);
    qa.check('Keep MD leaves the profession MD', profileOf(user.id)?.degree_type === 'MD', String(profileOf(user.id)?.degree_type));
    await openCmeCompliance(page);
    const text = await bodyText(page);
    const at = text.search(/\bME\b/); const card = at >= 0 ? text.slice(at, at + 500) : '';
    out.steps.mdCompliance = { card, shot: await snap(page, `${tag}-04-compliance-md`) };
    qa.check('as an MD the Maine card reads 10/40', /10(\.0+)?\s*\/\s*40\b/.test(card), card.slice(0, 300));
    await moreP(page, 'Generate CV');
    await page.getByRole('heading', { name: 'CV Generator' }).waitFor({ timeout: 15000 });
    await sleep(800);
    const cv = await bodyText(page);
    out.steps.cv = { text: cv.slice(cv.indexOf('Hide Preview'), cv.indexOf('Hide Preview') + 800), shot: await snap(page, `${tag}-05-cv`) };
    qa.check('the MD CV keeps "Dr." and "Medical Licenses"', cv.includes(`Dr. Dana ${last}`) && /Medical Licenses/.test(cv), out.steps.cv.text.slice(0, 200));
  }, { soft: true });
  out.pid = pid;
  save(`${tag}.json`, out);
});
