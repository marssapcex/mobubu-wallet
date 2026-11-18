import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

/**
 * Threshold order-encryption reference.
 *
 * This is NOT FHE. It is a threshold *opening* scheme for private orderflow:
 * the public relayer/mempool sees only an AES-GCM sealed blob. A vault committee
 * reconstructs the plaintext only after it has collected >= t key shares.
 *
 * The secret sharing is Shamir over the secp256k1 base field. The dealer flow is
 * simplified for local testing: `sealOrder` returns the shares that a client
 * would distribute to committee members over private channels.
 */
const P = 2n ** 256n - 2n ** 32n - 977n;
const VERSION = "threshold-aes-gcm-v2";
const MAX_PAYLOAD = 4096;
const HEX_ID = /^[0-9a-f]{32}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface CommitteePublic {
  readonly id: string;
  readonly n: number;
  readonly t: number;
  /** Public participant indices, usually 1..n. */
  readonly xs: readonly number[];
}

export interface ThresholdShare {
  x: number;
  y: string;
}

export interface SealedOrder {
  version: typeof VERSION;
  committeeId: string;
  /** base64 */
  iv: string;
  ciphertext: string;
  tag: string;
}

function mod(a: bigint, m: bigint = P): bigint {
  return ((a % m) + m) % m;
}

function pow(base: bigint, exp: bigint, m: bigint = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function inv(a: bigint): bigint {
  return pow(a, P - 2n);
}

function randomField(): bigint {
  // Rejection sample to avoid modulo bias.
  while (true) {
    const candidate = BigInt("0x" + randomBytes(32).toString("hex"));
    if (candidate < P) return candidate;
  }
}

function bigIntTo32Bytes(v: bigint): Buffer {
  return Buffer.from(v.toString(16).padStart(64, "0"), "hex");
}

function evalPoly(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    acc = mod(acc * x + coeffs[i]);
  }
  return acc;
}

function committeeSize(n: number, t: number): void {
  if (!Number.isInteger(n) || !Number.isInteger(t) || t < 2 || n < t || n > 255) {
    throw new Error("require 2 <= t <= n <= 255");
  }
}

function copyCommittee(pub: CommitteePublic): CommitteePublic {
  committeeSize(pub.n, pub.t);
  if (typeof pub.id !== "string" || pub.id.length !== 32 || !HEX_ID.test(pub.id) ||
      !Array.isArray(pub.xs) || pub.xs.length !== pub.n) throw new Error("invalid committee metadata");
  const xs = [...pub.xs];
  if (xs.some((x) => !Number.isInteger(x) || x < 1 || x > 255) || new Set(xs).size !== xs.length) {
    throw new Error("invalid committee participant indices");
  }
  return Object.freeze({ id: pub.id, n: pub.n, t: pub.t, xs: Object.freeze(xs) });
}

export function generateCommittee(n: number, t: number): CommitteePublic {
  committeeSize(n, t);
  const xs = Array.from({ length: n }, (_, i) => i + 1);
  const id = createHash("sha256")
    .update(JSON.stringify({ n, t, xs, nonce: randomBytes(16).toString("hex") }))
    .digest("hex")
    .slice(0, 32);
  return copyCommittee({ id, n, t, xs });
}

function splitSecret(secret: bigint, pub: CommitteePublic): ThresholdShare[] {
  const coeffs = [mod(secret)];
  for (let i = 1; i < pub.t; i++) coeffs.push(randomField());
  return pub.xs.map((x) => ({
    x,
    y: evalPoly(coeffs, BigInt(x)).toString(),
  }));
}

type ParsedShare = { x: number; y: bigint };

function parseShare(share: ThresholdShare, pub: CommitteePublic): ParsedShare {
  if (!share || !pub.xs.includes(share.x)) throw new Error("share index not in committee");
  if (typeof share.y !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(share.y)) {
    throw new Error("share value must be canonical decimal");
  }
  const y = BigInt(share.y);
  if (y >= P) throw new Error("share value is outside the field");
  return { x: share.x, y };
}

function combineShares(shares: readonly ParsedShare[], t: number): bigint {
  if (shares.length < t) throw new Error("not enough shares");
  const used = shares.slice(0, t);
  const xs = used.map((s) => BigInt(s.x));
  let secret = 0n;
  for (let i = 0; i < used.length; i++) {
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < used.length; j++) {
      if (i === j) continue;
      num = mod(num * xs[j]);
      den = mod(den * (xs[j] - xs[i]));
    }
    const lagrange = mod(num * inv(den));
    secret = mod(secret + used[i].y * lagrange);
  }
  return secret;
}

function deriveKey(secret: bigint): Buffer {
  return createHash("sha256").update(bigIntTo32Bytes(secret)).digest();
}

function base64(value: unknown, min: number, max: number, field: string): Buffer {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(max / 3)) throw new Error(`invalid ${field} length`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < min || bytes.length > max || bytes.toString("base64") !== value) {
    throw new Error(`invalid ${field} encoding or length`);
  }
  return bytes;
}

