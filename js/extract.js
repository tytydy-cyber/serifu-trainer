import { loadVendorScript } from './ui.js';
import { normalizeRawText } from './parser.js';

// All extraction happens on-device; nothing is uploaded anywhere.

// Plain text carries its indentation literally, so measure it in leading
// whitespace instead of coordinates and hand the parser the same shape the
// PDF path produces.
function linesFromPlainText(text) {
  return text.split('\n').map((raw) => {
    const leading = /^[ 　\t]*/.exec(raw)[0];
    const width = [...leading].reduce((n, ch) => n + (ch === '\t' ? 4 : ch === '　' ? 2 : 1), 0);
    return { text: raw.trim(), indent: Math.floor(width / 2) };
  });
}

export function extractFromPlainText(text) {
  const normalized = normalizeRawText(text);
  const rawPages = normalized.split('\f').map((t) => t.trim()).filter(Boolean);
  return (rawPages.length ? rawPages : [normalized]).map((t, i) => ({
    text: t,
    pageNumber: i + 1,
    lines: linesFromPlainText(t),
  }));
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

// Returns { lines: [{ text, start, vertical }], baseSize } for one page.
// `start` is where the line begins along the axis the text is indented on
// (y for vertical writing, x for horizontal) — the raw coordinate, turned into
// an indent level later once the whole document's margins are known.
function reconstructPageLines(rawItems) {
  const items = rawItems
    .filter((it) => it.str && it.str.length > 0)
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], height: it.height }));
  if (items.length === 0) return { lines: [], baseSize: 12 };

  const baseSize = modeHeight(items) || 12;
  // Ruby/furigana glyphs are set noticeably smaller than the body text they annotate.
  const main = items.filter((it) => !it.height || it.height >= baseSize * 0.65);
  if (main.length === 0) return { lines: [], baseSize };

  const lines = [];
  let cur = null;
  let prev = null;
  let verticalVotes = 0;
  let horizontalVotes = 0;

  // Keep both axes and pick between them once the document's writing direction
  // is known. A line cannot decide its own orientation reliably — a page whose
  // running header is set horizontally over vertical body text would otherwise
  // hand the first body line the header's orientation.
  const startLine = (it) => {
    cur = { text: it.str, startX: it.x, startY: it.y, bodyX: null, bodyY: null };
    lines.push(cur);
  };
  const noteGap = (it) => {
    // Where the text after the line's first gap begins. On a role-name line
    // this is where the dialogue column starts, which is also where wrapped
    // dialogue begins — giving us that landmark directly instead of inferring it.
    if (cur.bodyX === null) { cur.bodyX = it.x; cur.bodyY = it.y; }
  };

  for (const it of main) {
    if (!prev) {
      startLine(it);
      prev = it;
      continue;
    }
    const dx = it.x - prev.x;
    const dy = it.y - prev.y;
    const pitch = Math.max(prev.height || baseSize, it.height || baseSize, baseSize);
    const sameColumn = Math.abs(dx) < pitch * 0.4 && dy < 0;
    const sameRow = Math.abs(dy) < pitch * 0.4 && dx > 0;

    if (sameColumn) {
      verticalVotes++;
      // A gap wider than the character pitch is a deliberate separation — this
      // is the indent that sits between a role name and its dialogue.
      if (-dy - pitch > pitch * 0.5) { cur.text += ' '; noteGap(it); }
      cur.text += it.str;
    } else if (sameRow) {
      horizontalVotes++;
      if (dx - pitch > pitch * 0.6) { cur.text += ' '; noteGap(it); }
      cur.text += it.str;
    } else {
      startLine(it);
    }
    prev = it;
  }

  return { lines, baseSize, verticalVotes, horizontalVotes };
}

