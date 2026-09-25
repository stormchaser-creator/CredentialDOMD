// Member-granted support view (ticket d45e857c, phase 2): what an
// administrator may see of a member's account, and in what shape.
//
// The member turns it on in Settings for 24 hours and can end it at any time
// (migration 20260925131000_member_support_view.sql). While it is on, an
// administrator can open a read-only view of the account for at most 15
// minutes, with a written reason, and every view and every file opened is
// logged where the member can read it.
//
// Pure on purpose. The edge function (admin-member-view), the viewer in src/
// and plain node tests import this one module, so the columns the server
// selects, the keys the snapshot can carry and the labels the viewer shows
// cannot drift apart.
//
// Two walls, both here:
//   1. Every section names the exact columns the function SELECTs. A column
//      that is not named is never read from the database.
//   2. shapeSnapshot keeps only the keys a section names, drops every string
//      that starts with "enc1:" (secretBox ciphertext) wherever it sits, and
//      runs the app's own identifier gate (src/utils/identifierGate.js, copied
//      to ./app/utils/ by scripts/sync-shared-app-modules.mjs) over what is
//      left: a custom_fields or fieldValues entry whose label or value is a
//      patient identifier, a Social Security or taxpayer number, a full date
//      of birth or an account, encounter, licence or passport number is
//      dropped, and a line of free text that holds one is withheld. Rows the
//      write-time gate never saw (imports from before it, JSON restores) are
//      screened here all the same.
// Collections in MEMBER_VIEW_NEVER have no entry at all, so there is no code
// path that reads them.
import { identifierReason } from './app/utils/identifierGate.js';

export const MEMBER_VIEW_POLICY = Object.freeze({
  grantHours: 24,
  sessionMinutes: 15,
  reasonMin: 10,
  reasonMax: 500,
  maxRowsPerCollection: 5000,
  maxFileBytes: 10 * 1024 * 1024,
  origin: 'https://credentialdomd.com',
});

// Never read, never shown, whatever the member granted. Passport and travel
// IDs, the money ledgers, patient encounter coding (dictated text and private
// notes), and the two device-only sections (which have no cloud table anyway).
export const MEMBER_VIEW_NEVER = Object.freeze([
  'travelDocs', 'travelExpenses', 'taxPayments', 'invoices', 'deductibles', 'encounters', 'identityVault', 'answerBank',
]);

// Column-level exclusions inside sections that ARE shown. Listed so the tests
// can prove none of them can ever be selected or returned.
export const MEMBER_VIEW_NEVER_FIELDS = Object.freeze({
  licenses: ['renewalCost'],
  privileges: ['portalUrl', 'loginUsername', 'loginSecret'],
  healthRecords: ['specimenId'],
  malpracticeHistory: ['settlementAmount'],
  memberships: ['cost'],
  // notes is the Contracts form's "Key terms / notes" field ("Cancellation
  // clause, guaranteed hours, travel, etc."): where a physician writes the
  // rates in words, so it is withheld with them.
  locumContracts: ['hourlyRate', 'callHourlyRate', 'callStipend', 'overageHourlyRate', 'orientationFee', 'orientationBilled',
    'orientationHourlyRate', 'dayRate', 'callRateGrid', 'scholarlyRate', 'clinicalDayRate', 'customFields', 'notes'],
  workLog: ['invoiceId', 'privateNote'],
  dutyDays: ['amount', 'invoiceId', 'customFields'],
  scheduleDays: ['expected', 'sourceKey'],
  profile: ['apiKey', 'anthropicApiKey', 'taxPrep', 'deviceId', 'profilePhoto'],
});

// What the viewer tells the administrator is withheld. Fixed text, no counts.
export const MEMBER_VIEW_WITHHELD_LINE = 'Never shown: passport and travel IDs, taxes, invoices, expenses, deductions, contract rates, pay and terms, encounter coding, portal logins, Protected Identity, encrypted values, text the identifier check flags as a patient identifier or tax ID, and uploads that are not filed to a record shown here.';

