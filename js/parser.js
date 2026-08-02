// Rule-based script parser: normalization, role candidate extraction, block classification.
// No network calls — the script text never leaves the device.

const STOPWORDS = new Set([
  'そして', 'しかし', 'だが', 'それで', 'つまり', 'また', 'さて', 'では', 'ところで',
  'ナレーション', 'ナレ', 'ト書き', 'キャスト', '登場人物', '目次', 'あらすじ', '幕間',
]);

const HEADING_RE = /^\s*(第[一二三四五六七八九十0-90-9]+[場幕話幕場]|シーン\s*\d+|[○◯]{1,2}\s*\S*|\*{2,}|─{3,}|-{4,}|＝{4,})/;
const CUE_RE = /^\s*(M[-‐ー]?\s*\d+|SE\d*|ＳＥ\d*|BGM|暗転|明転|溶暗|場転|F\.?O\.?|F\.?I\.?)\b/i;
const PAREN_FULL_RE = /^[（(].*[）)]\s*$/;
const INLINE_PAREN_RE = /[（(][^（）()]{1,40}[）)]/g;

export function toHalfWidth(str) {
  return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  ).replace(/　/g, ' ');
}

export function normalizeKey(name) {
  return toHalfWidth(name).trim().replace(/\s+/g, '');
}

export function normalizeRawText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n');
}

// --- Role candidate extraction -------------------------------------------------

const PATTERN_A = /^([^\s:：「」（）()]{1,10})\s*[:：]\s*(.+)$/; // 役名：セリフ
const PATTERN_B = /^([^\s「」（）()]{1,10})\s*「(.+)」\s*$/; // 役名「セリフ」
const PATTERN_D = /^([^\t]{1,10})\t(.+)$/; // タブ区切り
const PATTERN_E = /^([^\s:：「」（）()]{1,10})[ 　]+(\S.*)$/; // 役名(全角/半角スペース)セリフ — 縦書き台本の再構成後によく出る

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Returns { candidates: [{name, count}], groups: [[name,...]] }
export function extractRoleCandidates(rawText) {
  const lines = rawText.split('\n');
  const counts = new Map();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (HEADING_RE.test(line) || CUE_RE.test(line) || PAREN_FULL_RE.test(line)) continue;

    let m = PATTERN_A.exec(line) || PATTERN_B.exec(line) || PATTERN_D.exec(line) || PATTERN_E.exec(line);
    if (m) {
      const name = m[1].trim();
      if (name && !STOPWORDS.has(name)) {
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      continue;
    }
    // Pattern C candidate: a short standalone line (role-only line style)
    if (line.length <= 10 && !/[。、！？.!?]/.test(line)) {
      counts.set(line, (counts.get(line) || 0) + 0.5); // weighted lower — confirmed by co-occurrence with A/B/D
    }
  }

  const candidates = [...counts.entries()]
    .filter(([name, count]) => count >= 1.5 && !STOPWORDS.has(name))
    .map(([name, count]) => ({ name, count: Math.round(count * 10) / 10 }))
    .sort((a, b) => b.count - a.count);

  // Suggest alias groups: names within edit distance 1, or containment (男 ⊂ 男A)
  const groups = [];
  const used = new Set();
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(candidates[i].name)) continue;
    const group = [candidates[i].name];
    used.add(candidates[i].name);
    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(candidates[j].name)) continue;
      const a = candidates[i].name, b = candidates[j].name;
      const contained = a.includes(b) || b.includes(a);
      const close = levenshtein(a, b) <= 1 && Math.max(a.length, b.length) > 1;
      if (contained || close) {
        group.push(candidates[j].name);
        used.add(b);
      }
    }
    if (group.length > 1) groups.push(group);
  }

  return { candidates, groups };
}

// --- Block classification -------------------------------------------------

// confirmedRoles: [{ id, name, aliases: string[] }]
function buildAliasLookup(confirmedRoles) {
  const entries = [];
  for (const role of confirmedRoles) {
    for (const alias of [role.name, ...(role.aliases || [])]) {
      const key = normalizeKey(alias);
      if (key) entries.push({ key, roleId: role.id });
    }
  }
  entries.sort((a, b) => b.key.length - a.key.length);
  return entries;
}

// Tries each known role/alias as a literal prefix of the line and figures out
// where the dialogue body starts, if any. Unlike a plain normalized-prefix
// check, this preserves internal whitespace so "役名 セリフ" (space-separated,
// no punctuation — the standard format for vertically-typeset scripts once
// reconstructed) is recognized alongside "役名：セリフ" / "役名「セリフ」" / tab-separated.
// Returns { roleId, body } where body is null for a role-alone line (Pattern C).
function matchRoleAndBody(line, lookup) {
  const half = toHalfWidth(line);
  for (const { key, roleId } of lookup) {
    if (!half.startsWith(key)) continue;
    const rest = half.slice(key.length);
    if (rest === '') return { roleId, body: null, matchedLen: key.length };
    let m = /^[:：]\s*(.+)$/.exec(rest);
    if (m) return { roleId, body: m[1].trim(), matchedLen: key.length };
    m = /^「(.+)」\s*$/.exec(rest);
    if (m) return { roleId, body: m[1].trim(), matchedLen: key.length };
    m = /^\t(.+)$/.exec(rest);
    if (m) return { roleId, body: m[1].trim(), matchedLen: key.length };
    m = /^ +(\S.*)$/.exec(rest);
    if (m) return { roleId, body: m[1].trim(), matchedLen: key.length };
  }
  return null;
}

