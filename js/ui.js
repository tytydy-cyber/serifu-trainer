export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

export function toast(msg, ms = 2200) {
  const node = el('div', { class: 'toast' }, msg);
  document.body.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

const PALETTE = ['#e0a45c', '#6fb3d9', '#c07ad9', '#7ad9a0', '#d97a9b', '#d9c26f', '#8a9fd9'];
export function colorForIndex(i) {
  return PALETTE[i % PALETTE.length];
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export async function confirmDialog(message) {
  return window.confirm(message);
}

const scriptLoadPromises = new Map();
export function loadVendorScript(src) {
  if (scriptLoadPromises.has(src)) return scriptLoadPromises.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`スクリプトの読み込みに失敗しました: ${src}`));
    document.head.appendChild(s);
  });
  scriptLoadPromises.set(src, p);
  return p;
}
