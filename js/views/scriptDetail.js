import { db } from '../db.js';
import { el, toast, formatDate, confirmDialog } from '../ui.js';
import { progressForBlocks, summarize, resetProgress } from '../progress.js';
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
  const tabsEl = el('div', { class: 'tabs sticky-tabs' }, TABS.map((t) => el('button', {
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
  else if (tab === 'notes') renderNotesTab(content, script, blocks, myRoleIds);
  else renderSettingsTab(content, script, roles, blocks);

  // Scroll to the line we came in for, after the router has done its own
  // scroll-to-top for the new view.
  const focusTimer = focusBlockId
    ? setTimeout(() => document.getElementById('focus-block')?.scrollIntoView({ block: 'center' }), 0)
    : null;

  // The topbar's own height isn't fixed — a long title wraps onto a second
  // line — so the tab bar's sticky offset has to be measured rather than
  // hardcoded, or it collides with the topbar exactly the way the practice
  // screen's page marker used to.
  const positionTabs = () => { tabsEl.style.top = `${topbar.offsetHeight}px`; };
  positionTabs();
  window.addEventListener('resize', positionTabs);

  return () => {
    if (focusTimer) clearTimeout(focusTimer);
    window.removeEventListener('resize', positionTabs);
  };
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
  // Recompute when there is nothing usable to show: no records at all, or
  // records from before scene previews existed (which would render as a
  // blank title on every card). Once the reader has edited the list by hand,
  // an empty result is their choice and must not be undone — the flag is
  // cleared in the 設定 tab, where changing roles invalidates the ranges.
  const needsRecompute = !script.appearancesEdited
    && (appearances.length === 0 || appearances.some((a) => a.preview === undefined));
  if (needsRecompute) {
    const ranges = computeAppearances(blocks, [...myRoleIds]);
    appearances = ranges.map((r) => ({ id: `appear_${script.id}_${r.index}`, scriptId: script.id, ...r }));
    if (appearances.length) await db.putMany('appearances', appearances);
  }
  appearances.sort((a, b) => a.startOrder - b.startOrder);

  if (script.revisionDiff) await renderRevisionDiffCard(content, script, blocks, appearances);

  if (script.performanceDate) {
    const daysLeft = Math.ceil((script.performanceDate - Date.now()) / 86400000);
    content.appendChild(el('div', { class: 'card' }, daysLeft >= 0 ? `本番まであと ${daysLeft} 日` : '本番は終了しました'));
  }

  if (appearances.length === 0) {
    content.appendChild(el('div', { class: 'empty-state' }, [
      el('p', {}, script.appearancesEdited ? '出番がすべて削除されています。' : '自分のセリフが見つかりませんでした。'),
      script.appearancesEdited ? el('button', { onclick: async () => {
        await db.put('scripts', { ...script, appearancesEdited: false });
        location.reload();
      } }, '出番を計算し直す') : null,
    ]));
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

    const menuPanel = el('div', { class: 'card-menu-panel', style: 'display:none' }, [
      el('button', {
        class: 'ghost small',
        onclick: async () => {
          if (!(await confirmDialog(`出番${a.index + 1}の練習記録を削除します。元に戻せません。よろしいですか？`))) return;
          await resetProgress(myBlockIds);
          content.innerHTML = '';
          await renderAppearancesTab(content, script, blocks, roles, myRoleIds);
        },
      }, '進捗をリセット'),
      el('button', {
        class: 'danger small',
        onclick: async () => {
          if (!(await confirmDialog(`出番${a.index + 1}を一覧から削除します。台本のセリフ自体は消えません。よろしいですか？`))) return;
          await db.delete('appearances', a.id);
          script.appearancesEdited = true;
          await db.put('scripts', script);
          content.innerHTML = '';
          await renderAppearancesTab(content, script, blocks, roles, myRoleIds);
        },
      }, '削除'),
    ]);
    const menuBtn = el('button', {
      class: 'ghost small card-menu-btn',
      onclick: () => { menuPanel.style.display = menuPanel.style.display === 'none' ? 'flex' : 'none'; },
    }, '⋮');

    content.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'spread' }, [
        el('div', { class: 'faint' }, `出番${a.index + 1}　p.${a.startPage}–${a.endPage}${a.sceneHeading ? `　・　${a.sceneHeading}` : ''}`),
        menuBtn,
      ]),
      menuPanel,
      el('h3', { style: 'margin:4px 0 10px' }, a.preview ? `「${a.preview}」` : `（自分のセリフなし）`),
      total > 0 ? el('div', { class: 'progress-bar', style: 'margin-bottom:8px' }, [
        el('span', { class: 'got', style: `width:${(counts.got / total) * 100}%` }),
        el('span', { class: 'shaky', style: `width:${(counts.shaky / total) * 100}%` }),
        el('span', { class: 'missed', style: `width:${(counts.missed / total) * 100}%` }),
        el('span', { class: 'unseen', style: `width:${(counts.unseen / total) * 100}%` }),
      ]) : null,
      el('div', { class: 'faint', style: 'margin-bottom:10px' }, `自分のセリフ ${a.myLineCount}本${total > 0 ? `（言えた ${counts.got} ・ 怪しい ${counts.shaky} ・ 出なかった ${counts.missed} ・ 未練習 ${counts.unseen}）` : '（まだ練習していません）'}`),
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', onclick: () => { location.hash = `#/script/${encodeURIComponent(script.id)}/practice/mask/${a.index}`; } }, 'マスク練習'),
        el('button', { onclick: () => { location.hash = `#/script/${encodeURIComponent(script.id)}/practice/voice/${a.index}`; } }, '音声稽古'),
      ]),
    ]));
  }
}

