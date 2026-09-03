import JSZip from "jszip";
import * as XLSX from "xlsx";
import { isDea, isBoard } from "./setupTasks.js";

/**
 * Section key to the folder its documents belong in. This is the ONE list:
 * the ZIP's folder structure is built from it and categorizeDocument routes
 * from it, so a section can no longer have a router entry and no folder, or
 * a folder and no router entry.
 *
 * Six sections had neither and everything they held fell through to
 * Other_Documents: a passport, a TB screening, the headshot, an employment
 * verification letter, a reference letter and a claim record all landed in
 * the same unlabelled pile.
 */
export const FOLDER_MAP = {
  licenses: "Medical_Licenses",
  privileges: "Hospital_Privileges",
  insurance: "Insurance",
  cme: "CME/CME_Certificates",
  education: "Education",
  healthRecords: "Health_Records",
  travelDocs: "Travel_and_IDs",
  screenings: "Screenings",
  professionalPhotos: "Professional_Photo",
  workHistory: "Work_History",
  peerReferences: "Peer_References",
  malpracticeHistory: "Malpractice_History",
};

/**
 * Two folders no section maps onto. A DEA registration and a board
 * certificate are both `licenses:` records, and both are asked for by name
 * by every credentialing office, so they cannot share a folder with the
 * state licenses.
 */
const DEA_FOLDER = "DEA_Registration";
const BOARD_FOLDER = "Board_Certifications";
const OTHER_FOLDER = "Other_Documents";

/** Folder order inside the ZIP, and the order documents are written in. */
export const PACKET_FOLDERS = [
  FOLDER_MAP.licenses, DEA_FOLDER, BOARD_FOLDER,
  FOLDER_MAP.privileges, FOLDER_MAP.insurance, FOLDER_MAP.cme,
  FOLDER_MAP.education, FOLDER_MAP.healthRecords, FOLDER_MAP.travelDocs,
  FOLDER_MAP.screenings, FOLDER_MAP.professionalPhotos, FOLDER_MAP.workHistory,
  FOLDER_MAP.peerReferences, FOLDER_MAP.malpracticeHistory, OTHER_FOLDER,
];

function sanitizeFilename(name) {
  return (name || "untitled").replace(/[^a-zA-Z0-9_\-. ]/g, "_").substring(0, 80);
}

/** Extensions the writer replaces with the one the mime type actually says. */
const KNOWN_EXT = /\.(pdf|png|jpe?g|heic|heif|webp|gif|tiff?)$/i;