const f = (key, label, kind = 'text') => Object.freeze({ key, label, kind });
const LIFECYCLE = [f('lifecycleStatus', 'Status', 'lifecycle'), f('dateUnknown', 'Date not known yet', 'yes'), f('supersededBy', 'Replaced by'), f('statusSource', 'Status source')];
const NOTES = f('notes', 'Notes', 'long');
const CUSTOM = f('customFields', 'More details', 'custom');

// group: where the member finds it. credentials = the Credentials tab,
// work = Practice / Work, activity = what the app sent and logged.
export const MEMBER_VIEW_SECTIONS = Object.freeze([
  { key: 'licenses', table: 'licenses', label: 'Licenses', group: 'credentials', fields: [f('type', 'Type'), f('name', 'Display Name'), f('licenseNumber', 'License #'), f('state', 'State'), f('issuedDate', 'Issued', 'date'), f('expirationDate', 'Expires', 'date'), f('noExpiration', 'Does not expire', 'yes'), f('cmeCycleStart', 'CME Cycle Start', 'date'), f('npiImported', 'Imported from NPI', 'yes'), ...LIFECYCLE, NOTES, CUSTOM] },
  { key: 'cme', table: 'cme', label: 'CME', group: 'credentials', fields: [f('title', 'Title'), f('category', 'Category'), f('hours', 'Hours', 'number'), f('date', 'Date', 'date'), f('provider', 'Provider'), f('certificateNumber', 'Certificate #'), f('topics', 'Topics', 'list'), NOTES, CUSTOM] },
  { key: 'privileges', table: 'privileges', label: 'Privileges', group: 'credentials', fields: [f('type', 'Type'), f('name', 'Display Name'), f('facility', 'Facility'), f('city', 'City'), f('state', 'State'), f('appointmentDate', 'Appointed', 'date'), f('expirationDate', 'Reappointment Due', 'date'), ...LIFECYCLE, NOTES, CUSTOM] },
  { key: 'insurance', table: 'insurance', label: 'Insurance', group: 'credentials', fields: [f('type', 'Type'), f('name', 'Display Name'), f('provider', 'Carrier'), f('policyNumber', 'Policy #'), f('coveragePerClaim', 'Per Claim'), f('coverageAggregate', 'Aggregate'), f('effectiveDate', 'Effective', 'date'), f('expirationDate', 'Expires', 'date'), ...LIFECYCLE, NOTES, CUSTOM] },
  { key: 'healthRecords', table: 'health_records', label: 'Health Records', group: 'credentials', fields: [f('category', 'Category'), f('type', 'Type'), f('name', 'Name'), f('dateAdministered', 'Date', 'date'), f('expirationDate', 'Expires', 'date'), f('result', 'Result'), f('resultValue', 'Value'), f('resultUnits', 'Units'), f('referenceRange', 'Reference range'), f('collectedDate', 'Collected', 'date'), f('reportedDate', 'Reported', 'date'), f('lab', 'Lab'), f('orderedBy', 'Ordered by'), f('lotNumber', 'Lot #'), f('facility', 'Facility'), f('doses', 'Doses', 'doses'), NOTES, CUSTOM] },
  { key: 'screenings', table: 'screenings', label: 'Screenings', group: 'credentials', fields: [f('type', 'Type'), f('name', 'Name'), f('agency', 'Agency'), f('requestedBy', 'Requested by'), f('assignment', 'Assignment'), f('fileNumber', 'File #'), f('orderDate', 'Ordered', 'date'), f('reportDate', 'Reported', 'date'), f('result', 'Result'), f('expirationDate', 'Expires', 'date'), f('components', 'Searches', 'components'), NOTES, CUSTOM] },
  { key: 'education', table: 'education', label: 'Education', group: 'credentials', fields: [f('type', 'Type'), f('name', 'Display Name'), f('institution', 'Institution'), f('startDate', 'Start Date', 'date'), f('graduationDate', 'Graduation / End Date', 'date'), f('fieldOfStudy', 'Field of Study / Specialty'), f('honors', 'Honors'), NOTES, CUSTOM] },
  { key: 'workHistory', table: 'work_history', label: 'Work History', group: 'credentials', fields: [f('type', 'Position Type'), f('position', 'Position/Title'), f('employer', 'Employer/Organization'), f('city', 'City'), f('state', 'State'), f('startDate', 'Start Date', 'date'), f('endDate', 'End Date', 'date'), f('current', 'Current Position', 'yes'), f('description', 'Description', 'long'), f('reasonForLeaving', 'Reason for Leaving'), NOTES, CUSTOM] },
  { key: 'peerReferences', table: 'peer_references', label: 'Peer References', group: 'credentials', fields: [f('name', 'Full Name'), f('degree', 'Degree/Credential'), f('specialty', 'Specialty'), f('institution', 'Institution/Hospital'), f('relationship', 'Relationship'), f('email', 'Email'), f('phone', 'Phone'), f('knownSince', 'Known Since'), f('yearsKnown', 'Years Known'), NOTES, CUSTOM] },
  { key: 'malpracticeHistory', table: 'malpractice_history', label: 'Malpractice History', group: 'credentials', fields: [f('dateOfIncident', 'Date of Incident', 'date'), f('dateFiled', 'Date Filed', 'date'), f('state', 'State'), f('outcome', 'Outcome'), f('description', 'Description', 'long'), f('facility', 'Facility'), f('insuranceCarrier', 'Insurance Carrier'), f('dateResolved', 'Date Resolved', 'date'), NOTES, CUSTOM] },
  { key: 'professionalPhotos', table: 'professional_photos', label: 'Professional Photo', group: 'credentials', fields: [f('name', 'Label'), f('dateTaken', 'Date Taken', 'date'), NOTES, CUSTOM] },
  { key: 'publications', table: 'publications', label: 'Publications', group: 'credentials', fields: [f('name', 'Short Label'), f('citation', 'Full Citation', 'long'), f('year', 'Year'), f('sortOrder', 'Order on CV', 'number'), f('doi', 'DOI'), f('pmid', 'PMID'), f('url', 'Link'), NOTES, CUSTOM] },
  { key: 'memberships', table: 'professional_memberships', label: 'Professional Organizations', group: 'credentials', fields: [f('organization', 'Organization'), f('name', 'Name'), f('role', 'Membership Type'), f('startDate', 'Member Since', 'date'), f('expirationDate', 'Renewal Due', 'date'), f('endDate', 'Ended', 'date'), NOTES, CUSTOM] },
  { key: 'caseLogs', table: 'case_logs', label: 'Case Logs', group: 'credentials', fields: [f('category', 'Category'), f('title', 'Description'), f('date', 'Date', 'date'), f('facility', 'Facility'), f('role', 'Role'), f('attending', 'Attending / Supervising Surgeon'), f('cptCodes', 'CPT Code(s)'), f('wRvu', 'wRVU', 'number'), f('complication', 'Complication (if any)'), f('source', 'Source'), NOTES, CUSTOM] },
  { key: 'customCategories', table: 'custom_categories', label: 'Your categories', group: 'credentials', fields: [f('name', 'Name'), f('description', 'Description', 'long'), f('icon', 'Icon'), f('fields', 'Fields', 'fieldDefs'), f('sortOrder', 'Order', 'number'), f('archivedAt', 'Archived', 'date'), CUSTOM] },
  { key: 'customRecords', table: 'custom_records', label: 'Other records', group: 'credentials', fields: [f('categoryId', 'Category id', 'hidden'), f('categoryName', 'Category'), f('name', 'Name'), f('issuer', 'Issued by'), f('number', 'Number / ID'), f('issuedDate', 'Issued', 'date'), f('expirationDate', 'Expires', 'date'), f('fieldLabels', 'Field labels', 'hidden'), f('fieldValues', 'Details', 'values'), f('documentIds', 'Files', 'hidden'), NOTES, CUSTOM] },
  { key: 'locumContracts', table: 'locum_contracts', label: 'Contracts', group: 'work', fields: [f('facility', 'Facility'), f('shortName', 'Short name'), f('agency', 'Agency'), f('location', 'Location'), f('workState', 'Work state'), f('billTo', 'Bill to'), f('startDate', 'Start', 'date'), f('endDate', 'End', 'date'), f('termStart', 'Term start', 'date'), f('termEnd', 'Term end', 'date'), f('coveragePeriods', 'Coverage periods', 'periods'), f('payModel', 'Pay model'), f('incrementMinutes', 'Billing increment (minutes)', 'number'), f('minCallMinutes', 'Minimum call (minutes)', 'number'), f('stipendHours', 'Stipend hours', 'number'), f('splitAtDayStart', 'Split call at day start', 'yes'), f('dayStartHour', 'Day starts at hour', 'number')] },
  { key: 'workLog', table: 'work_log', label: 'Work Log', group: 'work', fields: [f('contractId', 'Contract', 'contract'), f('type', 'Type'), f('date', 'Date', 'date'), f('startTime', 'Start', 'datetime'), f('endTime', 'End', 'datetime'), f('durationMin', 'Minutes', 'number'), f('billedMin', 'Billed minutes', 'number'), f('description', 'Description', 'long'), f('callDay', 'Call day', 'date'), f('splitGroupId', 'Split entry', 'hidden')] },
  { key: 'dutyDays', table: 'duty_days', label: 'Duty Days', group: 'work', fields: [f('contractId', 'Contract', 'contract'), f('date', 'Date', 'date'), f('workedDay', 'Worked day', 'yes'), f('scholarly', 'Scholarly', 'yes'), f('callHospital', 'Call hospital'), f('callRole', 'Call role'), f('callPeriods', 'Call periods', 'periods'), f('placementOk', 'Placement confirmed', 'yes'), NOTES] },
  { key: 'scheduleDays', table: 'schedule_days', label: 'Schedule', group: 'work', fields: [f('contractId', 'Contract', 'contract'), f('date', 'Date', 'date'), f('kind', 'Kind'), f('note', 'Note', 'long'), f('source', 'Source')] },
  { key: 'rotations', table: 'rotations', label: 'Hospital Rotations', group: 'work', fields: [f('hospital', 'Hospital'), f('city', 'City'), f('state', 'State'), f('startDate', 'Start', 'date'), f('endDate', 'End', 'date'), f('role', 'Role'), f('agency', 'Agency'), NOTES] },
  { key: 'taskNotes', table: 'task_notes', label: 'Task Notes', group: 'work', fields: [f('text', 'Task', 'long'), f('contractId', 'Contract', 'contract'), f('capturedAt', 'Captured', 'datetime'), f('startedAt', 'Started', 'datetime'), f('completedAt', 'Completed', 'datetime'), f('workLogId', 'Work entry', 'hidden'), NOTES, CUSTOM] },
  { key: 'shareLog', table: 'share_log', label: 'Share history', group: 'activity', fields: [f('itemName', 'Item'), f('section', 'Section'), f('method', 'Method'), f('recipient', 'Recipient'), f('sentAt', 'Sent', 'datetime'), f('itemId', 'Record', 'hidden')] },
  { key: 'followUps', table: 'follow_ups', label: 'Follow-ups', group: 'activity', fields: [f('itemName', 'Item'), f('recipient', 'Recipient'), f('note', 'Note', 'long'), f('emailed', 'Emailed', 'yes'), f('itemId', 'Record', 'hidden')] },
  { key: 'alertAcks', table: 'alert_acks', label: 'Snoozed alerts', group: 'activity', fields: [f('itemId', 'Record', 'hidden'), f('until', 'Snoozed until', 'date'), f('note', 'Note', 'long')] },
  { key: 'notificationLog', table: 'notification_log', label: 'Notifications sent', group: 'activity', fields: [f('method', 'Method'), f('alertCount', 'Alerts', 'number'), f('date', 'Date', 'datetime')] },
].map(section => Object.freeze({ ...section, fields: Object.freeze(section.fields) })));