async function renderRevisionDiffCard(content, script, blocks, appearances) {
  const d = script.revisionDiff;
  const parent = await db.get('scripts', d.parentScriptId);
  const blockMap = new Map(blocks.map((b) => [b.id, b]));
  const changedIds = new Set([...d.addedBlockIds, ...d.modifiedPairs.map((p) => p.newBlockId)]);
  const affected = appearances.filter((a) =>
    blocks.some((b) => changedIds.has(b.id) && b.order >= a.startOrder && b.order <= a.endOrder));

  const diffRows = [];
  if (d.modifiedPairs.length) {
    const parentBlocks = await db.byIndex('blocks', 'scriptId', d.parentScriptId);
    const parentBlockMap = new Map(parentBlocks.map((b) => [b.id, b]));
    for (const pair of d.modifiedPairs) {
      const newB = blockMap.get(pair.newBlockId);
      const oldB = parentBlockMap.get(pair.oldBlockId);
      if (!newB) continue;
      diffRows.push(el('div', { style: 'border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:8px' }, [
        el('span', { class: 'badge' }, '変更'),
        el('div', { class: 'faint', style: 'text-decoration:line-through;margin-top:4px' }, oldB ? oldB.text : '（旧テキスト不明）'),
        el('div', { style: 'margin-top:2px' }, newB.text),
      ]));
    }
  }
  for (const id of d.addedBlockIds) {
    const b = blockMap.get(id);
    if (!b) continue;
    diffRows.push(el('div', { style: 'border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:8px' }, [
      el('span', { class: 'badge' }, '追加'),
      el('div', { style: 'margin-top:4px' }, b.text),
    ]));
  }

  content.appendChild(el('div', { class: 'note ok' }, [
    el('strong', {}, parent ? `「${parent.title}」からの改訂版です` : '改訂版として取り込まれています'),
    el('div', {}, `変更 ${d.modifiedCount}　・　追加 ${d.addedCount}　・　削除 ${d.deletedCount}　・　変更なし ${d.unchangedCount}`),
    el('div', { class: 'faint', style: 'margin-top:2px' }, '変更のなかったセリフは、以前の練習記録をそのまま引き継いでいます。変更されたセリフは「怪しい」として登録し直しました。'),
    affected.length ? el('div', { class: 'row wrap', style: 'margin-top:10px' },
      affected.map((a) => el('button', {
        class: 'ghost small',
        onclick: () => { location.hash = `#/script/${encodeURIComponent(script.id)}/practice/mask/${a.index}`; },
      }, `出番${a.index + 1}で確認`))
    ) : null,
    diffRows.length ? el('details', { style: 'margin-top:10px' }, [
      el('summary', {}, '変更点の一覧を見る'),
      el('div', { style: 'margin-top:8px' }, diffRows),
    ]) : null,
  ]));
}

