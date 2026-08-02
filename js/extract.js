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
    // The column just finished, if any — recorded here (not measured off a
    // shared "bottom edge" coordinate, which turns out to have false friends:
    // moderate-length columns coincidentally end near the same position often
    // enough to look like a landmark) so markLineRoles can tell whether it
    // used up all the vertical space it had, the mechanical reason a speech
    // continues in the next column at all. Measured in character count, not
    // points — a heading set in a display size would otherwise measure as
    // "tall" on physical distance alone and be mistaken for a full column.
    if (cur) cur.span = Math.hypot(prev.x - cur.startX, prev.y - cur.startY) / (cur.fontSize || baseSize);
    cur = { text: it.str, startX: it.x, startY: it.y, span: 0, fontSize: it.height || baseSize };
    lines.push(cur);
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
      // is the indent that sits between a role name and its dialogue, wherever
      // a particular script happens to put it.
      if (-dy - pitch > pitch * 0.5) cur.text += ' ';
      cur.text += it.str;
    } else if (sameRow) {
      horizontalVotes++;
      if (dx - pitch > pitch * 0.6) cur.text += ' ';
      cur.text += it.str;
    } else {
      startLine(it);
    }
    prev = it;
  }
  if (cur) cur.span = Math.hypot(prev.x - cur.startX, prev.y - cur.startY) / (cur.fontSize || baseSize);

  return { lines, baseSize, verticalVotes, horizontalVotes };
}

// Japanese scripts indent the parts of a page by what they are: the role name
// sits at the margin, and everything belonging under it is pulled in — stage
// directions a little, dialogue wrapping onto the next line as far as the
// dialogue column. That layout is the clearest evidence of what a line *is*,
// and it survives in the PDF as the coordinate each line starts at.
//
// Two things distinguish what a line is, and neither depends on how wide a
// script sets its role-name field (which varies — some scripts reserve a
// fixed-width slot for the name regardless of length, others just leave a
// single gap after it, which puts the dialogue at a different position for
// every name length):
//
//  - Where a column *starts*. Fresh content — a role name, or a stage
//    direction with no name — begins at the margin, page after page, so that
//    position is the single most common start coordinate in the document.
//
//  - Why a column *exists at all*. A column that is not fresh content but the
//    continuation of a speech too long for the previous column exists only
//    because that previous column ran out of room and got cut off at the
//    page's bottom edge. That edge is mechanical — the same for every column
//    that overflows, regardless of the text in it — so it is the single most
//    common "previous column's last character" coordinate in the document.
//    A line whose predecessor ended there is a forced continuation.
//
// Both are found the same way: histogram the coordinate, take whichever value
// recurs most. Neither needs to know the width of anything.
function markLineRoles(allLines, baseSize, vertical) {
  if (allLines.length === 0) return;
  const startOf = (l) => (vertical ? l.startY : l.startX);
  const tolerance = baseSize * 0.6;

  // A column that used up (nearly) all the vertical space available to it was
  // almost certainly cut off rather than having ended there on purpose — so
  // whatever comes right after it is that same speech continuing. Measuring
  // each column's own span and comparing it to the tallest columns in the
  // document is more reliable than trying to recognize "the bottom edge" as a
  // shared coordinate: moderate-length columns end near the same position
  // often enough, by coincidence, to be mistaken for it.
  const spans = allLines.map((l) => l.span).filter((s) => s > 0).sort((a, b) => a - b);
  const tallSpan = spans.length ? spans[Math.floor(spans.length * 0.97)] : Infinity;
  const fullThreshold = tallSpan * 0.85;

  // Collect every coordinate that recurs often enough to be a real landmark
  // rather than a coincidence. A page can hold more than one independent
  // block of text with its own margin (this script sets two stacked bands
  // per page), so this keeps every such value rather than assuming a single
  // one applies to the whole document.
  const counts = new Map();
  for (const line of allLines) {
    const key = Math.round(startOf(line));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const minHits = Math.max(3, allLines.length * 0.015);
  const candidates = [...counts.entries()].filter(([, c]) => c >= minHits).map(([k]) => k);
  // A stage direction is deliberately pulled in a little from the true margin
  // — so its start position can itself recur often enough to look like a
  // landmark. Tell the two apart the way frequency tells apart any real
  // pattern from a lesser echo of it: keep a candidate only if nothing close
  // to it is *more* common, since most lines in a scene are dialogue, not
  // bare narration.
  const groupDistance = baseSize * 3;
  const margins = candidates.filter((c) => !candidates.some(
    (other) => other !== c && Math.abs(other - c) <= groupDistance && counts.get(other) > counts.get(c)
  ));
  const atMargin = (value) => margins.some((m) => Math.abs(value - m) <= tolerance);

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const isForcedContinuation = i > 0 && allLines[i - 1].span >= fullThreshold;
    if (isForcedContinuation) line.lineRole = 'continuation';
    else if (atMargin(startOf(line))) line.lineRole = 'margin';
    else line.lineRole = 'indented';
    line.isContinuation = isForcedContinuation;
  }
}

// Strips a running header/footer (title + changing page number) repeated on
// most pages, which would otherwise show up as a bogus "unknown" block on
// every single page in the manual-fix step.
function stripRunningHeaders(pages) {
  const withoutTrailingNumber = (line) => line.replace(/[0-9０-９\s]+$/, '').trim();
  // Some scripts print nothing but the page number itself as the header —
  // withoutTrailingNumber reduces that to '', which would otherwise never
  // reach the length-3 floor that guards against stripping a coincidence.
  const isBareNumber = (line) => /^[0-9０-９]+$/.test(line.trim());

  const counts = new Map();
  let bareNumberPages = 0;
  for (const p of pages) {
    const first = p.lines[0]?.text || '';
    if (isBareNumber(first)) { bareNumberPages++; continue; }
    const key = withoutTrailingNumber(first);
    if (key.length >= 3) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const threshold = Math.max(3, pages.length * 0.5);
  let headerKey = null;
  for (const [key, count] of counts) {
    if (count >= threshold) { headerKey = key; break; }
  }
  const stripBareNumbers = bareNumberPages >= threshold;
  if (!headerKey && !stripBareNumbers) return pages;

  return pages.map((p) => {
    const first = p.lines[0]?.text;
    if (!p.lines.length) return p;
    if (headerKey && withoutTrailingNumber(first) === headerKey) return { ...p, lines: p.lines.slice(1) };
    if (stripBareNumbers && isBareNumber(first)) return { ...p, lines: p.lines.slice(1) };
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
