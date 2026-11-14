/**
 * Backend-agnostic FHE/HE types.
 *
 * The swap protocol only depends on this interface. The default backend is
 * Microsoft SEAL BFV via `node-seal` (leveled homomorphic encryption). A true
 * TFHE backend (Zama tfhe-rs / fhEVM) can be substituted behind this interface,
 * but production integration may also require changes to integer encoding,
 * range checks, key management and threshold opening. See README "FHE backend".
 */

/** Serialized (base64) public material the matcher/relayer is allowed to hold. */
export interface PublicBundle {
  /** Encryption parameters, serialized. */
  params: string;
  /** Public key, serialized. */
  publicKey: string;
  /** Relinearization keys, serialized (needed for ciphertext*ciphertext). */
  relinKeys: string;
  /** Plaintext modulus (bigint as decimal string) — arithmetic is mod this. */
  plainModulus: string;
  /** Number of batching slots. */
  slotCount: number;
  /** Security level in bits. */
  securityLevel: 128 | 192 | 256;
  /** Backend identifier. */
  backend: "seal-bfv";
}

/** A serialized encrypted vector. Opaque to anyone without the secret key. */
export interface EncryptedVector {
  /** Ciphertext, base64 (zstd compressed). */
  ciphertext: string;
  /** Slot count of the underlying plaintext vector. */
  slotCount: number;
  /** Backend tag so ciphertexts are not mixed across schemes. */
  backend: "seal-bfv";
}

export interface FheParams {
  polyModulusDegree?: number;
  plainModulusBits?: number;
  securityLevel?: 128 | 192 | 256;
}

/**
 * Client-side context. Holds the SECRET key. Never give this to the matcher.
 */
export interface FheClient {
  readonly plainModulus: bigint;
  readonly slotCount: number;
  /** Public material safe to share with the matcher. */
  publicBundle(): PublicBundle;
  /** Encrypt a vector of unsigned integers (each < plainModulus). */
  encrypt(values: readonly bigint[]): EncryptedVector;
  /** Decrypt a vector. Only the secret-key holder can do this. */
  decrypt(ct: EncryptedVector): bigint[];
  /** Serialize the secret key (keep offline / in a hardened key store). */
  exportSecretKey(): string;
}

/**
 * Server/matcher-side evaluator. Holds ONLY public material. It can compute on
 * ciphertexts but has no `decrypt` method — it structurally cannot see plaintext.
 */
export interface FheEvaluator {
  readonly plainModulus: bigint;
  readonly slotCount: number;
  add(a: EncryptedVector, b: EncryptedVector): EncryptedVector;
  sub(a: EncryptedVector, b: EncryptedVector): EncryptedVector;
  /** Multiply ciphertext by a plaintext vector (slot-wise). */
  multiplyPlain(a: EncryptedVector, plain: readonly bigint[]): EncryptedVector;
  /** Multiply two ciphertexts (slot-wise) + relinearize. */
  multiply(a: EncryptedVector, b: EncryptedVector): EncryptedVector;
  /** Serialize a ciphertext for transport. */
  serialize(ct: EncryptedVector): string;
  /** Deserialize a ciphertext received over the wire. */
  deserialize(blob: string): EncryptedVector;
}
