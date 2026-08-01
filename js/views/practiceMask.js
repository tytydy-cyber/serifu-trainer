import { db } from '../db.js';
import { el, toast } from '../ui.js';
import { buildRoleMap, renderBlockList } from './scriptView.js';
import { recordResult } from '../progress.js';

function maskLevel(text, level) {
  if (level <= 0) return '█'.repeat(Math.min(14, Math.max(4, Math.ceil(text.length * 0.6))));
  if (level === 1) return '□'.repeat(text.length);
  if (level === 2) {
    const head = text.slice(0, Math.min(3, text.length));
    return head + '□'.repeat(Math.max(0, text.length - head.length));
  }
  if (level === 3) {
    const m = text.match(/^.*?[。！？]/);
    return m ? m[0] + '…' : text;
  }
  return text;
}

const HINT_LABELS = ['文字数', '頭出し', '一文', '全文'];

export async function renderPracticeMask(app, scriptId, appearanceIndex) {
  const script = await db.get('scripts', scriptId);
  const roles = await db.byIndex('roles', 'scriptId', scriptId);
  const blocks = (await db.byIndex('blocks', 'scriptId', scriptId)).sort((a, b) => a.order - b.order);
  const appearances = await db.byIndex('appearances', 'scriptId', scriptId);
  const appearance = appearances.find((a) => a.index === appearanceIndex);
  const roleMap = buildRoleMap(roles);
  const myRoleIds = new Set(roles.filter((r) => r.isMine).map((r) => r.id));

  if (!appearance) {
    app.appendChild(el('div', { class: 'page' }, '出番が見つかりませんでした'));
    return () => {};
  }

  const rangeBlocks = blocks.filter((b) => b.order >= appearance.startOrder && b.order <= appearance.endOrder);

  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'back ghost', onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/appearances`; } }, '←'),
    el('h1', {}, appearance.label),
  ]);
  app.appendChild(topbar);

  const shell = el('div', { class: 'practice-shell' });
  const contextArea = el('div', { class: 'practice-context' });
  const targetArea = el('div', { class: 'practice-target' });
  shell.appendChild(contextArea);
  shell.appendChild(targetArea);
  app.appendChild(shell);

  let cursor = 0;
  let contextBlocks = [];
  const results = { got: 0, shaky: 0, missed: 0 };
  let hintLevel = 0;

  function isMine(b) {
    return b.type === 'line' && b.roleIds && b.roleIds.some((r) => myRoleIds.has(r));
  }

  function step() {
    while (cursor < rangeBlocks.length && !isMine(rangeBlocks[cursor])) {
      contextBlocks.push(rangeBlocks[cursor]);
      cursor++;
    }
    if (cursor >= rangeBlocks.length) {
      renderComplete();
      return;
    }
    hintLevel = 0;
    renderTarget(rangeBlocks[cursor]);
  }

  function renderContext() {
    contextArea.innerHTML = '';
    contextArea.appendChild(renderBlockList(contextBlocks, roleMap, { highlightRoleIds: myRoleIds }));
    contextArea.scrollTop = contextArea.scrollHeight;
  }

  function renderTarget(block) {
    renderContext();
    targetArea.innerHTML = '';
    const roleNames = (block.roleIds || []).map((rid) => roleMap.get(rid)?.name || '?').join('・');

    const textEl = el('div', { class: 'mask-text' }, maskLevel(block.text, hintLevel));

    const hintRow = el('div', { class: 'hint-row' }, HINT_LABELS.map((label, i) => el('button', {
      onclick: () => { hintLevel = Math.max(hintLevel, i + 1); textEl.textContent = maskLevel(block.text, hintLevel); updateJudgeButtons(); },
    }, label)));

    const gotBtn = el('button', { class: 'got', onclick: () => judge('got') }, '言えた');
    const shakyBtn = el('button', { class: 'shaky', onclick: () => judge('shaky') }, '怪しい');
    const missedBtn = el('button', { class: 'missed', onclick: () => judge('missed') }, '出なかった');
    const judgeRow = el('div', { class: 'judge-row' }, [gotBtn, shakyBtn, missedBtn]);

    function updateJudgeButtons() {
      gotBtn.disabled = hintLevel >= 3;
      gotBtn.title = hintLevel >= 3 ? 'ヒントを多く使ったため選べません' : '';
    }
    updateJudgeButtons();

    async function judge(result) {
      results[result]++;
      await recordResult(block.id, result);
      textEl.textContent = block.text;
      contextBlocks.push(block);
      cursor++;
      step();
    }

    targetArea.appendChild(el('div', { class: 'role-name', style: 'margin-bottom:6px' }, [
      el('span', { class: 'dot', style: `background:${roleMap.get(block.roleIds[0])?.color || '#888'}` }),
      roleNames,
    ]));
    targetArea.appendChild(textEl);
    targetArea.appendChild(hintRow);
    targetArea.appendChild(judgeRow);
  }

  function renderComplete() {
    renderContext();
    targetArea.innerHTML = '';
    const total = results.got + results.shaky + results.missed;
    targetArea.appendChild(el('div', { class: 'stack' }, [
      el('h3', { style: 'margin:0' }, 'この出番の練習は完了です'),
      el('div', { class: 'row wrap' }, [
        el('span', { class: 'badge' }, `言えた ${results.got}`),
        el('span', { class: 'badge' }, `怪しい ${results.shaky}`),
        el('span', { class: 'badge' }, `出なかった ${results.missed}`),
        el('span', { class: 'faint' }, `全 ${total} 台詞`),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', onclick: () => { cursor = 0; contextBlocks = []; results.got = 0; results.shaky = 0; results.missed = 0; step(); } }, 'もう一度'),
        el('button', { onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/appearances`; } }, '出番一覧へ'),
      ]),
    ]));
  }

  step();
  return () => {};
}
