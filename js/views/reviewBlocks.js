import { db } from '../db.js';
import { el } from '../ui.js';

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

  const countsRow = el('div', { class: 'row wrap' });
  page.appendChild(el('div', { class: 'card' }, [countsRow]));

  let onlyIssues = blocks.some(isIssue);
  page.appendChild(el('label', { class: 'row' }, [
    el('input', { type: 'checkbox', checked: onlyIssues, onchange: (e) => { onlyIssues = e.target.checked; renderList(); } }),
    '「要確認」だけ表示する',
  ]));
  page.appendChild(el('p', { class: 'faint' },
    '「要確認」は、役のセリフともト書きとも判断できなかった行です。前後の行も薄く表示しているので、流れを見て判断してください。'));

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
    for (const [t, n] of Object.entries(counts)) countsRow.appendChild(el('span', { class: 'badge' }, `${TYPE_LABELS[t]} ${n}`));
  }

  function renderList() {
    renderCounts();
    list.innerHTML = '';
    if (!onlyIssues) {
      blocks.forEach((b) => list.appendChild(renderRow(b)));
      return;
    }
    const flaggedIdx = [];
    blocks.forEach((b, i) => { if (isIssue(b)) flaggedIdx.push(i); });
    if (flaggedIdx.length === 0) {
      list.appendChild(el('div', { class: 'empty-state' }, '直すべき行はありません。'));
      return;
    }
    let lastShownIdx = -1;
    for (const idx of flaggedIdx) {
      const from = Math.max(0, idx - CONTEXT);
      const to = Math.min(blocks.length - 1, idx + CONTEXT);
      if (lastShownIdx >= 0 && from > lastShownIdx + 1) {
        list.appendChild(el('div', { class: 'faint', style: 'text-align:center;margin:14px 0' }, '……'));
      }
      const start = Math.max(from, lastShownIdx + 1);
      for (let i = start; i <= to; i++) {
        if (i === idx) list.appendChild(renderRow(blocks[i]));
        else if (i > lastShownIdx) list.appendChild(renderContextRow(blocks[i]));
      }
      lastShownIdx = Math.max(lastShownIdx, to);
    }
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

    return el('div', { class: `card ${b.confidence < 0.6 ? 'block unknown' : ''}` }, [
      el('div', { class: 'row wrap', style: 'margin-bottom:8px' }, [
        el('span', { class: 'page-tag' }, `p.${b.page}`),
        typeSelect,
        roleSelect,
      ]),
      textArea,
    ]);
  }

  renderList();
  return () => {};
}
