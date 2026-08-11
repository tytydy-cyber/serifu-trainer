import { db, uid } from '../db.js';
import { el, toast } from '../ui.js';
import { getScenesForScript } from './scriptView.js';

function noteId(scriptId, sceneId) {
  return `note_${scriptId}__${sceneId}`;
}

export async function renderSceneNotes(app, scriptId, sceneId) {
  const script = await db.get('scripts', scriptId);
  const blocks = (await db.byIndex('blocks', 'scriptId', scriptId)).sort((a, b) => a.order - b.order);
  const scenes = getScenesForScript(scriptId, blocks);
  const scene = scenes.find((s) => s.id === sceneId) || { id: sceneId, label: 'シーン', page: '' };

  const id = noteId(scriptId, sceneId);
  let note = await db.get('sceneNotes', id);
  if (!note) {
    note = { id, scriptId, sceneId, sceneLabel: scene.label, movements: [], props: [] };
  }

  async function save() {
    await db.put('sceneNotes', note);
  }

  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'back ghost', onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/view`; } }, '←'),
    el('h1', {}, scene.label),
  ]);
  const page = el('div', { class: 'page' });
  app.appendChild(topbar);
  app.appendChild(page);

  page.appendChild(el('p', { class: 'faint' }, scene.page ? `p.${scene.page}` : ''));

  // --- 動き（移動・ブロッキング） ---
  page.appendChild(el('h3', {}, '🚶 動き（移動・立ち位置）'));
  const moveList = el('div', { class: 'stack' });
  page.appendChild(moveList);
  const addMoveBtn = el('button', { onclick: () => {
    note.movements.push({ id: uid('mv'), text: '' });
    renderMovements();
  } }, '＋ 動きを追加');
  page.appendChild(addMoveBtn);

  function renderMovements() {
    moveList.innerHTML = '';
    note.movements.forEach((m, idx) => {
      const input = el('input', { type: 'text', value: m.text, placeholder: `例）${idx + 1}. 上手から中央へ移動`, oninput: (e) => { m.text = e.target.value; }, onblur: save });
      const upBtn = el('button', { disabled: idx === 0, onclick: () => { [note.movements[idx - 1], note.movements[idx]] = [note.movements[idx], note.movements[idx - 1]]; save(); renderMovements(); } }, '↑');
      const downBtn = el('button', { disabled: idx === note.movements.length - 1, onclick: () => { [note.movements[idx + 1], note.movements[idx]] = [note.movements[idx], note.movements[idx + 1]]; save(); renderMovements(); } }, '↓');
      const delBtn = el('button', { class: 'ghost', onclick: () => { note.movements.splice(idx, 1); save(); renderMovements(); } }, '✕');
      moveList.appendChild(el('div', { class: 'note-item' }, [input, upBtn, downBtn, delBtn]));
    });
    if (note.movements.length === 0) {
      moveList.appendChild(el('div', { class: 'faint' }, 'この場面での立ち位置・移動のメモがまだありません。'));
    }
  }
  renderMovements();

  // --- 小道具 ---
  page.appendChild(el('h3', { style: 'margin-top:24px' }, '🎭 小道具'));
  const propList = el('div', { class: 'stack' });
  page.appendChild(propList);
  const addPropBtn = el('button', { onclick: () => {
    note.props.push({ id: uid('prop'), name: '', note: '', checked: false });
    renderProps();
  } }, '＋ 小道具を追加');
  page.appendChild(addPropBtn);

  function renderProps() {
    propList.innerHTML = '';
    note.props.forEach((p, idx) => {
      const checkbox = el('input', { type: 'checkbox', checked: p.checked, onchange: (e) => { p.checked = e.target.checked; save(); row.classList.toggle('checked', p.checked); } });
      const nameInput = el('input', { type: 'text', value: p.name, placeholder: '例）手紙、扇子', oninput: (e) => { p.name = e.target.value; }, onblur: save });
      const delBtn = el('button', { class: 'ghost', onclick: () => { note.props.splice(idx, 1); save(); renderProps(); } }, '✕');
      const row = el('div', { class: `prop-item ${p.checked ? 'checked' : ''}` }, [checkbox, nameInput, delBtn]);
      propList.appendChild(row);
    });
    if (note.props.length === 0) {
      propList.appendChild(el('div', { class: 'faint' }, 'この場面で使う小道具のメモがまだありません。'));
    }
  }
  renderProps();

  page.appendChild(el('p', { class: 'faint', style: 'margin-top:20px' }, 'チェックは「準備できた／仕込み済み」の目印として自由に使えます。入力は自動的に保存されます。'));

  return () => {};
}