function buildCredentialRows(data) {
  const rows = [];

  for (const lic of data.licenses || []) {
    rows.push({
      Credential: lic.state ? `${lic.state} Medical License` : "Medical License",
      Type: "License",
      "Issuing Authority": lic.issuingAuthority || lic.board || "",
      "License/Cert #": lic.licenseNumber || "",
      "Issue Date": lic.issuedDate || lic.issueDate || "",
      "Expiration Date": lic.expirationDate || "",
      Status: lic.status || "",
      State: lic.state || "",
      Notes: lic.notes || "",
    });
  }

  for (const priv of data.privileges || []) {
    rows.push({
      Credential: priv.hospital || priv.facility || "Hospital Privilege",
      Type: "Privilege",
      "Issuing Authority": priv.hospital || priv.facility || "",
      "License/Cert #": priv.privilegeNumber || "",
      "Issue Date": priv.appointmentDate || priv.issueDate || priv.startDate || "",
      "Expiration Date": priv.expirationDate || "",
      Status: priv.status || "",
      State: priv.state || "",
      Notes: priv.notes || "",
    });
  }

  for (const ins of data.insurance || []) {
    rows.push({
      Credential: ins.carrier || ins.company || "Insurance Policy",
      Type: "Insurance",
      "Issuing Authority": ins.carrier || ins.company || "",
      "License/Cert #": ins.policyNumber || "",
      "Issue Date": ins.issueDate || ins.effectiveDate || "",
      "Expiration Date": ins.expirationDate || "",
      Status: ins.status || "",
      State: ins.state || "",
      Notes: ins.notes || "",
    });
  }

  for (const cme of data.cme || []) {
    rows.push({
      Credential: cme.title || cme.activity || "CME Activity",
      Type: "CME",
      "Issuing Authority": cme.provider || cme.sponsor || "",
      "License/Cert #": cme.certificateNumber || "",
      "Issue Date": cme.completionDate || cme.date || "",
      "Expiration Date": "",
      Status: "Completed",
      State: cme.state || "",
      Notes: `${cme.hours || 0} hours${cme.category ? ` - ${cme.category}` : ""}`,
    });
  }

  for (const edu of data.education || []) {
    rows.push({
      Credential: edu.institution || edu.school || "Education",
      Type: "Education",
      "Issuing Authority": edu.institution || edu.school || "",
      "License/Cert #": edu.degree || "",
      "Issue Date": edu.startDate || "",
      "Expiration Date": edu.endDate || edu.graduationDate || "",
      Status: edu.status || "Completed",
      State: edu.state || "",
      Notes: edu.notes || "",
    });
  }

  for (const hr of data.healthRecords || []) {
    rows.push({
      Credential: hr.type || hr.name || "Health Record",
      Type: "Health Record",
      "Issuing Authority": hr.provider || "",
      "License/Cert #": "",
      "Issue Date": hr.date || "",
      "Expiration Date": hr.expirationDate || "",
      Status: hr.status || "",
      State: "",
      Notes: hr.notes || "",
    });
  }

  for (const wh of data.workHistory || []) {
    rows.push({
      Credential: wh.employer || wh.organization || "Work History",
      Type: "Work History",
      "Issuing Authority": wh.employer || wh.organization || "",
      "License/Cert #": "",
      "Issue Date": wh.startDate || "",
      "Expiration Date": wh.endDate || "",
      Status: wh.current ? "Current" : "Past",
      State: wh.state || "",
      Notes: wh.title || wh.position || "",
    });
  }

  for (const ref of data.peerReferences || []) {
    rows.push({
      Credential: ref.name || "Peer Reference",
      Type: "Peer Reference",
      "Issuing Authority": ref.institution || ref.organization || "",
      "License/Cert #": "",
      "Issue Date": "",
      "Expiration Date": "",
      Status: "",
      State: ref.state || "",
      Notes: `${ref.relationship || ""} ${ref.phone || ""} ${ref.email || ""}`.trim(),
    });
  }

  // Travel and IDs, screenings and the headshot each get a packet folder, so
  // each needs a line in the summary beside it. Without these three a
  // physician whose packet is a passport and a photo read "0 line items".
  for (const td of data.travelDocs || []) {
    rows.push({
      Credential: td.name || td.type || "Travel or ID",
      Type: td.type || "Travel / ID",
      "Issuing Authority": td.provider || "",
      "License/Cert #": td.number || "",
      "Issue Date": td.issuedDate || "",
      "Expiration Date": td.expirationDate || "",
      Status: "",
      State: td.state || "",
      Notes: td.notes || "",
    });
  }

  for (const sc of data.screenings || []) {
    rows.push({
      Credential: sc.name || sc.type || "Screening",
      Type: sc.type || "Screening",
      "Issuing Authority": sc.agency || "",
      "License/Cert #": sc.fileNumber || "",
      "Issue Date": sc.reportDate || sc.orderDate || "",
      "Expiration Date": sc.expirationDate || "",
      Status: sc.result || "",
      State: "",
      Notes: sc.notes || "",
    });
  }

  for (const ph of data.professionalPhotos || []) {
    rows.push({
      Credential: ph.name || "Professional photo",
      Type: "Professional Photo",
      "Issuing Authority": "",
      "License/Cert #": "",
      "Issue Date": ph.dateTaken || "",
      "Expiration Date": "",
      Status: "",
      State: "",
      Notes: ph.notes || "",
    });
  }

  for (const mal of data.malpracticeHistory || []) {
    rows.push({
      Credential: mal.description || "Malpractice History",
      Type: "Malpractice",
      "Issuing Authority": mal.court || "",
      "License/Cert #": mal.caseNumber || "",
      "Issue Date": mal.filingDate || mal.date || "",
      "Expiration Date": mal.resolutionDate || "",
      Status: mal.outcome || mal.status || "",
      State: mal.state || "",
      Notes: mal.notes || "",
    });
  }

  return rows;
}

