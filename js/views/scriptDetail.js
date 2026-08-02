import { db } from '../db.js';
import { el, toast, formatDate, confirmDialog, colorForIndex } from '../ui.js';
import { progressForBlocks, summarize } from '../progress.js';
import { computeAppearances } from '../appearances.js';
import { renderBlockList, buildRoleMap, getScenesForScript } from './scriptView.js';

const TABS = [
  { id: 'appearances', label: '出番' },
  { id: 'view', label: '台本' },
  { id: 'notes', label: 'メモ' },
  { id: 'settings', label: '設定' },
];

export async function renderScriptDetail(app, scriptId, tab, focusBlockId) {
  const script = await db.get('scripts', scriptId);
  if (!script) {
    app.appendChild(el('div', { class: 'page' }, '台本が見つかりませんでした'));
    return () => {};
  }
  const roles = await db.byIndex('roles', 'scriptId', scriptId);
  const blocks = (await db.byIndex('blocks', 'scriptId', scriptId)).sort((a, b) => a.order - b.order);
  const roleMap = buildRoleMap(roles);
  const myRoleIds = new Set(roles.filter((r) => r.isMine).map((r) => r.id));

  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'back ghost', onclick: () => { location.hash = '#/'; } }, '←'),
    el('h1', {}, script.title),
  ]);
  const tabsEl = el('div', { class: 'tabs' }, TABS.map((t) => el('button', {
    class: t.id === tab ? 'active' : '',
    onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/${t.id}`; },
  }, t.label)));
  const page = el('div', { class: 'page' }, [tabsEl]);
  app.appendChild(topbar);
  app.appendChild(page);

  const content = el('div', {});
  page.appendChild(content);

  if (tab === 'appearances') await renderAppearancesTab(content, script, blocks, roles, myRoleIds);
  else if (tab === 'view') renderViewTab(content, script, blocks, roleMap, myRoleIds, focusBlockId);
  else if (tab === 'notes') renderNotesTab(content, script, blocks);
  else renderSettingsTab(content, script, roles, blocks);

  // Scroll to the line we came in for, after the router has done its own
  // scroll-to-top for the new view.
  const focusTimer = focusBlockId
    ? setTimeout(() => document.getElementById('focus-block')?.scrollIntoView({ block: 'center' }), 0)
    : null;

  return () => { if (focusTimer) clearTimeout(focusTimer); };
}

async function renderAppearancesTab(content, script, blocks, roles, myRoleIds) {
  if (myRoleIds.size === 0) {
    content.appendChild(el('div', { class: 'empty-state' }, [
      el('p', {}, '自分の役が設定されていません。'),
      el('button', { class: 'primary', onclick: () => { location.hash = `#/script/${encodeURIComponent(script.id)}/settings`; } }, '設定タブで自分の役を選ぶ'),
    ]));
    return;
  }

  let appearances = await db.byIndex('appearances', 'scriptId', script.id);
  if (appearances.length === 0) {
    const ranges = computeAppearances(blocks, [...myRoleIds]);
    appearances = ranges.map((r) => ({ id: `appear_${script.id}_${r.index}`, scriptId: script.id, ...r }));
    if (appearances.length) await db.putMany('appearances', appearances);
  }
  appearances.sort((a, b) => a.startOrder - b.startOrder);

  if (script.performanceDate) {
    const daysLeft = Math.ceil((script.performanceDate - Date.now()) / 86400000);
    content.appendChild(el('div', { class: 'card' }, daysLeft >= 0 ? `本番まであと ${daysLeft} 日` : '本番は終了しました'));
  }

  if (appearances.length === 0) {
    content.appendChild(el('div', { class: 'empty-state' }, '自分のセリフが見つかりませんでした。'));
    return;
  }

  content.appendChild(el('p', { class: 'lead' },
    '自分のセリフが続くまとまりごとに「出番」に区切ってあります。今日さらう場面を選んで練習してください。'));
  content.appendChild(el('p', { class: 'faint' },
    'マスク練習は自分のセリフを隠して思い出す練習、音声稽古は相手のセリフを読み上げて実際に声に出す練習です。'));

  for (const a of appearances) {
    const myBlockIds = blocks
      .filter((b) => b.order >= a.startOrder && b.order <= a.endOrder && b.type === 'line' && b.roleIds && b.roleIds.some((r) => myRoleIds.has(r)))
      .map((b) => b.id);
    const progressMap = await progressForBlocks(myBlockIds);
    const { counts, total } = summarize([...progressMap.values()]);

    content.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'spread' }, [
        el('h3', { style: 'margin:0' }, a.label),
      ]),
      total > 0 ? el('div', { class: 'progress-bar', style: 'margin:10px 0' }, [
        el('span', { class: 'got', style: `width:${(counts.got / total) * 100}%` }),
        el('span', { class: 'shaky', style: `width:${(counts.shaky / total) * 100}%` }),
        el('span', { class: 'missed', style: `width:${(counts.missed / total) * 100}%` }),
        el('span', { class: 'unseen', style: `width:${(counts.unseen / total) * 100}%` }),
      ]) : null,
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', onclick: () => { location.hash = `#/script/${encodeURIComponent(script.id)}/practice/mask/${a.index}`; } }, 'マスク練習'),
        el('button', { onclick: () => { location.hash = `#/script/${encodeURIComponent(script.id)}/practice/voice/${a.index}`; } }, '音声稽古'),
      ]),
    ]));
  }
}

