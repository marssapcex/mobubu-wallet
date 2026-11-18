import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants, mkdtempSync, rmSync, type BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WORKER = fileURLToPath(new URL("../../../native/bin/tfhe_worker", import.meta.url));
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 32;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_CLOUD_KEY_BYTES = 128n * 1024n * 1024n;

export interface TfheParams {
  n: number;
  N: number;
  k: number;
  l: number;
  Bgbit: number;
}

/** An opaque ciphertext under the locally provisioned key. Not a proof. */
export interface EncryptedInt {
  readonly width: number;
  readonly blob: string;
  readonly backend: "tfhe-cggi";
  /** SHA-256 of the provisioned cloud-key file. A mix-up check, not authentication. */
  readonly keyId: string;
}

export class ProtocolError extends Error {
  constructor(public readonly id: number, message: string) {
    super(`tfhe request ${id} failed: ${message}`);
    this.name = "ProtocolError";
  }
}

export interface TfheBackend {
  raw(op: string, ...args: string[]): Promise<string>;
  close(): void;
}

type Pending = { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Trusted local IPC only. Do not expose this protocol or key paths over RPC. */
export class CppTfheBackend extends EventEmitter implements TfheBackend {
  private readonly proc: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private closed = false;

  constructor(workerPath: string, private readonly timeoutMs = 300_000) {
    super();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) {
      throw new RangeError("invalid TFHE timeout");
    }
    this.proc = spawn(workerPath, [], { env: { ...process.env, LC_ALL: "C" }, stdio: "pipe" });
    this.proc.stderr.resume(); // Drain diagnostic output without logging ciphertexts or key material.
    this.proc.stdout.setEncoding("ascii");
    this.proc.stdout.on("data", (data: string) => this.consume(data));
    this.proc.stdout.on("error", (err) => this.terminate(err));
    this.proc.stdin.on("error", (err) => this.terminate(err));
    this.proc.on("error", (err) => this.terminate(err));
    this.proc.once("close", (code, signal) => {
      this.terminate(new Error(`tfhe worker exited (${signal ?? code})`));
      this.emit("close", code);
    });
  }

  private consume(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      if (end >= MAX_FRAME_BYTES) break;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const response = /^(\d+) (OK|ERR) (.*)$/.exec(line);
      const id = Number(response?.[1]);
      const pending = this.pending.get(id);
      if (!response || !pending) {
        this.terminate(new Error("invalid or unsolicited TFHE response"));
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (response[2] === "OK") pending.resolve(response[3]);
      else pending.reject(new ProtocolError(id, response[3]));
    }
    if (this.buffer.length >= MAX_FRAME_BYTES) this.terminate(new Error("TFHE response exceeded size limit"));
  }

  async raw(op: string, ...args: string[]): Promise<string> {
    if (this.closed) throw new Error("tfhe worker is closed");
    if (this.pending.size >= MAX_PENDING) throw new Error("tfhe request queue is full");
    // No whitespace or control characters: a value is exactly one token.
    if (!/^[A-Z_]+$/.test(op) || args.some((arg) => !/^[!-~]+$/.test(arg))) {
      throw new Error("invalid TFHE protocol token");
    }
    const id = this.nextId++;
    const frame = [id, op, ...args].join(" ") + "\n";
    if (frame.length > MAX_FRAME_BYTES) throw new Error("TFHE request exceeded size limit");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Requests are serialized in the worker. Kill a stalled worker rather
        // than leaving every subsequent request stuck behind a timed-out one.
        this.terminate(new Error(`tfhe request ${id} (${op}) timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(frame, (err) => { if (err) this.terminate(err); });
    });
  }

  private terminate(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = "";
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.proc.stdin.destroy();
    this.proc.kill("SIGKILL");
  }

  close(): void { this.terminate(new Error("tfhe worker is closed")); }
  async [Symbol.asyncDispose](): Promise<void> { this.close(); }
}

export class TfheWorker extends CppTfheBackend {}

type Relation = "lt" | "le" | "gt" | "ge" | "eq" | "ne";

function width(w: number, max = 128): number {
  if (!Number.isInteger(w) || w < 1 || w > max) throw new RangeError(`bit width must be 1..${max}`);
  return w;
}

function scalar(value: bigint | number, w = 64): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new RangeError("use bigint for large values");
  if (typeof value !== "number" && typeof value !== "bigint") throw new TypeError("expected an unsigned integer");
  const v = BigInt(value);
  if (v < 0n || v > MAX_U64 || v >= (1n << BigInt(w))) throw new RangeError("value exceeds bit width");
  return v.toString();
}

async function requireUnchanged(path: string, snapshot: BigIntStats): Promise<void> {
  const after = await stat(path, { bigint: true });
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const) {
    if (snapshot[field] !== after[field]) throw new Error("TFHE cloud key changed while provisioning");
  }
}

/** Hash once per load, with bounded memory. Paths must be trusted/immutable. */
async function identifyCloudKey(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const snapshot = await file.stat({ bigint: true });
    if (!snapshot.isFile() || snapshot.size < 1n || snapshot.size > MAX_CLOUD_KEY_BYTES) {
      throw new Error("expected a regular TFHE cloud key file within the size limit");
    }
    const hash = createHash("sha256");
    let bytes = 0n;
    for await (const chunk of file.createReadStream({ end: Number(snapshot.size) - 1, autoClose: false })) {
      bytes += BigInt(chunk.length);
      hash.update(chunk);
    }
    if (bytes !== snapshot.size) throw new Error("incomplete TFHE cloud key read");
    await requireUnchanged(path, snapshot);
    return { keyId: hash.digest("hex"), snapshot };
  } finally {
    await file.close();
  }
}

function checkCiphertext(ct: EncryptedInt, key: KeyContext): void {
  if (ct?.backend !== "tfhe-cggi") throw new TypeError("expected TFHE ciphertext");
  if (ct.keyId !== key.id) throw new Error("TFHE ciphertext belongs to a different key");
  const bytes = width(ct.width) * (16 + 4 * key.params.n);
  const encoded = 4 * Math.ceil(bytes / 3);
  const padding = (3 - bytes % 3) % 3;
  if (typeof ct.blob !== "string" || ct.blob.length !== encoded ||
      !ct.blob.endsWith("=".repeat(padding)) || /[^a-zA-Z0-9+/]/.test(ct.blob.slice(0, encoded - padding))) {
    throw new TypeError("invalid ciphertext encoding or length");
  }
}

function sameWidth(a: EncryptedInt, b: EncryptedInt): void {
  if (a.width !== b.width) throw new RangeError("ciphertext widths must match");
}

type KeyContext = { id: string; params: TfheParams };

function params(parts: string[]): TfheParams {
  const [n, N, k, l, Bgbit] = parts.map(Number);
  // Only the pinned upstream preset is supported. A cloud key still must be a
  // trusted, locally provisioned file; this is not a safe arbitrary-key parser.
  if (parts.length !== 5 || n !== 630 || N !== 1024 || k !== 1 || l !== 3 || Bgbit !== 7) {
    throw new Error("unexpected TFHE parameter preset");
  }
  return { n, N, k, l, Bgbit };
}

abstract class TfheOperations {
  protected context?: KeyContext;

  protected constructor(protected readonly backend: TfheBackend, protected readonly defaultWidth: number) {
    width(defaultWidth, 64);
  }

  protected abstract ensureReady(): Promise<void>;

  protected async checkInputs(inputs: readonly EncryptedInt[]): Promise<KeyContext> {
    await this.ensureReady();
    const key = this.context;
    if (!key) throw new Error("no TFHE key loaded");
    for (const input of inputs) checkCiphertext(input, key);
    return key;
  }

  protected async ciphertext(w: number, op: string, inputs: readonly EncryptedInt[], ...args: string[]): Promise<EncryptedInt> {
    width(w);
    const key = await this.checkInputs(inputs.map((input) => ({ ...input })));
    const [encodedWidth, blob, extra] = (await this.backend.raw(op, ...args)).split(" ");
    if (encodedWidth !== String(w) || extra !== undefined) throw new Error("unexpected TFHE ciphertext response");
    const result = { width: w, blob, backend: "tfhe-cggi" as const, keyId: key.id };
    checkCiphertext(result, key);
    return Object.freeze(result);
  }

  private binary(op: string, a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    sameWidth(a, b);
    return this.ciphertext(a.width, op, [a, b], String(a.width), a.blob, b.blob);
  }

  async add(a: EncryptedInt, b: EncryptedInt) { return this.binary("ADD", a, b); }
  async sub(a: EncryptedInt, b: EncryptedInt) { return this.binary("SUB", a, b); }
  async and(a: EncryptedInt, b: EncryptedInt) { return this.binary("AND", a, b); }
  async or(a: EncryptedInt, b: EncryptedInt) { return this.binary("OR", a, b); }
  async xor(a: EncryptedInt, b: EncryptedInt) { return this.binary("XOR", a, b); }

  async not(a: EncryptedInt) {
    return this.ciphertext(a.width, "NOT", [a], String(a.width), a.blob);
  }

  /** Public/trivial constant, not a secret encryption. */
  async constant(value: bigint | number) {
    return this.ciphertext(this.defaultWidth, "CONST", [], String(this.defaultWidth), scalar(value, this.defaultWidth));
  }

  async addConst(a: EncryptedInt, value: bigint | number) {
    return this.ciphertext(a.width, "ADDCONST", [a], String(a.width), a.blob, scalar(value, a.width));
  }

  async mulConst(a: EncryptedInt, value: bigint | number, w = this.defaultWidth) {
    return this.ciphertext(w, "MULCONST", [a], String(a.width), a.blob, scalar(value), String(w));
  }

  async mul(a: EncryptedInt, b: EncryptedInt, w = a.width + b.width) {
    return this.ciphertext(w, "MUL", [a, b], String(a.width), a.blob, String(b.width), b.blob, String(w));
  }

  async shr(a: EncryptedInt, shift: number) {
    if (!Number.isInteger(shift) || shift < 0 || shift >= a.width) throw new RangeError("shift out of range");
    return this.ciphertext(a.width - shift, "SHR", [a], String(a.width), a.blob, String(shift));
  }

  async resize(a: EncryptedInt, w: number) {
    return this.ciphertext(w, "RESIZE", [a], String(a.width), a.blob, String(w));
  }

  async cmp(a: EncryptedInt, b: EncryptedInt, relation: Relation) {
    sameWidth(a, b);
    return this.ciphertext(1, "CMP", [a, b], relation, String(a.width), a.blob, b.blob);
  }

  /** Specialized unsigned comparison when the threshold is already public. */
  async geConst(a: EncryptedInt, threshold: bigint | number) {
    return this.ciphertext(1, "GE_CONST", [a], String(a.width), a.blob, scalar(threshold, a.width));
  }

  async mux(selector: EncryptedInt, a: EncryptedInt, b: EncryptedInt) {
    sameWidth(a, b);
    if (selector.width !== 1) throw new RangeError("mux selector must be an encrypted bit");
    return this.ciphertext(a.width, "MUX", [selector, a, b], selector.blob, String(a.width), a.blob, b.blob);
  }

  async divConst(a: EncryptedInt, divisor: bigint | number, w = a.width) {
    return this.ciphertext(w, "DIVCONST", [a], String(a.width), a.blob, scalar(divisor), String(w));
  }

  /** Caller must ensure the encrypted divisor is nonzero. */
  async div(a: EncryptedInt, b: EncryptedInt, w = a.width) {
    sameWidth(a, b);
    return this.ciphertext(w, "DIV", [a, b], String(a.width), a.blob, String(b.width), b.blob, String(w));
  }

  close(): void { this.backend.close(); }
}

export class TfheClient extends TfheOperations {
  private readonly directory: string;
  private readonly cloudPath: string;
  readonly ready: Promise<void>;

  constructor(backend: TfheBackend, w = 16, security: 128 = 128) {
    super(backend, w);
    if (security !== 128) throw new RangeError("only the upstream 128 parameter preset is supported");
    this.directory = mkdtempSync(join(tmpdir(), "mobubu-tfhe-"));
    this.cloudPath = join(this.directory, "cloud.key");
    if (backend instanceof CppTfheBackend) backend.once("close", () => this.removeKeyFile());
    this.ready = this.init().catch((error) => {
      this.close();
      throw error;
    });
  }

  private async init(): Promise<void> {
    const [role, security, ...values] = (await this.backend.raw("KEYGEN", "128", this.cloudPath)).split(" ");
    if (role !== "client" || security !== "128") throw new Error("unexpected KEYGEN response");
    const p = params(values);
    const { keyId } = await identifyCloudKey(this.cloudPath);
    this.context = { id: keyId, params: p };
  }

  protected async ensureReady(): Promise<void> { await this.ready; }

  async params(): Promise<TfheParams> {
    await this.ready;
    return { ...this.context!.params };
  }

  async encrypt(value: bigint | number, bits = this.defaultWidth): Promise<EncryptedInt> {
    width(bits, 64);
    return this.ciphertext(bits, "ENC", [], String(bits), scalar(value, bits));
  }

  async decrypt(ct: EncryptedInt): Promise<bigint> {
    const snapshot = { ...ct };
    await this.checkInputs([snapshot]);
    width(snapshot.width, 64);
    return BigInt(await this.backend.raw("DEC", String(snapshot.width), snapshot.blob));
  }

  getCloudPath(): string {
    if (!this.context) throw new Error("client is not initialized");
    return this.cloudPath;
  }

  private removeKeyFile(): void { rmSync(this.directory, { recursive: true, force: true }); }
  override close(): void {
    super.close();
    this.removeKeyFile();
  }
}

/** Holds only a trusted cloud key; intentionally has no DEC/ENC API. */
export class TfheEvaluator extends TfheOperations {
  private loading = false;

  constructor(backend: TfheBackend, w = 16) { super(backend, w); }

  async loadCloudKey(cloudKeyPath: string): Promise<TfheParams> {
    if (this.context || this.loading) throw new Error("TFHE cloud key is already loaded or loading");
    this.loading = true;
    try {
      const { keyId, snapshot } = await identifyCloudKey(cloudKeyPath);
      const [role, ...values] = (await this.backend.raw("LOADCLOUD", cloudKeyPath)).split(" ");
      if (role !== "evaluator") throw new Error("unexpected LOADCLOUD response");
      const p = params(values);
      await requireUnchanged(cloudKeyPath, snapshot);
      this.context = { id: keyId, params: p };
      return this.params();
    } catch (error) {
      this.close();
      throw error;
    } finally {
      this.loading = false;
    }
  }

  protected async ensureReady(): Promise<void> { this.params(); }
  params(): TfheParams {
    if (!this.context) throw new Error("no cloud key loaded");
    return { ...this.context.params };
  }
  isEvaluator(): boolean { return this.context !== undefined; }
}

type WorkerOptions = { backend?: TfheBackend; workerPath?: string; width?: number };
type ClientOptions = WorkerOptions & { role: "client"; security?: 128 };
type EvaluatorOptions = WorkerOptions & { role: "evaluator"; cloudKeyPath: string };
type WorkerContext<Role, Crypto> = { backend: TfheBackend; worker: TfheBackend; crypto: Crypto; role: Role };

export function makeTfhe(opts: ClientOptions): Promise<WorkerContext<"client", TfheClient>>;
export function makeTfhe(opts: EvaluatorOptions): Promise<WorkerContext<"evaluator", TfheEvaluator>>;
export async function makeTfhe(opts: ClientOptions | EvaluatorOptions) {
  const w = width(opts.width ?? 16, 64);
  const backend = opts.backend ?? new CppTfheBackend(opts.workerPath ?? DEFAULT_WORKER);
  try {
    if (opts.role === "client") {
      const crypto = new TfheClient(backend, w, opts.security);
      await crypto.ready;
      return { backend, worker: backend, crypto, role: "client" as const };
    }
    const crypto = new TfheEvaluator(backend, w);
    await crypto.loadCloudKey(opts.cloudKeyPath);
    return { backend, worker: backend, crypto, role: "evaluator" as const };
  } catch (error) {
    backend.close();
    throw error;
  }
}
