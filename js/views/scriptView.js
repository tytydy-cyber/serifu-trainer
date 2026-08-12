import { el } from '../ui.js';

// Renders the full script as a scrollable block list.
// options:
//   highlightRoleIds  Set — mark these roles' lines as the reader's own
//   maskRoleIds       Set — hide these roles' lines until tapped
//   focusBlockId      string — scroll to this block and mark it
//   onSceneNoteClick  (headingBlock) => void
//   rangeStart/rangeEnd — restrict to a range of block orders
//   filterRoleIds     Set — when non-empty, show only these roles' lines
//                      (plus headings, kept as landmarks)
export function renderBlockList(blocks, roleMap, options = {}) {
  const {
    highlightRoleIds = new Set(), maskRoleIds, focusBlockId,
    onSceneNoteClick, rangeStart, rangeEnd, filterRoleIds,
  } = options;
  const list = el('div', { class: 'block-list' });
  let lastPage = null;

  for (const b of blocks) {
    if (rangeStart != null && (b.order < rangeStart || b.order > rangeEnd)) continue;
    if (filterRoleIds && filterRoleIds.size && b.type !== 'heading') {
      const matches = b.type === 'line' && b.roleIds && b.roleIds.some((r) => filterRoleIds.has(r));
      if (!matches) continue;
    }

    if (b.page !== lastPage) {
      list.appendChild(el('div', { class: 'sticky-page-header' }, `p.${b.page}`));
      lastPage = b.page;
    }

    // computeAppearances anchors an 出番 a couple of blocks before the
    // reader's own first line, for lead-in context — that anchor can land on
    // any block type, not just a heading or a line, so every branch below
    // has to be able to carry the focus id or "台本で見る" silently fails to
    // scroll (staying wherever the router's own scroll-to-top left it).
    const isFocus = focusBlockId && b.id === focusBlockId;
    const focusId = isFocus ? 'focus-block' : undefined;

    if (b.type === 'heading') {
      // Every heading gets a stable, predictable id (not just the focused
      // one) so the scene-jump picker can scroll straight to it without a
      // full route change.
      const row = el('div', { class: `row heading-row ${isFocus ? 'focus' : ''}`, id: focusId || `scene-${b.id}`, style: 'justify-content:center;align-items:center;gap:10px' }, [
        el('div', { class: 'block heading', style: 'margin:0' }, b.text),
        onSceneNoteClick ? el('button', { class: 'ghost', style: 'min-height:32px;padding:4px 10px;font-size:13px', onclick: () => onSceneNoteClick(b) }, '📝 メモ') : null,
      ]);
      list.appendChild(row);
      continue;
    }
    if (b.type === 'cue') {
      list.appendChild(el('div', { class: `block cue ${isFocus ? 'focus' : ''}`, id: focusId }, b.text));
      continue;
    }
    if (b.type === 'direction') {
      list.appendChild(el('div', { class: `block direction ${isFocus ? 'focus' : ''}`, id: focusId }, b.text));
      continue;
    }
    if (b.type === 'line') {
      const isMine = b.roleIds && b.roleIds.some((r) => highlightRoleIds.has(r));
      const shouldMask = maskRoleIds && b.roleIds && b.roleIds.some((r) => maskRoleIds.has(r));
      const roleNames = (b.roleIds || []).map((rid) => roleMap.get(rid)?.name || '?').join('・');
      const roleColor = b.roleIds && roleMap.get(b.roleIds[0]) ? roleMap.get(b.roleIds[0]).color : '#888';

      const body = shouldMask
        ? el('div', {
            class: 'masked',
            title: 'タップして開く',
            onclick: (e) => {
              const node = e.currentTarget;
              node.classList.remove('masked');
              node.textContent = '';
              node.appendChild(renderLineText(b));
            },
          }, '█'.repeat(Math.min(20, Math.max(4, Math.ceil([...b.text].length * 0.7)))))
        : el('div', {}, renderLineText(b));

      const node = el('div', { class: `block line ${isMine ? 'mine' : ''} ${isFocus ? 'focus' : ''}`, id: focusId }, [
        el('div', { class: 'role-name' }, [
          el('span', { class: 'dot', style: `background:${roleColor}` }),
          roleNames || '（役未設定）',
        ]),
        body,
      ]);
      list.appendChild(node);
      continue;
    }
    // unknown
    list.appendChild(el('div', { class: `block unknown ${isFocus ? 'focus' : ''}`, id: focusId }, [
      el('div', { class: 'faint' }, '要確認'),
      el('div', {}, b.text),
    ]));
  }
  return list;
}

function renderLineText(block) {
  const wrap = el('span', {});
  const text = block.text;
  const dirs = block.inlineDirections || [];
  if (dirs.length === 0) {
    wrap.textContent = text;
    return wrap;
  }
  let last = 0;
  for (const { start, end } of dirs) {
    if (start > last) wrap.appendChild(document.createTextNode(text.slice(last, start)));
    wrap.appendChild(el('span', { class: 'inline-dir' }, text.slice(start, end)));
    last = end;
  }
  if (last < text.length) wrap.appendChild(document.createTextNode(text.slice(last)));
  return wrap;
}

export function buildRoleMap(roles) {
  const map = new Map();
  for (const r of roles) map.set(r.id, r);
  return map;
}

// myRoleIds is optional — when given, each scene also gets `hasMine`, so a
// caller like the scene-jump picker can flag which scenes the reader is
// actually in without every caller (e.g. the plain scene-notes list) having
// to know about roles at all.
export function getScenesForScript(scriptId, blocks, myRoleIds) {
  const isMine = (b) => myRoleIds && b.type === 'line' && b.roleIds && b.roleIds.some((r) => myRoleIds.has(r));
  const headings = blocks.filter((b) => b.type === 'heading');
  if (headings.length === 0) {
    const hasMine = myRoleIds ? blocks.some(isMine) : undefined;
    return [{ id: `virtual:${scriptId}`, label: '全体', page: blocks[0]?.page || 1, hasMine }];
  }
  return headings.map((h, i) => {
    const nextOrder = headings[i + 1]?.order ?? Infinity;
    const hasMine = myRoleIds
      ? blocks.some((b) => b.order > h.order && b.order < nextOrder && isMine(b))
      : undefined;
    return { id: h.id, label: h.text, page: h.page, hasMine };
  });
}
