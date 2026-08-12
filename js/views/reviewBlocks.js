import { db } from '../db.js';
import { el, confirmDialog } from '../ui.js';
import { extractInlineDirections } from '../parser.js';
import { resetProgress } from '../progress.js';

// Reopens the import wizard's 仕上げ step against blocks already saved to
// the database, so a classification miss found after the fact (a heading
// format the parser didn't know, a role added later) doesn't require
// re-importing the whole script from the original file — which by this
// point isn't even kept around; only its parsed-out blocks are.
const TYPE_LABELS = { heading: '見出し', cue: 'キュー', line: 'セリフ', direction: 'ト書き', unknown: '要確認' };
const CONTEXT = 2; // lines of surrounding context shown around each flagged row

export async function renderReviewBlocks(app, scriptId) {
  const script = await db.get('scripts', scriptId);
  if (!script) {
    app.appendChild(el('div', { class: 'page' }, '台本が見つかりませんでした'));
    return () => {};
  }
  const roles = await db.byIndex('roles', 'scriptId', scriptId);
  const blocks = (await db.byIndex('blocks', 'scriptId', scriptId)).sort((a, b) => a.order - b.order);

  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'back ghost', onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/settings`; } }, '←'),
    el('h1', {}, '分類を見直す'),
  ]);
  const page = el('div', { class: 'page' });
  app.appendChild(topbar);
  app.appendChild(page);

  page.appendChild(el('p', { class: 'lead' },
    '取り込み時に自動で判定した種類や役を、あとからここで直せます。変更するとすぐに保存されます。'));
  page.appendChild(el('p', { class: 'faint' },
    'ボタンをタップすると、その種類だけに絞り込めます。「要確認」は、役のセリフともト書きとも判断できなかった行で、前後の行も薄く表示します。'));

  const countsRow = el('div', { class: 'row wrap' });
  page.appendChild(el('div', { class: 'card' }, [countsRow]));

  let typeFilter = blocks.some(isIssue) ? 'unknown' : null;

  const list = el('div', { class: 'block-list' });
  page.appendChild(list);
  page.appendChild(el('div', { style: 'height:24px' }));

  function isIssue(b) { return b.type === 'unknown' || b.confidence < 0.6; }

  // 出番 are computed from which blocks are 'line' and who they belong to —
  // once either changes here, the existing ranges no longer mean anything.
  // Cleared once per visit (not per edit) since re-clearing on every
  // keystroke would just be wasted writes.
  let appearancesInvalidated = false;
  async function invalidateAppearancesOnce() {
    if (appearancesInvalidated) return;
    appearancesInvalidated = true;
    await db.clearByIndex('appearances', 'scriptId', scriptId);
    await db.put('scripts', { ...script, appearancesEdited: false });
  }

  function renderCounts() {
    const counts = { heading: 0, cue: 0, line: 0, direction: 0, unknown: 0 };
    for (const b of blocks) counts[b.type]++;
    countsRow.innerHTML = '';
    for (const [t, n] of Object.entries(counts)) {
      countsRow.appendChild(el('button', {
        class: `badge type-filter-btn ${typeFilter === t ? 'active' : ''}`,
        onclick: () => { typeFilter = typeFilter === t ? null : t; renderList(); },
      }, `${TYPE_LABELS[t]} ${n}`));
    }
  }

  function renderList() {
    renderCounts();
    list.innerHTML = '';
    if (typeFilter === 'unknown') {
      const flaggedIdx = [];
      blocks.forEach((b, i) => { if (isIssue(b)) flaggedIdx.push(i); });
      if (flaggedIdx.length === 0) {
        list.appendChild(el('div', { class: 'empty-state' }, '直すべき行はありません。'));
        return;
      }
      // A run of flagged rows closer together than CONTEXT (a song's
      // lyrics, say — every line its own 要確認) has each one fall inside
      // the previous one's window. Rendering only "the row THIS window is
      // centered on" as editable then silently drops a later flagged row to
      // read-only context — exactly the rows a reader most needs the 結合
      // button on — so membership in the full flagged set decides instead.
      const flaggedSet = new Set(flaggedIdx);
      let lastShownIdx = -1;
      for (const idx of flaggedIdx) {
        const from = Math.max(0, idx - CONTEXT);
        const to = Math.min(blocks.length - 1, idx + CONTEXT);
        if (lastShownIdx >= 0 && from > lastShownIdx + 1) {
          list.appendChild(el('div', { class: 'faint', style: 'text-align:center;margin:14px 0' }, '……'));
        }
        const start = Math.max(from, lastShownIdx + 1);
        for (let i = start; i <= to; i++) {
          if (flaggedSet.has(i)) list.appendChild(renderRow(blocks[i]));
          else list.appendChild(renderContextRow(blocks[i]));
        }
        lastShownIdx = Math.max(lastShownIdx, to);
      }
      return;
    }
    const filtered = typeFilter ? blocks.filter((b) => b.type === typeFilter) : blocks;
    if (filtered.length === 0) {
      list.appendChild(el('div', { class: 'empty-state' }, '該当する行はありません。'));
      return;
    }
    filtered.forEach((b) => list.appendChild(renderRow(b)));
  }

  function renderContextRow(b) {
    return el('div', { class: 'faint', style: 'padding:6px 12px;font-size:14px;line-height:1.6' }, [
      el('span', { class: 'page-tag' }, `p.${b.page}　`),
      el('span', {}, `[${TYPE_LABELS[b.type]}] `),
      b.text || '（空行）',
    ]);
  }

  function renderRow(b) {
    const typeSelect = el('select', {
      onchange: async (e) => {
        b.type = e.target.value;
        if (b.type !== 'line') b.roleIds = undefined;
        // A hand-picked classification is as trustworthy as it gets — this
        // both reflects that and stops the row from re-appearing in the
        // 要確認 filter (which keys off low confidence) forever after.
        if (b.type !== 'unknown') b.confidence = 1;
        await db.put('blocks', b);
        await invalidateAppearancesOnce();
        renderList();
      },
    }, Object.entries(TYPE_LABELS).map(([v, label]) => el('option', { value: v, selected: b.type === v }, label)));

    const roleSelect = b.type === 'line' ? el('select', {
      onchange: async (e) => {
        b.roleIds = e.target.value ? [e.target.value] : undefined;
        if (b.roleIds) b.confidence = 1;
        await db.put('blocks', b);
        await invalidateAppearancesOnce();
      },
    }, [
      el('option', { value: '', selected: !b.roleIds || !b.roleIds.length }, '（役を選ぶ）'),
      ...roles.map((r) => el('option', { value: r.id, selected: !!(b.roleIds && b.roleIds.includes(r.id)) }, r.name)),
    ]) : null;

    const textArea = el('textarea', {
      rows: b.text.length > 40 ? 3 : 1,
      onchange: async (e) => { b.text = e.target.value; await db.put('blocks', b); },
    }, b.text);

    // A monologue extract.js didn't recognize as column overflow (or a
    // song's rhythm-spaced lyric lines, which no line-by-line rule can tell
    // apart from a genuine one-off role cue) shreds into several rows in
    // sequence. Merging one back into its predecessor is the fast way to
    // put it back together by hand.
    const idx = blocks.indexOf(b);
    const mergeBtn = idx > 0 ? el('button', {
      class: 'ghost small',
      title: '直前の行と結合します',
      onclick: async () => {
        const prev = blocks[idx - 1];
        if (!(await confirmDialog(`この行を直前の行「${prev.text.slice(0, 20)}${prev.text.length > 20 ? '…' : ''}」に結合します。元に戻せません。よろしいですか？`))) return;
        prev.text += b.text;
        if (prev.type === 'line') prev.inlineDirections = extractInlineDirections(prev.text);
        await db.put('blocks', prev);
        await db.delete('blocks', b.id);
        await resetProgress([b.id]);
        blocks.splice(idx, 1);
        await invalidateAppearancesOnce();
        renderList();
      },
    }, '↑ 結合') : null;

    return el('div', { class: `card ${b.confidence < 0.6 ? 'block unknown' : ''}` }, [
      el('div', { class: 'row wrap', style: 'margin-bottom:8px' }, [
        el('span', { class: 'page-tag' }, `p.${b.page}`),
        typeSelect,
        roleSelect,
        mergeBtn,
      ]),
      textArea,
    ]);
  }

  renderList();
  return () => {};
}
