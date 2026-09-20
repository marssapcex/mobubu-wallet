import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { encodeMoneroBase58 } from './moneroBase58';
import { NET_PREFIX, scReduce32, bytesToBigIntLE } from './keys';

const SUBADDR_PREFIX = new Uint8Array([83, 117, 98, 65, 100, 100, 114, 0]); // "SubAddr\0"

export interface SubaddressInfo {
  major: number;
  minor: number;
  label: string;
  address: string;
  spendPublicHex: string;
  viewPublicHex: string;
  createdAt: number;
  isUsed: boolean;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const len = clean.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function deriveSubaddress(
  viewPrivHex: string,
  spendPubHex: string,
  major: number,
  minor: number,
  label: string = `Subaddress #${minor}`,
  netType: 'mainnet' | 'testnet' | 'stagenet' = 'mainnet'
): SubaddressInfo {
  const viewPrivBytes = hexToBytes(viewPrivHex);
  const viewPrivScalar = bytesToBigIntLE(viewPrivBytes);
  const spendPubBytes = hexToBytes(spendPubHex);

  // If major == 0 && minor == 0, that's primary address, but for minor > 0 it's a true subaddress:
  const idxBytes = new Uint8Array(8);
  const dv = new DataView(idxBytes.buffer);
  dv.setUint32(0, major, true);
  dv.setUint32(4, minor, true);

  const subInput = new Uint8Array(8 + 32 + 8);
  subInput.set(SUBADDR_PREFIX, 0);
  subInput.set(viewPrivBytes, 8);
  subInput.set(idxBytes, 40);

  const mHash = keccak_256(subInput);
  const mScalar = scReduce32(mHash);
  const mG = ed25519.Point.BASE.multiply(mScalar);

  // B + m*G
  const BPoint = ed25519.Point.fromHex(spendPubHex);
  const DPoint = BPoint.add(mG);
  const subSpendPubBytes = DPoint.toBytes();

  // C = a * D
  const CPoint = DPoint.multiply(viewPrivScalar);
  const subViewPubBytes = CPoint.toBytes();

  const prefix = netType === 'mainnet' 
    ? NET_PREFIX.MAINNET.SUBADDRESS 
    : netType === 'testnet' 
      ? NET_PREFIX.TESTNET.SUBADDRESS 
      : NET_PREFIX.STAGENET.SUBADDRESS;

  const addrPayload = new Uint8Array(1 + 32 + 32);
  addrPayload[0] = prefix;
  addrPayload.set(subSpendPubBytes, 1);
  addrPayload.set(subViewPubBytes, 33);

  const checksum = keccak_256(addrPayload).slice(0, 4);
  const fullBytes = new Uint8Array(69);
  fullBytes.set(addrPayload, 0);
  fullBytes.set(checksum, 65);

  const address = encodeMoneroBase58(fullBytes);

  return {
    major,
    minor,
    label,
    address,
    spendPublicHex: bytesToHex(subSpendPubBytes),
    viewPublicHex: bytesToHex(subViewPubBytes),
    createdAt: Date.now(),
    isUsed: false,
  };
}
