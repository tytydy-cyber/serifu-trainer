// Rule-based script parser: normalization, role candidate extraction, block classification.
// No network calls — the script text never leaves the device.

// Only words that structure the document itself. Speaker labels like ナレ or
// 一同 are left in: whether they are real roles is settled by the cast list,
// not by a hardcoded list of names.
const STOPWORDS = new Set([
  'そして', 'しかし', 'だが', 'それで', 'つまり', 'また', 'さて', 'では', 'ところで',
  'ト書き', 'キャスト', '登場人物', '目次', 'あらすじ', '幕間',
]);

const DIGITS = '0-9０-９一二三四五六七八九十';
const HEADING_RE = new RegExp(
  `^\\s*(第[${DIGITS}]+[場幕話]|シーン\\s*[${DIGITS}]+|[○◯]{1,2}\\s*\\S*|\\*{2,}|─{3,}|-{4,}|＝{4,})`
);
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

// Vertical (縦書き) typesetting has its own Unicode block of punctuation —
// visually identical to the familiar horizontal forms, just registered as
// different code points (CJK Compatibility / Vertical Forms) — so a script
// set this way can use 「」（） throughout and still fail every regex that
// only knows the horizontal ones. Fold them together once, up front, so
// every pattern in this file works the same regardless of which a given
// script's font happened to use.
const VERTICAL_FORM_MAP = {
  '﹁': '「', '﹂': '」', '﹃': '『', '﹄': '』',
  '︵': '（', '︶': '）', '︷': '｛', '︸': '｝',
  '︹': '【', '︺': '】', '︻': '〔', '︼': '〕',
  '︽': '《', '︾': '》', '︿': '〈', '﹀': '〉',
  '︑': '、', '︒': '。', '︓': '：', '︔': '；', '︕': '！', '︖': '？',
};
const VERTICAL_FORM_RE = new RegExp(Object.keys(VERTICAL_FORM_MAP).join('|'), 'g');

export function normalizeRawText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(VERTICAL_FORM_RE, (c) => VERTICAL_FORM_MAP[c]);
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
// 「(役名)セリフ」— a role name wrapped in parens at the head of the line,
// distinct from PATTERN_A–E's "role name, then a separator" shape. Scripts
// use this for all kinds of attribution, not just a song's singer: 「♪（全
// 員）…」, 「（ナレ）…」, a chorus line, and so on — the parens are the
// pattern, whatever the line turns out to contain.
const PATTERN_PAREN = /^[（(]([^（）()]{1,20})[）)]\s*(.*)$/;

// --- Cast list (登場人物表) -----------------------------------------------
// Most scripts open with a cast list. When we can find one it is far more
// reliable than any frequency heuristic: it tells us the real set of roles,
// so anything the body scan turns up that is absent from it can be surfaced
// to the user as suspicious rather than silently accepted.

const CAST_KEYWORDS_RE = /^(登場人物表|登場人物|人物表|人物|配役|役名|キャスト|出演者|出演)$/;
const CAST_HEADING_RE = /^[\s　]*(登場人物表|登場人物|人物表|人物|配役|役名|キャスト|出演者|出演)[\s　]*[：:]?[\s　]*$/;
// Front matter is often split into bracketed sections — 《登場人物》 for the
// cast, then 《表記》 for a notation legend, 《演出の前提》 for staging notes —
// with no blank line or punctuation between them. Recognizing the bracket
// itself both finds a cast heading set this way, and lets collection stop
// cleanly at the *next* such section instead of absorbing it as more names.
const SECTION_HEADING_RE = /^[《【]([^》】]{1,20})[》】]$/;

// A bullet/decoration character set before other content — "▼登場人物",
// "♪おはようの歌" — carries no information of its own (which symbol a given
// script reaches for is arbitrary) and would otherwise block whatever
// pattern comes after it: CAST_HEADING_RE's exact-line match, or a role tag
// in classifyScript's line matching below.
const LEADING_DECOR_RE = /^[\s　▼▽■□●○◆◇★☆＊*・♪♫♬]+/;

