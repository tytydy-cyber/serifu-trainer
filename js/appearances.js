// Splits a script's blocks into 出番 (appearance) ranges based on the gap
// between consecutive lines belonging to "my" roles.

const DEFAULT_GAP = 15;
const LEAD_IN = 2;

export function computeAppearances(blocks, myRoleIds, gapThreshold = DEFAULT_GAP) {
  const myRoleSet = new Set(myRoleIds);
  const isMine = (b) => b.type === 'line' && b.roleIds && b.roleIds.some((r) => myRoleSet.has(r));
  const isHeading = (b) => b.type === 'heading';

  const myIndexes = [];
  blocks.forEach((b, idx) => {
    if (isMine(b)) myIndexes.push(idx);
  });

  if (myIndexes.length === 0) return [];

  const ranges = [];
  let rangeStart = myIndexes[0];
  let rangeEnd = myIndexes[0];

  for (let k = 1; k < myIndexes.length; k++) {
    const idx = myIndexes[k];
    const gapBlocks = blocks.slice(rangeEnd + 1, idx);
    const gapCount = gapBlocks.filter((b) => b.type !== 'heading').length;
    const crossesHeading = gapBlocks.some(isHeading);
    if (gapCount > gapThreshold || crossesHeading) {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = idx;
    }
    rangeEnd = idx;
  }
  ranges.push([rangeStart, rangeEnd]);

  // Scene heading detection is only as good as a given script's formatting
  // (see parser.js) — some scripts we've tested against have none at all.
  // A snippet of the reader's own first line is available for every
  // appearance regardless, so it's the fallback that always works: not "what
  // scene is this" but "what do I say first", which is what actually jogs
  // memory of a scene.
  const truncate = (text, max) => {
    const t = text.trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  };
  const preview = (text) => truncate(text, 22);

  let precedingHeading = null;
  let headingCursor = 0;

  return ranges.map(([startIdx, endIdx], i) => {
    const leadStart = Math.max(0, startIdx - LEAD_IN);
    const leadEnd = Math.min(blocks.length - 1, endIdx + LEAD_IN);
    const startBlock = blocks[leadStart];
    const endBlock = blocks[leadEnd];
    const rangeBlocks = blocks.slice(startIdx, endIdx + 1);
    const myLineCount = rangeBlocks.filter(isMine).length;
    const firstMine = rangeBlocks.find(isMine);

    while (headingCursor <= leadStart) {
      if (blocks[headingCursor].type === 'heading') precedingHeading = blocks[headingCursor].text;
      headingCursor++;
    }

    return {
      index: i,
      startOrder: startBlock.order,
      endOrder: endBlock.order,
      startPage: startBlock.page,
      endPage: endBlock.page,
      myLineCount,
      sceneHeading: precedingHeading ? truncate(precedingHeading, 14) : null,
      preview: firstMine ? preview(firstMine.text) : '',
      label: `出番${i + 1}  p.${startBlock.page}–${endBlock.page}  自分のセリフ ${myLineCount}本`,
    };
  });
}
