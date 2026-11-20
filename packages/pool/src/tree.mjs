import { CAPACITY, DEPTH, emptyNodes, nonzero32, parent } from './notes.mjs';

/** Reconstruct the root and all paths locally from an ordered snapshot of
 * canonical LeafInserted logs. Callers must pin RPC, vault and block. */
export async function treeFromLeaves(input) {
  if (!Array.isArray(input) || input.length > CAPACITY) throw new RangeError('invalid note tree size');
  const leaves = [...input];
  if (new Set(leaves).size !== leaves.length) throw new Error('duplicate note leaf');
  for (const leaf of leaves) nonzero32(leaf);
  const zeros = await emptyNodes();
  const levels = [leaves];
  for (let height = 0; height < DEPTH; height++) {
    const level = levels[height], next = [];
    for (let j = 0; j < level.length; j += 2) next.push(await parent(level[j], level[j + 1] ?? zeros[height]));
    levels.push(next);
  }
  const root = levels[DEPTH][0] ?? zeros[DEPTH], count = leaves.length;
  return Object.freeze({ root, count, path(index) {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('note index outside funded range');
    const siblings = Array.from({ length: DEPTH }, (_, height) => levels[height][(index >> height) ^ 1] ?? zeros[height]);
    return Object.freeze({ root, count, index, siblings: Object.freeze(siblings) });
  } });
}