function isCastHeading(line) {
  const m = SECTION_HEADING_RE.exec(line);
  if (m) return CAST_KEYWORDS_RE.test(m[1].trim());
  return CAST_HEADING_RE.test(line) || CAST_HEADING_RE.test(line.replace(LEADING_DECOR_RE, ''));
}

function splitCastEntry(line) {
  const cleaned = line
    .replace(/[（(][^）)]*[）)]/g, '')     // 年齢・補足の括弧書き
    .replace(/[［\[][^］\]]*[］\]]/g, '')  // ふりがな「川野樹里[じゅり]」
    .replace(/[…‥]{1,}.*$/, '')            // 「太郎……30歳、会社員」
    .replace(/\t.*$/, '')                   // 俳優名が別カラムにある場合
    .replace(/[ 　]+.*$/, '')               // 「相原ほたる 事例制作会社の社員。」— 空白以降は説明文
    .trim();
  if (!cleaned) return [];
  // 「A／B」は一人二役の表記なのでどちらも役名として拾う
  return cleaned
    .split(/[／\/・、,]/)
    .map((s) => s.trim())
    .filter((s) => s && [...s].length <= 20);
}

// pages: [{ text, pageNumber }] — only the front matter is searched.
// Returns { names, pages } where `pages` are the page numbers the list spans;
// those pages are front matter, not dialogue, so callers skip them when
// scanning for speakers.
export function extractCastList(pages) {
  const names = [];
  const castPages = new Set();
  let collecting = false;
  let scanned = 0;

  outer:
  for (const page of pages.slice(0, 3)) {
    for (const raw of page.text.split('\n')) {
      const line = raw.trim();
      if (!collecting) {
        if (isCastHeading(line)) { collecting = true; castPages.add(page.pageNumber); }
        continue;
      }
      if (++scanned > 200) break outer;
      if (!line) continue;
      // The list ends where the play itself begins, or where a different
      // bracketed section (notation legend, staging notes, ...) starts.
      const section = SECTION_HEADING_RE.exec(line);
      if (section && !CAST_KEYWORDS_RE.test(section[1])) break outer;
      if (HEADING_RE.test(line) || CUE_RE.test(line)) break outer;
      // A cast entry can carry a description ("相原ほたる 事例制作会社の社員。") —
      // splitCastEntry already strips that off, so judge the *name*, not
      // whether the raw line happens to contain punctuation. Only a line that
      // still doesn't reduce to something name-shaped reads as prose, i.e.
      // the list has ended.
      const entries = splitCastEntry(line);
      if ([...line].length > 60 || entries.length === 0) break outer;
      // A name is a label, not a sentence. If splitCastEntry had nothing to
      // strip (no age/description in parens or after a space) and what's left
      // still ends in sentence-final punctuation, this was never a cast entry
      // — it's stage-direction prose that happens to follow the list with no
      // heading of its own announcing the new section (common when the list
      // simply ends a page and the opening stage direction starts the next).
      if (entries.some((e) => /[。！？]$/.test(e))) break outer;
      castPages.add(page.pageNumber);
      names.push(...entries);
    }
  }
  return { names: [...new Set(names)], pages: [...castPages] };
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

// Which lines on a page may introduce a speaker.
//
// Scripts put the role name at the margin and indent everything that belongs
// under it — wrapped dialogue, stage directions. So when a page carries indent
// information, only outdented lines are allowed to name a role. That single
// rule removes the whole class of false speakers that no amount of wording
// analysis can settle: the first words of a wrapped line or of a song lyric
// look exactly like a role name followed by dialogue, and differ only in where
// they sit on the page.
function speakerLines(pages) {
  const out = [];
  for (const page of pages) {
    const lines = page.lines || page.text.split('\n').map((text) => ({ text }));
    for (const line of lines) {
      out.push({ text: line.text, canNameRole: !line.isContinuation, page: page.pageNumber });
    }
  }
  return out;
}

// Returns { candidates, groups, castNames, hasCastList }
// Each candidate: { name, count, defaultInclude, inCast, castName }
export function extractRoleCandidates(pages, castNames = [], options = {}) {
  const skipPages = new Set(options.skipPages || []);
  const lines = speakerLines(pages)
    .filter((l) => l.canNameRole && !skipPages.has(l.page));
  const hasCastList = castNames.length >= 2;
  // Each candidate tracks two kinds of evidence separately: "strong" comes from
  // an explicit delimiter (colon / brackets / tab — a deliberate role marker),
  // "weak" comes from the bare-space pattern or a standalone short line, which
  // has no explicit marker and can coincidentally match a line's first word
  // (a lyric phrase, an emphasis pause, ...). Weak-only candidates need more
  // repetition before we default them to "included" in the wizard.
  const counts = new Map();
  const MAX_OCCURRENCES = 20; // enough for the review screen without holding a whole leading role's line count
  const bump = (rawName, kind, page, snippet) => {
    // Ellipses and stray separators cling to the speaker label when a script
    // writes "太郎……" for a pause; fold those into the plain name.
    const name = rawName.replace(/^[…‥・\s]+|[…‥・\s]+$/g, '');
    if (!name || STOPWORDS.has(name)) return;
    const entry = counts.get(name) || { strong: 0, weak: 0, occurrences: [] };
    entry[kind] += 1;
    if (entry.occurrences.length < MAX_OCCURRENCES) entry.occurrences.push({ page, text: snippet.slice(0, 60) });
    counts.set(name, entry);
  };

  for (const lineObj of lines) {
    const line = lineObj.text.trim();
    if (!line) continue;
    if (HEADING_RE.test(line) || CUE_RE.test(line) || PAREN_FULL_RE.test(line)) continue;

    // Checked before the lyric skip below: "(役名)" is a deliberate marker
    // (parens, same tier as a colon or brackets) wherever it appears —
    // including a song line ("♪（全員）…"), which is otherwise indistinguishable
    // from any other lyric fragment and would be skipped outright next.
    let m = PATTERN_PAREN.exec(line.replace(LEADING_DECOR_RE, ''));
    if (m) {
      bump(m[1].trim(), 'strong', lineObj.page, line);
      continue;
    }
    if (LYRIC_RE.test(line)) continue;

    m = PATTERN_A.exec(line) || PATTERN_B.exec(line) || PATTERN_D.exec(line);
    if (m) {
      bump(m[1].trim(), 'strong', lineObj.page, line);
      continue;
    }
    m = PATTERN_E.exec(line);
    if (m) {
      bump(m[1].trim(), 'weak', lineObj.page, line);
      continue;
    }
    // Pattern C candidate: a short standalone line (role-only line style)
    if (line.length <= 10 && !/[。、！？.!?]/.test(line)) {
      bump(line, 'weak', lineObj.page, line);
    }
  }

  const candidates = [...counts.entries()]
    .map(([name, { strong, weak, occurrences }]) => ({ name, strong, weak, count: strong + weak, occurrences }))
    .map((c) => ({ ...c, castName: hasCastList ? findCastMatch(c.name, castNames) : null }))
    // A name matched to an official cast entry is trustworthy even from a
    // single line — a stagehand or one-line extra may only ever speak once
    // in the whole script, and would otherwise never even reach the wizard
    // for the user to confirm. Without a cast match, still require the
    // pattern to repeat, since a lone space-separated match is as likely to
    // be an ordinary sentence's first two words as a real speaker tag.
    .filter((c) => c.count >= 2 || c.castName)
    .map((c) => {
      const inCast = !!c.castName;
      const castName = c.castName;
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
      // A role that only ever speaks once is easy to include by mistake (a
      // stray word matched, or a walk-on part not worth tracking progress
      // for) — still show it, but make the reader opt in rather than out.
      const onlyOnce = c.count <= 1;
      if (onlyOnce) defaultInclude = false;
      return {
        name: c.name,
        count: Math.round(c.count * 10) / 10,
        defaultInclude,
        onlyOnce,
        inCast,
        castName,
        occurrences: c.occurrences,
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
  const paren = PATTERN_PAREN.exec(half);
  if (paren) {
    const roleId = resolveAbbrRole(paren[1], lookup);
    if (roleId) return { roleId, body: paren[2].trim() || null, matchedLen: half.length - paren[2].length };
  }
  for (const { key, roleId } of lookup) {
    if (!half.startsWith(key)) continue;
    const rest = half.slice(key.length);
    if (rest === '') return { roleId, body: null, matchedLen: key.length };
    let m = /^[:：]\s*(.+)$/.exec(rest);
    if (m) return { roleId, body: m[1].trim(), matchedLen: key.length };
    // The gap before the bracket can be a real typeset space (reconstructed
    // vertical text inserts one for any gap wider than a character pitch —
    // see extract.js), so it has to be allowed here or this falls through to
    // the plain-space branch below and keeps the 「」 as part of the body.
    m = /^ *「(.+)」\s*$/.exec(rest);
    if (m) return { roleId, body: m[1].trim(), matchedLen: key.length };
    // An opening 「 the line never closes: a speech long enough to wrap onto
    // the next column, which is where its 」 actually sits. Without this the
    // unspaced form ("すみれ「ああ～…") matches nothing at all — the
    // plain-space branch below needs a space it doesn't have — and the whole
    // speech is read as narration by whoever happens to precede it.
    m = /^ *「(.+)$/.exec(rest);
    if (m) return { roleId, body: m[1].trim(), matchedLen: key.length };
    m = /^\t(.+)$/.exec(rest);
    if (m) return { roleId, body: m[1].trim(), matchedLen: key.length };
    m = /^ +(\S.*)$/.exec(rest);
    if (m) return { roleId, body: m[1].trim(), matchedLen: key.length };
    // "太郎…… はい" — an opening pause typeset tight against the role name.
    // The ellipsis is part of the speech, not of the name.
    m = /^([…‥]+) *(.*)$/.exec(rest);
    if (m) return { roleId, body: (m[1] + m[2]).trim(), matchedLen: key.length };
  }
  return null;
}

const MULTI_ROLE_SEP = /[・／\/＆&]/;

// True if `line` opens with one of the names the wizard found while scanning
// for role candidates — including ones the reader left unchecked (a walk-on
// part with a single line, say). Those names never made it into `lookup`
// (built only from confirmed roles), so matchRoleAndBody can't attribute the
// line to anyone — but the line is still a fresh speech, not a fragment of
// whatever came before it, and must not be folded into the previous block.
function looksLikeFreshSpeaker(line, knownNames) {
  if (!knownNames || knownNames.size === 0) return false;
  const half = toHalfWidth(line);
  for (const name of knownNames) {
    if (!name || !half.startsWith(name)) continue;
    const rest = half.slice(name.length);
    if (rest === '' || /^[:：\t]/.test(rest) || /^ *「/.test(rest) || /^ +\S/.test(rest) || /^[…‥]/.test(rest)) return true;
  }
  return false;
}

// A name inside "A＆B" is often shorter than that role's usual attribution
// elsewhere (姉＆麺 for 姉＆麺太郎) — the simultaneous-line tag only needs to
// be unambiguous, not the full name. Resolve it the same way an abbreviated
// cast-list entry is resolved: exact match first, then the registered name
// containing it.
function resolveAbbrRole(name, lookup) {
  const key = normalizeKey(name);
  if (!key) return null;
  const exact = lookup.find((e) => e.key === key);
  if (exact) return exact.roleId;
  const partial = lookup.find((e) => e.key.startsWith(key) || key.startsWith(e.key));
  return partial ? partial.roleId : null;
}

function matchMultiRolePrefix(line, lookup) {
  // "A・B「せりふ」" / "A＆B せりふ" style simultaneous lines.
  if (!MULTI_ROLE_SEP.test(line)) return null;
  // The name list ends at the first delimiter that could start the dialogue
  // (colon, bracket, tab, or a plain space) — not a fixed offset, since names
  // can be anywhere from one character to a full given name.
  const delim = /[:：「\t ]/.exec(line);
  const head = delim ? line.slice(0, delim.index) : line;
  if (!MULTI_ROLE_SEP.test(head)) return null;

  const names = head.split(MULTI_ROLE_SEP).map((s) => s.trim()).filter(Boolean);
  if (names.length < 2) return null;
  const roleIds = [];
  for (const n of names) {
    const roleId = resolveAbbrRole(n, lookup);
    if (!roleId) return null;
    roleIds.push(roleId);
  }
  return { roleIds, matchedLen: head.length };
}

// Strips the "A・B" name prefix a matchMultiRolePrefix match found, the same
// way matchRoleAndBody does for a single name, leaving just the shared line.
function buildMultiRoleLine(line, multi) {
  const afterHead = toHalfWidth(line).slice(multi.matchedLen);
  const bodyText = (
    /^[:：]\s*(.+)$/.exec(afterHead) ||
    /^ *「(.+)」\s*$/.exec(afterHead) ||
    /^\t(.+)$/.exec(afterHead) ||
    /^ +(\S.*)$/.exec(afterHead)
  )?.[1]?.trim() ?? afterHead.trim();
  return { roleIds: multi.roleIds, text: bodyText };
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
export function classifyScript(pages, confirmedRoles, options = {}) {
  const lookup = buildAliasLookup(confirmedRoles);
  const knownNames = options.knownNames || new Set();
  // Pages the cast list spans (from extractCastList). They are front matter —
  // a column of bare character names, which reads exactly like a run of
  // role-only speech lines and otherwise gets attributed as dialogue.
  const frontMatterPages = new Set(options.frontMatterPages || []);
  const blocks = [];
  let order = 0;
  let cursor = 0; // offset within the concatenated rawText
  const rawParts = [];

  for (const page of pages) {
    const isFrontMatter = frontMatterPages.has(page.pageNumber);
    const pageLines = page.lines || page.text.split('\n').map((text) => ({ text }));
    const lines = pageLines.map((l) => l.text);
    // A line beginning at the dialogue column continues the line above it; one
    // at the margin starts a new speech. Sources without layout information
    // (pasted text) mark nothing, and fall back to reading the wording alone.
    const continuesPrevious = (idx) => pageLines[idx].lineRole === 'continuation';
    const canStartSpeech = (idx) => pageLines[idx].lineRole !== 'continuation';
    // Set in from the margin but short of the dialogue column: a stage
    // direction, which belongs to nobody and must not be folded into the
    // speech above it.
    const isStageDirection = (idx) => pageLines[idx].lineRole === 'indented';

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

      if (isFrontMatter) {
        block = { type: 'direction', text: line, confidence: 0.9 };
      } else if (continuesPrevious(i)) {
        // "Continuation" is itself a layout guess (extract.js: the previous
        // column looked full, so this one must be the same speech running
        // on) — and on some scripts that guess fires on short columns that
        // aren't actually overflowing anything. A genuine continuation is
        // just wrapped dialogue, so it never opens with someone else's role
        // name; a line that does is a fresh speech the guess mis-flagged,
        // and has to be read as one rather than silently glued onto whatever
        // came before it. Stripping a leading decoration mark first (♪, a
        // bullet, …) means a line doesn't have to open with the role name
        // literally at position 0 to be recognized as one.
        const forMatch = line.replace(LEADING_DECOR_RE, '');
        const multi = matchMultiRolePrefix(forMatch, lookup);
        const single = !multi ? matchRoleAndBody(forMatch, lookup) : null;
        if (multi) {
          block = { type: 'line', ...buildMultiRoleLine(forMatch, multi), confidence: 0.9 };
        } else if (single && single.body !== null) {
          block = { type: 'line', roleIds: [single.roleId], text: single.body, confidence: 1.0 };
        } else {
          block = { type: 'unknown', text: line, confidence: 0, isContinuation: true };
        }
      } else if (HEADING_RE.test(line)) {
        block = { type: 'heading', text: line, confidence: 0.9 };
      } else if (CUE_RE.test(line)) {
        block = { type: 'cue', text: line, confidence: 0.9 };
      } else {
        // A confirmed role name at the head of the line is stronger evidence
        // than layout: the indent heuristic in extract.js only estimates
        // where a script's dialogue column sits, and on a script where
        // stage directions and dialogue aren't set at visibly different
        // depths that estimate can land on the wrong side for most of the
        // page. A literal "役名「セリフ」" match doesn't have that failure
        // mode, so it has to be tried before falling back to isStageDirection.
        // A leading decoration mark (♪, a bullet, …) is stripped first so it
        // doesn't have to sit literally at position 0 to be recognized.
        const forMatch = line.replace(LEADING_DECOR_RE, '');
        const multi = canStartSpeech(i) ? matchMultiRolePrefix(forMatch, lookup) : null;
        const single = !multi && canStartSpeech(i) ? matchRoleAndBody(forMatch, lookup) : null;

        if (multi) {
          block = { type: 'line', ...buildMultiRoleLine(forMatch, multi), confidence: 0.9 };
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
            const line2ForMatch = line2.replace(LEADING_DECOR_RE, '');
            if (canStartSpeech(j) && (matchRoleAndBody(line2ForMatch, lookup) || matchMultiRolePrefix(line2ForMatch, lookup))) break;
            bodyLines.push(line2);
            endOffset += raw2.length + 1;
            j++;
          }
          if (bodyLines.length > 0) {
            block = { type: 'line', roleIds: [single.roleId], text: bodyLines.join(''), confidence: 0.75, consumedLines: j - i - 1 };
          } else {
            block = { type: 'unknown', text: line, confidence: 0 };
          }
        } else if (isStageDirection(i)) {
          block = { type: 'direction', text: line, confidence: 0.85 };
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
      // into the previous block instead of creating a stray fragment — unless
      // it still looks like an attempted speaker tag (e.g. "父＆麺 ああ！"
      // where an abbreviation didn't resolve to a known role): that should
      // stay visible as unknown so it gets noticed and fixed, rather than
      // silently merging one character's line into another's.
      //
      // The same applies right after a heading: many scripts give a scene
      // both a number and a name on consecutive lines ("シーン５" then
      // "ラーメンは食べもの" on the next), and only the number half matches
      // HEADING_RE. The name has nothing distinguishing it from an ordinary
      // unmatched line, so it is the same absorption, just onto a heading
      // instead of a line/direction — with a space, since a heading is read
      // as a title rather than run-on prose.
      const looksLikeUnresolvedSpeaker = !block.isContinuation
        && (MULTI_ROLE_SEP.test(line.slice(0, 6)) || looksLikeFreshSpeaker(line, knownNames));
      const prevBlock = blocks[blocks.length - 1];
      if (block.type === 'unknown' && !looksLikeUnresolvedSpeaker && prevBlock
        && (prevBlock.type === 'line' || prevBlock.type === 'direction' || prevBlock.type === 'heading')) {
        prevBlock.text += (prevBlock.type === 'heading' ? '　' : '') + block.text;
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

  for (const b of blocks) {
    if (b.type !== 'line') continue;
    const trimmed = trimSpeechQuotes(b.text);
    if (trimmed === b.text) continue;
    b.text = trimmed;
    b.inlineDirections = extractInlineDirections(b.text);
  }

  return blocks;
}

// A wrapped speech opens its quote in one column and closes it several
// columns later, so only one of the pair is ever on the line the role name
// was matched against. Whichever bracket that match consumed leaves its
// partner stranded once the columns are folded back together — and a pair
// that survived intact is redundant now that the speaker is a field of its
// own. Drop the brackets in all three cases, leaving the words spoken.
function trimSpeechQuotes(text) {
  const t = text.trim();
  if (t.startsWith('「') && t.endsWith('」') && !t.slice(1, -1).includes('「')) return t.slice(1, -1).trim();
  if (t.endsWith('」') && !t.includes('「')) return t.slice(0, -1).trim();
  if (t.startsWith('「') && !t.includes('」')) return t.slice(1).trim();
  return t;
}

export function buildRawText(pages) {
  return pages.map((p) => p.text).join('\n');
}
