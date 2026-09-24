// Known sections and the fields each one really stores.
//
// Lives in its own module, with no imports, so pure code (customCategories.js)
// and plain node tests can read it without loading Vera's model clients.
// assistant.js re-exports it, so existing imports keep working.

export const SECTION_FIELDS = {
  licenses: ["type", "name", "licenseNumber", "state", "issuedDate", "expirationDate", "notes"],
  privileges: ["type", "name", "facility", "city", "state", "appointmentDate", "expirationDate", "notes"],
  insurance: ["type", "name", "provider", "policyNumber", "coveragePerClaim", "coverageAggregate", "effectiveDate", "expirationDate", "notes"],
  healthRecords: ["category", "type", "name", "dateAdministered", "expirationDate", "result", "resultValue", "resultUnits", "referenceRange", "collectedDate", "reportedDate", "lab", "specimenId", "orderedBy", "lotNumber", "facility", "notes"],
  education: ["type", "name", "institution", "startDate", "graduationDate", "fieldOfStudy", "honors", "notes"],
  cme: ["title", "category", "hours", "date", "provider", "certificateNumber", "topics", "notes"],
  workHistory: ["type", "position", "employer", "city", "state", "startDate", "endDate", "current", "description", "notes"],
  screenings: ["type", "name", "agency", "requestedBy", "assignment", "fileNumber", "orderDate", "reportDate", "result", "expirationDate", "components", "notes"],
  professionalPhotos: ["name", "dateTaken", "notes"],
  publications: ["name", "citation", "year", "sortOrder", "doi", "pmid", "url", "notes"],
  memberships: ["organization", "role", "startDate", "endDate", "notes"],
  locumContracts: ["facility", "location", "agency", "billTo", "coveragePeriods", "payModel", "dayRate", "callRateGrid", "callStipend", "stipendHours", "overageHourlyRate", "orientationHourlyRate", "orientationFee", "hourlyRate", "incrementMinutes", "minCallMinutes", "notes"],
};

// Every synced collection (the keys of TABLE_MAP in src/lib/supabase.js),
// listed here so pure code can tell a real section from one a model invented.
// tests/collection-registry.test.mjs fails if this drifts from TABLE_MAP.
export const BUILT_IN_SECTIONS = Object.freeze([
  "licenses",
  "cme",
  "privileges",
  "insurance",
  "healthRecords",
  "education",
  "caseLogs",
  "workHistory",
  "peerReferences",
  "malpracticeHistory",
  "documents",
  "shareLog",
  "notificationLog",
  "locumContracts",
  "workLog",
  "encounters",
  "screenings",
  "alertAcks",
  "followUps",
  "professionalPhotos",
  "publications",
  "travelDocs",
  "travelExpenses",
  "taxPayments",
  "scheduleDays",
  "taskNotes",
  "dutyDays",
  "memberships",
  "invoices",
  "deductibles",
  "rotations",
  "customCategories",
  "customRecords",
]);
