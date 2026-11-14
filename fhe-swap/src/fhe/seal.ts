import SEAL from "node-seal";
import type {
  EncryptedVector,
  FheClient,
  FheEvaluator,
  FheParams,
  PublicBundle,
} from "./types.js";

/**
 * Microsoft SEAL BFV backend.
 *
 * Important honesty note:
 * - BFV is exact integer homomorphic encryption. In this prototype it is used as
 *   a leveled HE engine for encrypted swap intents/quotes.
 * - It is NOT a drop-in production TFHE/fhEVM deployment. The `FheClient` /
 *   `FheEvaluator` interfaces exist so a TFHE-rs / OpenFHE / fhEVM backend can be
 *   substituted without rewriting settlement code.
 * - The matcher receives only `PublicBundle` and ciphertexts. It has no secret
 *   key and no decrypt function.
 */

// node-seal v7 exposes low-level Emscripten bindings. We keep the surface small
// and typed at the boundary instead of leaking WASM handles into protocol code.
type Seal = any;

const DEFAULT_POLY_DEGREE = 8192;
const DEFAULT_PLAIN_BITS = 60;
const DEFAULT_SECURITY = 128 as const;

function secLevel(seal: Seal, bits: 128 | 192 | 256): any {
  if (bits === 192) return seal.SecLevelType.tc192;
  if (bits === 256) return seal.SecLevelType.tc256;
  return seal.SecLevelType.tc128;
}

function compr(seal: Seal): any {
  return seal.ComprModeType.zstd;
}

function assertValues(values: readonly bigint[], plainModulus: bigint): void {
  for (const v of values) {
    if (typeof v !== "bigint") {
      throw new TypeError("FHE values must be bigint");
    }
    if (v < 0n || v >= plainModulus) {
      throw new RangeError(
        `FHE value ${v} outside [0, plainModulus=${plainModulus})`,
      );
    }
  }
}

function makeParams(
  seal: Seal,
  polyDegree: number,
  plainBits: number,
  security: 128 | 192 | 256,
): any {
  const params = new seal.EncryptionParameters(seal.SchemeType.bfv);
  params.setPolyModulusDegree(polyDegree);
  params.setCoeffModulus(
    seal.CoeffModulus.BFVDefault(polyDegree, secLevel(seal, security)),
  );
  params.setPlainModulus(seal.PlainModulus.Batching(polyDegree, plainBits));
  return params;
}

interface SealHandles {
  seal: Seal;
  context: any;
  evaluator: any;
  encoder: any;
  publicKey: any;
  relinKeys: any;
  secretKey?: any;
  encryptor: any;
  decryptor?: any;
  plainModulus: bigint;
  slotCount: number;
  securityLevel: 128 | 192 | 256;
  params: any;
}

async function initHandles(opts: {
  params?: FheParams;
  bundle?: PublicBundle;
}): Promise<SealHandles> {
  const seal: Seal = await SEAL();
  const security = opts.bundle?.securityLevel ?? opts.params?.securityLevel ?? DEFAULT_SECURITY;
  const polyDegree = opts.params?.polyModulusDegree ?? DEFAULT_POLY_DEGREE;
  const plainBits = opts.params?.plainModulusBits ?? DEFAULT_PLAIN_BITS;

  let params: any;
  if (opts.bundle) {
    params = new seal.EncryptionParameters(seal.SchemeType.bfv);
    params.loadFromBase64(opts.bundle.params);
  } else {
    params = makeParams(seal, polyDegree, plainBits, security);
  }

  const context = new seal.SEALContext(params, true, secLevel(seal, security));
  if (!context.parametersSet()) {
    throw new Error("SEAL context parameters are not valid");
  }

  const encoder = new seal.BatchEncoder(context);
  const evaluator = new seal.Evaluator(context);
  const plainModulus = context
    .firstContextData()
    .parms()
    .plainModulus()
    .value() as bigint;
  const slotCount = encoder.slotCount() as number;

  let publicKey: any;
  let relinKeys: any;
  let secretKey: any | undefined;
  let decryptor: any | undefined;

  if (opts.bundle) {
    publicKey = new seal.PublicKey();
    publicKey.loadFromBase64(context, opts.bundle.publicKey);
    relinKeys = new seal.RelinKeys();
    relinKeys.loadFromBase64(context, opts.bundle.relinKeys);
  } else {
    const kg = new seal.KeyGenerator(context);
    secretKey = kg.secretKey();
    publicKey = kg.createPublicKey();
    relinKeys = kg.createRelinKeys();
    decryptor = new seal.Decryptor(context, secretKey);
    kg.delete();
  }

  const encryptor = new seal.Encryptor(context, publicKey);

  return {
    seal,
    context,
    evaluator,
    encoder,
    publicKey,
    relinKeys,
    secretKey,
    encryptor,
    decryptor,
    plainModulus,
    slotCount,
    securityLevel: security,
    params,
  };
}

