// Revision diff: matches blocks between an old script and a newly imported
// revision, so progress can carry over and only what actually changed needs
// re-learning. Runs entirely client-side on the already-parsed block lists.
import { normalizeKey } from './parser.js';

function roleKey(block, roleMap) {
  return (block.roleIds || [])
    .map((id) => normalizeKey(roleMap.get(id)?.name || ''))
    .sort()
    .join(',');
}

function blockSignature(block, roleMap) {
  return `${block.type}|${roleKey(block, roleMap)}|${normalizeKey(block.text || '')}`;
}

// Plain O(N*M) LCS over signature arrays. Script block counts are in the
// low thousands at most, so the DP table (a few tens of MB) and the
// resulting sub-second computation are both acceptable for a one-off
// import-time step.
function lcsOps(oldSigs, newSigs) {
  const m = oldSigs.length;
  const n = newSigs.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    for (let j = n - 1; j >= 0; j--) {
      row[j] = oldSigs[i] === newSigs[j]
        ? nextRow[j + 1] + 1
        : Math.max(nextRow[j], row[j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldSigs[i] === newSigs[j]) {
      ops.push({ type: 'equal', oldIndex: i, newIndex: j });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', oldIndex: i });
      i++;
    } else {
      ops.push({ type: 'insert', newIndex: j });
      j++;
    }
  }
  while (i < m) { ops.push({ type: 'delete', oldIndex: i }); i++; }
  while (j < n) { ops.push({ type: 'insert', newIndex: j }); j++; }
  return ops;
}

// Compares the old and new block sequences and classifies every new block as
// unchanged / modified / added, plus which old blocks were dropped.
//
// A plain LCS only ever produces "equal" / "delete" / "insert": an edited
// line looks identical to an unrelated delete+insert pair. The pairing pass
// below turns a delete+insert of the *same role*, adjacent in the same
// replace hunk, into "modified" — which is what actually happened when a
// line is reworded during revision.
//
// Returns { newBlockStatus: Map<newBlockId, {status, matchedOldBlockId}>,
//           deletedOldBlockIds: string[] }
export function diffScripts(oldBlocks, oldRoleMap, newBlocks, newRoleMap) {
  const oldSigs = oldBlocks.map((b) => blockSignature(b, oldRoleMap));
  const newSigs = newBlocks.map((b) => blockSignature(b, newRoleMap));
  const ops = lcsOps(oldSigs, newSigs);

  const newBlockStatus = new Map();
  const deletedOldBlockIds = [];

  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.type === 'equal') {
      newBlockStatus.set(newBlocks[op.newIndex].id, {
        status: 'unchanged',
        matchedOldBlockId: oldBlocks[op.oldIndex].id,
      });
      k++;
      continue;
    }

    const hunkStart = k;
    while (k < ops.length && ops[k].type !== 'equal') k++;
    const hunk = ops.slice(hunkStart, k);
    const deletes = hunk.filter((o) => o.type === 'delete').map((o) => oldBlocks[o.oldIndex]);
    const inserts = hunk.filter((o) => o.type === 'insert').map((o) => newBlocks[o.newIndex]);

    const usedDeletes = new Set();
    for (const ins of inserts) {
      const insKey = roleKey(ins, newRoleMap);
      let matchIdx = -1;
      for (let d = 0; d < deletes.length; d++) {
        if (usedDeletes.has(d)) continue;
        const del = deletes[d];
        if (del.type === ins.type && insKey && insKey === roleKey(del, oldRoleMap)) {
          matchIdx = d;
          break;
        }
      }
      if (matchIdx >= 0) {
        usedDeletes.add(matchIdx);
        newBlockStatus.set(ins.id, { status: 'modified', matchedOldBlockId: deletes[matchIdx].id });
      } else {
        newBlockStatus.set(ins.id, { status: 'added', matchedOldBlockId: null });
      }
    }
    deletes.forEach((del, d) => { if (!usedDeletes.has(d)) deletedOldBlockIds.push(del.id); });
  }

  return { newBlockStatus, deletedOldBlockIds };
}

export function computeRevisionDiff(oldRoles, oldBlocks, newRoles, newBlocks) {
  const oldRoleMap = new Map(oldRoles.map((r) => [r.id, r]));
  const newRoleMap = new Map(newRoles.map((r) => [r.id, r]));
  return diffScripts(oldBlocks, oldRoleMap, newBlocks, newRoleMap);
}
