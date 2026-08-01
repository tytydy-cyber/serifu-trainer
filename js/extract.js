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
    const items = content.items
      .filter((it) => it.str != null)
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));

    items.sort((a, b) => b.y - a.y || a.x - b.x);

    const TOL = 3;
    const lines = [];
    let curY = null;
    let curLine = [];
    for (const it of items) {
      if (curY === null || Math.abs(it.y - curY) > TOL) {
        if (curLine.length) lines.push(curLine);
        curLine = [it];
        curY = it.y;
      } else {
        curLine.push(it);
      }
    }
    if (curLine.length) lines.push(curLine);

    const pageText = lines
      .map((line) => {
        line.sort((a, b) => a.x - b.x);
        return line.map((it) => it.str).join('');
      })
      .join('\n');

    pages.push({ text: normalizeRawText(pageText), pageNumber: i });
  }

  return pages;
}

export async function extractFromFile(file, onProgress) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return extractFromPdfFile(file, onProgress);
  if (name.endsWith('.docx')) return extractFromDocxFile(file);
  if (name.endsWith('.txt') || name.endsWith('.md')) return extractFromTxtFile(file);
  throw new Error('対応していないファイル形式です（.pdf / .docx / .txt に対応）');
}
