import JSZip from "jszip";
import * as XLSX from "xlsx";

const FOLDER_MAP = {
  licenses: "Medical_Licenses",
  privileges: "Hospital_Privileges",
  insurance: "Insurance",
  cme: "CME",
  education: "Education",
  healthRecords: "Health_Records",
};

function sanitizeFilename(name) {
  return (name || "untitled").replace(/[^a-zA-Z0-9_\-. ]/g, "_").substring(0, 80);
}

function buildCredentialRows(data) {
  const rows = [];

  for (const lic of data.licenses || []) {
    rows.push({
      Credential: lic.state ? `${lic.state} Medical License` : "Medical License",
      Type: "License",
      "Issuing Authority": lic.issuingAuthority || lic.board || "",
      "License/Cert #": lic.licenseNumber || "",
      "Issue Date": lic.issueDate || "",
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
      "Issue Date": priv.issueDate || priv.startDate || "",
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

function categorizeDocument(doc) {
  const linked = (doc.linkedTo || "").toLowerCase();
  const name = (doc.name || "").toLowerCase();

  if (linked.startsWith("licenses") || name.includes("license")) return "Medical_Licenses";
  if (linked.startsWith("privileges") || name.includes("privilege")) return "Hospital_Privileges";
  if (linked.startsWith("insurance") || name.includes("insurance") || name.includes("malpractice")) return "Insurance";
  if (linked.startsWith("cme") || name.includes("cme") || name.includes("continuing")) return "CME/CME_Certificates";
  if (name.includes("dea")) return "DEA_Registration";
  if (name.includes("board") || name.includes("abns") || name.includes("abms")) return "Board_Certifications";
  return "Other_Documents";
}

export async function generateCredentialZip(data) {
  const zip = new JSZip();
  const root = zip.folder("CredentialDOMD_Export");

  // Create folder structure
  const folders = [
    "Medical_Licenses", "DEA_Registration", "Board_Certifications",
    "Hospital_Privileges", "Insurance", "CME/CME_Certificates",
    "Education", "Health_Records", "Other_Documents",
  ];
  for (const f of folders) {
    root.folder(f);
  }

  // Add documents if they have file data
  for (const doc of data.documents || []) {
    if (!doc.fileData && !doc.url) continue;
    const folder = categorizeDocument(doc);
    const ext = doc.fileType?.includes("pdf") ? ".pdf"
      : doc.fileType?.includes("png") ? ".png"
      : doc.fileType?.includes("jpeg") || doc.fileType?.includes("jpg") ? ".jpg"
      : "";
    const filename = sanitizeFilename(doc.name || doc.title) + ext;

    if (doc.fileData) {
      // Base64 encoded file data
      const base64 = doc.fileData.includes(",") ? doc.fileData.split(",")[1] : doc.fileData;
      root.file(`${folder}/${filename}`, base64, { base64: true });
    }
  }

  // Add spreadsheet
  const xlsxData = buildSpreadsheet(data);
  root.file("credentials_summary.xlsx", xlsxData);

  // Add JSON backup
  const { apiKey, ...safeSettings } = data.settings;
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