export const MEMBER_VIEW_SECTION_KEYS = Object.freeze(MEMBER_VIEW_SECTIONS.map(s => s.key));
const SECTION = new Map(MEMBER_VIEW_SECTIONS.map(s => [s.key, s]));
export const memberViewSection = key => SECTION.get(key) || null;

// Keys every shown record carries besides its fields.
const RECORD_KEYS = ['id', 'createdAt', 'updatedAt', 'favorite'];

export function camelToSnake(key) { return key.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase()); }
export function snakeToCamel(key) { return key.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase()); }

/** The exact columns the function selects for a section. */
export function sectionColumns(section) {
  return [...new Set([...RECORD_KEYS, ...section.fields.map(field => field.key)].map(camelToSnake))];
}

// The profile row: what the member's Profile & settings screen shows, and the
// setup and notification state support is usually asked about. Never the AI
// keys, the tax plan, the photo or the columns of the retired fitness schema.
export const MEMBER_VIEW_PROFILE_FIELDS = Object.freeze([
  f('name', 'Full Name'), f('degreeType', 'Degree'), f('npi', 'NPI'), f('primaryState', 'Primary state'),
  f('additionalStates', 'Additional states', 'list'), f('specialties', 'Specialties', 'list'), f('email', 'Email'),
  f('verifiedEmail', 'Verified sign-in email'), f('phone', 'Phone'), f('address', 'Address', 'long'), f('website', 'Website'),
  f('languages', 'Languages'), f('professionalSummary', 'Professional summary', 'long'), f('cvHighlights', 'CV highlights', 'long'),
  f('accessStatus', 'App access'), f('foundingNumber', 'Founding number', 'number'), f('isFoundingMember', 'Founding member', 'yes'),
  f('reminderLeadDays', 'Reminder lead (days)', 'number'), f('notifyEmail', 'Email reminders', 'yes'), f('notifyBrowser', 'Browser alerts', 'yes'),
  f('notifyText', 'Text alerts', 'yes'), f('notifyFreqDays', 'Alert frequency (days)', 'number'), f('backupMonthly', 'Monthly backup', 'yes'),
  f('ackRequests', 'Acknowledge forwarded requests', 'yes'), f('showDashboardCredentials', 'Credentials on dashboard', 'yes'),
  f('theme', 'Theme'), f('fontSize', 'Text size'), f('setupState', 'Setup progress', 'hidden'),
  f('createdAt', 'Joined', 'datetime'), f('lastSeenAt', 'Last seen', 'datetime'),
]);
export const PROFILE_COLUMNS = Object.freeze(['id', ...MEMBER_VIEW_PROFILE_FIELDS.map(field => camelToSnake(field.key))]);

