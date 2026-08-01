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
      doc.text(`${section.name}${section.degree ? `, ${section.degree}` : ""}`, M, y + 14);
      y += 24;
      doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(90, 98, 110);
      if (section.address) { doc.text(section.address, M, y + 10); y += 14; }
      const contact = [section.email, section.website, section.phone, section.npi ? `NPI ${section.npi}` : ""]
        .filter(Boolean).join("   ·   ");
      if (contact) { doc.text(contact, M, y + 10); y += 14; }
      if (section.specialties?.length) {
        doc.setFont("helvetica", "bold").setFontSize(10.5).setTextColor(13, 110, 253);
        doc.text(`${section.fullDegree ? section.fullDegree + " — " : ""}${section.specialties.map(id => id.split(":").pop()).join(", ")}`, M, y + 10);
        y += 14;
      }
      y += 6;
      doc.setDrawColor(20, 24, 33).setLineWidth(1.4);
      doc.line(M, y, M + W, y);
      y += 18;
      continue;
    }

    ensure(40);
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
      const detail = item.detail ? doc.setFontSize(9).splitTextToSize(item.detail, W - 10) : [];
      const need = (item.primary ? 13 : 2) + secondary.length * (paraSize + 2.5) + detail.length * 10 + 5;
      ensure(Math.min(need, 700));

      if (item.primary) {
        doc.setFont("helvetica", "bold").setFontSize(item.subhead ? 11 : 10.5).setTextColor(20, 24, 33);
        const dateW = item.date ? doc.setFont("helvetica", "normal").setFontSize(9).getTextWidth(item.date) : 0;
        doc.setFont("helvetica", "bold").setFontSize(item.subhead ? 11 : 10.5);
        const primary = doc.splitTextToSize(item.primary, W - dateW - 16);
        if (item.subhead) y += 3;
        doc.text(primary, M + (item.subhead ? 0 : 4), y + 10);
        if (item.date) {
          doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(130, 136, 145);
          doc.text(item.date, M + W - dateW, y + 10);
        }
        y += 13 + (primary.length - 1) * 12;
      }

      if (secondary.length) {
        doc.setFont("helvetica", "normal").setFontSize(paraSize).setTextColor(item.primary ? 90 : 40, item.primary ? 98 : 46, item.primary ? 110 : 56);
        doc.text(secondary, M + 4, y + 9);
        y += secondary.length * (paraSize + 2.5) + 1;
      }
      if (detail.length) {
        doc.setFontSize(9).setTextColor(130, 136, 145);
        doc.text(detail, M + 4, y + 9);
        y += detail.length * 10 + 1;
      }
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
