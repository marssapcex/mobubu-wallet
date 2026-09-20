/**
 * Monero Base58 Encoding & Decoding
 * Monero uses a custom base58 scheme where 8-byte blocks are encoded into 11-char base58 strings.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) {
  ALPHABET_MAP.set(ALPHABET[i], i);
}

const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const DECODED_BLOCK_SIZES = new Map<number, number>([
  [0, 0],
  [2, 1],
  [3, 2],
  [5, 3],
  [6, 4],
  [7, 5],
  [9, 6],
  [10, 7],
  [11, 8],
]);

function encodeBlock(bytes: Uint8Array): string {
  let num = 0n;
  for (let i = 0; i < bytes.length; i++) {
    num = (num << 8n) | BigInt(bytes[i]);
  }
  let res = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    res = ALPHABET[rem] + res;
  }
  const targetLen = ENCODED_BLOCK_SIZES[bytes.length];
  while (res.length < targetLen) {
    res = ALPHABET[0] + res;
  }
  return res;
}

export function encodeMoneroBase58(bytes: Uint8Array): string {
  let res = "";
  for (let i = 0; i < bytes.length; i += 8) {
    const chunk = bytes.slice(i, Math.min(i + 8, bytes.length));
    res += encodeBlock(chunk);
  }
  return res;
}

function decodeBlock(str: string): Uint8Array {
  const byteLen = DECODED_BLOCK_SIZES.get(str.length);
  if (byteLen === undefined) {
    throw new Error(`Invalid base58 block length: ${str.length}`);
  }
  let num = 0n;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const val = ALPHABET_MAP.get(char);
    if (val === undefined) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    num = num * 58n + BigInt(val);
  }
  const res = new Uint8Array(byteLen);
  for (let i = byteLen - 1; i >= 0; i--) {
    res[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  return res;
}

export function decodeMoneroBase58(str: string): Uint8Array {
  const fullBlocks = Math.floor(str.length / 11);
  const remainder = str.length % 11;
  const totalBytes = fullBlocks * 8 + (DECODED_BLOCK_SIZES.get(remainder) ?? 0);
  const result = new Uint8Array(totalBytes);
  let byteOffset = 0;

  for (let i = 0; i < fullBlocks * 11; i += 11) {
    const chunk = str.slice(i, i + 11);
    result.set(decodeBlock(chunk), byteOffset);
    byteOffset += 8;
  }

  if (remainder > 0) {
    const chunk = str.slice(fullBlocks * 11);
    result.set(decodeBlock(chunk), byteOffset);
  }

  return result;
}