function renderViewTab(content, script, blocks, roleMap, myRoleIds, focusBlockId) {
  content.appendChild(el('p', { class: 'lead' },
    '台本の全文を読み返せる画面です（編集はできません）。自分のセリフには左側に色の線が付いています。練習中に迷ったら「台本で見る」からここに戻ってこられます。'));
  content.appendChild(el('p', { class: 'faint' },
    '場面の見出しの横にある「📝 メモ」から、その場面の動き（立ち位置・移動）と小道具を書き留められます。赤枠は自動判定がうまくいかなかった行です。'));
  const legend = el('div', { class: 'row wrap', style: 'margin: 12px 0' }, [...roleMap.values()].map((r) => el('span', { class: 'badge' }, [
    el('span', { class: 'dot', style: `background:${r.color};width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px` }),
    r.name + (r.isMine ? '（自分）' : ''),
  ])));
  content.appendChild(legend);

  const list = renderBlockList(blocks, roleMap, {
    highlightRoleIds: myRoleIds,
    focusBlockId,
    onSceneNoteClick: (heading) => { location.hash = `#/script/${encodeURIComponent(script.id)}/scene/${encodeURIComponent(heading.id)}`; },
  });
  content.appendChild(list);
}

function renderNotesTab(content, script, blocks) {
  const scenes = getScenesForScript(script.id, blocks);
  content.appendChild(el('p', { class: 'lead' },
    '場面ごとに、動き（立ち位置・移動）と小道具をメモできます。'));
  content.appendChild(el('p', { class: 'faint' },
    '稽古で決まった段取りをその場で書き留めておくと、次の稽古前にここだけ見返せます。場面を選んで開いてください。'));
  const list = el('div', { class: 'stack' });
  for (const s of scenes) {
    list.appendChild(el('div', { class: 'card tappable', onclick: () => { location.hash = `#/script/${encodeURIComponent(script.id)}/scene/${encodeURIComponent(s.id)}`; } }, [
      el('div', { class: 'spread' }, [
        el('div', {}, s.label),
        el('span', { class: 'faint' }, `p.${s.page}`),
      ]),
    ]));
  }
  content.appendChild(list);
}

function renderSettingsTab(content, script, roles, blocks) {
  content.appendChild(el('div', { class: 'card stack' }, [
    el('div', {}, [el('div', { class: 'faint' }, 'タイトル'), el('div', {}, script.title)]),
    script.revision ? el('div', {}, [el('div', { class: 'faint' }, '稿'), el('div', {}, script.revision)]) : null,
    el('div', {}, [el('div', { class: 'faint' }, '取り込み日'), el('div', {}, formatDate(script.createdAt))]),
  ]));

  content.appendChild(el('h3', {}, '役の設定'));
  const rolesCard = el('div', { class: 'card stack' });
  for (const role of roles) {
    const checkbox = el('input', { type: 'checkbox', checked: role.isMine, onchange: async (e) => {
      role.isMine = e.target.checked;
      await db.put('roles', role);
      await db.clearByIndex('appearances', 'scriptId', script.id);
      toast('更新しました。出番タブで再計算されます。');
    } });
    rolesCard.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'dot', style: `background:${role.color};width:10px;height:10px;border-radius:50%;display:inline-block` }),
      el('div', { style: 'flex:1' }, role.name),
      el('label', { class: 'row', style: 'width:auto' }, [checkbox, '自分の役']),
    ]));
  }
  content.appendChild(rolesCard);

  content.appendChild(el('h3', {}, 'データ'));
  content.appendChild(el('div', { class: 'card stack' }, [
    el('button', { class: 'danger', onclick: async () => {
      if (await confirmDialog(`「${script.title}」を削除します。元に戻せません。よろしいですか？`)) {
        await db.deleteScriptCascade(script.id);
        toast('削除しました');
        location.hash = '#/';
      }
    } }, 'この台本を削除'),
  ]));
}
