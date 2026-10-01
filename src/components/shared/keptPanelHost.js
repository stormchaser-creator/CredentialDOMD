/**
 * The detached element a kept panel renders into (KeptPanel.jsx). Null
 * without a document (a server render), where KeptPanel renders in place.
 * Pass it to useState so a screen makes one host for its lifetime.
 */
export function newKeptPanelHost() {
  return typeof document !== "undefined" ? document.createElement("div") : null;
}