function matchMultiRolePrefix(line, lookup) {
  // "A・B「せりふ」" style simultaneous lines
  const sepIdx = line.search(/[・／\/＆&]/);
  if (sepIdx < 0 || sepIdx > 20) return null;
  const head = line.slice(0, line.search(/[:：「\t]/) >= 0 ? line.search(/[:：「\t]/) : sepIdx + 3);
  const names = head.split(/[・／\/＆&]/).map((s) => s.trim()).filter(Boolean);
  if (names.length < 2) return null;
  const roleIds = [];
  for (const n of names) {
    const key = normalizeKey(n);
    const found = lookup.find((e) => e.key === key);
    if (!found) return null;
    roleIds.push(found.roleId);
  }
  const restIdx = line.indexOf(head) + head.length;
  return { roleIds, matchedLen: restIdx };
}

function extractInlineDirections(text) {
  const ranges = [];
  let m;
  INLINE_PAREN_RE.lastIndex = 0;
  while ((m = INLINE_PAREN_RE.exec(text))) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

// pages: [{ text: string, pageNumber: number }]
// confirmedRoles: [{ id, name, aliases }]
export function classifyScript(pages, confirmedRoles) {
  const lookup = buildAliasLookup(confirmedRoles);
  const blocks = [];
  let order = 0;
  let cursor = 0; // offset within the concatenated rawText
  const rawParts = [];

  for (const page of pages) {
    const pageText = page.text;
    const lines = pageText.split('\n');
    let i = 0;
    let lineOffset = cursor;

    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();
      const srcStart = lineOffset;
      const srcEnd = lineOffset + raw.length;

      if (!line) {
        lineOffset = srcEnd + 1;
        i++;
        continue;
      }

      let block = null;

      if (HEADING_RE.test(line)) {
        block = { type: 'heading', text: line, confidence: 0.9 };
      } else if (CUE_RE.test(line)) {
        block = { type: 'cue', text: line, confidence: 0.9 };
      } else {
        const multi = matchMultiRolePrefix(line, lookup);
        const single = !multi ? matchRoleAndBody(line, lookup) : null;

        if (multi) {
          const afterHead = toHalfWidth(line).slice(multi.matchedLen);
          const bodyText = (
            /^[:：]\s*(.+)$/.exec(afterHead) ||
            /^「(.+)」\s*$/.exec(afterHead) ||
            /^\t(.+)$/.exec(afterHead) ||
            /^ +(\S.*)$/.exec(afterHead)
          )?.[1]?.trim() ?? afterHead.trim();
          block = { type: 'line', roleIds: multi.roleIds, text: bodyText, confidence: 0.9 };
        } else if (single && single.body !== null) {
          block = { type: 'line', roleIds: [single.roleId], text: single.body, confidence: 1.0 };
        } else if (single) {
          // Pattern C: role name alone on its line; body is following lines until blank/next role/heading
          const bodyLines = [];
          let j = i + 1;
          let endOffset = srcEnd;
          while (j < lines.length) {
            const raw2 = lines[j];
            const line2 = raw2.trim();
            if (!line2) break;
            if (HEADING_RE.test(line2) || CUE_RE.test(line2)) break;
            if (matchRoleAndBody(line2, lookup) || matchMultiRolePrefix(line2, lookup)) break;
            bodyLines.push(line2);
            endOffset += raw2.length + 1;
            j++;
          }
          if (bodyLines.length > 0) {
            block = { type: 'line', roleIds: [single.roleId], text: bodyLines.join(''), confidence: 0.75, consumedLines: j - i - 1 };
          } else {
            block = { type: 'unknown', text: line, confidence: 0 };
          }
        } else if (PAREN_FULL_RE.test(line)) {
          block = { type: 'direction', text: line, confidence: 0.8 };
        } else {
          block = { type: 'unknown', text: line, confidence: 0 };
        }
      }

      const consumed = block.consumedLines || 0;
      let finalSrcEnd = srcEnd;
      if (consumed > 0) {
        let off = srcEnd;
        for (let k = 1; k <= consumed; k++) off += lines[i + k].length + 1;
        finalSrcEnd = off;
      }

      // A line that matches nothing is often not a new "unknown" thought but
      // the tail of the previous line's text, split by a column/row wrap in
      // the source PDF (typesetting, not a sentence boundary). Fold it back
      // into the previous block instead of creating a stray fragment.
      const prevBlock = blocks[blocks.length - 1];
      if (block.type === 'unknown' && prevBlock && (prevBlock.type === 'line' || prevBlock.type === 'direction')) {
        prevBlock.text += block.text;
        prevBlock.srcEnd = finalSrcEnd;
        if (prevBlock.type === 'line') prevBlock.inlineDirections = extractInlineDirections(prevBlock.text);
        rawParts.push(raw);
        i += 1 + consumed;
        lineOffset = finalSrcEnd + 1;
        continue;
      }

      blocks.push({
        order: order++,
        page: page.pageNumber,
        type: block.type,
        roleIds: block.roleIds || undefined,
        text: block.text,
        inlineDirections: block.type === 'line' ? extractInlineDirections(block.text) : [],
        srcStart,
        srcEnd: finalSrcEnd,
        confidence: block.confidence,
      });

      rawParts.push(raw);
      i += 1 + consumed;
      lineOffset = finalSrcEnd + 1;
    }
    cursor = lineOffset;
  }

  return blocks;
}

export function buildRawText(pages) {
  return pages.map((p) => p.text).join('\n');
}