// Japanese scripts indent the parts of a page by what they are: the role name
// sits at the margin, and everything belonging under it is pulled in — stage
// directions a little, dialogue wrapping onto the next line as far as the
// dialogue column. That layout is the clearest evidence of what a line *is*,
// and it survives in the PDF as the coordinate each line starts at.
//
// Rather than trying to recover margins by clustering coordinates — which
// breaks down as soon as a page holds several text blocks with their own
// margins, or a stray line lands between them — use a landmark we can read
// off directly. On a role-name line the gap after the name lands exactly on
// the dialogue column, and that is the same position wrapped dialogue starts
// at. So collect those positions, keep the ones that recur, and a line
// continues the previous one precisely when it begins at one of them.
function markLineRoles(allLines, baseSize, vertical) {
  if (allLines.length === 0) return;
  const startOf = (l) => (vertical ? l.startY : l.startX);
  const bodyOf = (l) => (vertical ? l.bodyY : l.bodyX);
  // Distance from the dialogue column back towards the margin, as a positive
  // number regardless of which way the script is set.
  const towardsMargin = (from, column) => (vertical ? from - column : column - from);

  const bodyCounts = new Map();
  for (const line of allLines) {
    if (bodyOf(line) === null) continue;
    const key = Math.round(bodyOf(line));
    bodyCounts.set(key, (bodyCounts.get(key) || 0) + 1);
  }
  // A real dialogue column recurs on page after page; a one-off gap does not.
  const minHits = Math.max(3, allLines.length * 0.02);
  const columns = [...bodyCounts.entries()]
    .filter(([, count]) => count >= minHits)
    .map(([coord]) => coord);

  if (columns.length === 0) {
    for (const line of allLines) line.lineRole = 'margin';
    return;
  }

  // How far the margin sits from the dialogue column — i.e. the width of the
  // role-name field. Measured from the role lines themselves, where both
  // positions are known, so it needs no assumption about the page layout.
  const offsets = allLines
    .filter((l) => bodyOf(l) !== null)
    .map((l) => towardsMargin(startOf(l), bodyOf(l)))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const marginOffset = offsets[Math.floor(offsets.length / 2)] || baseSize;

  const tolerance = baseSize * 0.5;
  for (const line of allLines) {
    const start = startOf(line);
    // Compare against whichever dialogue column this line sits nearest, so a
    // page holding several blocks of text needs no special handling.
    const column = columns.reduce(
      (best, c) => (Math.abs(start - c) < Math.abs(start - best) ? c : best),
      columns[0]
    );
    const rel = towardsMargin(start, column);
    if (Math.abs(rel) <= tolerance) line.lineRole = 'continuation';
    else if (Math.abs(rel - marginOffset) <= tolerance) line.lineRole = 'margin';
    else line.lineRole = rel > 0 ? 'indented' : 'continuation';
    line.isContinuation = line.lineRole === 'continuation';
  }
}

// Strips a running header/footer (title + changing page number) repeated on
// most pages, which would otherwise show up as a bogus "unknown" block on
// every single page in the manual-fix step.
function stripRunningHeaders(pages) {
  const withoutTrailingNumber = (line) => line.replace(/[0-9０-９\s]+$/, '').trim();

  const counts = new Map();
  for (const p of pages) {
    const key = withoutTrailingNumber(p.lines[0]?.text || '');
    if (key.length >= 3) counts.set(key, (counts.get(key) || 0) + 1);
  }
  let headerKey = null;
  for (const [key, count] of counts) {
    if (count >= Math.max(3, pages.length * 0.5)) { headerKey = key; break; }
  }
  if (!headerKey) return pages;

  return pages.map((p) => {
    if (p.lines.length && withoutTrailingNumber(p.lines[0].text) === headerKey) {
      return { ...p, lines: p.lines.slice(1) };
    }
    return p;
  });
}

function withText(page) {
  return { ...page, text: normalizeRawText(page.lines.map((l) => l.text).join('\n')) };
}

export async function extractFromPdfFile(file, onProgress) {
  await loadVendorScript('vendor/pdf.min.js');
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  const allLines = [];
  const sizeVotes = [];
  let vertical = 0;
  let horizontal = 0;

  for (let i = 1; i <= doc.numPages; i++) {
    if (onProgress) onProgress(i, doc.numPages);
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const { lines, baseSize: size, verticalVotes, horizontalVotes } = reconstructPageLines(content.items);
    // The title page is set in display sizes, so take the body size from the
    // document as a whole rather than from whichever page happens to be first.
    sizeVotes.push(size);
    vertical += verticalVotes;
    horizontal += horizontalVotes;
    allLines.push(...lines);
    pages.push({ pageNumber: i, lines });
  }

  sizeVotes.sort((a, b) => a - b);
  const baseSize = sizeVotes[Math.floor(sizeVotes.length / 2)] || 12;
  markLineRoles(allLines, baseSize, vertical >= horizontal);
  return stripRunningHeaders(pages).map(withText);
}

export async function extractFromFile(file, onProgress) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return extractFromPdfFile(file, onProgress);
  if (name.endsWith('.docx')) return extractFromDocxFile(file);
  if (name.endsWith('.txt') || name.endsWith('.md')) return extractFromTxtFile(file);
  throw new Error('対応していないファイル形式です（.pdf / .docx / .txt に対応）');
}
