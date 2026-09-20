// A failed collection read is unknown data, never an empty account. Keep this
// reference fixed: provider messages and record contents must not enter reports.
export const ACCOUNT_RECORDS_SUPPORT_REFERENCE = "DATA-LOAD-UNAVAILABLE";

export function accountRecordsLoadError() {
  const error = new Error("Your saved records could not be loaded completely.");
  error.code = "account_records_unavailable";
  return error;
}

export function assertCompleteAccountRecords(value, profileId, collectionKeys) {
  if (!value || value._userId !== profileId || !value.settings || typeof value.settings !== "object"
    || Array.isArray(value.settings) || (value._errored != null && (!(value._errored instanceof Set) || value._errored.size > 0))
    || collectionKeys.some(key => !Array.isArray(value[key]))) throw accountRecordsLoadError();
}
