// Administrator access (a standing, view-only credential share): the section
// catalog, how a live view reads, the invitation text, and the owner allowlist.
//
// Pure on purpose. The Edge handler, the owner UI (src/) and plain node tests
// all import this one module, so the sections the owner is offered, the
// labels the administrator sees and the checks the server makes cannot drift.
// The authoritative allowlist is SQL (credential_portal_shareable_sections and
// credential_portal_records in 20260925040000_credential_portal_admin_access.sql);
// tests/credential-portal/standing.test.mjs fails if this catalog and that list
// ever disagree. shapeView below is a SECOND filter: only the keys named here
// ever leave the server, whatever the SQL returns.

export const ADMIN_ACCESS_POLICY = Object.freeze({
  durations: Object.freeze([14, 30, 90, 180]),
  defaultDays: 30,
  maxDays: 180,
  purposeMax: 120,
  visitMinutes: 60,
  maxCustomCategories: 50,
});

// Fixed owner-facing line. Enforced by the SQL allowlist, not by this text.
export const ADMIN_ACCESS_NEVER_SHARED = 'Passport and travel IDs, receipts, taxes, invoices, contracts, unfiled uploads';

// Collections that are never offered and never shown (document for the tests;
// the SQL simply has no branch for them).
export const ADMIN_ACCESS_DENIED = Object.freeze([
  'travelDocs', 'travelExpenses', 'taxPayments', 'invoices', 'deductibles', 'locumContracts', 'workLog', 'encounters',
  'scheduleDays', 'dutyDays', 'rotations', 'taskNotes', 'shareLog', 'notificationLog', 'alertAcks', 'followUps',
  'identityVault', 'answerBank', 'documents', 'customCategories', 'customRecords',
]);

const f = (key, label, kind = 'text') => Object.freeze({ key, label, kind });
const SCREENING_FIELDS = [f('name', 'Name'), f('agency', 'Agency'), f('fileNumber', 'File number'), f('orderDate', 'Ordered', 'date'), f('reportDate', 'Reported', 'date'), f('result', 'Result'), f('expirationDate', 'Expires', 'date'), f('components', 'Searches', 'components')];

