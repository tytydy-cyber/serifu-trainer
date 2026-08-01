// SpeechEngine: thin abstraction over the Web Speech API so the backing
// implementation can later be swapped for pre-rendered audio files without
// touching call sites.

let cachedVoices = null;
let voicesPromise = null;

export function getVoices() {
  if (cachedVoices) return Promise.resolve(cachedVoices);
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise((resolve) => {
    const existing = speechSynthesis.getVoices();
    if (existing.length > 0) {
      cachedVoices = existing;
      resolve(existing);
      return;
    }
    const handler = () => {
      const v = speechSynthesis.getVoices();
      if (v.length > 0) {
        cachedVoices = v;
        speechSynthesis.removeEventListener('voiceschanged', handler);
        resolve(v);
      }
    };
    speechSynthesis.addEventListener('voiceschanged', handler);
    setTimeout(() => {
      const v = speechSynthesis.getVoices();
      cachedVoices = v;
      resolve(v);
    }, 1500);
  });
  return voicesPromise;
}

export async function isJapaneseTtsAvailable() {
  const voices = await getVoices();
  return voices.some((v) => v.lang && v.lang.toLowerCase().startsWith('ja'));
}

function splitForSpeech(text, maxLen = 90) {
  const sentences = text.split(/(?<=[。！？])/);
  const chunks = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > maxLen && buf) {
      chunks.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text];
}

export class SpeechEngine {
  constructor() {
    this.cancelled = false;
  }

  // text: string (parens-stripped by caller if needed)
  // opts: { voiceURI, rate = 1, pitch = 1 }
  speak(text, opts = {}) {
    return new Promise(async (resolve, reject) => {
      if (!('speechSynthesis' in window)) {
        reject(new Error('この端末は音声合成に対応していません'));
        return;
      }
      this.cancelled = false;
      const voices = await getVoices();
      const voice = opts.voiceURI ? voices.find((v) => v.voiceURI === opts.voiceURI) : null;
      const chunks = splitForSpeech(text);

      const speakChunk = (i) => {
        if (this.cancelled) {
          resolve();
          return;
        }
        if (i >= chunks.length) {
          resolve();
          return;
        }
        const u = new SpeechSynthesisUtterance(chunks[i]);
        if (voice) u.voice = voice;
        u.lang = (voice && voice.lang) || 'ja-JP';
        u.rate = opts.rate || 1;
        u.pitch = opts.pitch || 1;
        u.onend = () => speakChunk(i + 1);
        u.onerror = (e) => {
          if (e.error === 'canceled' || e.error === 'interrupted') resolve();
          else reject(e);
        };
        speechSynthesis.speak(u);
      };
      speakChunk(0);
    });
  }

  cancel() {
    this.cancelled = true;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}

export function stripDirectionsForSpeech(text, inlineDirections) {
  if (!inlineDirections || inlineDirections.length === 0) return text;
  let out = '';
  let last = 0;
  for (const { start, end } of inlineDirections) {
    out += text.slice(last, start);
    const dir = text.slice(start, end);
    if (/間/.test(dir)) out += '、、、';
    last = end;
  }
  out += text.slice(last);
  return out;
}
