/**
 * exportUtils.js
 * ─────────────────────────────────────────────────────────────
 * Save the accumulated book text as a real .docx (Word) or .pdf
 * file. Used by the "Book to Digital" → "Export Options" modal.
 *
 * Design notes:
 *   - Both libraries (`docx`, `jspdf`) are lazy dynamic-imported so
 *     they never bloat the initial bundle — only paid for when the
 *     user actually clicks an export button.
 *   - Returns the same { ok, path?, error? } shape the rest of the
 *     app uses (see ocrEngine.js) so callers log uniformly.
 *   - Output preserves the soft line breaks in the accumulated text:
 *       `\n`  → newline (next Paragraph / next PDF line)
 *       `\n\n` → a blank-line separator (one empty paragraph, or an
 *                extra blank PDF line) so page boundaries stay visible.
 *   - RTL/Persian text is handled as best-effort for Task 4:
 *       • DOCX: paragraphs are flagged `bidirectional` so Word lays
 *         them out RTL automatically when the dominant script is RTL.
 *       • PDF: jsPDF's standard fonts don't shape Persian glyphs, but
 *         the text content and line structure are preserved exactly.
 *         A Unicode-font upgrade for proper Persian shaping is tracked
 *         as a Phase 2 follow-up.
 * ─────────────────────────────────────────────────────────────
 */

/**
 * Lazy-save the text as a Word .docx file.
 *
 * @param {string} text   - The accumulated book text (may contain `\n` / `\n\n`)
 * @param {object} [opts]
 * @param {string} [opts.filename='subscribe-book-export.docx']
 * @returns {Promise<{ok: boolean, filename?: string, error?: string}>}
 */
export async function exportToDocx(text, opts = {}) {
  const filename = opts.filename || 'subscribe-book-export.docx';
  const content = typeof text === 'string' ? text : '';

  if (!content.trim()) {
    return { ok: false, error: 'Nothing to export — accumulated text is empty.' };
  }

  try {
    // Lazy import so the library only enters the bundle when used.
    const { Document, Packer, Paragraph, TextRun } = await import('docx');

    // Detect the dominant script so every paragraph can flag itself
    // as bidirectional — Word then picks RTL/LTR per paragraph.
    const isRtl = detectIsRtl(content);

    // One Paragraph per line keeps `\n` as line breaks and `\n\n` as
    // actual blank-line separators between pages.
    const lines = content.split(/\r?\n/);
    const children = lines.map((line) =>
      new Paragraph({
        children: [new TextRun({ text: line })],
        bidirectional: isRtl,
        spacing: { line: 320 }, // ~1.33 line height for readable book text
      })
    );

    const doc = new Document({
      creator: 'SubScribe AI',
      title: 'Book to Digital export',
      sections: [
        {
          properties: {},
          children,
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    triggerBlobDownload(blob, filename);
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: err?.message || 'Failed to generate DOCX.' };
  }
}

/**
 * Lazy-save the text as a PDF file.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.filename='subscribe-book-export.pdf']
 * @returns {Promise<{ok: boolean, filename?: string, error?: string}>}
 */
export async function exportToPdf(text, opts = {}) {
  const filename = opts.filename || 'subscribe-book-export.pdf';
  const content = typeof text === 'string' ? text : '';

  if (!content.trim()) {
    return { ok: false, error: 'Nothing to export — accumulated text is empty.' };
  }

  try {
    // Lazy import — same reason as exportToDocx.
    const { default: jsPDF } = await import('jspdf');

    // A4 portrait, point units for predictable line math.
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginX = 48;
    const marginY = 56;             // top margin (leaves room for header line)
    const maxWidth = pageWidth - marginX * 2;
    const lineHeight = 16;
    const fontLineGap = 8;          // extra gap for blank-line separators

    // Use the standard Helvetica font. Persian glyphs will be missing/
    // best-effort, but line structure and Latin text are intact.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);

    // Optional header line so exports are clearly branded & paginated.
    const drawHeader = () => {
      doc.setTextColor(150, 150, 160);
      doc.setFontSize(9);
      doc.text('SubScribe AI — Book to Digital export', marginX, marginY - 24);
      doc.setFontSize(12);
      doc.setTextColor(20, 20, 25);
    };

    let y = marginY;
    drawHeader();

    // Walk the text line by line. `\n\n` naturally produces one empty
    // line, which we render as a small vertical gap (lineHeight + gap).
    // Long lines are wrapped with splitTextToSize so wide paragraphs
    // never run off the right margin.
    const rawLines = content.split(/\r?\n/);

    for (const rawLine of rawLines) {
      const isBlank = rawLine.trim() === '';

      if (isBlank) {
        // Render the blank line as extra vertical space (page break aware).
        y += fontLineGap;
        if (y > pageHeight - marginY) {
          doc.addPage();
          y = marginY;
          drawHeader();
        }
        continue;
      }

      const wrapped = doc.splitTextToSize(rawLine, maxWidth);
      for (const seg of wrapped) {
        if (y > pageHeight - marginY) {
          doc.addPage();
          y = marginY;
          drawHeader();
        }
        doc.text(seg, marginX, y);
        y += lineHeight;
      }
    }

    const blob = doc.output('blob');
    triggerBlobDownload(blob, filename);
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: err?.message || 'Failed to generate PDF.' };
  }
}

/* ─── Internal helpers ─── */

/**
 * Trigger a browser blob download. Works identically in the Electron
 * renderer and a plain browser tab — Vite dev + packaged Electron
 * both honor the standard <a download> flow.
 */
function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the click event has time to flush.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Detect whether the dominant script of the text is RTL (Persian,
 * Arabic, Hebrew, etc.). Used to flag DOCX paragraphs as bidirectional
 * so Word lays them out correctly.
 */
function detectIsRtl(text) {
  if (!text) return false;
  const sample = text.slice(0, 4000);
  let rtl = 0;
  let ltr = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0);
    // Arabic (0x0600–0x06FF), Arabic Supplement (0x0750–0x077F),
    // Hebrew (0x0590–0x05FF), Persian lives inside the Arabic block.
    if ((code >= 0x0600 && code <= 0x06FF) ||
        (code >= 0x0750 && code <= 0x077F) ||
        (code >= 0x0590 && code <= 0x05FF)) {
      rtl++;
    } else if (/[A-Za-z]/.test(ch)) {
      ltr++;
    }
  }
  return rtl > ltr;
}
