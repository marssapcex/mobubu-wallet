import { ZeroHash, toBeHex } from 'ethers';
import { STARK_NOTE_LIMIT, GOLDILOCKS as P } from './networks.mjs';

const MASK = (1n << 64n) - 1n;
const SPEND = 0x53504e44n;
const NULL = 0x4e554c4cn;
const NOTE = 0x4e4f5445n;
const DEPTH = 32;

export function uint(value, max, label = 'integer') {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value))) {
    throw new Error(`Invalid ${label}: expected a canonical decimal integer`);
  }
  const n = BigInt(value);
  if (n < 0n || n > max) throw new Error(`${label} out of range`);
  return n;
}

export function limbs4(values) {
  if (!Array.isArray(values) || values.length !== 4) throw new Error('Expected four canonical Goldilocks limbs');
  return values.map((v) => uint(v, P - 1n, 'Goldilocks limb'));
}

export function word256(value) {
  if (typeof value !== 'string' || !/^0x[a-f0-9]{64}$/i.test(value)) throw new Error('Expected a 32-byte hex word');
  return value.toLowerCase();
}

export function pack(values) {
  return toBeHex(limbs4(values).reduce((n, v, i) => n | (v << BigInt(64 * i)), 0n), 32);
}

export function unpack(word) {
  const n = BigInt(word256(word));
  return limbs4(Array.from({ length: 4 }, (_, i) => (n >> BigInt(64 * i)) & MASK));
}

export function seedEntry(note, network) {
  // The pinned Rust seed reader expects these fields in this order, and JSON u64 numbers.
  return { value: note.value, asset_id: network.assetId, spend_pk: unpack(note.spendPk), blinding: note.blinding };
}

// Read constants from the pinned Solidity hasher rather than maintaining a second permutation.
export function makeNoteCodec(solidity, randomBytes) {
  const constants = (name, count) => {
    const words = solidity.match(new RegExp(`constant ${name} =\\s*hex"([a-f0-9]+)"`))?.[1]?.match(/.{16}/g);
    if (words?.length !== count) throw new Error(`Invalid Poseidon ${name} constants`);
    return words.map((w) => BigInt(`0x${w}`));
  };
  const MDS = constants('MDS', 64);
  const RC = constants('RC', 256);
  // Width 8, x^7, 32 full rounds (hash2, NOT the hashFields/31-round single block).
  // JS BigInt is not constant time; only run on the operator's own machine.
  function hash2(left, right) {
    let state = [...unpack(left), ...unpack(right)];
    for (let round = 0; round < 32; round++) {
      const t = state.map((x) => {
        const x2 = x * x % P;
        const x4 = x2 * x2 % P;
        return x4 * x2 * x % P;
      });
      state = state.map((_, j) => {
        let n = RC[8 * round + j];
        for (let k = 0; k < 8; k++) n += MDS[8 * j + k] * t[k];
        return n % P;
      });
    }
    return pack(state.slice(0, 4));
  }

  function rebuildRoot(leaves) {
    if (!leaves.length || leaves.length > 2 ** DEPTH) throw new Error('Invalid depth-32 leaf count');
    let row = leaves;
    let zero = ZeroHash;
    for (let level = 0; level < DEPTH; level++) {
      const next = [];
      for (let i = 0; i < row.length; i += 2) next.push(hash2(row[i], row[i + 1] ?? zero));
      row = next;
      zero = hash2(zero, zero);
    }
    return row[0];
  }

  function randomLimbs() {
    return Array.from({ length: 4 }, () => {
      let n;
      do { n = new DataView(Uint8Array.from(randomBytes(8)).buffer).getBigUint64(0, true); } while (n >= P);
      return n;
    });
  }

  const tag = (n) => pack([n, 0n, 0n, 0n]);

  function openNote(network, value, secret = randomLimbs(), blinding = randomLimbs()) {
    if (network.assetId !== 0n) throw new Error('Only native ETH notes are supported');
    value = uint(value, STARK_NOTE_LIMIT, 'note value');
    secret = limbs4(secret);
    blinding = limbs4(blinding);
    if (secret.every((x) => x === 0n)) throw new Error('Invalid all-zero note secret');
    const spendPk = hash2(pack(secret), tag(SPEND));
    const ownerCommit = hash2(spendPk, pack(blinding));
    const header = pack([value & 0xffffffffn, value >> 32n, network.assetId, NOTE]);
    const leaf = hash2(header, ownerCommit);
    if (ownerCommit === ZeroHash || leaf === ZeroHash) throw new Error('Degenerate note; generate a fresh opening');
    return { value, secret, blinding, spendPk, ownerCommit, leaf };
  }

  function noteNullifier(note, index) {
    const nk = hash2(pack(note.secret), tag(NULL));
    return hash2(hash2(nk, note.leaf), tag(uint(index, (1n << 32n) - 1n, 'leaf index')));
  }

  return { hash2, openNote, noteNullifier, rebuildRoot };
}
