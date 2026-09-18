// Tiny ASCII-only documents for offline UI canaries. No real credential data.
export function syntheticPdf({ pages = 2, inertActions = false } = {}) {
  const pageRefs = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`);
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${inertActions ? ' /OpenAction << /S /JavaScript /JS (app.alert\\("SYNTHETIC_PDF_ACTION"\\)) >>' : ""} >>`,
    `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 16 Tf 30 100 Td (Synthetic credential page ${i + 1}) Tj ET`;
    const link = inertActions ? ' /Annots [<< /Type /Annot /Subtype /Link /Rect [20 20 180 45] /A << /S /URI /URI (https://example.invalid/synthetic-pdf-link) >> >>]' : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R${link} >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(value.length); value += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = value.length;
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) value += `${String(offset).padStart(10, "0")} 00000 n \n`;
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(value);
}