// Documents: metadata only. storage_path is read by the file route and never
// returned; the bytes are opened one at a time through the function.
export const DOCUMENT_COLUMNS = Object.freeze(['id', 'name', 'mime_type', 'type', 'size_bytes', 'size', 'linked_to', 'uploaded_at', 'created_at']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}\u{2028}\u{2029}]/gu;
// custom_fields keys that are never shown, at any depth: sign-in material,
// identifiers the app keeps off the server, and the importer's raw source rows.
const SECRET_KEY = /pass(word)?|secret|login|token|api.?key|lock.?code|ssn|social.?security|birth|dob|passport|patient|mrn|private|source.?row|source.?doc/i;
const MAX_TEXT = 5000;

export const isSecretValue = value => typeof value === 'string' && value.trimStart().startsWith('enc1:');

/** Why a labelled value is withheld (identifierGate's reason), or null. */
export function withheldReason(label, value) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return identifierReason(String(label ?? ''), text);
}

// A line written "Label: value" is judged like a field with that label, so
// "Pt Name: Jane Q" or "Tax ID: 12-3456789" typed into notes is caught as
// well as "MRN 00481234".
function lineReason(line) {
  const labelled = /^\s*([^:\n]{1,60}):\s*(\S.*)$/.exec(line);
  return (labelled && identifierReason(labelled[1], labelled[2])) || identifierReason('', line);
}