/** Every section a standing grant can include, in display order. optIn = off by default. */
export const ADMIN_ACCESS_SECTIONS = Object.freeze([
  { key: 'licenses', label: 'Licenses, DEA and certifications', hint: "Medical licenses, DEA and state controlled substance, boards, life support and other professional certificates. Driver's licenses and ID cards never appear.",
    titleKeys: ['name', 'type'], fields: [f('type', 'Type'), f('licenseNumber', 'Number'), f('state', 'State'), f('issuedDate', 'Issued', 'date'), f('expirationDate', 'Expires', 'date')] },
  { key: 'cme', label: 'CME', hint: 'Certificates, hours and providers.', sortDate: 'date',
    titleKeys: ['title', 'category'], fields: [f('category', 'Category'), f('hours', 'Hours'), f('date', 'Completed', 'date'), f('provider', 'Provider'), f('certificateNumber', 'Certificate number'), f('topics', 'Topics', 'list')] },
  { key: 'privileges', label: 'Hospital privileges', hint: 'Facility, type and dates. Portal links and logins never appear.',
    titleKeys: ['facility', 'name', 'type'], fields: [f('type', 'Privileges'), f('name', 'Name'), f('facility', 'Facility'), f('city', 'City'), f('state', 'State'), f('appointmentDate', 'Appointed', 'date'), f('expirationDate', 'Expires', 'date')] },
  { key: 'insurance', label: 'Malpractice insurance', hint: 'Malpractice, professional liability and tail policies only. Personal health, life and disability policies never appear.',
    titleKeys: ['name', 'provider', 'type'], fields: [f('type', 'Policy type'), f('provider', 'Carrier'), f('policyNumber', 'Policy number'), f('coveragePerClaim', 'Per claim'), f('coverageAggregate', 'Aggregate'), f('effectiveDate', 'Effective', 'date'), f('expirationDate', 'Expires', 'date')] },
  { key: 'education', label: 'Education and training', hint: 'Degrees, residency and fellowship.',
    titleKeys: ['institution', 'name', 'type'], fields: [f('type', 'Degree or program'), f('name', 'Name'), f('institution', 'Institution'), f('fieldOfStudy', 'Field'), f('startDate', 'Started', 'date'), f('graduationDate', 'Completed', 'date'), f('honors', 'Honors')] },
  { key: 'workHistory', label: 'Work history', hint: 'Employers, positions and dates. Reasons for leaving never appear.',
    titleKeys: ['employer', 'position'], fields: [f('position', 'Position'), f('type', 'Employment type'), f('city', 'City'), f('state', 'State'), f('startDate', 'Start', 'date'), f('endDate', 'End', 'date'), f('current', 'Current', 'yes'), f('description', 'Description')] },
  { key: 'healthRecords', label: 'Health clearances', hint: 'Vaccinations, TB tests, fit tests and titers. Drug screens are not in this section.',
    titleKeys: ['name', 'type', 'category'], fields: [f('category', 'Category'), f('type', 'Type'), f('dateAdministered', 'Date', 'date'), f('result', 'Result'), f('resultValue', 'Value'), f('resultUnits', 'Units'), f('referenceRange', 'Reference range'), f('collectedDate', 'Collected', 'date'), f('reportedDate', 'Reported', 'date'), f('lab', 'Lab'), f('lotNumber', 'Lot number'), f('facility', 'Facility'), f('expirationDate', 'Expires', 'date'), f('doses', 'Doses', 'doses')] },
  { key: 'screenings', label: 'Background and screening reports', hint: 'Report type, agency, dates and result. Drug screens and any Flagged or Review result are left out unless you turn them on below. Who requested a screening never appears.',
    titleKeys: ['type', 'name'], fields: SCREENING_FIELDS },
  { key: 'screeningsSensitive', optIn: true, label: 'Drug screens and flagged screenings', hint: 'Off unless you turn it on. Drug screen reports, and any screening whose result is Flagged or Review.',
    titleKeys: ['type', 'name'], fields: SCREENING_FIELDS },
  { key: 'professionalPhotos', label: 'Professional photos', hint: 'Headshots for badges and directories.',
    titleKeys: ['name'], fallbackTitle: 'Professional photo', fields: [f('dateTaken', 'Taken', 'date')] },
  { key: 'publications', label: 'Publications', hint: 'Citations for your CV.',
    titleKeys: ['name', 'citation'], fields: [f('citation', 'Citation'), f('year', 'Year'), f('doi', 'DOI'), f('pmid', 'PMID'), f('url', 'Link')] },
  { key: 'memberships', label: 'Professional memberships', hint: 'Societies and roles. Dues never appear.',
    titleKeys: ['organization', 'name'], fields: [f('name', 'Name'), f('role', 'Role'), f('startDate', 'Since', 'date'), f('endDate', 'Until', 'date'), f('expirationDate', 'Expires', 'date')] },
  { key: 'malpracticeHistory', optIn: true, label: 'Malpractice history', hint: 'Off unless you turn it on. Settlement amounts never appear.',
    titleKeys: ['facility'], fallbackTitle: 'Malpractice case', fields: [f('dateOfIncident', 'Incident', 'date'), f('dateFiled', 'Filed', 'date'), f('state', 'State'), f('outcome', 'Outcome'), f('dateResolved', 'Resolved', 'date'), f('insuranceCarrier', 'Carrier'), f('description', 'Description')] },
  { key: 'peerReferences', optIn: true, label: 'Peer references', hint: "Off unless you turn it on. Shares your references' names and contact details.",
    titleKeys: ['name'], fallbackTitle: 'Reference', fields: [f('degree', 'Degree'), f('specialty', 'Specialty'), f('institution', 'Institution'), f('relationship', 'Relationship'), f('email', 'Email'), f('phone', 'Phone'), f('knownSince', 'Known since'), f('yearsKnown', 'Years known')] },
  { key: 'caseLogs', optIn: true, label: 'Case log summary', hint: 'Off unless you turn it on. Category, date, facility, role, CPT codes and attending only. Case files never appear.', sortDate: 'date',
    titleKeys: ['category'], fallbackTitle: 'Case', fields: [f('date', 'Date', 'date'), f('facility', 'Facility'), f('role', 'Role'), f('cptCodes', 'CPT codes'), f('attending', 'Attending')] },
].map(section => Object.freeze({ optIn: false, ...section, fields: Object.freeze(section.fields) })));

