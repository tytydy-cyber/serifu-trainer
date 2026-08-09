import { db } from '../db.js';
import { el } from '../ui.js';
import { buildRoleMap } from './scriptView.js';
import { recordResult } from '../progress.js';
import { SpeechEngine, getVoices, isJapaneseTtsAvailable, stripDirectionsForSpeech } from '../tts.js';

export async function renderPracticeVoice(app, scriptId, appearanceIndex) {
  const roles = await db.byIndex('roles', 'scriptId', scriptId);
  const blocks = (await db.byIndex('blocks', 'scriptId', scriptId)).sort((a, b) => a.order - b.order);
  const appearances = await db.byIndex('appearances', 'scriptId', scriptId);
  const appearance = appearances.find((a) => a.index === appearanceIndex);
  const roleMap = buildRoleMap(roles);
  const myRoleIds = new Set(roles.filter((r) => r.isMine).map((r) => r.id));

  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'back ghost', onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/appearances`; } }, '←'),
    el('h1', {}, appearance ? `${appearance.label}（音声稽古）` : '音声稽古'),
  ]);
  app.appendChild(topbar);

  if (!appearance) {
    app.appendChild(el('div', { class: 'page' }, '出番が見つかりませんでした'));
    return () => {};
  }

  const shell = el('div', { class: 'practice-shell' });
  app.appendChild(shell);

  const ttsOk = await isJapaneseTtsAvailable();
  if (!ttsOk) {
    shell.appendChild(el('div', { class: 'page' }, [
      el('div', { class: 'card' }, [
        el('p', {}, 'この端末には日本語の読み上げ音声が見つかりませんでした。'),
        el('p', { class: 'faint' }, '端末の設定から日本語の音声合成データを追加すると使えるようになります。それまではマスク練習をご利用ください。'),
      ]),
      el('button', { class: 'primary', onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/appearances`; } }, '出番一覧へ戻る'),
    ]));
    return () => {};
  }

  const rangeBlocks = blocks.filter((b) => b.order >= appearance.startOrder && b.order <= appearance.endOrder && (b.type === 'line' || b.type === 'direction'));
  const voices = await getVoices();
  const jaVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('ja'));

  const settings = {
    pauseMultiplier: 1,
    readDirections: true,
    speakMyLines: false,
  };
  const roleVoice = new Map(); // roleId -> voiceURI
  roles.forEach((r, i) => {
    const v = jaVoices[i % Math.max(1, jaVoices.length)];
    roleVoice.set(r.id, r.voice?.voiceURI || v?.voiceURI || null);
  });

  const settingsPanel = el('details', { class: 'card' }, [
    el('summary', {}, '声の設定'),
    el('div', { class: 'stack', style: 'margin-top:10px' }, [
      ...roles.map((r) => el('label', { class: 'row' }, [
        el('span', { style: 'width:5em;flex:none' }, r.name),
        el('select', { onchange: (e) => roleVoice.set(r.id, e.target.value || null) },
          [el('option', { value: '' }, '（既定）'), ...jaVoices.map((v) => el('option', { value: v.voiceURI, selected: roleVoice.get(r.id) === v.voiceURI }, v.name))]
        ),
      ])),
      el('label', { class: 'row' }, [
        el('span', { style: 'width:8em;flex:none' }, '間の長さ'),
        el('input', { type: 'range', min: '0.5', max: '2', step: '0.1', value: '1', oninput: (e) => { settings.pauseMultiplier = Number(e.target.value); } }),
      ]),
      el('label', { class: 'row' }, [
        el('input', { type: 'checkbox', checked: true, onchange: (e) => { settings.readDirections = e.target.checked; } }),
        'ト書きも読み上げる',
      ]),
      el('label', { class: 'row' }, [
        el('input', { type: 'checkbox', checked: false, onchange: (e) => { settings.speakMyLines = e.target.checked; } }),
        '自分のセリフも聞き流す（読み上げる）',
      ]),
    ]),
  ]);

  const stage = el('div', { class: 'voice-stage' });
  const startBtn = el('button', { class: 'primary', onclick: startPractice }, '▶ 稽古を始める');
  const controls = el('div', { class: 'fab-row', style: 'display:none' }, []);

  shell.appendChild(el('div', { class: 'page' }, [settingsPanel, stage, el('div', { style: 'text-align:center' }, startBtn)]));
  app.appendChild(controls);

  const engine = new SpeechEngine();
  let stopped = false;
  let paused = false;
  let skipRequested = false;
  let cursor = 0;
  const results = { got: 0, shaky: 0, missed: 0 };

  function isMine(b) {
    return b.roleIds && b.roleIds.some((r) => myRoleIds.has(r));
  }

  function setControls() {
    controls.innerHTML = '';
    controls.style.display = 'flex';
    controls.appendChild(el('button', { onclick: () => { paused = !paused; pauseBtn.textContent = paused ? '▶ 再開' : '⏸ 一時停止'; if (!paused) engine.cancel(); } }, '⏸ 一時停止'));
    controls.appendChild(el('button', { onclick: () => { skipRequested = true; engine.cancel(); } }, '次へ'));
    controls.appendChild(el('button', { class: 'danger', onclick: () => { stopped = true; engine.cancel(); location.hash = `#/script/${encodeURIComponent(scriptId)}/appearances`; } }, '中断'));
    var pauseBtn = controls.children[0];
  }

  function speakerLabel(block) {
    return (block.roleIds || []).map((rid) => roleMap.get(rid)?.name || '?').join('・');
  }

  async function waitWhilePaused() {
    while (paused && !stopped) await new Promise((r) => setTimeout(r, 150));
  }

  async function playOtherLine(block) {
    stage.innerHTML = '';
    stage.appendChild(el('div', { class: 'speaker' }, speakerLabel(block)));
    stage.appendChild(el('div', { class: 'status-dot' }));
    stage.appendChild(el('div', { class: 'content' }, block.text));
    const speechText = stripDirectionsForSpeech(block.text, block.inlineDirections);
    const roleId = block.roleIds[0];
    try {
      await engine.speak(speechText, { voiceURI: roleVoice.get(roleId), rate: 1 });
    } catch (e) { /* ignore speech errors, continue */ }
  }

  async function playDirection(block) {
    stage.innerHTML = '';
    stage.appendChild(el('div', { class: 'speaker' }, 'ト書き'));
    stage.appendChild(el('div', { class: 'content', style: 'font-size:16px;color:var(--text-dim)' }, block.text));
    try { await engine.speak(block.text, { rate: 1.05, pitch: 0.9 }); } catch (e) {}
  }

  function playMyLine(block) {
    return new Promise((resolve) => {
      stage.innerHTML = '';
      stage.appendChild(el('div', { class: 'speaker' }, `${speakerLabel(block)}（あなた）`));
      const contentEl = el('div', { class: 'content' }, '・・・');
      stage.appendChild(contentEl);
      stage.appendChild(el('div', { class: 'faint' }, 'セリフを言ってみましょう。タップで答えを表示します。'));
      stage.appendChild(el('div', { class: 'row', style: 'gap:8px;justify-content:center' }, [
        el('span', { class: 'faint' }, `p.${block.page}`),
        el('button', {
          class: 'ghost small',
          onclick: (e) => {
            e.stopPropagation();
            stopped = true;
            engine.cancel();
            location.hash = `#/script/${encodeURIComponent(scriptId)}/view/${encodeURIComponent(block.id)}`;
          },
        }, '台本で見る'),
      ]));

      let revealed = false;
      const reveal = async () => {
        if (revealed) return;
        revealed = true;
        contentEl.textContent = block.text;
        if (settings.speakMyLines) {
          try { await engine.speak(stripDirectionsForSpeech(block.text, block.inlineDirections), { voiceURI: roleVoice.get(block.roleIds[0]) }); } catch (e) {}
        }
        showJudge();
      };

      const pauseMs = block.text.length * 180 * settings.pauseMultiplier + 1000;
      const timer = setTimeout(reveal, pauseMs);
      stage.addEventListener('click', () => { clearTimeout(timer); reveal(); }, { once: true });

      function showJudge() {
        const row = el('div', { class: 'judge-row', style: 'max-width:400px' }, [
          el('button', { class: 'got', onclick: () => finish('got') }, '言えた'),
          el('button', { class: 'shaky', onclick: () => finish('shaky') }, '怪しい'),
          el('button', { class: 'missed', onclick: () => finish('missed') }, '出なかった'),
        ]);
        stage.appendChild(row);
      }

      async function finish(result) {
        results[result]++;
        await recordResult(block.id, result);
        resolve();
      }
    });
  }

  async function startPractice() {
    startBtn.remove();
    setControls();
    for (cursor = 0; cursor < rangeBlocks.length; cursor++) {
      if (stopped) return;
      await waitWhilePaused();
      if (stopped) return;
      skipRequested = false;
      const block = rangeBlocks[cursor];
      if (block.type === 'direction') {
        if (settings.readDirections) await playDirection(block);
        continue;
      }
      if (isMine(block)) {
        await playMyLine(block);
      } else {
        await playOtherLine(block);
      }
      if (!skipRequested) await new Promise((r) => setTimeout(r, 250));
    }
    if (!stopped) showComplete();
  }

  function showComplete() {
    controls.innerHTML = '';
    controls.style.display = 'none';
    const total = results.got + results.shaky + results.missed;
    stage.innerHTML = '';
    stage.appendChild(el('div', { class: 'stack' }, [
      el('h3', { style: 'margin:0' }, 'この出番の音声稽古は完了です'),
      total > 0 ? el('div', { class: 'row wrap' }, [
        el('span', { class: 'badge' }, `言えた ${results.got}`),
        el('span', { class: 'badge' }, `怪しい ${results.shaky}`),
        el('span', { class: 'badge' }, `出なかった ${results.missed}`),
      ]) : null,
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/practice/voice/${appearanceIndex}`; location.reload(); } }, 'もう一度'),
        el('button', { onclick: () => { location.hash = `#/script/${encodeURIComponent(scriptId)}/appearances`; } }, '出番一覧へ'),
      ]),
    ]));
  }

  return () => { stopped = true; engine.cancel(); };
}
