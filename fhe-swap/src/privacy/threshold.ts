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

export interface CommitteePublic {
  id: string;
  n: number;
  t: number;
  /** Public participant indices, usually 1..n. */
  xs: number[];
}

export interface ThresholdShare {
  x: number;
  y: string;
}

export interface SealedOrder {
  version: "threshold-aes-gcm-v1";
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

export function generateCommittee(n: number, t: number): CommitteePublic {
  if (!Number.isInteger(n) || !Number.isInteger(t) || t < 2 || n < t || n > 255) {
    throw new Error("require 2 <= t <= n <= 255");
  }
  const xs = Array.from({ length: n }, (_, i) => i + 1);
  const id = createHash("sha256")
    .update(JSON.stringify({ n, t, xs, nonce: randomBytes(16).toString("hex") }))
    .digest("hex")
    .slice(0, 32);
  return { id, n, t, xs };
}

function splitSecret(secret: bigint, pub: CommitteePublic): ThresholdShare[] {
  const coeffs = [mod(secret)];
  for (let i = 1; i < pub.t; i++) coeffs.push(randomField());
  return pub.xs.map((x) => ({
    x,
    y: evalPoly(coeffs, BigInt(x)).toString(),
  }));
}

function combineShares(shares: ThresholdShare[], t: number): bigint {
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
    secret = mod(secret + BigInt(used[i].y) * lagrange);
  }
  return secret;
}

function deriveKey(secret: bigint): Buffer {
  return createHash("sha256").update(bigIntTo32Bytes(secret)).digest();
}

export function orderIdOf(sealed: SealedOrder): string {
  return createHash("sha256")
    .update(`${sealed.version}:${sealed.committeeId}:${sealed.iv}:${sealed.ciphertext}:${sealed.tag}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Client-side sealing. Returns the sealed blob for the public orderflow layer
 * and the shares that must be sent privately to committee members.
 */
export function sealOrder(
  plaintext: unknown,
  pub: CommitteePublic,
): { sealed: SealedOrder; shares: ThresholdShare[]; orderId: string } {
  const secret = BigInt("0x" + randomBytes(31).toString("hex")); // < P
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const json = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  const sealed: SealedOrder = {
    version: "threshold-aes-gcm-v1",
    committeeId: pub.id,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
  return {
    sealed,
    shares: splitSecret(secret, pub),
    orderId: orderIdOf(sealed),
  };
}

export function openOrder<T = unknown>(
  sealed: SealedOrder,
  shares: ThresholdShare[],
  pub: CommitteePublic,
): T {
  if (sealed.committeeId !== pub.id) throw new Error("committee mismatch");
  if (sealed.version !== "threshold-aes-gcm-v1") throw new Error("unknown sealed version");
  const validXs = new Set(pub.xs);
  const seen = new Set<number>();
  for (const s of shares) {
    if (!validXs.has(s.x)) throw new Error("share index not in committee");
    if (seen.has(s.x)) throw new Error("duplicate share index");
    seen.add(s.x);
  }
  const secret = combineShares(shares, pub.t);
  const key = deriveKey(secret);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * Vault-side share collector / opener.
 * Relayers never call this with plaintext; they only forward sealed blobs.
 */
export class ThresholdOrderOpener {
  private sharesByOrder = new Map<string, Map<number, ThresholdShare>>();

  constructor(private readonly pub: CommitteePublic) {}

  submitShare(orderId: string, share: ThresholdShare): void {
    if (!this.pub.xs.includes(share.x)) {
      throw new Error("share index not in committee");
    }
    let bag = this.sharesByOrder.get(orderId);
    if (!bag) {
      bag = new Map();
      this.sharesByOrder.set(orderId, bag);
    }
    bag.set(share.x, share);
  }

  canOpen(orderId: string): boolean {
    return (this.sharesByOrder.get(orderId)?.size ?? 0) >= this.pub.t;
  }

  open<T = unknown>(orderId: string, sealed: SealedOrder): T {
    if (orderIdOf(sealed) !== orderId) throw new Error("sealed order id mismatch");
    const bag = this.sharesByOrder.get(orderId);
    if (!bag || bag.size < this.pub.t) throw new Error("not enough shares");
    return openOrder<T>(sealed, [...bag.values()], this.pub);
  }
}
