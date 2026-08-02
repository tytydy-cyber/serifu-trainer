import { loadVendorScript } from './ui.js';
import { normalizeRawText } from './parser.js';

// All extraction happens on-device; nothing is uploaded anywhere.

export function extractFromPlainText(text) {
  const normalized = normalizeRawText(text);
  const rawPages = normalized.split('\f').map((t) => t.trim()).filter(Boolean);
  const pages = (rawPages.length ? rawPages : [normalized]).map((t, i) => ({ text: t, pageNumber: i + 1 }));
  return pages;
}

export async function extractFromTxtFile(file) {
  const text = await file.text();
  return extractFromPlainText(text);
}

export async function extractFromDocxFile(file) {
  await loadVendorScript('vendor/mammoth.browser.min.js');
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return extractFromPlainText(result.value);
}

// Japanese stage scripts are as often set vertically (縦書き) as horizontally,
// sometimes on the same page (a horizontal running header over vertical body
// text). pdf.js's getTextContent() gives per-character position but no
// reliable direction flag for this kind of font, so instead of assuming rows,
// we look at the geometric transition between each pair of consecutive glyphs
// (which pdf.js already emits in the writing/reading order the PDF's content
// stream used — verified against real 縦書き scripts) and classify it as
// "continues this column" (small |dx|, moving down), "continues this row"
// (small |dy|, moving right), or "new line" (anything else — a column/row
// change or a large jump). A gap bigger than one character's pitch inside a
// run becomes a space — this is what turns "役名┃セリフ" (role name directly
// followed by dialogue with just a typesetting gap, no colon/brackets) into
// "役名 セリフ", which parser.js recognizes.
function modeHeight(items) {
  const counts = new Map();
  for (const it of items) {
    if (!it.height) continue;
    const key = Math.round(it.height * 5) / 5;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = 12;
  let bestCount = 0;
  for (const [h, c] of counts) {
    if (c > bestCount) { best = h; bestCount = c; }
  }
  return best;
}

function reconstructPageText(rawItems) {
  const items = rawItems
    .filter((it) => it.str && it.str.length > 0)
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], height: it.height }));
  if (items.length === 0) return '';

  const baseSize = modeHeight(items) || 12;
  // Ruby/furigana glyphs are set noticeably smaller than the body text they annotate.
  const main = items.filter((it) => !it.height || it.height >= baseSize * 0.65);

  let out = '';
  let prev = null;
  for (const it of main) {
    if (!prev) {
      out += it.str;
      prev = it;
      continue;
    }
    const dx = it.x - prev.x;
    const dy = it.y - prev.y;
    const pitch = Math.max(prev.height || baseSize, it.height || baseSize, baseSize);
    const sameColumn = Math.abs(dx) < pitch * 0.4 && dy < 0;
    const sameRow = Math.abs(dy) < pitch * 0.4 && dx > 0;

    if (sameColumn) {
      if (-dy - pitch > pitch * 0.5) out += ' ';
      out += it.str;
    } else if (sameRow) {
      if (dx - pitch > pitch * 0.6) out += ' ';
      out += it.str;
    } else {
      out += '\n' + it.str;
    }
    prev = it;
  }
  return out;
}

// Strips a running header/footer (title + changing page number) repeated on
// most pages, which would otherwise show up as a bogus "unknown" block on
// every single page in the manual-fix step.
function stripRunningHeaders(pages) {
  const firstLine = (text) => {
    const idx = text.indexOf('\n');
    return idx === -1 ? text : text.slice(0, idx);
  };
  const withoutTrailingNumber = (line) => line.replace(/[0-9０-９\s]+$/, '').trim();

  const counts = new Map();
  for (const p of pages) {
    const key = withoutTrailingNumber(firstLine(p.text));
    if (key.length >= 3) counts.set(key, (counts.get(key) || 0) + 1);
  }
  let headerKey = null;
  for (const [key, count] of counts) {
    if (count >= Math.max(3, pages.length * 0.5)) { headerKey = key; break; }
  }
  if (!headerKey) return pages;

  return pages.map((p) => {
    const idx = p.text.indexOf('\n');
    const first = idx === -1 ? p.text : p.text.slice(0, idx);
    if (withoutTrailingNumber(first) === headerKey) {
      return { ...p, text: idx === -1 ? '' : p.text.slice(idx + 1) };
    }
    return p;
  });
}

export async function extractFromPdfFile(file, onProgress) {
  await loadVendorScript('vendor/pdf.min.js');
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    if (onProgress) onProgress(i, doc.numPages);
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = reconstructPageText(content.items);
    pages.push({ text: normalizeRawText(pageText), pageNumber: i });
  }

  return stripRunningHeaders(pages);
}

export async function extractFromFile(file, onProgress) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return extractFromPdfFile(file, onProgress);
  if (name.endsWith('.docx')) return extractFromDocxFile(file);
  if (name.endsWith('.txt') || name.endsWith('.md')) return extractFromTxtFile(file);
  throw new Error('対応していないファイル形式です（.pdf / .docx / .txt に対応）');
}
