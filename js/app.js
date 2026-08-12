import { renderHome } from './views/home.js';
import { renderImport } from './views/import.js';
import { renderScriptDetail } from './views/scriptDetail.js';
import { renderSceneNotes } from './views/sceneNotes.js';
import { renderPracticeMask } from './views/practiceMask.js';
import { renderPracticeVoice } from './views/practiceVoice.js';
import { renderReviewBlocks } from './views/reviewBlocks.js';

const app = document.getElementById('app');

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  return parts;
}

let currentCleanup = null;

// Remembers how far down each hash was scrolled, so going back to a list
// (出番一覧 after マスク稽古, say) restores where the reader left off instead
// of dumping them back at the top. Keyed by the exact hash, so it only ever
// restores a genuine revisit — any other hash still opens at the top below.
let lastHash = location.hash;
const scrollPositions = new Map();

async function route() {
  scrollPositions.set(lastHash, window.scrollY);
  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch (e) { /* noop */ }
  }
  currentCleanup = null;
  app.innerHTML = '';
  const parts = parseRoute();

  try {
    if (parts.length === 0) {
      currentCleanup = await renderHome(app);
    } else if (parts[0] === 'import') {
      currentCleanup = await renderImport(app);
    } else if (parts[0] === 'script' && parts[1]) {
      const scriptId = decodeURIComponent(parts[1]);
      if (parts[2] === 'scene' && parts[3]) {
        currentCleanup = await renderSceneNotes(app, scriptId, decodeURIComponent(parts[3]));
      } else if (parts[2] === 'review') {
        currentCleanup = await renderReviewBlocks(app, scriptId);
      } else if (parts[2] === 'practice' && parts[3] === 'mask' && parts[4] !== undefined) {
        currentCleanup = await renderPracticeMask(app, scriptId, Number(parts[4]));
      } else if (parts[2] === 'practice' && parts[3] === 'voice' && parts[4] !== undefined) {
        currentCleanup = await renderPracticeVoice(app, scriptId, Number(parts[4]));
      } else {
        // #/script/{id}/view/{blockId} — open the script scrolled to one line.
        const focusBlockId = parts[3] ? decodeURIComponent(parts[3]) : null;
        currentCleanup = await renderScriptDetail(app, scriptId, parts[2] || 'appearances', focusBlockId);
      }
    } else {
      app.appendChild(document.createTextNode('ページが見つかりません'));
    }
  } catch (err) {
    console.error(err);
    app.innerHTML = '';
    app.appendChild(document.createElement('div')).textContent = `エラーが発生しました: ${err.message}`;
  }
  lastHash = location.hash;
  window.scrollTo(0, scrollPositions.get(lastHash) || 0);
}

// Module scripts execute after the document has been parsed (like <script defer>),
// so the DOM is always ready here — no need to also wait for DOMContentLoaded.
window.addEventListener('hashchange', route);
route();