const CUSTOM_SECTION = Object.freeze({
  titleKeys: ['name'], fallbackTitle: 'Record',
  fields: Object.freeze([f('issuer', 'Issued by'), f('number', 'Number / ID'), f('issuedDate', 'Issued', 'date'), f('expirationDate', 'Expires', 'date')]),
});

export const ADMIN_ACCESS_SECTION_KEYS = Object.freeze(ADMIN_ACCESS_SECTIONS.map(s => s.key));
export const ADMIN_ACCESS_DEFAULT_SECTIONS = Object.freeze(ADMIN_ACCESS_SECTIONS.filter(s => !s.optIn).map(s => s.key));
const SECTION = new Map(ADMIN_ACCESS_SECTIONS.map(s => [s.key, s]));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBJECT = /^user_[A-Za-z0-9]+$/;
// Controls and the Unicode line separators; the purpose is one line of text.
const CONTROL = /[\u{0}-\u{1f}\u{7f}\u{2028}\u{2029}]/gu;

/**
 * CREDENTIAL_PORTAL_OWNER_PROFILES: unset or "*" opens administrator access to
 * every active account; otherwise only the listed profile UUIDs. A value that
 * lists nothing valid opens it to nobody.
 */
export function ownerAllowed(setting, profileId) {
  if (setting === undefined || setting === null) return true;
  const value = String(setting).trim();
  if (value === '*') return true;
  const allowed = new Set(value.split(',').map(v => v.trim().toLowerCase()).filter(v => UUID.test(v)));
  return typeof profileId === 'string' && allowed.has(profileId.toLowerCase());
}

export function normalizePurpose(value) {
  if (typeof value !== 'string') return null;
  const purpose = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return purpose.length >= 1 && purpose.length <= ADMIN_ACCESS_POLICY.purposeMax ? purpose : null;
}

/** Owner-chosen scope. Returns null for anything the server would refuse. */
export function normalizeScopeInput({ sections, customCategories } = {}) {
  if (sections !== undefined && !Array.isArray(sections)) return null;
  if (customCategories !== undefined && !Array.isArray(customCategories)) return null;
  const s = sections || [], c = customCategories || [];
  if (s.some(k => typeof k !== 'string' || !SECTION.has(k))) return null;
  if (c.length > ADMIN_ACCESS_POLICY.maxCustomCategories || c.some(id => typeof id !== 'string' || !UUID.test(id))) return null;
  const scope = { sections: [...new Set(s)].sort(), customCategories: [...new Set(c)].sort() };
  return scope.sections.length || scope.customCategories.length ? scope : null;
}

export function normalizeStandingInput(input) {
  if (!input || typeof input !== 'object') return null;
  const purpose = normalizePurpose(input.purpose);
  const scope = normalizeScopeInput(input);
  if (!purpose || !scope || !ADMIN_ACCESS_POLICY.durations.includes(input.accessDays) || typeof input.allowDownload !== 'boolean'
    || typeof input.requestId !== 'string' || !STRICT_UUID.test(input.requestId)) return null;
  return { purpose, accessDays: input.accessDays, allowDownload: input.allowDownload, scope, requestId: input.requestId };
}

/** Only "<one of the owner's subjects>/<this document id>" is ever read. */
export function ownedDocumentPath(subjects, path, documentId) {
  if (!Array.isArray(subjects) || typeof path !== 'string' || typeof documentId !== 'string') return false;
  const match = /^(user_[A-Za-z0-9]+)\/([0-9a-f-]{36})$/.exec(path);
  return !!match && match[2] === documentId && subjects.some(s => typeof s === 'string' && SUBJECT.test(s) && s === match[1]);
}

export function physicianDisplayName(physician) {
  const name = typeof physician?.name === 'string' ? physician.name.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '';
  const degree = typeof physician?.degreeType === 'string' ? physician.degreeType.replace(CONTROL, ' ').trim() : '';
  if (!name) return '';
  if (!degree || new RegExp(`[\\s,]${degree.replace(/[^A-Za-z]/g, '')}\\.?$`, 'i').test(name)) return name;
  return `${name}, ${degree}`;
}

/** An IANA zone the runtime knows (the owner's browser sends it), or null. */
export function validTimeZone(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/.test(value)) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone || null; } catch { return null; }
}