function renderViewTab(content, script, blocks, roleMap, myRoleIds, focusBlockId) {
  content.appendChild(el('p', { class: 'lead' },
    '台本の全文です（編集はできません）。自分のセリフには左に色の線、★の場面には自分の出番があります。'));
  content.appendChild(el('p', { class: 'faint' },
    '見出しの横の「📝 メモ」でその場面の動きと小道具を書き留められます。赤枠は自動判定がうまくいかなかった行です。'));

  const scenes = getScenesForScript(script.id, blocks, myRoleIds);
  const hasRealScenes = !scenes[0]?.id.startsWith('virtual:');
  if (hasRealScenes) {
    const jump = el('select', {
      style: 'margin-bottom:12px',
      onchange: (e) => {
        if (!e.target.value) return;
        document.getElementById(`scene-${e.target.value}`)?.scrollIntoView({ block: 'start' });
        e.target.value = '';
      },
    }, [
      el('option', { value: '' }, `場面へジャンプ（${scenes.length}）`),
      // ★ marks scenes the reader actually appears in. The marker has to be
      // in the text, not only in the styling — iOS renders <select> with its
      // own native picker wheel, which ignores most CSS on <option>.
      ...scenes.map((s) => el('option', {
        value: s.id,
        class: s.hasMine ? 'mine-scene' : '',
      }, `${s.hasMine ? '★ ' : '　 '}p.${s.page}　${s.label}`)),
    ]);
    content.appendChild(jump);
  }

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

function renderNotesTab(content, script, blocks, myRoleIds) {
  const scenes = getScenesForScript(script.id, blocks, myRoleIds);
  content.appendChild(el('p', { class: 'lead' },
    '場面ごとに、動き（立ち位置・移動）と小道具をメモできます。'));
  content.appendChild(el('p', { class: 'faint' },
    '稽古で決まった段取りをその場で書き留めておくと、次の稽古前にここだけ見返せます。場面を選んで開いてください。★は自分が出る場面です。'));
  const list = el('div', { class: 'stack' });
  for (const s of scenes) {
    list.appendChild(el('div', { class: `card tappable ${s.hasMine ? 'mine-scene' : ''}`, onclick: () => { location.hash = `#/script/${encodeURIComponent(script.id)}/scene/${encodeURIComponent(s.id)}`; } }, [
      el('div', { class: 'spread' }, [
        el('div', {}, `${s.hasMine ? '★ ' : ''}${s.label}`),
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
      // Which lines are "mine" is what the ranges were built from, so they no
      // longer mean anything — including any hand-editing of the list, hence
      // clearing the flag that would otherwise suppress the recompute.
      await db.clearByIndex('appearances', 'scriptId', script.id);
      await db.put('scripts', { ...script, appearancesEdited: false });
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
    el('button', { onclick: async () => {
      if (!(await confirmDialog('この台本の練習記録（言えた／怪しい／出なかった）をすべて削除します。台本自体は残ります。元に戻せません。よろしいですか？'))) return;
      const myRoleIds = new Set(roles.filter((r) => r.isMine).map((r) => r.id));
      await resetProgress(blocks.filter((b) => b.type === 'line' && b.roleIds && b.roleIds.some((r) => myRoleIds.has(r))).map((b) => b.id));
      toast('進捗をリセットしました');
    } }, '練習記録をすべてリセット'),
    el('div', { class: 'faint' }, '出番ごとにリセットしたいときは、出番タブの各カードの「⋮」から行えます。'),
    el('button', { class: 'danger', onclick: async () => {
      if (await confirmDialog(`「${script.title}」を削除します。元に戻せません。よろしいですか？`)) {
        await db.deleteScriptCascade(script.id);
        toast('削除しました');
        location.hash = '#/';
      }
    } }, 'この台本を削除'),
  ]));
}