/**
 * Free text with every line that holds an identifier replaced by a note of
 * what was withheld. The rest of the text is kept, so support still reads
 * "Renew online" beside a withheld chart number.
 */
export function withholdIdentifiers(text) {
  if (typeof text !== 'string' || !text) return text;
  const lines = text.split('\n');
  let changed = false;
  const out = lines.map(line => {
    const why = lineReason(line);
    if (!why) return line;
    changed = true;
    return `[Withheld: ${why}]`;
  });
  return changed ? out.join('\n') : text;
}

/**
 * One value, cleaned for the snapshot: ciphertext and control characters out,
 * identifiers withheld, long text cut, objects filtered by key, depth and
 * size bounded. Returns undefined for anything that is dropped.
 */
export function cleanValue(value, depth = 0) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    if (isSecretValue(value)) return undefined;
    const clean = withholdIdentifiers(value.replace(CONTROL, ' '));
    return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) : clean;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    const out = value.slice(0, 500).map(item => cleanValue(item, depth + 1)).filter(item => item !== undefined);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      // A key is a label: "Medical Record #", "Pt Name", "Tax ID". Judged
      // with its value, the way the app judges a field on the way in.
      if (SECRET_KEY.test(key) || withheldReason(key, item)) continue;
      const clean = cleanValue(item, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return undefined;
}

