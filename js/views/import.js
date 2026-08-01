import { db, uid } from '../db.js';
import { el, toast, colorForIndex, escapeHtml } from '../ui.js';
import { extractFromFile, extractFromPlainText } from '../extract.js';
import { extractRoleCandidates, classifyScript, buildRawText, normalizeKey } from '../parser.js';
import { computeAppearances } from '../appearances.js';

const TYPE_LABELS = { heading: '見出し', cue: 'キュー', line: 'セリフ', direction: 'ト書き', unknown: '要確認' };

export async function renderImport(app) {
  const state = {
    step: 'source',
    sourceMethod: 'paste',
    title: '',
    revision: '',
    performanceDate: '',
    pages: [],
    candidates: [],
    groups: [],
    selections: new Map(), // name -> { included: bool, primaryName: string }
    roles: [], // { tempId, name, aliases, isMine, color }
    blocks: [],
  };

  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'back ghost', onclick: () => { location.hash = '#/'; } }, '←'),
    el('h1', {}, '台本を取り込む'),
  ]);
  const page = el('div', { class: 'page' });
  app.appendChild(topbar);
  app.appendChild(page);

  function go(step) {
    state.step = step;
    render();
  }

  function render() {
    page.innerHTML = '';
    if (state.step === 'source') page.appendChild(renderSourceStep());
    else if (state.step === 'roles') page.appendChild(renderRoleCandidateStep());
    else if (state.step === 'roleConfirm') page.appendChild(renderRoleConfirmStep());
    else if (state.step === 'fix') page.appendChild(renderFixStep());
  }

  // --- Step 1: source ------------------------------------------------

  function renderSourceStep() {
    const container = el('div', { class: 'stack' });

    const methodTabs = el('div', { class: 'file-tabs' }, [
      el('button', { class: state.sourceMethod === 'paste' ? 'primary' : '', onclick: () => { state.sourceMethod = 'paste'; render(); } }, '貼り付け'),
      el('button', { class: state.sourceMethod === 'file' ? 'primary' : '', onclick: () => { state.sourceMethod = 'file'; render(); } }, 'ファイル'),
    ]);
    container.appendChild(methodTabs);

    if (state.sourceMethod === 'paste') {
      const textarea = el('textarea', { rows: 10, placeholder: '台本のテキストをここに貼り付けてください' });
      container.appendChild(el('div', { class: 'card' }, [textarea]));
      container.appendChild(el('p', { class: 'faint' }, 'Google ドキュメントの場合は「ファイル > ダウンロード > Word (.docx) または テキスト (.txt)」で書き出してから、ファイルタブで取り込んでください。'));
      container._getPages = () => {
        if (!textarea.value.trim()) throw new Error('テキストを入力してください');
        return extractFromPlainText(textarea.value);
      };
    } else {
      const status = el('div', { class: 'faint' }, '.pdf / .docx / .txt に対応しています');
      const fileInput = el('input', { type: 'file', accept: '.pdf,.docx,.txt,.md' });
      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'dropzone' }, [fileInput]),
        status,
      ]));
      container._getPages = async () => {
        const file = fileInput.files[0];
        if (!file) throw new Error('ファイルを選択してください');
        status.textContent = '抽出中…';
        try {
          const pages = await extractFromFile(file, (i, n) => { status.textContent = `抽出中… (${i}/${n}ページ)`; });
          state.sourceFileName = file.name;
          return pages;
        } finally {
          status.textContent = '.pdf / .docx / .txt に対応しています';
        }
      };
    }

    const titleInput = el('input', { type: 'text', value: state.title, placeholder: '例）夜想曲', oninput: (e) => { state.title = e.target.value; } });
    const revisionInput = el('input', { type: 'text', value: state.revision, placeholder: '例）第3稿', oninput: (e) => { state.revision = e.target.value; } });
    const dateInput = el('input', { type: 'date', value: state.performanceDate, oninput: (e) => { state.performanceDate = e.target.value; } });

    container.appendChild(el('div', { class: 'card stack' }, [
      el('label', {}, [el('div', { class: 'faint' }, 'タイトル'), titleInput]),
      el('label', {}, [el('div', { class: 'faint' }, '稿（任意）'), revisionInput]),
      el('label', {}, [el('div', { class: 'faint' }, '本番日（任意・逆算表示に使用）'), dateInput]),
    ]));

    const nextBtn = el('button', { class: 'primary', onclick: async () => {
      try {
        nextBtn.disabled = true;
        const pages = await container._getPages();
        if (!pages.length || pages.every((p) => !p.text.trim())) {
          throw new Error('テキストを抽出できませんでした。別の形式でお試しください。');
        }
        state.pages = pages;
        const rawText = buildRawText(pages);
        const { candidates, groups } = extractRoleCandidates(rawText);
        state.candidates = candidates;
        state.groups = groups;
        state.selections = new Map();
        const grouped = new Map();
        for (const g of groups) for (const n of g) grouped.set(n, g[0]);
        for (const c of candidates) {
          state.selections.set(c.name, {
            included: c.count >= 2,
            primaryName: grouped.get(c.name) || c.name,
          });
        }
        go('roles');
      } catch (err) {
        toast(err.message);
      } finally {
        nextBtn.disabled = false;
      }
    } }, '次へ：役名を確認');

    container.appendChild(el('div', { style: 'height:80px' }));
    app.querySelector('.fab-row')?.remove();
    app.appendChild(el('div', { class: 'fab-row' }, [nextBtn]));

    return container;
  }

  // --- Step 2: role candidates ---------------------------------------

  function renderRoleCandidateStep() {
    const container = el('div', { class: 'stack' });
    container.appendChild(el('p', { class: 'faint' }, '台本から役名らしき語を自動で拾いました。役でないものは外し、表記ゆれは「表示名」を揃えてまとめてください（例：「男」「男A」を両方「男」に）。'));

    if (state.candidates.length === 0) {
      container.appendChild(el('div', { class: 'empty-state' }, '役名の候補が見つかりませんでした。次の画面で手動で追加できます。'));
    }

    for (const c of state.candidates) {
      const sel = state.selections.get(c.name);
      const checkbox = el('input', { type: 'checkbox', checked: sel.included, onchange: (e) => { sel.included = e.target.checked; } });
      const nameInput = el('input', { type: 'text', value: sel.primaryName, oninput: (e) => { sel.primaryName = e.target.value; } });
      container.appendChild(el('div', { class: 'role-candidate' }, [
        checkbox,
        el('div', { class: 'name' }, [
          el('div', {}, escapeHtml(c.name)),
          el('div', { class: 'faint' }, `出現 ${c.count}回`),
        ]),
        el('span', { class: 'faint' }, '→'),
        nameInput,
      ]));
    }

    const backBtn = el('button', { onclick: () => go('source') }, '戻る');
    const nextBtn = el('button', { class: 'primary', onclick: () => {
      const primaryNames = new Set();
      for (const c of state.candidates) {
        const sel = state.selections.get(c.name);
        if (sel.included && sel.primaryName.trim()) primaryNames.add(sel.primaryName.trim());
      }
      state.roles = [...primaryNames].map((name, i) => {
        const aliases = state.candidates
          .filter((c) => state.selections.get(c.name).included && state.selections.get(c.name).primaryName.trim() === name)
          .map((c) => c.name);
        return { tempId: uid('role'), name, aliases: [...new Set(aliases)], isMine: false, color: colorForIndex(i) };
      });
      go('roleConfirm');
    } }, '次へ：自分の役を選ぶ');

    app.querySelector('.fab-row')?.remove();
    app.appendChild(el('div', { class: 'fab-row' }, [backBtn, nextBtn]));
    return container;
  }

  // --- Step 3: confirm roles + pick "mine" ----------------------------

  function renderRoleConfirmStep() {
    const container = el('div', { class: 'stack' });
    container.appendChild(el('p', { class: 'faint' }, '自分が演じる役にチェックしてください（複数可・二役対応）。見つからない役は下から追加できます。'));

    const list = el('div', { class: 'stack' });
    function renderRoleList() {
      list.innerHTML = '';
      state.roles.forEach((role, i) => {
        const mineCheckbox = el('input', { type: 'checkbox', checked: role.isMine, onchange: (e) => { role.isMine = e.target.checked; } });
        const nameInput = el('input', { type: 'text', value: role.name, oninput: (e) => { role.name = e.target.value; } });
        const removeBtn = el('button', { class: 'ghost', onclick: () => { state.roles.splice(i, 1); renderRoleList(); } }, '削除');
        list.appendChild(el('div', { class: 'role-candidate' }, [
          el('span', { class: 'badge role', style: `background:${role.color}` }, '●'),
          mineCheckbox,
          el('div', { class: 'name' }, [
            nameInput,
            role.aliases.length > 1 ? el('div', { class: 'faint' }, `表記ゆれ: ${role.aliases.join(' / ')}`) : null,
          ]),
          removeBtn,
        ]));
      });
    }
    renderRoleList();
    container.appendChild(list);

    const addBtn = el('button', { onclick: () => {
      state.roles.push({ tempId: uid('role'), name: '', aliases: [], isMine: false, color: colorForIndex(state.roles.length) });
      renderRoleList();
    } }, '＋ 役を手動で追加');
    container.appendChild(addBtn);

    const backBtn = el('button', { onclick: () => go('roles') }, '戻る');
    const nextBtn = el('button', { class: 'primary', onclick: () => {
      state.roles = state.roles.filter((r) => r.name.trim());
      if (state.roles.length === 0) { toast('役を1つ以上登録してください'); return; }
      if (!state.roles.some((r) => r.isMine)) {
        toast('自分の役を選んでいません。あとで台本の設定タブから変更できます。');
      }
      const rolesForClassify = state.roles.map((r) => ({ id: r.tempId, name: r.name, aliases: r.aliases }));
      state.blocks = classifyScript(state.pages, rolesForClassify);
      go('fix');
    } }, '次へ：分類結果を確認');

    app.querySelector('.fab-row')?.remove();
    app.appendChild(el('div', { class: 'fab-row' }, [backBtn, nextBtn]));
    return container;
  }

  // --- Step 4: manual fix ---------------------------------------------

  function renderFixStep() {
    const container = el('div', {});
    const counts = { heading: 0, cue: 0, line: 0, direction: 0, unknown: 0 };
    for (const b of state.blocks) counts[b.type]++;

    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'row wrap' }, Object.entries(counts).map(([t, n]) => el('span', { class: 'badge' }, `${TYPE_LABELS[t]} ${n}`))),
    ]));

    let onlyIssues = counts.unknown > 0;
    const toggleLabel = el('label', { class: 'row' }, [
      el('input', { type: 'checkbox', checked: onlyIssues, onchange: (e) => { onlyIssues = e.target.checked; renderList(); } }),
      '要確認のみ表示',
    ]);
    container.appendChild(toggleLabel);

    const list = el('div', { class: 'block-list' });
    container.appendChild(list);

    function renderList() {
      list.innerHTML = '';
      state.blocks.forEach((b, idx) => {
        if (onlyIssues && !(b.type === 'unknown' || b.confidence < 0.6)) return;
        list.appendChild(renderFixRow(b, idx));
      });
      if (list.children.length === 0) {
        list.appendChild(el('div', { class: 'empty-state' }, '要確認の行はありません。'));
      }
    }

    function renderFixRow(b, idx) {
      const typeSelect = el('select', { onchange: (e) => { b.type = e.target.value; renderList(); } },
        Object.entries(TYPE_LABELS).map(([v, label]) => el('option', { value: v, selected: b.type === v }, label))
      );
      const roleSelect = b.type === 'line' ? el('select', { onchange: (e) => { b.roleIds = [e.target.value]; } }, [
        el('option', { value: '', selected: !b.roleIds || !b.roleIds.length }, '（役を選択）'),
        ...state.roles.map((r) => el('option', { value: r.tempId, selected: !!(b.roleIds && b.roleIds.includes(r.tempId)) }, r.name)),
      ]) : null;
      const textArea = el('textarea', { rows: b.text.length > 40 ? 3 : 1, oninput: (e) => { b.text = e.target.value; } }, b.text);

      return el('div', { class: `card ${b.confidence < 0.6 ? 'block unknown' : ''}` }, [
        el('div', { class: 'row wrap', style: 'margin-bottom:8px' }, [
          el('span', { class: 'page-tag' }, `p.${b.page}`),
          typeSelect,
          roleSelect,
        ]),
        textArea,
      ]);
    }

    renderList();

    const backBtn = el('button', { onclick: () => go('roleConfirm') }, '戻る');
    const saveBtn = el('button', { class: 'primary', onclick: async () => {
      saveBtn.disabled = true;
      try {
        await saveScript();
      } catch (err) {
        toast('保存に失敗しました: ' + err.message);
        saveBtn.disabled = false;
      }
    } }, '保存する');

    app.querySelector('.fab-row')?.remove();
    app.appendChild(el('div', { class: 'fab-row' }, [backBtn, saveBtn]));
    return container;
  }

  async function saveScript() {
    const scriptId = uid('script');
    const rawText = buildRawText(state.pages);
    const script = {
      id: scriptId,
      title: state.title.trim() || '無題の台本',
      revision: state.revision.trim(),
      sourceType: state.sourceMethod === 'paste' ? 'paste' : (state.sourceFileName || '').split('.').pop() || 'txt',
      sourceFileName: state.sourceFileName,
      rawText,
      pageBreaks: [],
      createdAt: Date.now(),
      performanceDate: state.performanceDate ? new Date(state.performanceDate).getTime() : undefined,
    };

    const roleIdMap = new Map();
    const roles = state.roles.map((r) => {
      const id = uid('role');
      roleIdMap.set(r.tempId, id);
      return { id, scriptId, name: r.name, aliases: r.aliases, isMine: r.isMine, color: r.color };
    });

    const blocks = state.blocks.map((b) => ({
      id: uid('block'),
      scriptId,
      order: b.order,
      page: b.page,
      type: b.type,
      roleIds: b.roleIds ? b.roleIds.map((tid) => roleIdMap.get(tid)).filter(Boolean) : undefined,
      text: b.text,
      inlineDirections: b.inlineDirections || [],
      srcStart: b.srcStart,
      srcEnd: b.srcEnd,
      confidence: b.confidence,
    }));

    const myRoleIds = roles.filter((r) => r.isMine).map((r) => r.id);
    const appearanceRanges = computeAppearances(blocks, myRoleIds);
    const appearances = appearanceRanges.map((a) => ({ id: uid('appear'), scriptId, ...a }));

    await db.put('scripts', script);
    await db.putMany('roles', roles);
    await db.putMany('blocks', blocks);
    await db.putMany('appearances', appearances);

    toast('台本を保存しました');
    location.hash = `#/script/${encodeURIComponent(scriptId)}`;
  }

  render();
  return () => {};
}
