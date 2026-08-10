import { db } from '../db.js';
import { el, formatDate, toast, confirmDialog } from '../ui.js';
import { progressForBlocks, summarize } from '../progress.js';

export async function renderHome(app) {
  let selectMode = false;
  const selected = new Set();
  const checkboxRows = [];

  const topbar = el('div', { class: 'topbar' }, [
    el('h1', {}, 'セリフトレーナー'),
    el('button', { class: 'ghost', onclick: () => exportBackup() }, '書き出し'),
  ]);
  const page = el('div', { class: 'page' });
  app.appendChild(topbar);
  app.appendChild(page);

  page.appendChild(el('p', { class: 'lead' },
    '台本を取り込むと、自分のセリフを隠して覚える練習ができます。台本データはこの端末だけに保存され、どこにも送信されません。'));

  const scripts = await db.all('scripts');
  scripts.sort((a, b) => b.createdAt - a.createdAt);

  if (scripts.length === 0) {
    page.appendChild(el('div', { class: 'empty-state' }, [
      el('p', {}, '台本がまだありません。'),
      el('p', { class: 'faint' }, '下の「＋ 台本を取り込む」から脚本のファイルを選ぶと、役名とセリフを自動で読み取ります。'),
      el('p', { class: 'faint' }, '自分の役を選ぶと出番（自分のセリフが続くまとまり）ごとに区切られ、セリフを隠して覚える練習と、相手のセリフを読み上げる音声稽古ができます。'),
    ]));
  } else {
    const deleteBtn = el('button', { class: 'danger small', style: 'display:none' }, '選択した台本を削除');
    const selectToggleBtn = el('button', { class: 'ghost small' }, '選択して削除');

    function updateDeleteBtn() {
      deleteBtn.textContent = `選択した台本を削除（${selected.size}）`;
      deleteBtn.disabled = selected.size === 0;
    }

    selectToggleBtn.addEventListener('click', () => {
      selectMode = !selectMode;
      selected.clear();
      for (const row of checkboxRows) {
        row.style.display = selectMode ? 'flex' : 'none';
        row.querySelector('input').checked = false;
      }
      selectToggleBtn.textContent = selectMode ? 'キャンセル' : '選択して削除';
      deleteBtn.style.display = selectMode ? 'inline-flex' : 'none';
      updateDeleteBtn();
    });

    deleteBtn.addEventListener('click', async () => {
      if (selected.size === 0) return;
      if (!(await confirmDialog(`選択した${selected.size}件の台本を削除します。元に戻せません。よろしいですか？`))) return;
      for (const id of selected) await db.deleteScriptCascade(id);
      toast('削除しました');
      location.hash = '#/';
      location.reload();
    });

    page.appendChild(el('div', { class: 'row', style: 'justify-content:flex-end;gap:8px;margin-bottom:10px' }, [deleteBtn, selectToggleBtn]));

    const list = el('div', { class: 'stack' });
    for (const s of scripts) {
      const { card, checkboxRow } = await renderScriptCard(s, () => selectMode, selected, updateDeleteBtn);
      checkboxRows.push(checkboxRow);
      list.appendChild(card);
    }
    page.appendChild(list);
  }

  const importInput = el('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await db.importAll(payload);
      toast('復元しました');
      location.hash = '#/';
      location.reload();
    } catch (err) {
      toast('読み込みに失敗しました: ' + err.message);
    }
  } });
  document.body.appendChild(importInput);

  page.appendChild(el('div', { style: 'margin-top:20px;text-align:center' }, [
    el('button', { class: 'ghost', onclick: () => importInput.click() }, 'バックアップ（.json）から復元'),
    el('p', { class: 'faint', style: 'margin-top:6px' },
      '「書き出し」で保存しておいた控えファイルを読み込んで、この端末に全データを戻すためのボタンです。台本を追加したいときは、下の「＋ 台本を取り込む」を使ってください。'),
  ]));

  app.appendChild(el('div', { class: 'fab-row' }, [
    el('button', { class: 'primary', onclick: () => { location.hash = '#/import'; } }, '＋ 台本を取り込む'),
  ]));

  return () => { importInput.remove(); };
}

async function renderScriptCard(script, isSelectMode, selected, onSelectionChange) {
  const roles = await db.byIndex('roles', 'scriptId', script.id);
  const blocks = await db.byIndex('blocks', 'scriptId', script.id);
  const myRoleIds = new Set(roles.filter((r) => r.isMine).map((r) => r.id));
  const myBlocks = blocks.filter((b) => b.type === 'line' && b.roleIds && b.roleIds.some((r) => myRoleIds.has(r)));
  const progressMap = await progressForBlocks(myBlocks.map((b) => b.id));
  const { counts, total } = summarize([...progressMap.values()]);

  const daysLeft = script.performanceDate
    ? Math.ceil((script.performanceDate - Date.now()) / (24 * 60 * 60 * 1000))
    : null;

  const checkbox = el('input', { type: 'checkbox', onchange: (e) => {
    if (e.target.checked) selected.add(script.id); else selected.delete(script.id);
    onSelectionChange();
  } });
  const checkboxRow = el('label', { class: 'row mine-check', style: 'display:none;margin-bottom:8px' }, [checkbox, '選択']);

  const card = el('div', {
    class: 'card script-card tappable',
    onclick: (e) => {
      if (isSelectMode()) {
        if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
        return;
      }
      location.hash = `#/script/${encodeURIComponent(script.id)}`;
    },
  }, [
    checkboxRow,
    el('h3', {}, script.title || '無題の台本'),
    el('div', { class: 'meta faint' }, [
      script.revision ? el('span', {}, script.revision) : null,
      script.parentScriptId ? el('span', { class: 'badge' }, '改訂版') : null,
      el('span', {}, `自分のセリフ ${total}本`),
      daysLeft != null ? el('span', { style: daysLeft <= 3 ? 'color:var(--missed)' : '' }, daysLeft >= 0 ? `本番まであと${daysLeft}日` : '本番終了') : null,
      el('span', {}, formatDate(script.createdAt)),
    ]),
    total > 0 ? el('div', { class: 'progress-bar', style: 'margin-top:10px' }, [
      el('span', { class: 'got', style: `width:${(counts.got / total) * 100}%` }),
      el('span', { class: 'shaky', style: `width:${(counts.shaky / total) * 100}%` }),
      el('span', { class: 'missed', style: `width:${(counts.missed / total) * 100}%` }),
      el('span', { class: 'unseen', style: `width:${(counts.unseen / total) * 100}%` }),
    ]) : null,
  ]);
  return { card, checkboxRow };
}

async function exportBackup() {
  const payload = await db.exportAll();
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `serifu-trainer-backup-${Date.now()}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
