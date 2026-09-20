import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { encodeMoneroBase58, decodeMoneroBase58 } from './moneroBase58';

export const ED25519_ORDER = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

export const NET_PREFIX = {
  MAINNET: {
    PRIMARY: 0x12,      // 18  -> '4'
    INTEGRATED: 0x13,   // 19  -> '4'
    SUBADDRESS: 0x2a,   // 42  -> '8'
  },
  TESTNET: {
    PRIMARY: 0x35,      // 53  -> '9'
    INTEGRATED: 0x36,   // 54  -> 'A'
    SUBADDRESS: 0x3f,   // 63  -> 'B'
  },
  STAGENET: {
    PRIMARY: 0x18,      // 24  -> '5'
    INTEGRATED: 0x19,   // 25  -> '5'
    SUBADDRESS: 0x24,   // 36  -> '7'
  }
} as const;

export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let res = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    res = (res << 8n) | BigInt(bytes[i]);
  }
  return res;
}

export function bigIntToBytesLE(num: bigint, len: number = 32): Uint8Array {
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = Number((num >> BigInt(i * 8)) & 0xffn);
  }
  return bytes;
}

export function scReduce32(bytes: Uint8Array): bigint {
  const n = bytesToBigIntLE(bytes);
  return n % ED25519_ORDER;
}

export interface MoneroKeys {
  seedHex: string;
  spendPrivateHex: string;
  spendPublicHex: string;
  viewPrivateHex: string;
  viewPublicHex: string;
  primaryAddress: string;
}

export function createKeysFromSeed(seedBytes: Uint8Array, netType: 'mainnet' | 'testnet' | 'stagenet' = 'mainnet'): MoneroKeys {
  if (seedBytes.length !== 32) {
    throw new Error('Seed must be exactly 32 bytes');
  }

  const spendPrivScalar = scReduce32(seedBytes);
  const spendPrivBytes = bigIntToBytesLE(spendPrivScalar, 32);
  const spendPubBytes = ed25519.Point.BASE.multiply(spendPrivScalar).toBytes();

  const viewHash = keccak_256(spendPrivBytes);
  const viewPrivScalar = scReduce32(viewHash);
  const viewPrivBytes = bigIntToBytesLE(viewPrivScalar, 32);
  const viewPubBytes = ed25519.Point.BASE.multiply(viewPrivScalar).toBytes();

  const prefix = netType === 'mainnet' 
    ? NET_PREFIX.MAINNET.PRIMARY 
    : netType === 'testnet' 
      ? NET_PREFIX.TESTNET.PRIMARY 
      : NET_PREFIX.STAGENET.PRIMARY;

  const addrPayload = new Uint8Array(1 + 32 + 32);
  addrPayload[0] = prefix;
  addrPayload.set(spendPubBytes, 1);
  addrPayload.set(viewPubBytes, 33);

  const checksum = keccak_256(addrPayload).slice(0, 4);
  const fullBytes = new Uint8Array(69);
  fullBytes.set(addrPayload, 0);
  fullBytes.set(checksum, 65);

  const primaryAddress = encodeMoneroBase58(fullBytes);

  return {
    seedHex: Array.from(seedBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
    spendPrivateHex: Array.from(spendPrivBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
    spendPublicHex: Array.from(spendPubBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
    viewPrivateHex: Array.from(viewPrivBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
    viewPublicHex: Array.from(viewPubBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
    primaryAddress,
  };
}

export interface AddressValidation {
  isValid: boolean;
  type?: 'primary' | 'subaddress' | 'integrated' | 'unknown';
  nettype?: 'mainnet' | 'testnet' | 'stagenet';
  error?: string;
}

export function validateMoneroAddress(address: string): AddressValidation {
  const trimmed = address.trim();
  if (trimmed.length !== 95 && trimmed.length !== 106) {
    return { isValid: false, error: 'Invalid address length (expected 95 or 106 characters)' };
  }

  try {
    const raw = decodeMoneroBase58(trimmed);
    if (raw.length !== 69 && raw.length !== 77) {
      return { isValid: false, error: 'Decoded byte length invalid' };
    }

    const payload = raw.slice(0, raw.length - 4);
    const checksum = raw.slice(raw.length - 4);
    const calculated = keccak_256(payload).slice(0, 4);

    for (let i = 0; i < 4; i++) {
      if (checksum[i] !== calculated[i]) {
        return { isValid: false, error: 'Address checksum mismatch' };
      }
    }

    const prefix = raw[0];
    if (prefix === NET_PREFIX.MAINNET.PRIMARY) {
      return { isValid: true, type: 'primary', nettype: 'mainnet' };
    }
    if (prefix === NET_PREFIX.MAINNET.SUBADDRESS) {
      return { isValid: true, type: 'subaddress', nettype: 'mainnet' };
    }
    if (prefix === NET_PREFIX.MAINNET.INTEGRATED) {
      return { isValid: true, type: 'integrated', nettype: 'mainnet' };
    }
    if (prefix === NET_PREFIX.TESTNET.PRIMARY) {
      return { isValid: true, type: 'primary', nettype: 'testnet' };
    }
    if (prefix === NET_PREFIX.TESTNET.SUBADDRESS) {
      return { isValid: true, type: 'subaddress', nettype: 'testnet' };
    }
    if (prefix === NET_PREFIX.STAGENET.PRIMARY) {
      return { isValid: true, type: 'primary', nettype: 'stagenet' };
    }
    if (prefix === NET_PREFIX.STAGENET.SUBADDRESS) {
      return { isValid: true, type: 'subaddress', nettype: 'stagenet' };
    }

    return { isValid: true, type: 'unknown' };
  } catch (err: unknown) {
    return { isValid: false, error: (err as Error)?.message || 'Invalid Base58 encoding' };
  }
}
