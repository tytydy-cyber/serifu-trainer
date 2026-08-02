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
// 役名(全角/半角スペース)セリフ。コロンや鉤括弧のような明示的な区切りがないぶん、
// 本文中の普通の一文の先頭語にも当たってしまう。話者名として現実的な長さで頭打ちにする。
const PATTERN_E = /^([^\s:：「」（）()]{1,8})[ 　]+(\S.*)$/;
// 歌詞は音符記号で始まり、譜割りのための空白が頻繁に入るため PATTERN_E が
// フレーズの先頭語を話者名と誤認しやすい。
const LYRIC_RE = /[♪♫♬]/;

// --- Cast list (登場人物表) -----------------------------------------------
// Most scripts open with a cast list. When we can find one it is far more
// reliable than any frequency heuristic: it tells us the real set of roles,
// so anything the body scan turns up that is absent from it can be surfaced
// to the user as suspicious rather than silently accepted.

const CAST_HEADING_RE = /^[\s　]*(登場人物表|登場人物|人物表|人物|配役|役名|キャスト|出演者|出演)[\s　]*[：:]?[\s　]*$/;

function splitCastEntry(line) {
  const cleaned = line
    .replace(/[（(][^）)]*[）)]/g, '')   // 年齢・補足の括弧書き
    .replace(/[…‥]{1,}.*$/, '')          // 「太郎……30歳、会社員」
    .replace(/\t.*$/, '')                 // 俳優名が別カラムにある場合
    .replace(/[ 　]{2,}.*$/, '')          // 同上（スペース揃え）
    .trim();
  if (!cleaned) return [];
  // 「A／B」は一人二役の表記なのでどちらも役名として拾う
  return cleaned
    .split(/[／\/・、,]/)
    .map((s) => s.trim())
    .filter((s) => s && [...s].length <= 20);
}

// pages: [{ text, pageNumber }] — only the front matter is searched.
export function extractCastList(pages) {
  const names = [];
  let collecting = false;
  let scanned = 0;

  outer:
  for (const page of pages.slice(0, 3)) {
    for (const raw of page.text.split('\n')) {
      const line = raw.trim();
      if (!collecting) {
        if (CAST_HEADING_RE.test(line)) collecting = true;
        continue;
      }
      if (++scanned > 200) break outer;
      if (!line) continue;
      // The list ends where the play itself begins.
      if (HEADING_RE.test(line) || CUE_RE.test(line)) break outer;
      if ([...line].length > 30 || /[。！？]/.test(line)) break outer;
      names.push(...splitCastEntry(line));
    }
  }
  return [...new Set(names)];
}

// Characters of `key` appear in `text` in order, but not necessarily adjacent.
function isSubsequence(key, text) {
  let i = 0;
  for (const ch of text) {
    if (ch === key[i]) i++;
    if (i === key.length) return true;
  }
  return i === key.length;
}

// Body text abbreviates cast entries constantly, and in two different ways:
// by taking a contiguous piece (麺太郎 for 松本麺太郎, 父 for 麺太郎の父) or by
// picking characters out of the full name (さお男 for さおだけ屋の男, ジャ母 for
// ジャイアン太郎の母). Try contiguous first since it is the stronger reading,
// then fall back to an in-order subsequence. The shortest match wins, being
// the most specific. Returns the matched cast entry, or null.
function findCastMatch(name, castNames) {
  const key = normalizeKey(name);
  if (!key) return null;
  const keys = castNames
    .map((cast) => ({ cast, castKey: normalizeKey(cast) }))
    .filter((e) => e.castKey);

  for (const { cast, castKey } of keys) {
    if (castKey === key) return cast;
  }
  let best = null;
  for (const { cast, castKey } of keys) {
    if (castKey.includes(key) && (!best || castKey.length < normalizeKey(best).length)) best = cast;
  }
  if (best) return best;
  // Subsequence matching is loose, so require a real abbreviation: at least two
  // characters, and a cast entry not wildly longer than the abbreviation.
  if (key.length < 2) return null;
  for (const { cast, castKey } of keys) {
    if (castKey.length > key.length * 5) continue;
    if (isSubsequence(key, castKey) && (!best || castKey.length < normalizeKey(best).length)) best = cast;
  }
  return best;
}

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

