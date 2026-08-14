import { db, uid } from '../db.js';
import { el, colorForIndex } from '../ui.js';
import { resetProgress } from '../progress.js';
import { createBlockFixUI } from './blockFixList.js';

// Reopens the import wizard's 仕上げ step against blocks already saved to
// the database, so a classification miss found after the fact (a heading
// format the parser didn't know, a role added later) doesn't require
// re-importing the whole script from the original file — which by this
// point isn't even kept around; only its parsed-out blocks are.

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

  const { countsRow, list } = createBlockFixUI({
    getBlocks: () => blocks,
    roles,
    roleIdField: 'id',
    confirmMerge: true,
    onBlockChanged: (b) => db.put('blocks', b),
    onBlockCreated: (b) => { b.id = uid('block'); return db.put('blocks', b); },
    onBlockRemoved: async (b) => { await db.delete('blocks', b.id); await resetProgress([b.id]); },
    onStructureChanged: invalidateAppearancesOnce,
    createRole: async (name) => {
      const role = { id: uid('role'), scriptId, name, aliases: [], isMine: false, color: colorForIndex(roles.length) };
      await db.put('roles', role);
      return role;
    },
  });
  page.appendChild(el('div', { class: 'card' }, [countsRow]));
  page.appendChild(list);
  page.appendChild(el('div', { style: 'height:24px' }));

  return () => {};
}