function envelope(raw: SealedOrder) {
  if (!raw || raw.version !== VERSION) throw new Error("unknown sealed version");
  const { committeeId, iv, ciphertext, tag } = raw;
  if (typeof committeeId !== "string" || committeeId.length !== 32 || !HEX_ID.test(committeeId)) {
    throw new Error("invalid committee id");
  }
  const sealed: SealedOrder = { version: VERSION, committeeId, iv, ciphertext, tag };
  return {
    sealed,
    iv: base64(iv, IV_BYTES, IV_BYTES, "IV"),
    ciphertext: base64(ciphertext, 1, MAX_PAYLOAD, "ciphertext"),
    tag: base64(tag, TAG_BYTES, TAG_BYTES, "tag"),
  };
}

/** Validate first, then store only the expected public envelope fields. */
export function normalizeSealedOrder(sealed: SealedOrder): SealedOrder { return envelope(sealed).sealed; }

function idOf({ version, committeeId, iv, ciphertext, tag }: SealedOrder): string {
  return createHash("sha256").update(`${version}:${committeeId}:${iv}:${ciphertext}:${tag}`).digest("hex").slice(0, 32);
}

export function orderIdOf(sealed: SealedOrder): string { return idOf(normalizeSealedOrder(sealed)); }

function aad(committeeId: string): Buffer { return Buffer.from(`${VERSION}:${committeeId}`, "ascii"); }

/** Client-side demo dealer. Shares must be submitted over trusted channels. */
export function sealOrder(
  plaintext: unknown,
  pub: CommitteePublic,
): { sealed: SealedOrder; shares: ThresholdShare[]; orderId: string } {
  const committee = copyCommittee(pub);
  const encoded = JSON.stringify(plaintext);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD) throw new Error("invalid sealed payload size");
  let secret = randomField();
  while (secret === 0n) secret = randomField();
  const key = deriveKey(secret);
  const iv = randomBytes(IV_BYTES);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(committee.id));
    const ciphertext = Buffer.concat([cipher.update(encoded, "utf8"), cipher.final()]);
    const sealed: SealedOrder = {
      version: VERSION, committeeId: committee.id, iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
    };
    return { sealed, shares: splitSecret(secret, committee), orderId: idOf(sealed) };
  } finally {
    key.fill(0);
  }
}

function openEnvelope<T>(input: ReturnType<typeof envelope>, shares: readonly ParsedShare[], pub: CommitteePublic): T {
  if (input.sealed.committeeId !== pub.id) throw new Error("committee mismatch");
  const key = deriveKey(combineShares(shares, pub.t));
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, input.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(pub.id));
    decipher.setAuthTag(input.tag);
    const body = decipher.update(input.ciphertext);
    try {
      plaintext = Buffer.concat([body, decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as T;
    } finally {
      body.fill(0);
    }
  } finally {
    plaintext?.fill(0);
    key.fill(0);
  }
}

export function openOrder<T = unknown>(sealed: SealedOrder, shares: readonly ThresholdShare[], pub: CommitteePublic): T {
  const committee = copyCommittee(pub);
  if (!Array.isArray(shares) || shares.length > committee.n) throw new Error("invalid share count");
  const seen = new Set<number>();
  const parsed = Array.from(shares, (share) => {
    const value = parseShare(share, committee);
    if (seen.has(value.x)) throw new Error("duplicate share index");
    seen.add(value.x);
    return value;
  });
  return openEnvelope<T>(envelope(sealed), parsed, committee);
}

/** Trusted in-process collector. This is not share authentication or verifiable secret sharing. */
export class ThresholdOrderOpener {
  private readonly pub: CommitteePublic;
  private readonly sharesByOrder = new Map<string, Map<number, ParsedShare>>();

  constructor(pub: CommitteePublic) { this.pub = copyCommittee(pub); }

  requireCommittee(id: string): void {
    if (id !== this.pub.id) throw new Error("committee mismatch");
  }

  submitShare(orderId: string, share: ThresholdShare): void {
    if (typeof orderId !== "string" || orderId.length !== 32 || !HEX_ID.test(orderId)) throw new Error("invalid order id");
    const { x, y } = parseShare(share, this.pub);
    let bag = this.sharesByOrder.get(orderId);
    if (!bag) this.sharesByOrder.set(orderId, bag = new Map());
    const existing = bag.get(x);
    if (existing && existing.y !== y) throw new Error("conflicting share for participant");
    if (!existing) bag.set(x, { x, y });
  }

  canOpen(orderId: string): boolean { return (this.sharesByOrder.get(orderId)?.size ?? 0) >= this.pub.t; }

  discard(orderId: string): void { this.sharesByOrder.delete(orderId); }

  open<T = unknown>(orderId: string, sealed: SealedOrder): T {
    const input = envelope(sealed);
    if (idOf(input.sealed) !== orderId) throw new Error("sealed order id mismatch");
    const bag = this.sharesByOrder.get(orderId);
    if (!bag || bag.size < this.pub.t) throw new Error("not enough shares");
    try {
      return openEnvelope<T>(input, [...bag.values()], this.pub);
    } finally {
      this.discard(orderId);
    }
  }
}
