// MD and DO golden cases for the PA and NP work (DESIGN 7.1). Not a test file
// itself: scripts/capture-profession-golden.mjs writes the hashes these cases
// produce at the base commit, and tests/profession/md-do-golden.test.mjs
// recomputes them on every run. Any byte that moves for an MD or a DO fails.
//
// Synthetic data only. Time is frozen at 2026-10-01 local noon, and every Date
// is written as a local calendar day, so the files match in any time zone.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));

export const BASE_COMMIT = '5c53366d';
export const FROZEN = [2026, 9, 1, 12, 0, 0];
export const FULL_STATES = ['TX', 'CA', 'OH', 'CO', 'NY', 'WV'];

const RealDate = globalThis.Date;

/** Run fn with Date frozen at FROZEN (local). */
export async function withFrozenDate(fn) {
  const now = new RealDate(...FROZEN).getTime();
  class FrozenDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(now); else super(...a); }
    static now() { return now; }
  }
  globalThis.Date = FrozenDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

/** One bundle of every module the cases read, so extensionless imports resolve. */
export async function loadModules() {
  const contents = [
    ['compliance', 'src/utils/compliance.js'],
    ['stateReqs', 'src/constants/stateRequirements.js'],
    ['types', 'src/constants/credentialTypes.js'],
    ['topics', 'src/constants/cmeTopics.js'],
    ['renewal', 'src/utils/renewalRoute.js'],
    ['npi', 'src/utils/npiImport.js'],
    ['notifications', 'src/utils/notifications.js'],
    ['setup', 'src/utils/setupTasks.js'],
    ['helpers', 'src/utils/helpers.js'],
    ['credit', 'src/constants/creditEquivalence.js'],
    ['board', 'src/utils/boardCompliance.js'],
    ['evidence', 'src/utils/assistantEvidence.js'],
    ['assistant', 'src/utils/assistant.js'],
    ['viewer', 'src/utils/memberViewer.js'],
    ['presentation', 'src/utils/cmePresentation.js'],
    ['cv', 'src/utils/cvContent.js'],
    ['invoice', 'src/utils/invoiceCover.js'],
    ['scanner', 'src/utils/scannerCore.js'],
    ['cmeImport', 'src/utils/cmeImport.js'],
    ['forms', 'src/utils/credentialForms.js'],
    ['topicSources', 'src/utils/cmeTopicSources.js'],
  ].map(([name, path]) => `export * as ${name} from ${JSON.stringify(`./${path}`)};`).join('\n');
  const out = await build({
    stdin: { contents, resolveDir: root, loader: 'js' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'pdfjs-dist', 'jspdf', 'jspdf-autotable', 'xlsx', 'mammoth', 'jszip', 'docx'],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Plain data: Dates as local days, functions named, keys sorted. */
export function normalize(v, seen = new WeakSet()) {
  if (v instanceof RealDate) return Number.isNaN(v.getTime()) ? 'Invalid Date' : `<date ${localDay(v)}>`;
  if (typeof v === 'function') return '<fn>';
  if (typeof v === 'number' && !Number.isFinite(v)) return `<${v}>`;
  if (v === undefined) return '<undefined>';
  if (!v || typeof v !== 'object') return v;
  if (seen.has(v)) return '<cycle>';
  seen.add(v);
  if (v instanceof Map) v = Object.fromEntries(v);
  if (v instanceof Set) v = [...v];
  if (Array.isArray(v)) { const r = v.map(x => normalize(x, seen)); seen.delete(v); return r; }
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = normalize(v[k], seen);
  seen.delete(v);
  return out;
}

export const stableJson = (v) => JSON.stringify(normalize(v));
export const sha = (v) => createHash('sha256').update(stableJson(v)).digest('hex');

// ── Synthetic fixtures ──────────────────────────────────────────────

const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d); };

function cmeFixtures(m) {
  const topics = new Set(m.topics.CME_TOPICS);
  for (const e of Object.values(m.stateReqs.STATE_REQS)) {
    for (const r of (e.md || e.do) ? [e.md, e.do].filter(Boolean) : [e]) for (const t of r.topics || []) topics.add(t.topic);
  }
  const cats = [...new Set([...m.types.CME_CATEGORIES_MD, ...m.types.CME_CATEGORIES_DO])];
  let id = 0;
  const entry = (category, hours, date, tags = []) => ({ id: `cme-${++id}`, title: `Synthetic activity ${id}`, category, hours: String(hours), date, topics: tags });
  const mixed = [];
  cats.forEach((c, i) => mixed.push(entry(c, 3 + (i % 4) * 2.25, dayOffset(-30 - i * 11))));
  [...topics].forEach((t, i) => mixed.push(entry(i % 3 ? 'AMA PRA Category 1' : 'AOA Category 1-A', 1 + (i % 5) * 0.5, dayOffset(-60 - i * 7), [t])));
  mixed.push(entry('AMA PRA Category 1', 4, dayOffset(-1500), ['Opioid Prescribing']));
  mixed.push(entry('AMA PRA Category 1', 2.5, dayOffset(-2600), ['Substance Use Disorders', 'Suicide Prevention']));
  mixed.push(entry('AMA PRA Category 1', 1, '', ['Ethics']));
  // Boundary: on the anchored window's first and last day (exp 2027-03-31,
  // 2-year cycle opens 2025-03-31), the day before and the day after.
  const boundary = [
    entry('AMA PRA Category 1', 10, '2025-03-31', ['Pain Management']),
    entry('AOA Category 1-A', 10, '2027-03-31', ['Implicit Bias']),
    entry('AMA PRA Category 1', 7, '2025-03-30'),
    entry('AOA Category 1-B', 7, '2027-04-01'),
    entry('AMA PRA Category 2', 0.1, '2026-01-02'), entry('AMA PRA Category 2', 0.2, '2026-01-03'),
  ];
  return { empty: [], mixed, boundary };
}

function conditionAnswers(m) {
  const out = {};
  for (const e of Object.values(m.stateReqs.STATE_REQS)) {
    for (const r of (e.md || e.do) ? [e.md, e.do].filter(Boolean) : [e]) for (const t of r.topics || []) if (t.condition) out[t.condition.field] = 'Yes';
  }
  return out;
}

const OPTS = (m) => ({
  rolling: {},
  anchored: { licenseExpiration: '2027-03-31', licenseIssued: '2025-11-15', hasDEA: true, topicApplicability: conditionAnswers(m) },
  custom: { licenseExpiration: '2026-12-31', cycleStart: '2025-06-01', hasDEA: true, topicApplicability: { 'California geriatric CME applies': 'No' } },
  badStart: { licenseExpiration: '2026-11-30', cycleStart: '2027-01-01' },
});

function licenceFixture(deg) {
  const med = deg === 'DO' ? 'State Medical License (DO)' : 'State Medical License';
  return [
    { id: 'l1', type: med, name: 'TX Medical License', state: 'TX', licenseNumber: 'Q1000', expirationDate: dayOffset(40), issuedDate: '2024-11-01', customFields: { 'California geriatric CME applies': 'Yes' } },
    { id: 'l2', type: med, name: 'CA Medical License', state: 'CA', licenseNumber: 'A2000', expirationDate: dayOffset(400), cmeCycleStart: dayOffset(-200) },
    { id: 'l3', type: med, name: 'OH Medical License', state: 'OH', licenseNumber: '35.3000', expirationDate: '', dateUnknown: true },
    { id: 'l4', type: med, name: 'CO Medical License', state: 'CO', licenseNumber: 'DR4000', expirationDate: dayOffset(-5) },
    { id: 'l5', type: med, name: 'NY Medical License', state: 'NY', licenseNumber: '500000', expirationDate: dayOffset(700), status: 'historical' },
    { id: 'l6', type: 'DEA Registration', name: 'DEA Registration', state: 'TX', licenseNumber: 'AB1234563', expirationDate: dayOffset(20) },
    { id: 'l7', type: 'State Controlled Substance', name: 'TX CSR', state: 'TX', licenseNumber: 'C7000', expirationDate: dayOffset(100) },
    { id: 'l8', type: 'BLS Certification', name: 'BLS', expirationDate: dayOffset(300) },
    { id: 'l9', type: deg === 'DO' ? 'Board Certification (AOA)' : 'Board Certification (ABMS)', name: deg === 'DO' ? 'AOBS Neurological Surgery' : 'ABNS Neurological Surgery', expirationDate: dayOffset(900) },
    { id: 'l10', type: med, name: 'WV Medical License', state: 'WV', licenseNumber: '9000', expirationDate: '', pendingConfirmation: true },
  ];
}

function dataFixture(m, deg, cme) {
  return {
    settings: {
      name: 'Alex Example', degreeType: deg, primaryState: 'TX', additionalStates: ['CA', 'FL', 'WV'], npi: '1234567893',
      specialties: deg === 'DO' ? ['AOA:NS'] : ['ABMS:NS'], email: 'alex@example.test', notifyEmail: true, reminderLeadDays: 90,
      address: '1 Synthetic Way', phone: '555-0100',
    },
    licenses: licenceFixture(deg), cme, privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [
      { id: 'e1', type: deg === 'DO' ? 'Doctor of Osteopathic Medicine (DO)' : 'Doctor of Medicine (MD)', institution: 'Synthetic School', graduationDate: '2010-05-15' },
      { id: 'e2', type: 'Residency Certificate', institution: 'Synthetic Hospital', graduationDate: '2016-06-30' },
    ],
    workHistory: [{ id: 'w1', type: 'Full-Time Employed', employer: 'Synthetic Clinic', startDate: '2016-07-01', current: true }],
    documents: [], customRecords: [], customCategories: [], alertAcks: [], memberships: [], peerReferences: [], travelDocs: [], professionalPhotos: [],
  };
}

const CREDENTIAL_STRINGS = ['MD', 'M.D.', 'DO', 'D.O.', 'MD, PHD', 'DO FACOS', 'OD', 'DMD', 'DDS', '', 'PA-C', 'NP', 'FNP-BC', 'DNP', 'MD, PA', 'CRNP', 'RN'];

// ── The cases ───────────────────────────────────────────────────────

/** name -> value, for MD and DO. */
export function buildCases(m) {
  const cases = {};
  const put = (name, fn) => { try { cases[name] = fn(); } catch (e) { cases[name] = { threw: String(e?.message || e) }; } };
  const today = new Date().toLocaleDateString();
  const scrub = (s) => typeof s === 'string' ? s.split(today).join('<today>') : s;
  const keys = [...Object.keys(m.stateReqs.STATE_REQS), 'ZZ'];
  const fixtures = cmeFixtures(m);
  const opts = OPTS(m);

  for (const deg of ['MD', 'DO']) {
    // Rules
    for (const st of keys) {
      put(`rules:getStateReq:${st}:${deg}`, () => m.stateReqs.getStateReq(st, deg));
      put(`rules:getStateEntry:${st}:${deg}`, () => m.stateReqs.getStateEntry(st, deg));
      put(`rules:hasSeparateBoards:${st}:${deg}`, () => !!m.stateReqs.hasSeparateBoards(st));
    }
    // Engine
    for (const st of keys) {
      for (const [fx, cme] of Object.entries(fixtures)) {
        for (const [on, o] of Object.entries(opts)) {
          put(`engine:${st}:${deg}:${fx}:${on}`, () => {
            const comp = m.compliance.computeCompliance(cme, st, deg, o);
            return { comp, notes: m.compliance.windowNotes(comp), label: m.presentation.cmeAssessmentLabel(comp), hours: m.presentation.totalHoursLabel(comp) };
          });
        }
      }
    }
    const data = dataFixture(m, deg, fixtures.mixed);
    const lic = data.licenses;
    put(`gates:${deg}`, () => ({
      tracked: m.compliance.trackedStates('TX', ['CA', 'FL'], lic),
      alerting: m.compliance.alertingStates('TX', ['CA', 'FL'], lic),
      find: ['TX', 'CA', 'OH', 'CO', 'NY', 'WV', 'FL'].map(st => [st, m.compliance.findStateLicense(lic, st)?.id ?? null, m.compliance.resolvePendingLicense(lic, st)?.id ?? null]),
      dea: m.compliance.hasDEARegistration(lic),
    }));
    for (const st of ['TX', 'CA', 'FL', 'WV', 'OH', 'CO', 'NY']) put(`complianceFor:${st}:${deg}`, () => m.compliance.complianceFor(data, st));
    const list = () => (m.compliance.complianceListFor
      ? m.compliance.complianceListFor(data).map(({ st, comp, lic: l }) => ({ st, comp, lic: l }))
      : m.compliance.trackedStates(data.settings.primaryState, data.settings.additionalStates, data.licenses)
        .map(st => ({ st, comp: m.compliance.complianceFor(data, st), lic: m.compliance.findStateLicense(data.licenses, st) })));
    put(`list:${deg}`, list);
    put(`standing:${deg}`, () => m.compliance.standingScore({ items: data.licenses, missingRequired: [], stateComps: list(), leadDays: 90 }));
    put(`review:${deg}`, () => m.presentation.cmeReviewSummary(list()));
    put(`alerts:${deg}`, () => {
      const alerts = m.notifications.generateAlerts(data);
      return { alerts, message: scrub(m.notifications.buildNotificationMessage(data, alerts)) };
    });
    put(`viewer:${deg}`, () => m.viewer.stateCmeCards({ member: { name: 'Alex Example', degreeType: deg, primaryState: 'TX', additionalStates: ['CA', 'FL'], reminderLeadDays: 90 }, sections: { licenses: data.licenses, cme: data.cme } }));
    put(`snapshot:${deg}`, () => {
      const snap = m.assistant.buildSnapshot(data, ['TX', 'CA', 'FL', 'WV']);
      return { physician: snap.physician, cmeSummary: snap.cmeSummary, referenceEvidence: snap.referenceEvidence, renewalInfo: snap.renewalInfo, licenses: snap.licenses };
    });

    // Vocabulary
    put(`vocab:${deg}`, () => ({
      licenseTypes: m.types.getLicenseTypes(deg), categories: m.types.getCMECategories(deg),
      education: m.types.EDUCATION_TYPES, topics: m.topics.CME_TOPICS, refs: m.types.REFERENCE_RELATIONSHIPS,
      nonExpiring: m.types.NON_EXPIRING_LICENSE_TYPES, nonExpiringOf: m.types.getLicenseTypes(deg).map(t => m.types.isInherentlyNonExpiringLicense(t)),
    }));
    put(`forms:${deg}`, () => m.types.getLicenseTypes(deg).map(type => m.forms.licenseFields({ degreeType: deg }).map(f => ({
      key: f.key, label: typeof f.label === 'function' ? f.label({ type }) : f.label,
      placeholder: typeof f.placeholder === 'function' ? f.placeholder({ type }) : f.placeholder,
      shown: typeof f.show === 'function' ? !!f.show({ type }) : true,
      required: typeof f.required === 'function' ? !!f.required({ type }) : !!f.required,
      options: f.options,
    }))));

    // Routing
    for (const st of keys) {
      put(`route:${st}:${deg}`, () => m.renewal.renewalRoute(st, deg));
      for (const type of [m.types.getLicenseTypes(deg)[0], 'DEA Registration', 'State Controlled Substance', 'BLS Certification', 'Other']) {
        put(`view:${st}:${deg}:${type}`, () => m.renewal.renewalView({ id: 'x', type, state: st, expirationDate: dayOffset(45) }, deg));
      }
    }

    // Credit labels
    put(`credit:${deg}`, () => {
      const accepted = [['AMA PRA Category 1'], ['AOA Category 1-A'], ['AOA Category 1-A', 'AOA Category 1-B'], ['AMA PRA Category 1', 'AOA Category 1-A'], []];
      const start = new Date(2024, 9, 1), end = new Date(2026, 9, 1);
      return accepted.map(a => ({ label: m.credit.cat1BucketLabel(a, deg), breakdown: m.credit.cat1Breakdown(fixtures.mixed, { start, end, accepted: a, degreeType: deg }) }));
    });

    // Boards
    put(`board:${deg}`, () => ({ ids: m.board.boardIdsFromLicenses(data.licenses), comp: m.board.boardComplianceFor(data), aoa: deg === 'DO' ? m.board.aoaNationalEntry(data) : null }));

    // Vera evidence
    for (const st of keys) {
      put(`evidence:${st}:${deg}`, () => ({ j: m.evidence.jurisdictionEvidence(st, deg), r: m.evidence.renewalEvidence(st, deg) }));
    }
    put(`evidence:calc:${deg}`, () => ['TX', 'CA', 'OH'].map(st => m.evidence.calculationEvidence(m.compliance.complianceFor(data, st), deg, '2026-10-01')));
    put(`evidence:saved:${deg}`, () => m.evidence.savedReferenceContext(['TX', 'CA', 'PA', 'MD'], deg));
    put(`evidence:turn:${deg}`, () => [
      [{ role: 'user', content: "I'm an MD in Maryland" }],
      [{ role: 'user', content: 'What do I need in PA and NY?' }],
      [{ role: 'user', content: 'Pennsylvania CME' }, { role: 'assistant', content: 'Which state?' }, { role: 'user', content: 'and Texas' }],
    ].map(h => m.evidence.evidenceForTurn({ physician: { degree: deg, states: ['TX'] } }, h)));
    put('evidence:instructions', () => m.evidence.EVIDENCE_INSTRUCTIONS);
    put(`topicSources:${deg}`, () => ['Pain Management', 'Opioid Prescribing', 'Implicit Bias', 'Human Trafficking'].map(t => m.topicSources.topicSources(t, ['TX', 'CA', 'FL', 'WV'], deg)));

    // Prompts and import
    put(`scanner:${deg}`, () => m.scanner.SYSTEM_PROMPT(deg, ['Hospital ID Badges']));
    put(`scannerPdf:${deg}`, () => m.scanner.scanPdfText(deg));
    put(`mapCredit:${deg}`, () => ['', 'AMA PRA Category 1', 'Category 1', 'cat 2', 'AOA 1-A', '1-b', 'contact hours', 'CE', 'ANCC contact hours', 'AAPA Category 1 CME', 'self assessment', 'moc part iv', 'grand rounds', 'live', 'Pharmacology 5', 'nursing CE'].map(r => m.cmeImport.mapCreditType(r, deg)));

    // Setup
    put(`setup:${deg}`, () => {
      const shape = (b) => ({
        tasks: b.tasks.map(t => ({ id: t.id, status: t.status, done: t.done, locked: t.locked, label: t.label, why: t.why, detail: t.detail, cardLine: t.cardLine, nextPhrase: t.nextPhrase })),
        open: b.open.map(t => t.id), next: b.next?.id ?? null, counts: b.counts,
      });
      const empty = { settings: { name: 'Alex Example', degreeType: deg, primaryState: 'TX' }, licenses: [], cme: [] };
      return [shape(m.setup.buildSetup(empty)), shape(m.setup.buildSetup(data)), shape(m.setup.buildSetup(data, { isPro: true }))];
    });

    // NPPES
    put(`npi:${deg}`, () => ({
      type: m.npi.licenseTypeFor(deg),
      merged: m.npi.mergeNpiLicenses([{ state: 'TX', licenseNumber: 'Q-1000' }], [
        { state: 'TX', licenseNumber: 'Q1000', taxonomyCode: '207T00000X', description: 'Neurological Surgery' },
        { state: 'CA', licenseNumber: 'A2000', taxonomyCode: '207T00000X', description: '' },
        { state: 'FL', licenseNumber: 'PA9000', taxonomyCode: '363A00000X', description: 'Physician Assistant' },
        { state: 'NY', licenseNumber: 'RN1', taxonomyCode: '163W00000X', description: 'Registered Nurse' },
        { state: 'NY', licenseNumber: 'NP1', taxonomyCode: '363LF0000X', description: 'Nurse Practitioner, Family' },
        { state: '', licenseNumber: 'X' },
      ], { degreeType: deg, makeId: (() => { let i = 0; return () => `id${++i}`; })() }),
    }));

    // Documents
    const licItem = data.licenses[0];
    put(`share:${deg}`, () => ({
      text: scrub(m.helpers.buildCredentialText(licItem, 'licenses', data.settings)),
      blurb: scrub(m.helpers.buildCredentialBlurb(licItem, 'licenses', data.settings, true, 'Synthetic note')),
      subject: m.helpers.buildEmailSubject(licItem, 'licenses', data.settings),
      noName: scrub(m.helpers.buildCredentialText(licItem, 'licenses', { ...data.settings, name: '' })),
      noNameBlurb: scrub(m.helpers.buildCredentialBlurb(licItem, 'licenses', { ...data.settings, name: '' }, false, '')),
    }));
    put(`cv:${deg}`, () => m.cv.buildCvContent(data));
    put(`cvNoName:${deg}`, () => m.cv.buildCvContent({ ...data, settings: { ...data.settings, name: '' } }));
  }
  // Degree-independent tables.
  put('npi:degreeFromCredential', () => CREDENTIAL_STRINGS.map(c => [c, m.npi.degreeFromCredential(c)]));
  put('invoice', () => {
    const inv = { number: 'INV-1', physician: 'Alex Example, MD', facility: 'Synthetic Hospital', agency: 'Synthetic Agency', periodStart: '2026-08-01', periodEnd: '2026-08-15', total: 1500, paid: 0, npi: '1234567893', email: 'alex@example.test' };
    return { blurb: m.invoice.invoiceCoverBlurb(inv), email: m.invoice.invoiceCoverEmail(inv), noName: m.invoice.invoiceCoverBlurb({ ...inv, physician: '' }) };
  });
  return cases;
}

/** { hashes, full } for the golden files. */
export async function computeGolden() {
  const m = await loadModules();
  return withFrozenDate(() => {
    const cases = buildCases(m);
    const hashes = {};
    for (const [k, v] of Object.entries(cases)) hashes[k] = sha(v);
    const full = {};
    for (const [k, v] of Object.entries(cases)) {
      if (FULL_STATES.some(st => k.startsWith(`engine:${st}:`) && k.endsWith(':mixed:anchored'))) full[k] = normalize(v);
    }
    return { hashes, full };
  });
}