/**
 * When access ends, as the physician set it: the date AND time in their own
 * zone, with the zone named ("October 25, 2026 at 7:00 PM MDT"). A bare UTC
 * date reads a day late for a grant made on a US evening. Falls back to UTC,
 * named as such. Narrow and ordinary no-break spaces some ICU builds put
 * before AM/PM become plain spaces (this is plain-text email).
 */
export function formatAccessEnd(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const zone = validTimeZone(timeZone) || 'UTC';
  const day = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: zone });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: zone });
  return `${day} at ${time}`.replace(/[\u{a0}\u{202f}]/gu, ' ');
}

/** The invitation. Plain text with real line breaks; no dashes as punctuation. */
export function standingInvitationEmail({ physician, purpose, accessEndsAt, allowDownload, link, replyTo, timeZone }) {
  const who = physicianDisplayName(physician);
  if (!who) throw new Error('physician_name_required');
  const lines = [
    `${who} has given you view access to their credential file.`,
    '',
    `Purpose: ${normalizePurpose(purpose) || ''}`,
    `Access ends: ${formatAccessEnd(accessEndsAt, timeZone)}`,
    '',
    'Open the file:',
    link,
    '',
    `Each time you open the link, a 6-digit code is emailed to this address. Enter it to start a visit of up to ${ADMIN_ACCESS_POLICY.visitMinutes} minutes. The link keeps working until the end date unless ${who} ends access sooner.`,
    '',
    allowDownload ? 'You can view the records and download the files that were shared. Nothing can be changed.' : 'You can view the records and files that were shared. Downloads are turned off, and nothing can be changed.',
    '',
    'Please do not forward this email. The code only goes to this address.',
    '',
    replyTo ? `Questions about the file? Reply to this email to reach ${who}.` : `Questions about the file? Contact ${who} directly.`,
    '',
    'CredentialDOMD',
  ];
  return { subject: `Credential file access from ${who}`, text: lines.join('\n'), ...(replyTo ? { replyTo } : {}) };
}

export function standingCodeEmail({ physician, code }) {
  const who = physicianDisplayName(physician);
  return {
    subject: 'Your credential file access code',
    text: [
      `Your CredentialDOMD verification code is ${code}.`,
      '',
      who ? `Use it to open the credential file ${who} shared with you. It expires in 10 minutes.` : 'Use it to open the shared credential file. It expires in 10 minutes.',
      '',
      'Never share this code. If you did not request it, ignore this email.',
    ].join('\n'),
  };
}

// Shaping a view ------------------------------------------------------------
const text = (value, max = 500) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return clean.startsWith('enc1:') ? '' : clean.slice(0, max);
};
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
const strings = (value, max = 40) => Array.isArray(value) ? value.map(v => text(v, 120)).filter(Boolean).slice(0, max) : [];

function fieldValue(field, raw) {
  const value = raw?.[field.key];
  if (field.kind === 'date') return isoDate(value);
  if (field.kind === 'yes') return value === true ? 'Yes' : '';
  if (field.kind === 'list') return strings(value).join(', ');
  if (field.kind === 'doses' || field.kind === 'components') {
    const keys = field.kind === 'doses' ? ['date', 'manufacturer', 'lotNumber', 'facility'] : ['name', 'scope', 'status', 'date'];
    const items = Array.isArray(value) ? value.slice(0, 20).map(item => {
      if (!item || typeof item !== 'object') return '';
      const parts = keys.map(k => k === 'lotNumber' && text(item[k]) ? `lot ${text(item[k], 80)}` : text(item[k], 120)).filter(Boolean);
      const lead = field.kind === 'doses' && text(item.doseNumber) ? `Dose ${text(item.doseNumber, 8)}: ` : '';
      return parts.length ? lead + parts.join(', ') : '';
    }).filter(Boolean) : [];
    return items.join('; ');
  }
  return text(value, field.key === 'description' ? 2000 : 500);
}

function shapeRecord(definition, raw, id, extraFields = []) {
  const titleKey = definition.titleKeys.find(k => text(raw?.[k]));
  const title = titleKey ? text(raw[titleKey], 200) : definition.fallbackTitle || 'Record';
  const fields = [];
  for (const field of definition.fields) {
    if (field.key === titleKey) continue;
    const value = fieldValue(field, raw);
    if (value) fields.push({ label: field.label, value });
  }
  for (const extra of extraFields) fields.push(extra);
  return { id, title, expirationDate: isoDate(raw?.expirationDate) || null, fields, documents: [] };
}

