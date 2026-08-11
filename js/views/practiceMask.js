import { db } from '../db.js';
import { el } from '../ui.js';
import { buildRoleMap, renderBlockList } from './scriptView.js';
import { recordResult } from '../progress.js';

// Kept visible even while a line is blanked out: they carry the rhythm of a
// line (where it pauses, where it ends) without giving away any wording, so
// hiding them behind □ only made the guess harder without testing anything.
const PUNCTUATION_RE = /[。、！？…\s「」『』（）()・～]/;

function maskTail(text) {
  return [...text].map((ch) => (PUNCTUATION_RE.test(ch) ? ch : '□')).join('');
}

function maskLevel(text, level) {
  // Level 0 hides the character count itself, so it stays a fixed block —
  // showing real punctuation positions here would leak the line's length.
  if (level <= 0) return '█'.repeat(Math.min(14, Math.max(4, Math.ceil(text.length * 0.6))));
  if (level === 1) return maskTail(text);
  if (level === 2) {
    const head = text.slice(0, Math.min(3, text.length));
    return head + maskTail(text.slice(head.length));
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
    el('button', { class: 'ghost small', onclick: () => { mode = mode === 'quiz' ? 'whole' : 'quiz'; renderMode(); } }, '通し表示'),
  ]);
  app.appendChild(topbar);

  const shell = el('div', { class: 'practice-shell' });
  const contextArea = el('div', { class: 'practice-context' });
  const targetArea = el('div', { class: 'practice-target' });
  const wholeArea = el('div', { class: 'page', style: 'display:none' });
  shell.appendChild(contextArea);
  shell.appendChild(targetArea);
  shell.appendChild(wholeArea);
  app.appendChild(shell);

  let mode = 'quiz';

  function renderMode() {
    const quiz = mode === 'quiz';
    contextArea.style.display = quiz ? '' : 'none';
    targetArea.style.display = quiz ? '' : 'none';
    wholeArea.style.display = quiz ? 'none' : '';
    topbar.lastChild.textContent = quiz ? '通し表示' : '一問ずつ';
    if (!quiz) renderWhole();
  }

  // The whole passage in order, with only my own lines hidden — so a line can
  // be placed in the flow of the scene rather than answered in isolation.
  function renderWhole() {
    wholeArea.innerHTML = '';
    wholeArea.appendChild(el('p', { class: 'faint' },
      'この出番の全文です。自分のセリフだけ伏せてあります。伏せ字をタップすると、その1本だけ開きます。'));
    wholeArea.appendChild(el('div', { class: 'row', style: 'margin-bottom:12px' }, [
      el('button', { onclick: () => wholeArea.querySelectorAll('.masked').forEach((n) => n.click()) }, 'すべて開く'),
      el('button', { onclick: renderWhole }, 'すべて伏せる'),
    ]));

    const list = renderBlockList(rangeBlocks, roleMap, {
      highlightRoleIds: myRoleIds,
      maskRoleIds: myRoleIds,
    });
    wholeArea.appendChild(list);
  }

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
    // Separate from hintLevel: whether the full line is currently on screen.
    // Tapping 文字数/頭出し/一文 alone should not count as having seen the
    // answer — only 全文, or a first tap of a judge button, does.
    let revealed = false;
    const confirmHint = el('div', { class: 'faint', style: 'margin:4px 0;visibility:hidden' }, 'もう一度タップで記録します');

    const hintRow = el('div', { class: 'hint-row' }, HINT_LABELS.map((label, i) => el('button', {
      onclick: () => {
        hintLevel = Math.max(hintLevel, i + 1);
        if (hintLevel >= 4) revealed = true;
        textEl.textContent = maskLevel(block.text, hintLevel);
        updateJudgeButtons();
      },
    }, label)));

    const gotBtn = el('button', { class: 'got', onclick: () => judge('got') }, '言えた');
    const shakyBtn = el('button', { class: 'shaky', onclick: () => judge('shaky') }, '怪しい');
    const missedBtn = el('button', { class: 'missed', onclick: () => judge('missed') }, '出なかった');
    const judgeRow = el('div', { class: 'judge-row' }, [gotBtn, shakyBtn, missedBtn]);

    function updateJudgeButtons() {
      // Hints past 一文 already show most of the line, so claiming "言えた"
      // at that point would not mean much — same rule as before.
      gotBtn.disabled = hintLevel >= 3 && !revealed;
      gotBtn.title = gotBtn.disabled ? 'ヒントを多く使ったため選べません' : '';
    }
    updateJudgeButtons();

    async function judge(result) {
      // First tap: show the correct line so it can be checked against what
      // was actually said, without recording anything yet. Second tap (of
      // any judge button, now that the answer is visible) records it.
      if (!revealed) {
        revealed = true;
        textEl.textContent = block.text;
        confirmHint.style.visibility = 'visible';
        updateJudgeButtons();
        return;
      }
      results[result]++;
      await recordResult(block.id, result);
      contextBlocks.push(block);
      cursor++;
      step();
    }

    const myTotal = rangeBlocks.filter(isMine).length;
    const myDone = rangeBlocks.slice(0, cursor).filter(isMine).length;

    targetArea.appendChild(el('div', { class: 'spread', style: 'margin-bottom:6px' }, [
      el('div', { class: 'role-name', style: 'margin:0' }, [
        el('span', { class: 'dot', style: `background:${roleMap.get(block.roleIds[0])?.color || '#888'}` }),
        roleNames,
      ]),
      el('div', { class: 'row', style: 'gap:6px' }, [
        el('span', { class: 'faint' }, `p.${block.page} ・ ${myDone + 1}/${myTotal}`),
        el('button', {
          class: 'ghost small',
          onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/view/${encodeURIComponent(block.id)}`; },
        }, '台本で見る'),
      ]),
    ]));
    targetArea.appendChild(textEl);
    targetArea.appendChild(hintRow);
    targetArea.appendChild(confirmHint);
    targetArea.appendChild(judgeRow);
  }

  function renderComplete() {
    renderContext();
    targetArea.innerHTML = '';
    const total = results.got + results.shaky + results.missed;
    targetArea.appendChild(el('div', { class: 'stack' }, [
      el('h3', { style: 'margin:0' }, 'この出番の稽古は完了です'),
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
  renderMode();
  return () => {};
}
