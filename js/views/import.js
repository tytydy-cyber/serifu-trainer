import { db, uid } from '../db.js';
import { el, toast, colorForIndex } from '../ui.js';
import { extractFromFile, extractFromPlainText, detectEncodingIssue } from '../extract.js';
import { extractRoleCandidates, extractCastList, classifyScript, buildRawText } from '../parser.js';
import { computeAppearances } from '../appearances.js';
import { computeRevisionDiff } from '../diff.js';
import { getProgress, carryOverProgress } from '../progress.js';

const TYPE_LABELS = { heading: '見出し', cue: 'キュー', line: 'セリフ', direction: 'ト書き', unknown: '要確認' };

const STEPS = [
  { id: 'source', label: '台本を読み込む' },
  { id: 'roles', label: '役名を確認' },
  { id: 'roleConfirm', label: '自分の役' },
  { id: 'fix', label: '仕上げ' },
];

export async function renderImport(app) {
  const existingScripts = (await db.all('scripts')).sort((a, b) => b.createdAt - a.createdAt);

  const state = {
    step: 'source',
    sourceMethod: 'file',
    title: '',
    revision: '',
    performanceDate: '',
    parentScriptId: null,
    pages: [],
    castNames: [],
    castPages: [],
    hasCastList: false,
    candidates: [],
    groups: [],
    selections: new Map(), // name -> { included, primaryName }
    roles: [],
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
    window.scrollTo(0, 0);
  }

  function stepHeader() {
    const idx = STEPS.findIndex((s) => s.id === state.step);
    return el('div', { class: 'step-header' }, [
      el('div', { class: 'step-dots' }, STEPS.map((s, i) => el('span', {
        class: `step-dot ${i < idx ? 'done' : ''} ${i === idx ? 'current' : ''}`,
      }))),
      el('div', { class: 'step-title' }, `ステップ ${idx + 1} / ${STEPS.length}　${STEPS[idx].label}`),
    ]);
  }

  function render() {
    page.innerHTML = '';
    page.appendChild(stepHeader());
    if (state.step === 'source') page.appendChild(renderSourceStep());
    else if (state.step === 'roles') page.appendChild(renderRoleCandidateStep());
    else if (state.step === 'roleConfirm') page.appendChild(renderRoleConfirmStep());
    else if (state.step === 'fix') page.appendChild(renderFixStep());
  }

  function setFooter(buttons) {
    app.querySelector('.fab-row')?.remove();
    app.appendChild(el('div', { class: 'fab-row' }, buttons));
  }

  // --- Step 1: source ------------------------------------------------

  function renderSourceStep() {
    const container = el('div', { class: 'stack' });

    container.appendChild(el('p', { class: 'lead' },
      '脚本のファイルを選ぶと、役名・セリフ・ト書きを自動で読み取ります。読み取った内容は次の画面で確認・修正できます。'));
    container.appendChild(el('p', { class: 'faint' },
      '台本はこの端末の中だけに保存されます。インターネットに送信されることはありません。'));

    const methodTabs = el('div', { class: 'file-tabs' }, [
      el('button', { class: state.sourceMethod === 'file' ? 'primary' : '', onclick: () => { state.sourceMethod = 'file'; render(); } }, 'ファイルから'),
      el('button', { class: state.sourceMethod === 'paste' ? 'primary' : '', onclick: () => { state.sourceMethod = 'paste'; render(); } }, '文字を貼り付け'),
    ]);
    container.appendChild(methodTabs);

    const warnBox = el('div', {});
    container.appendChild(warnBox);

    if (state.sourceMethod === 'file') {
      const status = el('div', { class: 'faint', style: 'text-align:center' }, '');
      const fileName = el('div', { class: 'file-name' }, '');
      const fileInput = el('input', {
        type: 'file',
        accept: '.pdf,.docx,.txt,.md',
        class: 'visually-hidden',
        onchange: () => {
          const f = fileInput.files[0];
          fileName.textContent = f ? f.name : '';
          fileName.classList.toggle('has-file', !!f);
        },
      });
      const pickBtn = el('button', { class: 'file-pick', onclick: () => fileInput.click() }, '📄 ファイルを選ぶ');

      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'dropzone' }, [
          fileInput,
          pickBtn,
          fileName,
          el('div', { class: 'faint', style: 'margin-top:10px' }, 'PDF / Word (.docx) / テキスト (.txt) に対応'),
        ]),
        status,
      ]));
      container.appendChild(el('div', { class: 'note' }, [
        el('strong', {}, 'Google ドキュメントの台本のとき'),
        el('div', {}, 'ドキュメントを開き「ファイル → ダウンロード → Word (.docx)」で保存してから、そのファイルを選んでください。'),
      ]));

      container._getPages = async () => {
        const file = fileInput.files[0];
        if (!file) throw new Error('台本のファイルを選んでください');
        status.textContent = '読み取り中…';
        try {
          const pages = await extractFromFile(file, (i, n) => { status.textContent = `読み取り中… (${i}/${n}ページ)`; });
          state.sourceFileName = file.name;
          if (!state.title.trim()) state.title = file.name.replace(/\.[^.]+$/, '');
          return pages;
        } finally {
          status.textContent = '';
        }
      };
    } else {
      const textarea = el('textarea', { rows: 10, placeholder: '台本の本文をここに貼り付けてください' });
      container.appendChild(el('div', { class: 'card' }, [textarea]));
      container.appendChild(el('p', { class: 'faint' }, 'ファイルがうまく読み取れないときは、本文をコピーしてここに貼り付けると確実です。'));
      container._getPages = () => {
        if (!textarea.value.trim()) throw new Error('台本の本文を貼り付けてください');
        return extractFromPlainText(textarea.value);
      };
    }

    const titleInput = el('input', { type: 'text', value: state.title, placeholder: '例）宇宙論ラーメン', oninput: (e) => { state.title = e.target.value; } });
    const revisionInput = el('input', { type: 'text', value: state.revision, placeholder: '例）第3稿', oninput: (e) => { state.revision = e.target.value; } });
    const dateInput = el('input', { type: 'date', value: state.performanceDate, oninput: (e) => { state.performanceDate = e.target.value; } });

    container.appendChild(el('div', { class: 'card stack' }, [
      el('label', {}, [el('div', { class: 'field-label' }, 'タイトル'), titleInput,
        el('div', { class: 'faint' }, '空欄ならファイル名がそのまま使われます')]),
      el('label', {}, [el('div', { class: 'field-label' }, '稿（任意）'), revisionInput,
        el('div', { class: 'faint' }, '稿が変わったときに見分けるための覚え書きです')]),
      el('label', {}, [el('div', { class: 'field-label' }, '本番日（任意）'), dateInput,
        el('div', { class: 'faint' }, '入れておくと「本番まであと何日」が表示されます')]),
    ]));

    if (existingScripts.length) {
      const parentSelect = el('select', {
        onchange: (e) => { state.parentScriptId = e.target.value || null; },
      }, [
        el('option', { value: '' }, 'なし（新しい台本として取り込む）'),
        ...existingScripts.map((s) => el('option', {
          value: s.id,
          selected: state.parentScriptId === s.id,
        }, `${s.title}${s.revision ? `（${s.revision}）` : ''}`)),
      ]);
      container.appendChild(el('div', { class: 'card stack' }, [
        el('label', {}, [
          el('div', { class: 'field-label' }, '改訂元の台本（任意）'),
          parentSelect,
          el('div', { class: 'faint' }, '台本が改訂されたときに選ぶと、変わらなかったセリフの稽古記録を引き継ぎ、変わった箇所だけをあとで確認できます。'),
        ]),
      ]));
    }

    container.appendChild(el('div', { style: 'height:70px' }));

    const nextBtn = el('button', { class: 'primary', onclick: async () => {
      warnBox.innerHTML = '';
      try {
        nextBtn.disabled = true;
        nextBtn.textContent = '読み取り中…';
        const pages = await container._getPages();
        if (!pages.length || pages.every((p) => !p.text.trim())) {
          const err = new Error('文字が見つかりませんでした');
          err.isImagePdf = true;
          throw err;
        }
        state.pages = pages;
        state.encodingIssue = detectEncodingIssue(pages);
        const cast = extractCastList(pages);
        state.castNames = cast.names;
        state.castPages = cast.pages;
        const { candidates, groups, hasCastList } = extractRoleCandidates(pages, cast.names, { skipPages: cast.pages });
        state.candidates = candidates;
        state.groups = groups;
        state.hasCastList = hasCastList;
        state.selections = new Map();
        const grouped = new Map();
        for (const g of groups) for (const n of g) grouped.set(n, g[0]);
        for (const c of candidates) {
          state.selections.set(c.name, {
            included: c.defaultInclude,
            primaryName: grouped.get(c.name) || c.name,
          });
        }
        go('roles');
      } catch (err) {
        if (err.isImagePdf) {
          warnBox.appendChild(el('div', { class: 'note warn' }, [
            el('strong', {}, 'このPDFは画像として保存されているようです'),
            el('div', {}, '見た目には文字がありますが、スキャンした紙や写真をそのままPDFにしたファイルは、内部的には「絵」として保存されていて、文字のデータが入っていません。そのため自動では読み取れません。'),
            el('div', { style: 'margin-top:6px' }, '元になった文字データ（Wordファイルなど）があれば、そちらから取り込んでください。無い場合は、Macの「プレビュー」アプリでこのPDFを開いて本文を選択・コピーするか、Googleドライブにアップロードして開くと自動で文字認識されるので、それを上の「文字を貼り付け」に貼り付けてください。'),
          ]));
        } else {
          toast(err.message);
        }
      } finally {
        nextBtn.disabled = false;
        nextBtn.textContent = '読み取って次へ →';
      }
    } }, '読み取って次へ →');

    setFooter([nextBtn]);
    return container;
  }

  // --- Step 2: role candidates ---------------------------------------

  function renderRoleCandidateStep() {
    const container = el('div', { class: 'stack' });

    if (state.encodingIssue?.suspicious) {
      container.appendChild(el('div', { class: 'note warn' }, [
        el('strong', {}, 'このPDFは一部の文字が正しく読み取れていない可能性があります'),
        el('div', {}, `「っ」「ー」などの文字が、埋め込みフォントの不具合でまれに別の文字（${state.encodingIssue.samples.map((s) => `「${s}」`).join('・')} など）に化けて読み取られています。見た目は正しく表示されているPDFでも、内部の文字データだけがずれていることがあります。`),
        el('div', { style: 'margin-top:6px' }, '元がGoogleドキュメントやWordなら、そちらから「.docx」または「.txt」で書き出して取り込み直すと直ります。'),
      ]));
    }

    if (state.hasCastList) {
      container.appendChild(el('div', { class: 'note ok' }, [
        el('strong', {}, `冒頭の登場人物表から ${state.castNames.length} 名を読み取りました`),
        el('div', {}, '登場人物表に載っている役は、あらかじめチェックを入れてあります。そのままで問題なければ次に進んでください。'),
      ]));
    } else {
      container.appendChild(el('div', { class: 'note warn' }, [
        el('strong', {}, '登場人物表が見つかりませんでした'),
        el('div', {}, '本文の書かれ方から役名を推測しています。実際の役でないものが混ざっていることがあるので、チェックを見直してください。'),
      ]));
    }

    container.appendChild(el('p', { class: 'lead' },
      '役名を確認します。役でないものはチェックを外し、同じ役の言い換え（例：「男」と「男Ａ」）は右の表示名を同じ文字にすると、ひとつの役にまとまります。'));

    if (state.candidates.length === 0) {
      container.appendChild(el('div', { class: 'empty-state' }, '役名の候補が見つかりませんでした。次の画面で手動で追加できます。'));
    }

    const listed = state.candidates.filter((c) => !state.hasCastList || c.inCast);
    const unlisted = state.candidates.filter((c) => state.hasCastList && !c.inCast);

    const makeRow = (c) => {
      const sel = state.selections.get(c.name);
      const checkbox = el('input', { type: 'checkbox', checked: sel.included, onchange: (e) => { sel.included = e.target.checked; } });
      const nameInput = el('input', { type: 'text', value: sel.primaryName, oninput: (e) => { sel.primaryName = e.target.value; } });
      const label = el('label', { class: 'role-candidate' }, [
        checkbox,
        el('div', { class: 'name' }, [
          el('div', {}, c.name),
          el('div', { class: 'faint' }, c.onlyOnce
            ? `セリフ ${c.count} 回　・　1回しか登場しないため既定ではチェックを外しています`
            : `セリフ ${c.count} 回`),
        ]),
        el('span', { class: 'faint' }, '→'),
        nameInput,
      ]);
      const occurrences = c.occurrences && c.occurrences.length
        ? el('details', { class: 'role-occurrences' }, [
            el('summary', {}, `台本内の登場箇所を見る（${c.occurrences.length}件${c.occurrences.length < c.count ? '・先頭のみ' : ''}）`),
            el('div', {}, c.occurrences.map((o) => el('div', { class: 'role-occurrence-row' }, `p.${o.page}　${o.text}`))),
          ])
        : null;
      return occurrences ? el('div', {}, [label, occurrences]) : label;
    };

    if (listed.length) {
      container.appendChild(el('h3', { class: 'section-title' },
        state.hasCastList ? '登場人物表にある役' : '見つかった役名の候補'));
      for (const c of listed) container.appendChild(makeRow(c));
    }

    if (unlisted.length) {
      container.appendChild(el('h3', { class: 'section-title warn-title' }, '⚠ 登場人物表に無い候補'));
      container.appendChild(el('p', { class: 'faint' },
        '本文からは役名らしく見えましたが、冒頭の登場人物表には載っていませんでした。歌詞やセリフの一部を役名と読み違えている可能性が高いので、既定ではチェックを外してあります。「一同」「全員」など表に書かれない役のこともあるので、必要ならチェックを入れてください。'));
      for (const c of unlisted) container.appendChild(makeRow(c));
    }

    container.appendChild(el('div', { style: 'height:70px' }));

    setFooter([
      el('button', { onclick: () => go('source') }, '← 戻る'),
      el('button', { class: 'primary', onclick: () => {
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
        if (state.roles.length === 0) { toast('役を1つ以上チェックしてください'); return; }
        go('roleConfirm');
      } }, '次へ →'),
    ]);
    return container;
  }

  // --- Step 3: confirm roles + pick "mine" ----------------------------

  function renderRoleConfirmStep() {
    const container = el('div', { class: 'stack' });
    container.appendChild(el('p', { class: 'lead' },
      'あなたが演じる役にチェックを入れてください。ここで選んだ役のセリフが、稽古のときに隠されます。'));
    container.appendChild(el('p', { class: 'faint' },
      '一人で二役を演じる場合は、両方にチェックを入れてください。あとから「設定」タブで変更できます。'));

    const list = el('div', { class: 'stack' });
    function renderRoleList() {
      list.innerHTML = '';
      state.roles.forEach((role, i) => {
        const mineCheckbox = el('input', { type: 'checkbox', checked: role.isMine, onchange: (e) => { role.isMine = e.target.checked; } });
        const nameInput = el('input', { type: 'text', value: role.name, oninput: (e) => { role.name = e.target.value; } });
        const removeBtn = el('button', { class: 'ghost remove', onclick: () => { state.roles.splice(i, 1); renderRoleList(); } }, '削除');
        list.appendChild(el('div', { class: 'role-row' }, [
          el('div', { class: 'role-row-main' }, [
            el('span', { class: 'role-dot', style: `background:${role.color}` }),
            nameInput,
            removeBtn,
          ]),
          el('div', { class: 'role-row-sub' }, [
            el('label', { class: 'mine-check' }, [mineCheckbox, '自分が演じる役']),
            role.aliases.length > 1 ? el('div', { class: 'faint' }, `まとめた表記: ${role.aliases.join(' / ')}`) : null,
          ]),
        ]));
      });
    }
    renderRoleList();
    container.appendChild(list);

    container.appendChild(el('button', { onclick: () => {
      state.roles.push({ tempId: uid('role'), name: '', aliases: [], isMine: false, color: colorForIndex(state.roles.length) });
      renderRoleList();
    } }, '＋ 役を手動で追加'));

    container.appendChild(el('div', { style: 'height:70px' }));

    setFooter([
      el('button', { onclick: () => go('roles') }, '← 戻る'),
      el('button', { class: 'primary', onclick: () => {
        state.roles = state.roles.filter((r) => r.name.trim());
        if (state.roles.length === 0) { toast('役を1つ以上登録してください'); return; }
        if (!state.roles.some((r) => r.isMine)) {
          toast('自分の役が選ばれていません。あとで設定タブから変更できます。');
        }
        const rolesForClassify = state.roles.map((r) => ({ id: r.tempId, name: r.name, aliases: r.aliases }));
        // Every name the wizard ever suspected of being a role, whether the
        // reader kept it checked or not — a walk-on part's line still has to
        // be recognized as a fresh speech rather than swallowed into whoever
        // spoke before it. See looksLikeFreshSpeaker in parser.js.
        const knownNames = new Set(state.candidates.map((c) => c.name));
        state.blocks = classifyScript(state.pages, rolesForClassify, { frontMatterPages: state.castPages, knownNames });
        go('fix');
      } }, '読み取り結果を見る →'),
    ]);
    return container;
  }

  // --- Step 4: manual fix ---------------------------------------------

  function renderFixStep() {
    const container = el('div', {});
    const counts = { heading: 0, cue: 0, line: 0, direction: 0, unknown: 0 };
    for (const b of state.blocks) counts[b.type]++;

    container.appendChild(el('p', { class: 'lead' },
      '読み取り結果です。このまま保存しても使えます。おかしな行があれば、種類や役をその場で直せます。'));
    container.appendChild(el('p', { class: 'faint' },
      'ボタンをタップすると、その種類だけに絞り込めます。「要確認」は、役のセリフともト書きとも判断できなかった行で、多くはタイトルや登場人物表など本文以外の部分です。前後の行も薄く表示します。'));

    const countsRow = el('div', { class: 'row wrap' });
    container.appendChild(el('div', { class: 'card' }, [countsRow]));

    let typeFilter = counts.unknown > 0 ? 'unknown' : null;

    const list = el('div', { class: 'block-list' });
    container.appendChild(list);

    const CONTEXT = 2; // lines of surrounding context shown around each flagged row

    function isIssue(b) { return b.type === 'unknown' || b.confidence < 0.6; }

    function renderCounts() {
      countsRow.innerHTML = '';
      for (const [t, n] of Object.entries(counts)) {
        countsRow.appendChild(el('button', {
          class: `badge type-filter-btn ${typeFilter === t ? 'active' : ''}`,
          onclick: () => { typeFilter = typeFilter === t ? null : t; renderList(); },
        }, `${TYPE_LABELS[t]} ${n}`));
      }
    }

    function renderList() {
      renderCounts();
      list.innerHTML = '';
      if (typeFilter !== 'unknown') {
        const filtered = typeFilter ? state.blocks.filter((b) => b.type === typeFilter) : state.blocks;
        filtered.forEach((b) => list.appendChild(renderFixRow(b)));
        if (list.children.length === 0) {
          list.appendChild(el('div', { class: 'empty-state' }, typeFilter ? '該当する行はありません。' : '直すべき行はありません。そのまま保存できます。'));
        }
        return;
      }

      const flaggedIdx = [];
      state.blocks.forEach((b, i) => { if (isIssue(b)) flaggedIdx.push(i); });
      if (flaggedIdx.length === 0) {
        list.appendChild(el('div', { class: 'empty-state' }, '直すべき行はありません。そのまま保存できます。'));
        return;
      }

      let lastShownIdx = -1;
      for (const idx of flaggedIdx) {
        const from = Math.max(0, idx - CONTEXT);
        const to = Math.min(state.blocks.length - 1, idx + CONTEXT);
        if (lastShownIdx >= 0 && from > lastShownIdx + 1) {
          list.appendChild(el('div', { class: 'faint', style: 'text-align:center;margin:14px 0' }, '……'));
        }
        const start = Math.max(from, lastShownIdx + 1);
        for (let i = start; i <= to; i++) {
          if (i === idx) list.appendChild(renderFixRow(state.blocks[i]));
          else if (i > lastShownIdx) list.appendChild(renderContextRow(state.blocks[i]));
        }
        lastShownIdx = Math.max(lastShownIdx, to);
      }
    }

    function renderContextRow(b) {
      return el('div', { class: 'faint', style: 'padding:6px 12px;font-size:14px;line-height:1.6' }, [
        el('span', { class: 'page-tag' }, `p.${b.page}　`),
        el('span', {}, `[${TYPE_LABELS[b.type]}] `),
        b.text || '（空行）',
      ]);
    }

    function renderFixRow(b) {
      const typeSelect = el('select', { onchange: (e) => { b.type = e.target.value; renderList(); } },
        Object.entries(TYPE_LABELS).map(([v, label]) => el('option', { value: v, selected: b.type === v }, label))
      );
      const roleSelect = b.type === 'line' ? el('select', { onchange: (e) => { b.roleIds = [e.target.value]; } }, [
        el('option', { value: '', selected: !b.roleIds || !b.roleIds.length }, '（役を選ぶ）'),
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
    container.appendChild(el('div', { style: 'height:70px' }));

    const saveBtn = el('button', { class: 'primary', onclick: async () => {
      saveBtn.disabled = true;
      try {
        await saveScript();
      } catch (err) {
        toast('保存に失敗しました: ' + err.message);
        saveBtn.disabled = false;
      }
    } }, '保存して始める');

    setFooter([
      el('button', { onclick: () => go('roleConfirm') }, '← 戻る'),
      saveBtn,
    ]);
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

    let progressToSave = [];
    if (state.parentScriptId) {
      const parentBlocks = (await db.byIndex('blocks', 'scriptId', state.parentScriptId)).sort((a, b) => a.order - b.order);
      const parentRoles = await db.byIndex('roles', 'scriptId', state.parentScriptId);
      const lineBlocks = blocks.filter((b) => b.type === 'line');
      if (parentBlocks.length && lineBlocks.length) {
        const { newBlockStatus, deletedOldBlockIds } = computeRevisionDiff(parentRoles, parentBlocks, roles, blocks);
        const addedBlockIds = [];
        const modifiedPairs = [];
        let unchangedCount = 0;
        for (const b of lineBlocks) {
          const info = newBlockStatus.get(b.id);
          if (!info) continue;
          if (info.status === 'unchanged') {
            unchangedCount++;
            const oldP = await getProgress(info.matchedOldBlockId);
            const carried = carryOverProgress(oldP, b.id, { modified: false });
            if (carried) progressToSave.push(carried);
          } else if (info.status === 'modified') {
            modifiedPairs.push({ newBlockId: b.id, oldBlockId: info.matchedOldBlockId });
            const oldP = await getProgress(info.matchedOldBlockId);
            const carried = carryOverProgress(oldP, b.id, { modified: true });
            if (carried) progressToSave.push(carried);
          } else {
            addedBlockIds.push(b.id);
          }
        }
        const parentLineIds = new Set(parentBlocks.filter((b) => b.type === 'line').map((b) => b.id));
        const deletedCount = deletedOldBlockIds.filter((id) => parentLineIds.has(id)).length;

        script.parentScriptId = state.parentScriptId;
        script.revisionDiff = {
          parentScriptId: state.parentScriptId,
          addedCount: addedBlockIds.length,
          modifiedCount: modifiedPairs.length,
          unchangedCount,
          deletedCount,
          addedBlockIds,
          modifiedPairs,
        };
      }
    }

    await db.put('scripts', script);
    await db.putMany('roles', roles);
    await db.putMany('blocks', blocks);
    await db.putMany('appearances', appearances);
    if (progressToSave.length) await db.putMany('progress', progressToSave);

    if (script.revisionDiff) {
      const d = script.revisionDiff;
      toast(`改訂版として保存しました（変更 ${d.modifiedCount}・追加 ${d.addedCount}・削除 ${d.deletedCount}）`);
    } else {
      toast('台本を保存しました');
    }
    location.hash = `#/script/${encodeURIComponent(scriptId)}`;
  }

  render();
  return () => { app.querySelector('.fab-row')?.remove(); };
}