function shapeDocument(d) {
  const size = Number.isInteger(d.sizeBytes) && d.sizeBytes >= 0 ? d.sizeBytes : null;
  return { id: d.id, name: text(d.name, 300) || 'Credential document', mimeType: text(d.mimeType, 120) || 'application/octet-stream', sizeBytes: size };
}

/**
 * credential_portal_view output to what the administrator (and the owner's
 * preview) sees. Unknown sections, keys and documents without a shown record
 * are dropped here even if the SQL ever returned them.
 */
export function shapeView(raw) {
  const physicianRaw = raw?.physician && typeof raw.physician === 'object' ? raw.physician : {};
  const physician = {
    name: text(physicianRaw.name, 200), degreeType: text(physicianRaw.degreeType, 20), npi: text(physicianRaw.npi, 20),
    specialties: strings(physicianRaw.specialties), primaryState: text(physicianRaw.primaryState, 40),
    additionalStates: strings(physicianRaw.additionalStates, 60), email: text(physicianRaw.email, 254),
  };
  const sections = new Map();
  const records = new Map();
  for (const item of Array.isArray(raw?.records) ? raw.records : []) {
    if (!item || typeof item.id !== 'string' || !UUID.test(item.id) || !item.data || typeof item.data !== 'object') continue;
    let key, label, record;
    if (item.section === 'customRecords') {
      const categoryId = item.data.categoryId;
      if (typeof categoryId !== 'string' || !UUID.test(categoryId)) continue;
      key = `custom:${categoryId}`; label = text(item.data.categoryName, 60) || 'Other records';
      const values = (Array.isArray(item.data.values) ? item.data.values : []).slice(0, 24)
        .map(v => ({ label: text(v?.label, 40), value: text(v?.value, 2000) })).filter(v => v.label && v.value);
      record = shapeRecord(CUSTOM_SECTION, item.data, item.id, values);
    } else {
      const definition = SECTION.get(item.section);
      if (!definition) continue;
      key = definition.key; label = definition.label;
      record = shapeRecord(definition, item.data, item.id);
      record.sortDate = definition.sortDate ? isoDate(item.data[definition.sortDate]) : '';
    }
    if (!sections.has(key)) sections.set(key, { key, label, records: [] });
    sections.get(key).records.push(record);
    records.set(`${item.section}:${item.id}`, record);
  }
  let documentCount = 0;
  for (const d of Array.isArray(raw?.documents) ? raw.documents : []) {
    if (!d || typeof d.id !== 'string' || !UUID.test(d.id)) continue;
    const record = records.get(`${d.section}:${d.recordId}`);
    if (!record) continue;
    record.documents.push(shapeDocument(d));
    documentCount++;
  }
  const order = key => { const i = ADMIN_ACCESS_SECTION_KEYS.indexOf(key); return i < 0 ? ADMIN_ACCESS_SECTION_KEYS.length : i; };
  const out = [...sections.values()].sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  for (const section of out) {
    section.records.sort((a, b) => (b.sortDate || '').localeCompare(a.sortDate || '') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    for (const record of section.records) {
      delete record.sortDate;
      record.documents.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    }
  }
  return { physician, sections: out, documentCount };
}

/** The flat document list for a standing session, same membership as shapeView. */
export function flatDocuments(view) {
  const out = [];
  for (const section of view.sections) for (const record of section.records) for (const d of record.documents) out.push({ ...d, recordTitle: record.title, section: section.label });
  return out;
}

export function shapeGrant(grant) {
  return {
    purpose: text(grant?.purpose, ADMIN_ACCESS_POLICY.purposeMax),
    accessEndsAt: typeof grant?.accessEndsAt === 'string' ? grant.accessEndsAt : null,
    allowDownload: grant?.allowDownload === true,
  };
}

/** Per-section counts from a shaped view, for the owner's checkboxes. */
export function viewCounts(view) {
  const counts = {};
  for (const section of view?.sections || []) {
    counts[section.key] = { records: section.records.length, files: section.records.reduce((n, r) => n + r.documents.length, 0) };
  }
  return counts;
}
