import { db } from './db.js';

const DAY = 24 * 60 * 60 * 1000;
const INTERVALS = [3 * DAY, 7 * DAY, 14 * DAY];

export async function getProgress(blockId) {
  return (await db.get('progress', blockId)) || {
    blockId,
    status: 'unseen',
    streak: 0,
    attempts: 0,
    lastReviewedAt: 0,
    dueAt: 0,
  };
}

export async function recordResult(blockId, result) {
  const p = await getProgress(blockId);
  p.attempts += 1;
  p.lastReviewedAt = Date.now();

  if (result === 'got') {
    p.streak += 1;
    p.status = 'got';
    const interval = INTERVALS[Math.min(p.streak - 1, INTERVALS.length - 1)];
    p.dueAt = Date.now() + interval;
  } else if (result === 'shaky') {
    p.streak = 0;
    p.status = 'shaky';
    p.dueAt = Date.now() + DAY;
  } else {
    p.streak = 0;
    p.status = 'missed';
    p.dueAt = Date.now(); // due immediately (same-session retry)
  }
  await db.put('progress', p);
  return p;
}

export async function progressForBlocks(blockIds) {
  const map = new Map();
  for (const id of blockIds) {
    map.set(id, await getProgress(id));
  }
  return map;
}

export function summarize(progressList) {
  const counts = { unseen: 0, missed: 0, shaky: 0, got: 0 };
  for (const p of progressList) counts[p.status]++;
  const total = progressList.length || 1;
  return { counts, total, gotRatio: counts.got / total };
}

// Carries a block's practice history across a revision. An untouched line
// (still 'unseen') has nothing worth copying. A reworded line keeps its
// attempt count but is demoted to 'shaky' — the wording changed, so the old
// streak toward a longer review interval no longer means the actor knows
// *this* phrasing.
export function carryOverProgress(oldProgress, newBlockId, { modified }) {
  if (!oldProgress || oldProgress.attempts === 0) return null;
  if (modified) {
    return {
      blockId: newBlockId,
      status: 'shaky',
      streak: 0,
      attempts: oldProgress.attempts,
      lastReviewedAt: oldProgress.lastReviewedAt,
      dueAt: Date.now() + DAY,
    };
  }
  return { ...oldProgress, blockId: newBlockId };
}
