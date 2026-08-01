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

  return ranges.map(([startIdx, endIdx], i) => {
    const leadStart = Math.max(0, startIdx - LEAD_IN);
    const leadEnd = Math.min(blocks.length - 1, endIdx + LEAD_IN);
    const startBlock = blocks[leadStart];
    const endBlock = blocks[leadEnd];
    const myLineCount = blocks
      .slice(startIdx, endIdx + 1)
      .filter(isMine).length;
    return {
      index: i,
      startOrder: startBlock.order,
      endOrder: endBlock.order,
      startPage: startBlock.page,
      endPage: endBlock.page,
      myLineCount,
      label: `出番${i + 1}  p.${startBlock.page}–${endBlock.page}  自分の台詞 ${myLineCount}`,
    };
  });
}
