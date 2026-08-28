import { jsPDF } from "jspdf";

/**
 * Real PDF for the CV — the print-window approach dies silently in the
 * installed PWA (iOS blocks window.open in standalone), so the CV ships
 * the same way invoices do: jsPDF file → share sheet → download fallback.
 */

const M = 54; // page margin (pt)
const W = 612 - M * 2; // usable width on letter

export function buildCvPdf(sections, { name = "Physician", degree = "" } = {}) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageH = doc.internal.pageSize.getHeight();
  let y = M;

  const ensure = (need) => {
    if (y + need > pageH - M) { doc.addPage(); y = M; }
  };

  for (const section of sections) {
    if (section.type === "header") {
      doc.setFont("helvetica", "bold").setFontSize(19).setTextColor(20, 24, 33);
      // The header block is centered: that is the convention for a physician
      // CV, and it is what a medical staff office expects at the top of the
      // page. Everything below the rule stays left aligned.
      const CX = M + W / 2;
      // Name only — the degree rides on the specialty line, exactly as the
      // preview and clipboard export render it.
      for (const line of doc.splitTextToSize(section.name, W)) {
        doc.text(line, CX, y + 14, { align: "center" });
        y += 22;
      }
      y += 2;
      doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(90, 98, 110);
      const headerLine = (text, step) => {
        for (const line of doc.splitTextToSize(text, W)) {
          doc.text(line, CX, y + 10, { align: "center" });
          y += step;
        }
      };
      if (section.address) headerLine(section.address, 13);
      const contact = [section.email, section.website, section.phone, section.npi ? `NPI ${section.npi}` : ""]
        .filter(Boolean).join("   ·   ");
      if (contact) headerLine(contact, 13);
      if (section.specialties?.length) {
        doc.setFont("helvetica", "bold").setFontSize(10.5).setTextColor(13, 110, 253);
        headerLine(`${section.fullDegree ? section.fullDegree + " — " : ""}${section.specialties.map(id => id.split(":").pop()).join(", ")}`, 13.5);
      }
      y += 6;
      doc.setDrawColor(20, 24, 33).setLineWidth(1.4);
      doc.line(M, y, M + W, y);
      y += 18;
      continue;
    }

    // A heading must never sit alone at the foot of a page — reserve the
    // heading block plus the first line of its first item.
    ensure(25 + 26);
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(13, 110, 253);
    doc.text(section.title.toUpperCase(), M, y + 10);
    y += 15;
    doc.setDrawColor(210, 214, 220).setLineWidth(0.6);
    doc.line(M, y, M + W, y);
    y += 10;

    for (const item of section.items) {
      // Paragraph items (summary text, publication citations) carry their body
      // in `secondary` with no bold lead line — render as flowing text
      const paraSize = item.primary ? 9.5 : 10;
      const secondary = item.secondary ? doc.setFont("helvetica", "normal").setFontSize(paraSize).splitTextToSize(item.secondary, W - 10) : [];
      const detail = item.detail ? doc.setFont("helvetica", "normal").setFontSize(9).splitTextToSize(item.detail, W - 10) : [];

      if (item.primary) {
        doc.setFont("helvetica", "normal").setFontSize(9);
        const dateW = item.date ? doc.getTextWidth(item.date) : 0;
        doc.setFont("helvetica", "bold").setFontSize(item.subhead ? 11 : 10.5);
        const primary = doc.splitTextToSize(item.primary, W - dateW - 16);
        // Reserve the whole lead block plus one following line, so a wrapped
        // title never splits from its own body across a page break.
        ensure(13 + (primary.length - 1) * 12 + (secondary.length || detail.length ? 12 : 0));
        if (item.subhead) y += 3;
        doc.setTextColor(20, 24, 33);
        doc.text(primary, M + (item.subhead ? 0 : 4), y + 10);
        if (item.date) {
          doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(130, 136, 145);
          doc.text(item.date, M + W - dateW, y + 10);
        }
        y += 13 + (primary.length - 1) * 12;
      }

      // Long bodies (a full publication citation, the summary paragraph) can
      // exceed a whole page — draw line by line so nothing is ever clipped.
      const flow = (linesArr, size, color) => {
        for (const line of linesArr) {
          ensure(size + 2.5);
          doc.setFont("helvetica", "normal").setFontSize(size).setTextColor(...color);
          doc.text(line, M + 4, y + 9);
          y += size + 2.5;
        }
        if (linesArr.length) y += 1;
      };
      flow(secondary, paraSize, item.primary ? [90, 98, 110] : [40, 46, 56]);
      flow(detail, 9, [130, 136, 145]);
      y += item.primary ? 5 : 7;
    }
    y += 8;
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(160, 165, 172);
    doc.text(`${name}${degree ? `, ${degree}` : ""} — Curriculum Vitae · page ${p} of ${pages}`, M, pageH - 24);
  }

  const blob = doc.output("blob");
  const fname = `CV — ${name}${degree ? `, ${degree}` : ""}.pdf`;
  return new File([blob], fname, { type: "application/pdf" });
}

export async function shareCvPdf(sections, meta) {
  const file = buildCvPdf(sections, meta);
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ title: file.name, files: [file] });
      return "share";
    } catch (err) {
      if (err?.name === "AbortError") return null;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "download";
}
