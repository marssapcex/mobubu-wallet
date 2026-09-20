import { MONERO_ENGLISH_WORDS } from './wordlist';

const N_WORDS = 1626;

// CRC32 table initialization
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

export function crc32(str: string): number {
  let crc = 0 ^ (-1);
  for (let i = 0; i < str.length; i++) {
    const byte = str.charCodeAt(i);
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

export function generateRandomSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

export function seedToMnemonic(seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error('Seed must be exactly 32 bytes');
  }

  const words: string[] = [];
  const dv = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);

  for (let i = 0; i < 32; i += 4) {
    const val = dv.getUint32(i, true); // little-endian
    const w1 = val % N_WORDS;
    const w2 = (Math.floor(val / N_WORDS) + w1) % N_WORDS;
    const w3 = (Math.floor(Math.floor(val / N_WORDS) / N_WORDS) + w2) % N_WORDS;
    words.push(MONERO_ENGLISH_WORDS[w1], MONERO_ENGLISH_WORDS[w2], MONERO_ENGLISH_WORDS[w3]);
  }

  // Calculate 25th checksum word using 3-char prefixes of first 24 words
  let prefixString = '';
  for (let i = 0; i < 24; i++) {
    prefixString += words[i].slice(0, 3);
  }

  const checksumIndex = crc32(prefixString) % 24;
  words.push(words[checksumIndex]);

  return words.join(' ');
}

export function mnemonicToSeed(mnemonic: string): Uint8Array {
  const rawWords = mnemonic.trim().toLowerCase().split(/\s+/);
  if (rawWords.length !== 24 && rawWords.length !== 25) {
    throw new Error(`Invalid mnemonic word count: expected 24 or 25 words, got ${rawWords.length}`);
  }

  const wordIndexMap = new Map<string, number>();
  for (let i = 0; i < MONERO_ENGLISH_WORDS.length; i++) {
    wordIndexMap.set(MONERO_ENGLISH_WORDS[i], i);
  }

  const words24 = rawWords.slice(0, 24);

  // If 25 words provided, verify checksum word
  if (rawWords.length === 25) {
    let prefixString = '';
    for (let i = 0; i < 24; i++) {
      prefixString += words24[i].slice(0, 3);
    }
    const expectedChecksumIndex = crc32(prefixString) % 24;
    const expectedChecksumWord = words24[expectedChecksumIndex];
    if (rawWords[24] !== expectedChecksumWord) {
      throw new Error(`Invalid 25th checksum word: expected "${expectedChecksumWord}", got "${rawWords[24]}"`);
    }
  }

  const seed = new Uint8Array(32);
  const dv = new DataView(seed.buffer);

  for (let i = 0; i < 24; i += 3) {
    const w1 = wordIndexMap.get(words24[i]);
    const w2 = wordIndexMap.get(words24[i + 1]);
    const w3 = wordIndexMap.get(words24[i + 2]);

    if (w1 === undefined || w2 === undefined || w3 === undefined) {
      throw new Error(`Unrecognized word in mnemonic at positions ${i + 1}-${i + 3}`);
    }

    const diff2 = ((w2 - w1) % N_WORDS + N_WORDS) % N_WORDS;
    const diff3 = ((w3 - w2) % N_WORDS + N_WORDS) % N_WORDS;
    const val = w1 + N_WORDS * diff2 + N_WORDS * N_WORDS * diff3;

    dv.setUint32(Math.floor(i / 3) * 4, val, true);
  }

  return seed;
}

export function validateMnemonic(mnemonic: string): { isValid: boolean; error?: string } {
  try {
    mnemonicToSeed(mnemonic);
    return { isValid: true };
  } catch (e) {
    return { isValid: false, error: (e as Error).message };
  }
}
