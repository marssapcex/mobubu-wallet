import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeNoteCodec } from './notes-core.mjs';

export { limbs4, pack, seedEntry, uint, unpack, word256 } from './notes-core.mjs';
const solidity = readFileSync(new URL('../contracts/vendor/nonos/PoseidonGoldilocks.sol', import.meta.url), 'utf8');
export const { hash2, openNote, noteNullifier, rebuildRoot } = makeNoteCodec(solidity, randomBytes);
