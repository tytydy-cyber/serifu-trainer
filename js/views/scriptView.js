import { el, escapeHtml } from '../ui.js';

// Renders the full script as a scrollable block list.
// options: { highlightRoleIds: Set, onSceneNoteClick: (headingBlock) => void, rangeStart, rangeEnd, hideOthers }
export function renderBlockList(blocks, roleMap, options = {}) {
  const { highlightRoleIds = new Set(), onSceneNoteClick, rangeStart, rangeEnd } = options;
  const list = el('div', { class: 'block-list' });
  let lastPage = null;

  for (const b of blocks) {
    if (rangeStart != null && (b.order < rangeStart || b.order > rangeEnd)) continue;

    if (b.page !== lastPage) {
      list.appendChild(el('div', { class: 'sticky-page-header' }, `p.${b.page}`));
      lastPage = b.page;
    }

    if (b.type === 'heading') {
      const row = el('div', { class: 'row', style: 'justify-content:center;align-items:center;gap:10px' }, [
        el('div', { class: 'block heading', style: 'margin:0' }, b.text),
        onSceneNoteClick ? el('button', { class: 'ghost', style: 'min-height:32px;padding:4px 10px;font-size:13px', onclick: () => onSceneNoteClick(b) }, '📝 メモ') : null,
      ]);
      list.appendChild(row);
      continue;
    }
    if (b.type === 'cue') {
      list.appendChild(el('div', { class: 'block cue' }, b.text));
      continue;
    }
    if (b.type === 'direction') {
      list.appendChild(el('div', { class: 'block direction' }, b.text));
      continue;
    }
    if (b.type === 'line') {
      const isMine = b.roleIds && b.roleIds.some((r) => highlightRoleIds.has(r));
      const roleNames = (b.roleIds || []).map((rid) => roleMap.get(rid)?.name || '?').join('・');
      const roleColor = b.roleIds && roleMap.get(b.roleIds[0]) ? roleMap.get(b.roleIds[0]).color : '#888';
      list.appendChild(el('div', { class: `block line ${isMine ? 'mine' : ''}` }, [
        el('div', { class: 'role-name' }, [
          el('span', { class: 'dot', style: `background:${roleColor}` }),
          roleNames || '（役未設定）',
        ]),
        el('div', {}, renderLineText(b)),
      ]));
      continue;
    }
    // unknown
    list.appendChild(el('div', { class: 'block unknown' }, [
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

export function getScenesForScript(scriptId, blocks) {
  const headings = blocks.filter((b) => b.type === 'heading');
  if (headings.length === 0) {
    return [{ id: `virtual:${scriptId}`, label: '全体', page: blocks[0]?.page || 1 }];
  }
  return headings.map((h) => ({ id: h.id, label: h.text, page: h.page }));
}
