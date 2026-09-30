import { DEFAULT_REMINDER_LEAD_DAYS, DEFAULT_NOTIFY_FREQ_DAYS } from "../utils/reminderPreferences.js";

export const STORAGE_KEY = "credentialdomd-data";

// Settings the cloud has no column for: they exist only in this device's
// cached file. lib/supabase.js explains each one and carries them across a
// cloud load (withLocalOnlySettings); storageScope.js keeps them when a
// session ends without Sign out, so the next sign-in finds them.
export const LOCAL_ONLY_SETTINGS = Object.freeze(["assistantModel", "coderModel", "birthMonthDay"]);

export const DEFAULT_SETTINGS = {
  primaryState: "",
  additionalStates: [],
  // One number with send-reminders: a blank lead on the server is this too.
  reminderLeadDays: DEFAULT_REMINDER_LEAD_DAYS,
  name: "",
  npi: "",
  // birthMonthDay ("MM-DD", no year; src/utils/cmePassport.js) is kept on this
  // device only and deliberately has no default here: LOCAL_ONLY_SETTINGS
  // (above; lib/supabase.js) carries it across a cloud load, and a default would
  // make the merged value defined and lose it. Readers coerce undefined to "".
  degreeType: "", // unset until the physician chooses MD or DO; never assume
  specialties: [],
  email: "",
  phone: "",
  address: "",
  website: "",
  languages: "",
  professionalSummary: "",
  cvHighlights: "",
  theme: "dark",
  fontSize: "M",
  showDashboardCredentials: false,
  // The typeof guard keeps this module importable by the pure-node test
  // scripts (scripts/*.test.mjs), where import.meta.env does not exist.
  // Vite still statically replaces the member expression at build time.
  apiKey: (typeof import.meta.env !== "undefined" && import.meta.env.VITE_GEMINI_API_KEY) || "",
  // Blank means on for email reminders (utils/reminderPreferences.js), so
  // a profile row with no notify_email shows the switch the server obeys.
  notifyEmail: true,
  notifyText: true,
  // A forwarded document request is acknowledged to its requester from
  // docs@ on arrival; the physician still approves before anything is sent.
  ackRequests: true,
  notifyFreqDays: DEFAULT_NOTIFY_FREQ_DAYS,
  lastNotified: null,
  alertsFingerprint: null,
  snoozedUntil: null,
  lastCmeVerification: null,
  cmeVerificationResults: {},
  cmeVerificationAlerted: false,
  // Setup board state. Null until the board is first rendered; see
  // src/utils/setupTasks.js for the shape.
  setupState: null,
};

export const DEFAULT_DATA = {
  // User-created categories and the records filed in them (custom_categories,
  // custom_records). Without these, offline and cached loads leave the keys
  // undefined and assertCompleteAccountRecords refuses the account.
  customCategories: [],
  customRecords: [],
  licenses: [],
  cme: [],
  privileges: [],
  caseLogs: [],
  insurance: [],
  healthRecords: [],
  education: [],
  documents: [],
  shareLog: [],
  notificationLog: [],
  workHistory: [],
  peerReferences: [],
  dutyDays: [],       // [{ id, contractId, date, workedDay, scholarly, callHospital, callRole, amount }]
  taskNotes: [],      // [{ id, text, contractId, capturedAt, startedAt, completedAt }]
  publications: [],   // [{ id, name, citation, year, doi, pmid, url, sortOrder, notes }]
  travelDocs: [],     // [{ id, type, name, provider, number, expirationDate, notes }]
  memberships: [],    // [{ id, organization, role, startDate, endDate, notes }]
  malpracticeHistory: [],
  answerBank: [],     // [{ id, question, questionVersion, answer, scope, scopeDetail, confirmationDate, source, explanation, notes }] — reusable, dated credentialing-questionnaire answers
  identityVault: [],  // [{ id, label, legalFirstName, legalMiddleName, legalLastName, suffix, fullDob (secret), ssn (secret), source, verifiedDate, notes }] — protected application-identity fields, encrypted via secretBox
  travelExpenses: [], // [{ id, date, category, description, amount, taxYear }]
  taxPayments: [],    // [{ id, date, quarter, taxYear, jurisdiction, amount, method, notes }]
  scheduleDays: [],   // [{ id, contractId, date, kind, expected, note }] — kind "vacation" marks a day off (no contract/expected), note says why
  // Locum tier features
  rotations: [],     // [{ id, hospital, city, state, startDate, endDate, role, agency, notes }]
  deductibles: [],   // [{ id, date, category, description, amount, taxYear }]
  locumContracts: [], // [{ id, facility, agency, billTo, startDate, endDate, hourlyRate, callHourlyRate, incrementMinutes, minCallMinutes, notes }]
  workLog: [],        // [{ id, contractId, type, date, startTime, endTime, durationMin, billedMin, description, invoiceId }]
  screenings: [],
  alertAcks: [],     // [{ id, itemId, until, note }] — acknowledged/snoozed expiration alerts
  followUps: [],     // [{ id, itemId, itemName, recipient, note, emailed, createdAt }] — logged follow-up actions on an expiring item (e.g. "emailed the medical staff office about privileges")
  professionalPhotos: [], // [{ id, name, dateTaken, notes }] — headshots for credentialing packets    // [{ id, type, name, agency, requestedBy, assignment, fileNumber, orderDate, reportDate, result, expirationDate, components: [{name, scope, status, date, note}], notes }]
  encounters: [],     // [{ id, contractId, date, codes: [{code, units, desc, wRVU}], note, spokenText }]
  invoices: [],       // [{ id, number, contractId, periodStart, periodEnd, entryIds, totalMinutes, totalAmount, sentAt }]
  settings: { ...DEFAULT_SETTINGS },
};