// A custom record's fieldValues are keyed by a generated key ("f1",
// "badgeNumber"); the physician's label is in fieldLabels. Judge each value
// by its label as well, and drop the label with a withheld value.
function screenFieldValues(record) {
  const values = record.fieldValues;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return;
  const labels = record.fieldLabels && typeof record.fieldLabels === 'object' && !Array.isArray(record.fieldLabels) ? record.fieldLabels : {};
  for (const [key, value] of Object.entries(values)) {
    const label = typeof labels[key] === 'string' && labels[key].trim() ? labels[key] : key;
    if (withheldReason(label, value)) { delete values[key]; delete labels[key]; }
  }
}

const PERIOD_KEYS = ['start', 'end', 'startDate', 'endDate', 'from', 'to', 'label', 'hospital', 'role', 'kind'];
function cleanField(field, value) {
  if (field.kind === 'periods') {
    if (!Array.isArray(value)) return undefined;
    // Coverage and call periods may carry a rate beside their dates: keep the
    // dates and names only.
    return value.slice(0, 200).map(period => {
      if (!period || typeof period !== 'object') return undefined;
      const out = {};
      for (const key of PERIOD_KEYS) { const clean = cleanValue(period[key], 2); if (clean !== undefined && typeof clean !== 'object') out[key] = clean; }
      return Object.keys(out).length ? out : undefined;
    }).filter(Boolean);
  }
  return cleanValue(value);
}

function shapeRecord(section, row) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !UUID.test(row.id)) return null;
  const record = { id: row.id };
  for (const key of ['createdAt', 'updatedAt']) {
    const value = row[camelToSnake(key)] ?? row[key];
    if (typeof value === 'string') record[key] = value;
  }
  if ((row.favorite ?? false) === true) record.favorite = true;
  for (const field of section.fields) {
    const value = cleanField(field, row[camelToSnake(field.key)] ?? row[field.key]);
    if (value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    record[field.key] = value;
  }
  screenFieldValues(record);
  return record;
}

function shapeProfile(row) {
  const member = {};
  if (!row || typeof row !== 'object') return member;
  for (const field of MEMBER_VIEW_PROFILE_FIELDS) {
    const value = cleanValue(row[camelToSnake(field.key)] ?? row[field.key]);
    if (value === undefined || (typeof value === 'string' && !value.trim())) continue;
    member[field.key] = value;
  }
  return member;
}

