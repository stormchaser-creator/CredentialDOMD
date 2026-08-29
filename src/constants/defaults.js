export const STORAGE_KEY = "credentialdomd-data";

export const DEFAULT_SETTINGS = {
  primaryState: "",
  additionalStates: [],
  reminderLeadDays: 90,
  name: "",
  npi: "",
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
  notifyEmail: true,
  notifyText: true,
  notifyFreqDays: 7,
  lastNotified: null,
  alertsFingerprint: null,
  snoozedUntil: null,
  lastCmeVerification: null,
  cmeVerificationResults: {},
  cmeVerificationAlerted: false,
};

export const DEFAULT_DATA = {
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
  followUps: [],     // [{ id, itemId, itemName, recipient, note, emailed, createdAt }] — logged follow-up actions on an expiring item (e.g. "emailed Kyle about Penrose privileges")
  professionalPhotos: [], // [{ id, name, dateTaken, notes }] — headshots for credentialing packets    // [{ id, type, name, agency, requestedBy, assignment, fileNumber, orderDate, reportDate, result, expirationDate, components: [{name, scope, status, date, note}], notes }]
  encounters: [],     // [{ id, contractId, date, codes: [{code, units, desc, wRVU}], note, spokenText }]
  invoices: [],       // [{ id, number, contractId, periodStart, periodEnd, entryIds, totalMinutes, totalAmount, sentAt }]
  settings: { ...DEFAULT_SETTINGS },
};