// Returns { candidates, groups, castNames, hasCastList }
// Each candidate: { name, count, defaultInclude, inCast, castName }
export function extractRoleCandidates(rawText, castNames = []) {
  const lines = rawText.split('\n');
  const hasCastList = castNames.length >= 2;
  // Each candidate tracks two kinds of evidence separately: "strong" comes from
  // an explicit delimiter (colon / brackets / tab — a deliberate role marker),
  // "weak" comes from the bare-space pattern or a standalone short line, which
  // has no explicit marker and can coincidentally match a line's first word
  // (a lyric phrase, an emphasis pause, ...). Weak-only candidates need more
  // repetition before we default them to "included" in the wizard.
  const counts = new Map();
  const bump = (rawName, kind) => {
    // Ellipses and stray separators cling to the speaker label when a script
    // writes "太郎……" for a pause; fold those into the plain name.
    const name = rawName.replace(/^[…‥・\s]+|[…‥・\s]+$/g, '');
    if (!name || STOPWORDS.has(name)) return;
    const entry = counts.get(name) || { strong: 0, weak: 0 };
    entry[kind] += 1;
    counts.set(name, entry);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (HEADING_RE.test(line) || CUE_RE.test(line) || PAREN_FULL_RE.test(line) || LYRIC_RE.test(line)) continue;

    let m = PATTERN_A.exec(line) || PATTERN_B.exec(line) || PATTERN_D.exec(line);
    if (m) {
      bump(m[1].trim(), 'strong');
      continue;
    }
    m = PATTERN_E.exec(line);
    if (m) {
      bump(m[1].trim(), 'weak');
      continue;
    }
    // Pattern C candidate: a short standalone line (role-only line style)
    if (line.length <= 10 && !/[。、！？.!?]/.test(line)) {
      bump(line, 'weak');
    }
  }

  const candidates = [...counts.entries()]
    .map(([name, { strong, weak }]) => ({ name, strong, weak, count: strong + weak }))
    .filter((c) => c.count >= 2)
    .map((c) => {
      const castName = hasCastList ? findCastMatch(c.name, castNames) : null;
      const inCast = !!castName;
      // With a cast list, membership is the deciding signal. Without one, fall
      // back to evidence quality: an explicit delimiter (colon/brackets/tab) is
      // a deliberate role marker and trustworthy at low counts, while the
      // space-separated form has to repeat before we believe it.
      let defaultInclude = hasCastList
        ? (inCast || c.strong >= 3)
        : (c.strong >= 2 || c.weak >= 5);
      // A one-character candidate matches far too easily (any stray particle
      // sits inside some cast entry), so require real recurrence on top.
      if ([...c.name].length <= 1 && c.count < (inCast ? 5 : 10)) defaultInclude = false;
      return {
        name: c.name,
        count: Math.round(c.count * 10) / 10,
        defaultInclude,
        inCast,
        castName,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Suggest which candidates are the same role written two ways.
  const groups = [];
  const used = new Set();
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(candidates[i].name)) continue;
    const group = [candidates[i].name];
    used.add(candidates[i].name);
    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(candidates[j].name)) continue;
      const a = candidates[i], b = candidates[j];
      const contained = a.name.includes(b.name) || b.name.includes(a.name);
      const close = levenshtein(a.name, b.name) <= 1 && Math.max(a.name.length, b.name.length) > 1;
      const looksAlike = contained || close;
      // Looking alike is necessary but not sufficient: ジャイ and ジャ母 look
      // alike yet are ジャイアン太郎 and ジャイアン太郎の母. Conversely two names
      // can share a cast entry without being the same role, since an entry like
      // 麺太郎の父 contains both 麺太郎 and 父. Require both signals to agree.
      const same = hasCastList && (a.inCast || b.inCast)
        ? looksAlike && a.castName === b.castName
        : looksAlike;
      if (same) {
        group.push(b.name);
        used.add(b.name);
      }
    }
    if (group.length > 1) groups.push(group);
  }

  return { candidates, groups, castNames, hasCastList };
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
