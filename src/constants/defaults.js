export const STORAGE_KEY = "credentialdomd-data";

export const DEFAULT_SETTINGS = {
  primaryState: "",
  additionalStates: [],
  reminderLeadDays: 90,
  name: "",
  npi: "",
  degreeType: "DO",
  specialties: [],
  email: "",
  phone: "",
  theme: "dark",
  fontSize: "M",
  apiKey: import.meta.env.VITE_GEMINI_API_KEY || "",
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
  malpracticeHistory: [],
  // Locum tier features
  rotations: [],     // [{ id, hospital, city, state, startDate, endDate, role, agency, notes }]
  deductibles: [],   // [{ id, date, category, description, amount, taxYear }]
  locumContracts: [], // [{ id, facility, agency, billTo, startDate, endDate, hourlyRate, callHourlyRate, incrementMinutes, minCallMinutes, notes }]
  workLog: [],        // [{ id, contractId, type, date, startTime, endTime, durationMin, billedMin, description, invoiceId }]
  screenings: [],    // [{ id, type, name, agency, requestedBy, assignment, fileNumber, orderDate, reportDate, result, expirationDate, components: [{name, scope, status, date, note}], notes }]
  encounters: [],     // [{ id, contractId, date, codes: [{code, units, desc, wRVU}], note, spokenText }]
  invoices: [],       // [{ id, number, contractId, periodStart, periodEnd, entryIds, totalMinutes, totalAmount, sentAt }]
  settings: { ...DEFAULT_SETTINGS },
};
