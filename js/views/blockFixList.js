import { el, toast, confirmDialog } from '../ui.js';
import { extractInlineDirections, matchKnownNamePrefix } from '../parser.js';

// Shared by the import wizard's 仕上げ step (in-memory state, nothing
// persisted until 保存) and the post-save 分類を見直す screen (every edit
// writes straight to IndexedDB). The two used to be separate ~200-line
// implementations that had already drifted out of sync three times — a
// confidence reset, a counts-badge refresh, and a roleIds clear each landed
// in only one of them. Persistence and destructive-confirm behavior differ
// between the two callers, so those are injected; the row UI, filtering, and
// the 要確認-context windowing are identical and live here once.

export const TYPE_LABELS = { heading: '見出し', cue: 'キュー', line: 'セリフ', direction: 'ト書き', unknown: '要確認' };
const CONTEXT = 2; // lines of surrounding context shown around each flagged row

export function isIssue(b) { return b.type === 'unknown' || b.confidence < 0.6; }

// options:
//   getBlocks(): () => block[]        current block array (mutated in place by this module)
//   roles: role[]                     mutated in place when a suggestion becomes a new role
//   roleIdField: 'id' | 'tempId'      which field on a role object identifies it (default 'id')
//   onBlockChanged(block): persist a single block's field change. No-op if nothing to persist yet.
//   onBlockCreated(block): called right after a split produces a new block, before it's spliced in
//                          — the callback may assign an id and/or persist it.
//   onBlockRemoved(block): called when a merge deletes a block (persist deletion / drop its progress).
//   onStructureChanged(): called whenever which blocks are 'line'/whose role changed — appearances
//                          are derived from that and may need invalidating. No-op if nothing computed yet.
//   confirmMerge: boolean             ask before merging (real data already saved) vs not (wizard draft)
//   createRole(name): role            build + persist (if applicable) a new role for "◯◯を役にして割り当てる"
export function createBlockFixUI(options) {
  const {
    getBlocks, roles, roleIdField = 'id',
    onBlockChanged = () => {}, onBlockCreated = () => {}, onBlockRemoved = () => {},
    onStructureChanged = () => {}, confirmMerge = false, createRole,
  } = options;

  const countsRow = el('div', { class: 'row wrap' });
  const list = el('div', { class: 'block-list' });
  let typeFilter = getBlocks().some(isIssue) ? 'unknown' : null;

  function renderCounts() {
    const blocks = getBlocks();
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

  function renderContextRow(b) {
    return el('div', { class: 'faint', style: 'padding:6px 12px;font-size:14px;line-height:1.6;white-space:pre-wrap' }, [
      el('span', { class: 'page-tag' }, `p.${b.page}　`),
      el('span', {}, `[${TYPE_LABELS[b.type]}] `),
      b.text || '（空行）',
    ]);
  }

  function renderList() {
    renderCounts();
    list.innerHTML = '';
    const blocks = getBlocks();

    if (typeFilter === 'unknown') {
      const flaggedIdx = [];
      blocks.forEach((b, i) => { if (isIssue(b)) flaggedIdx.push(i); });
      if (flaggedIdx.length === 0) {
        list.appendChild(el('div', { class: 'empty-state' }, '直すべき行はありません。そのまま保存できます。'));
        return;
      }
      // A run of flagged rows closer together than CONTEXT (a song's lyrics,
      // say — every line its own 要確認) has each one fall inside the
      // previous one's window. Membership in the full flagged set decides
      // whether a row renders editable, not "is this the row the window is
      // centered on" — otherwise a later flagged row swallowed into an
      // earlier window silently renders as read-only context.
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
      list.appendChild(el('div', { class: 'empty-state' }, typeFilter ? '該当する行はありません。' : '直すべき行はありません。そのまま保存できます。'));
      return;
    }
    filtered.forEach((b) => list.appendChild(renderRow(b)));
  }

  function renderRow(b) {
    const blocks = getBlocks();

    const typeSelect = el('select', {
      onchange: async (e) => {
        b.type = e.target.value;
        if (b.type !== 'line') b.roleIds = undefined;
        // A hand-picked classification is as trustworthy as it gets — this
        // both reflects that and stops the row from re-appearing in the
        // 要確認 filter (which keys off low confidence) forever after.
        if (b.type !== 'unknown') b.confidence = 1;
        await onBlockChanged(b);
        await onStructureChanged();
        renderList();
      },
    }, Object.entries(TYPE_LABELS).map(([v, label]) => el('option', { value: v, selected: b.type === v }, label)));

    const roleSelect = b.type === 'line' ? el('select', {
      onchange: async (e) => {
        b.roleIds = e.target.value ? [e.target.value] : undefined;
        if (b.roleIds) b.confidence = 1;
        await onBlockChanged(b);
        await onStructureChanged();
      },
    }, [
      el('option', { value: '', selected: !b.roleIds || !b.roleIds.length }, '（役を選ぶ）'),
      ...roles.map((r) => el('option', { value: r[roleIdField], selected: !!(b.roleIds && b.roleIds.includes(r[roleIdField])) }, r.name)),
    ]) : null;

    const textArea = el('textarea', {
      rows: b.text.length > 40 ? 3 : 1,
      onchange: async (e) => { b.text = e.target.value; await onBlockChanged(b); },
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
        if (confirmMerge && !(await confirmDialog(`この行を直前の行「${prev.text.slice(0, 20)}${prev.text.length > 20 ? '…' : ''}」に結合します。元に戻せません。よろしいですか？`))) return;
        prev.text += '\n' + b.text;
        if (prev.type === 'line') prev.inlineDirections = extractInlineDirections(prev.text);
        // Extend the surviving block's source range to cover what got
        // folded into it — a Block is meant to always map back to the
        // original text (see DESIGN §3), and a merge that leaves the range
        // where it was silently breaks that for the absorbed text.
        if (b.srcEnd != null && (prev.srcEnd == null || b.srcEnd > prev.srcEnd)) prev.srcEnd = b.srcEnd;
        await onBlockChanged(prev);
        await onBlockRemoved(b);
        blocks.splice(idx, 1);
        await onStructureChanged();
        renderList();
      },
    }, '↑ 結合') : null;

    // The inverse: a block that's actually two speeches glued together
    // (auto-folded on a guess that turned out wrong — or wrong before it
    // ever reached a fix screen, e.g. two names in one cue like "ヘッドギ
    // ア男女", which nothing here can split into its own two roles, but a
    // false "this doesn't look like a fresh speaker" guess can still be
    // undone by hand). Splits at wherever the cursor sits in the textarea;
    // the new block starts out 要確認 like any other unattributed line.
    const splitBtn = el('button', {
      class: 'ghost small',
      title: 'カーソル位置でこの行を2つに分けます',
      onclick: async () => {
        const pos = textArea.selectionStart;
        if (pos <= 0 || pos >= b.text.length) {
          toast('分けたい位置にカーソルを置いてからタップしてください');
          return;
        }
        const before = b.text.slice(0, pos).replace(/[\n ]+$/, '');
        const after = b.text.slice(pos).replace(/^[\n ]+/, '');
        if (!before || !after) { toast('分けたい位置にカーソルを置いてからタップしてください'); return; }

        // Split the source range proportionally between the two halves so
        // both stay tied to the original text (DESIGN §3) — not exact (the
        // original offsets don't track edits made in this textarea either),
        // but close enough to be useful, and contiguous with no overlap.
        let beforeSrcEnd = b.srcEnd;
        let afterSrcStart = b.srcStart;
        if (b.srcStart != null && b.srcEnd != null) {
          const ratio = before.length / (before.length + after.length || 1);
          const mid = Math.round(b.srcStart + (b.srcEnd - b.srcStart) * ratio);
          beforeSrcEnd = mid;
          afterSrcStart = mid;
        }

        const next = blocks[idx + 1];
        const newBlock = {
          scriptId: b.scriptId,
          order: next ? (b.order + next.order) / 2 : b.order + 0.5,
          page: b.page,
          type: 'unknown',
          text: after,
          inlineDirections: [],
          srcStart: afterSrcStart,
          srcEnd: b.srcEnd,
          confidence: 0,
        };
        b.text = before;
        b.srcEnd = beforeSrcEnd;
        await onBlockCreated(newBlock);
        await onBlockChanged(b);
        blocks.splice(idx + 1, 0, newBlock);
        await onStructureChanged();
        renderList();
      },
    }, '↓ 分離');

    // This line only sits in 要確認 because nobody checked the box for a
    // name the candidate scan already found (e.g. a walk-on the reader left
    // unchecked at 役名を確認) — offer to register it as a role and
    // attribute the line in one tap instead of retyping the name.
    const suggestion = b.type === 'unknown' && b.suggestedRoleName ? el('div', { class: 'note ok' }, [
      el('div', {}, `候補：「${b.suggestedRoleName}」の役かもしれません`),
      el('button', {
        class: 'ghost small',
        style: 'margin-top:6px',
        onclick: async () => {
          let role = roles.find((r) => r.name === b.suggestedRoleName);
          if (!role) {
            role = await createRole(b.suggestedRoleName);
            roles.push(role);
          }
          // A walk-on part that speaks more than once shows up as one
          // 要確認 row per line, all with the same suggestion — re-tapping
          // this button for every occurrence is exactly the busywork it
          // exists to avoid. Once the name is confirmed, sweep every other
          // 要確認 row for the same opening name and attribute it too,
          // instead of only the row that was actually tapped.
          const nameLookup = new Map([[role.name, false]]);
          let count = 0;
          for (const candidate of getBlocks()) {
            if (candidate.type !== 'unknown') continue;
            const known = matchKnownNamePrefix(candidate.text, nameLookup);
            if (!known) continue;
            candidate.type = 'line';
            candidate.roleIds = [role[roleIdField]];
            if (known.body && known.body.trim()) candidate.text = known.body;
            candidate.confidence = 0.9;
            candidate.suggestedRoleName = undefined;
            candidate.suggestedBody = undefined;
            await onBlockChanged(candidate);
            count++;
          }
          if (count > 1) toast(`「${role.name}」を役にして、一致する${count}件のセリフをまとめて割り当てました`);
          await onStructureChanged();
          renderList();
        },
      }, `「${b.suggestedRoleName}」を役にして割り当てる`),
    ]) : null;

    return el('div', { class: `card ${b.confidence < 0.6 ? 'block unknown' : ''}` }, [
      suggestion,
      el('div', { class: 'row wrap', style: 'margin-bottom:8px' }, [
        el('span', { class: 'page-tag' }, `p.${b.page}`),
        typeSelect,
        roleSelect,
        mergeBtn,
        splitBtn,
      ]),
      textArea,
    ]);
  }

  renderList();
  return { countsRow, list, render: renderList };
}