/** "section:recordId" for a document filed to a record, or null. */
export function documentLink(linkedTo) {
  const match = /^([A-Za-z]+):([0-9a-f-]{36})$/i.exec(String(linkedTo || ''));
  return match ? { section: match[1], recordId: match[2] } : null;
}

/**
 * Whether a document may be listed and opened: only when it is filed to a
 * record in a shown section. Unfiled uploads, and anything filed to a travel,
 * money, contract or identity record, are never listed or opened.
 */
export function documentShownFor(linkedTo) {
  const link = documentLink(linkedTo);
  if (!link || link.section === 'locumContracts' || !SECTION.has(link.section) || MEMBER_VIEW_NEVER.includes(link.section)) return null;
  return link;
}

function shapeDocument(row, shown) {
  if (!row || typeof row.id !== 'string' || !UUID.test(row.id)) return null;
  const link = documentShownFor(row.linked_to ?? row.linkedTo);
  if (!link || !shown.has(`${link.section}:${link.recordId}`)) return null;
  const size = [row.size_bytes, row.sizeBytes, row.size].map(Number).find(n => Number.isSafeInteger(n) && n >= 0);
  const name = cleanValue(row.name);
  const mime = cleanValue(row.mime_type ?? row.mimeType ?? row.type);
  const uploadedAt = cleanValue(row.uploaded_at ?? row.uploadedAt ?? row.created_at ?? row.createdAt);
  return {
    id: row.id,
    name: typeof name === 'string' && name.trim() ? name.slice(0, 300) : 'Document',
    mimeType: typeof mime === 'string' ? mime.slice(0, 120) : 'application/octet-stream',
    sizeBytes: size ?? null,
    linkedTo: `${link.section}:${link.recordId}`,
    uploadedAt: typeof uploadedAt === 'string' ? uploadedAt : null,
  };
}

/**
 * Database rows to the snapshot the viewer renders. `raw` is
 * { profile: row, collections: { [sectionKey]: rows }, documents: rows,
 * truncated: [sectionKey] }. Anything not named in MEMBER_VIEW_SECTIONS is
 * dropped, even if a caller passed it.
 */
export function shapeSnapshot(raw) {
  const sections = {};
  const shown = new Set();
  for (const section of MEMBER_VIEW_SECTIONS) {
    const rows = Array.isArray(raw?.collections?.[section.key]) ? raw.collections[section.key] : [];
    const records = rows.map(row => shapeRecord(section, row)).filter(Boolean);
    sections[section.key] = records;
    for (const record of records) shown.add(`${section.key}:${record.id}`);
  }
  const documents = (Array.isArray(raw?.documents) ? raw.documents : []).map(row => shapeDocument(row, shown)).filter(Boolean);
  const truncated = (Array.isArray(raw?.truncated) ? raw.truncated : []).filter(key => SECTION.has(key));
  return { schemaVersion: 1, member: shapeProfile(raw?.profile), sections, documents, truncated, withheld: MEMBER_VIEW_WITHHELD_LINE };
}

/**
 * The reason as it will be stored, whatever its length: one line, runs of
 * whitespace collapsed. The admin screen counts and checks this same string,
 * so the counter and the server never disagree.
 */
export function collapseReason(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The reason the administrator typed, as stored: one line, 10 to 500 characters, or null. */
export function normalizeReason(value) {
  const reason = collapseReason(value);
  return reason.length >= MEMBER_VIEW_POLICY.reasonMin && reason.length <= MEMBER_VIEW_POLICY.reasonMax ? reason : null;
}

/** Every key path in a value ("sections.licenses[].licenseNumber"), for the tests and the audit of a shape. */
export function keyPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) { for (const item of value) keyPaths(item, `${prefix}[]`, out); return out; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { const path = prefix ? `${prefix}.${key}` : key; out.add(path); keyPaths(item, path, out); }
  }
  return out;
}