function encodePlain(h: SealHandles, values: readonly bigint[]): any {
  assertValues(values, h.plainModulus);
  if (values.length > h.slotCount) {
    throw new RangeError(
      `Vector length ${values.length} exceeds slot count ${h.slotCount}`,
    );
  }
  const padded = new BigUint64Array(h.slotCount);
  for (let i = 0; i < values.length; i++) padded[i] = values[i];
  const plain = new h.seal.Plaintext();
  h.encoder.encode(padded, plain);
  return plain;
}

function decodePlain(h: SealHandles, plain: any, length: number): bigint[] {
  const arr = h.encoder.decodeBigUint64(plain) as BigUint64Array;
  const out: bigint[] = [];
  for (let i = 0; i < length; i++) out.push(BigInt(arr[i]));
  return out;
}

function assertVectorMeta(h: SealHandles, ct: EncryptedVector): void {
  if (ct.backend !== "seal-bfv") throw new Error("backend mismatch");
  if (
    !Number.isInteger(ct.slotCount) ||
    ct.slotCount < 0 ||
    ct.slotCount > h.slotCount
  ) {
    throw new RangeError(`invalid ciphertext slotCount ${ct.slotCount}`);
  }
}

function loadCiphertext(h: SealHandles, blob: string): any {
  const ct = new h.seal.Ciphertext();
  ct.loadFromBase64(h.context, blob);
  return ct;
}

function saveCiphertext(h: SealHandles, ct: any): string {
  return ct.saveToBase64(compr(h.seal)) as string;
}

function wrapVector(h: SealHandles, ct: any, length: number): EncryptedVector {
  const ciphertext = saveCiphertext(h, ct);
  ct.delete();
  return { ciphertext, slotCount: length, backend: "seal-bfv" };
}

export class SealFheClient implements FheClient {
  private constructor(private readonly h: SealHandles) {}

  static async create(params: FheParams = {}): Promise<SealFheClient> {
    const h = await initHandles({ params });
    if (!h.decryptor || !h.secretKey) {
      throw new Error("client requires secret key");
    }
    return new SealFheClient(h);
  }

  get plainModulus(): bigint {
    return this.h.plainModulus;
  }

  get slotCount(): number {
    return this.h.slotCount;
  }

  publicBundle(): PublicBundle {
    return {
      params: this.h.params.saveToBase64(compr(this.h.seal)) as string,
      publicKey: this.h.publicKey.saveToBase64(compr(this.h.seal)) as string,
      relinKeys: this.h.relinKeys.saveToBase64(compr(this.h.seal)) as string,
      plainModulus: this.h.plainModulus.toString(),
      slotCount: this.h.slotCount,
      securityLevel: this.h.securityLevel,
      backend: "seal-bfv",
    };
  }

  encrypt(values: readonly bigint[]): EncryptedVector {
    const plain = encodePlain(this.h, values);
    const ct = new this.h.seal.Ciphertext();
    this.h.encryptor.encrypt(plain, ct);
    plain.delete();
    return wrapVector(this.h, ct, values.length);
  }