function buildSpreadsheet(data) {
  const rows = buildCredentialRows(data);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Set column widths
  ws["!cols"] = [
    { wch: 30 }, { wch: 15 }, { wch: 25 }, { wch: 20 },
    { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 8 }, { wch: 30 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Credentials");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

/**
 * Last resort only: a filename says far less than a link does. "dea" is a
 * word test rather than a substring, or every file with "idea" in its name
 * filed itself as a controlled-substance registration.
 */
function folderFromName(doc) {
  const name = String(doc?.name || "").toLowerCase();
  if (!name) return null;
  if (/\bdea\b/.test(name)) return DEA_FOLDER;
  if (/\b(board|abms|aoa|abns|diplomate)\b/.test(name)) return BOARD_FOLDER;
  if (name.includes("privilege")) return FOLDER_MAP.privileges;
  if (name.includes("insurance") || name.includes("malpractice")) return FOLDER_MAP.insurance;
  if (name.includes("cme") || name.includes("continuing")) return FOLDER_MAP.cme;
  if (name.includes("license")) return FOLDER_MAP.licenses;
  if (name.includes("passport") || name.includes("driver")) return FOLDER_MAP.travelDocs;
  return null;
}

/**
 * Where one document belongs in the packet.
 *
 * The link is read first, which was already right, but "licenses:" won
 * outright and swallowed the DEA card and the board certificate with it, so
 * DEA_Registration and Board_Certifications were folders the ZIP created and
 * never wrote a file into. A `licenses:`-linked document is therefore
 * resolved against the record it is linked to, and the record's own type
 * decides the folder.
 */
export function categorizeDocument(doc, data) {
  const [section, id] = String(doc?.linkedTo || "").split(":");
  const folder = section ? FOLDER_MAP[section] : null;
  if (folder && section === "licenses") {
    const rec = (data?.licenses || []).find((l) => l && l.id === id);
    // The record was deleted after the file was attached, so the link points
    // at nothing and the filename is all that is left to read.
    if (!rec) return folderFromName(doc) || folder;
    if (isDea(rec)) return DEA_FOLDER;
    if (isBoard(rec)) return BOARD_FOLDER;
    return folder;
  }
  if (folder) return folder;
  return folderFromName(doc) || OTHER_FOLDER;
}

/** The bytes a document carries, as a base64 payload, or null when it has none. */
function docBase64(doc) {
  const raw = doc?.data || doc?.fileData;
  if (typeof raw !== "string" || !raw) return null;
  // A data URL ("data:image/png;base64,AAA") carries its bytes after the
  // comma; a bare base64 string is already the payload. Reading `.includes`
  // off fileData threw on every document written by the app, because the app
  // writes `data` and nothing has ever written `fileData`.
  const comma = raw.indexOf(",");
  return comma === -1 ? raw : raw.slice(comma + 1);
}

/**
 * The packet proper: every document that carries bytes AND is linked to a
 * record that still exists, in folder order.
 *
 * "Linked" is the whole claim the ending makes, so a stray upload sitting in
 * Files unattached is not counted, and a link pointing at a deleted record is
 * not counted either. Both still ride along in the ZIP; neither is described
 * as proof of anything.
 */
export function packetDocuments(data) {
  const rank = new Map(PACKET_FOLDERS.map((f, i) => [f, i]));
  const rows = [];
  for (const doc of data?.documents || []) {
    if (!doc || !docBase64(doc)) continue;
    const [section, id] = String(doc.linkedTo || "").split(":");
    if (!section || !id) continue;
    if (!(data?.[section] || []).some((r) => r && r.id === id)) continue;
    rows.push({ doc, folder: categorizeDocument(doc, data) });
  }
  return rows
    .sort((a, b) => (rank.get(a.folder) ?? 99) - (rank.get(b.folder) ?? 99))
    .map((r) => r.doc);
}

/** What the assembled packet contains, counted off the physician's own file. */
export function packetSummary(data) {
  return {
    lineItems: buildCredentialRows(data).length,
    documents: packetDocuments(data).length,
  };
}

/**
 * The one sentence under "Your packet is assembled." Every number in it is
 * checkable by opening the ZIP: the line items are the rows of
 * credentials_summary.xlsx, and the documents are the files beside it.
 */
export function packetSummaryLine({ lineItems = 0, documents = 0 } = {}) {
  const items = `${lineItems} line item${lineItems === 1 ? "" : "s"}`;
  if (!documents) return `${items}. No documents are attached to them yet.`;
  return `${items}. ${documents} document${documents === 1 ? "" : "s"}, each one linked to the record it proves.`;
}

export async function generateCredentialZip(data) {
  const zip = new JSZip();
  const root = zip.folder("CredentialDOMD_Export");

  for (const f of PACKET_FOLDERS) {
    root.folder(f);
  }

  // Two documents photographed on the same phone are both IMG_0269.jpeg, and
  // the second silently replaced the first inside its folder. A packet that
  // quietly drops a file is worse than one that names them awkwardly.
  const taken = new Set();
  const uniquePath = (folder, filename) => {
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    let path = `${folder}/${filename}`;
    let n = 2;
    while (taken.has(path)) path = `${folder}/${stem}_${n++}${ext}`;
    taken.add(path);
    return path;
  };

  for (const doc of data.documents || []) {
    const base64 = docBase64(doc);
    if (!base64) continue;
    const folder = categorizeDocument(doc, data);
    const mimeT = doc.type || doc.fileType;
    const ext = mimeT?.includes("pdf") ? ".pdf"
      : mimeT?.includes("png") ? ".png"
      : mimeT?.includes("jpeg") || mimeT?.includes("jpg") ? ".jpg"
      : "";
    const raw = sanitizeFilename(doc.name || doc.title);
    // IMG_0269.jpeg already carries an extension; appending .jpg to it is
    // the sort of detail a credentialing office reads as carelessness. When
    // the mime type is unrecognised the original name is left exactly as is.
    const filename = ext ? raw.replace(KNOWN_EXT, "") + ext : raw;
    root.file(uniquePath(folder, filename), base64, { base64: true });
  }

  // Add spreadsheet
  const xlsxData = buildSpreadsheet(data);
  root.file("credentials_summary.xlsx", xlsxData);

  // Add JSON backup
  const { apiKey, anthropicApiKey, ...safeSettings } = data.settings || {};
  const jsonBackup = JSON.stringify({
    ...data,
    settings: safeSettings,
    _exportMeta: {
      app: "CredentialDOMD",
      exportedAt: new Date().toISOString(),
    },
  }, null, 2);
  root.file("credentialdomd_backup.json", jsonBackup);

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  return blob;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}