  decrypt(ct: EncryptedVector): bigint[] {
    if (!this.h.decryptor) throw new Error("no secret key");
    assertVectorMeta(this.h, ct);
    const cipher = loadCiphertext(this.h, ct.ciphertext);
    const plain = new this.h.seal.Plaintext();
    this.h.decryptor.decrypt(cipher, plain);
    const values = decodePlain(this.h, plain, ct.slotCount);
    plain.delete();
    cipher.delete();
    return values;
  }

  exportSecretKey(): string {
    if (!this.h.secretKey) throw new Error("no secret key");
    return this.h.secretKey.saveToBase64(compr(this.h.seal)) as string;
  }
}

export class SealFheEvaluator implements FheEvaluator {
  private constructor(private readonly h: SealHandles) {}

  static async fromBundle(bundle: PublicBundle): Promise<SealFheEvaluator> {
    if (bundle.backend !== "seal-bfv") {
      throw new Error(`unsupported backend ${bundle.backend}`);
    }
    const h = await initHandles({ bundle });
    if (h.decryptor || h.secretKey) {
      throw new Error("evaluator must not hold secret key");
    }
    if (h.plainModulus.toString() !== bundle.plainModulus) {
      throw new Error("plain modulus mismatch");
    }
    return new SealFheEvaluator(h);
  }

  get plainModulus(): bigint {
    return this.h.plainModulus;
  }

  get slotCount(): number {
    return this.h.slotCount;
  }

  serialize(ct: EncryptedVector): string {
    return JSON.stringify(ct);
  }

  deserialize(blob: string): EncryptedVector {
    const parsed = JSON.parse(blob) as EncryptedVector;
    assertVectorMeta(this.h, parsed);
    // Validate loadability without secret key.
    const cipher = loadCiphertext(this.h, parsed.ciphertext);
    cipher.delete();
    return parsed;
  }

  add(a: EncryptedVector, b: EncryptedVector): EncryptedVector {
    this.assertSameLength(a, b);
    const ca = loadCiphertext(this.h, a.ciphertext);
    const cb = loadCiphertext(this.h, b.ciphertext);
    const out = new this.h.seal.Ciphertext();
    this.h.evaluator.add(ca, cb, out);
    ca.delete();
    cb.delete();
    return wrapVector(this.h, out, a.slotCount);
  }

  sub(a: EncryptedVector, b: EncryptedVector): EncryptedVector {
    this.assertSameLength(a, b);
    const ca = loadCiphertext(this.h, a.ciphertext);
    const cb = loadCiphertext(this.h, b.ciphertext);
    const out = new this.h.seal.Ciphertext();
    this.h.evaluator.sub(ca, cb, out);
    ca.delete();
    cb.delete();
    return wrapVector(this.h, out, a.slotCount);
  }

  multiplyPlain(a: EncryptedVector, plain: readonly bigint[]): EncryptedVector {
    assertVectorMeta(this.h, a);
    if (plain.length !== a.slotCount) {
      throw new RangeError("plaintext vector length mismatch");
    }
    const ct = loadCiphertext(this.h, a.ciphertext);
    const pt = encodePlain(this.h, plain);
    const out = new this.h.seal.Ciphertext();
    this.h.evaluator.multiplyPlain(ct, pt, out);
    ct.delete();
    pt.delete();
    return wrapVector(this.h, out, a.slotCount);
  }

  multiply(a: EncryptedVector, b: EncryptedVector): EncryptedVector {
    this.assertSameLength(a, b);
    const ca = loadCiphertext(this.h, a.ciphertext);
    const cb = loadCiphertext(this.h, b.ciphertext);
    const out = new this.h.seal.Ciphertext();
    this.h.evaluator.multiply(ca, cb, out);
    this.h.evaluator.relinearizeInplace(out, this.h.relinKeys);
    ca.delete();
    cb.delete();
    return wrapVector(this.h, out, a.slotCount);
  }

  private assertSameLength(a: EncryptedVector, b: EncryptedVector): void {
    assertVectorMeta(this.h, a);
    assertVectorMeta(this.h, b);
    if (a.slotCount !== b.slotCount) {
      throw new RangeError("ciphertext vector length mismatch");
    }
  }
}
