import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_WORKER = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "native",
  "bin",
  "tfhe_worker",
);

export interface TfheParams {
  n: number;
  N: number;
  k: number;
  l: number;
  Bgbit: number;
}

export interface EncryptedInt {
  width: number;
  blob: string;
  backend: "tfhe-cggi";
}

export class ProtocolError extends Error {
  constructor(public readonly id: number, message: string) {
    super(`tfhe request ${id} failed: ${message}`);
    this.name = "ProtocolError";
  }
}

/**
 * Backend abstraction: cho phép thay C++ worker bằng TFHE-rs (Rust/WASM) hoặc
 * Concrete (Python) mà không đổi business logic.
 */
export interface TfheBackend {
  raw(op: string, ...args: string[]): Promise<string>;
  close(): void;
}

/**
 * C++ worker backend (hiện tại). Sau này có thể swap bằng TfheRsBackend (WASM/Rust)
 * hoặc ConcreteBackend (Python) mà không sửa TfheClient/TfheEvaluator.
 */
export class CppTfheBackend extends EventEmitter implements TfheBackend {
  private proc: ChildProcess;
  private pending = new Map<number, {
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }>();
  private nextId = 1;
  private buf = "";
  private closed = false;
  private readonly timeoutMs: number;
  private readonly pendTimer = new Map<number, NodeJS.Timeout>();

  constructor(workerPath: string, timeoutMs = 300_000) {
    super();
    this.timeoutMs = timeoutMs;
    this.proc = spawn(workerPath, [], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (d) => {
      this.buf += d.toString();
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.trim() === "") continue;
        this.handleLine(line);
      }
    });
    this.proc.on("close", (code) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`tfhe worker exited (code ${code})`));
      }
      this.pending.clear();
      this.emit("close", code);
    });
    this.proc.on("error", (err) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.emit("error", err);
    });
  }

  private handleLine(line: string): void {
    const space = line.indexOf(" ");
    if (space < 0) return;
    const id = Number(line.slice(0, space));
    const rest = line.slice(space + 1);
    const pend = this.pending.get(id);
    if (!pend) return;
    this.pending.delete(id);
    clearTimeout(this.pendTimer.get(id));
    this.pendTimer.delete(id);
    if (rest.startsWith("OK ")) {
      pend.resolve(rest.slice(3));
    } else if (rest.startsWith("ERR ")) {
      pend.reject(new ProtocolError(id, rest.slice(4)));
    } else {
      pend.reject(new ProtocolError(id, `unexpected response: ${rest}`));
    }
  }

  async raw(op: string, ...args: string[]): Promise<string> {
    if (this.closed) throw new Error("tfhe worker is closed");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        this.pending.delete(id);
        this.pendTimer.delete(id);
        reject(new Error(`tfhe request ${id} (${op}) timed out`));
      }, this.timeoutMs);
      this.pendTimer.set(id, t);
      try {
        this.proc.stdin!.write([id, op, ...args].join(" ") + "\n");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(t);
        reject(err);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.proc.stdin!.write("QUIT\n");
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.closed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
}

/**
 * Placeholder backend cho TFHE-rs (Rust/WASM) hoặc Concrete (Python).
 * Khi có WASM binding, triển khai raw() bằng cách gọi WASM module.
 */
export class TfheRsBackend implements TfheBackend {
  async raw(op: string, ...args: string[]): Promise<string> {
    throw new Error(
      "TfheRsBackend not implemented yet. Build TFHE-rs WASM binding and wire here.",
    );
  }
  close(): void {
    /* noop */
  }
}

/**
 * TfheClient: giữ secret key, encrypt/decrypt. Default width = 16 (giảm từ 32
 * để tăng tốc FHE; đủ cho số tiền lớn đến 65,535 đơn vị, chia nhỏ nếu cần hơn).
 *//**
 * Backward-compatible wrapper around CppTfheBackend.
 * Old tests import TfheWorker directly; kept for compatibility.
 */
export class TfheWorker extends CppTfheBackend {
  constructor(workerPath: string, timeoutMs = 300_000) {
    super(workerPath, timeoutMs);
  }
}


export class TfheClient {
  private backend: TfheBackend;
  private mode: { kind: "client"; security: number; params: TfheParams } |
    null = null;
  private readonly width: number;
  public readonly ready: Promise<void>;
  private cloudPath = "";

  constructor(backend: TfheBackend, width = 16, security: 80 | 128 = 128) {
    this.backend = backend;
    this.width = width;
    this.ready = this.init(security);
  }

  private async init(security: 80 | 128): Promise<void> {
    const cloudPath = `/tmp/tfhe-cloud-${process.pid}-${Date.now()}.key`;
    const payload = await this.backend.raw("KEYGEN", String(security), cloudPath);
    const toks = payload.split(" ");
    if (toks[0] !== "client") throw new Error("unexpected KEYGEN response");
    this.mode = {
      kind: "client",
      security: (Number(toks[1]) as 80 | 128),
      params: {
        n: Number(toks[2]),
        N: Number(toks[3]),
        k: Number(toks[4]),
        l: Number(toks[5]),
        Bgbit: Number(toks[6]),
      },
    };
    this.cloudPath = cloudPath;
  }

  private async ensureClient(): Promise<void> {
    await this.ready;
    if (this.mode?.kind !== "client") {
      throw new Error("this worker is not in client role (no secret key)");
    }
  }

  async params(): Promise<TfheParams> {
    await this.ensureClient();
    return { ...this.mode!.params };
  }

  async encrypt(value: bigint | number): Promise<EncryptedInt> {
    await this.ensureClient();
    const v = typeof value === "bigint" ? value.toString() : String(value);
    const payload = await this.backend.raw("ENC", String(this.width), v);
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }

  async decrypt(ct: EncryptedInt): Promise<bigint> {
    await this.ensureClient();
    const payload = await this.backend.raw("DEC", String(ct.width), ct.blob);
    return BigInt(payload);
  }

  async constant(value: bigint | number): Promise<EncryptedInt> {
    await this.ensureClient();
    const v = typeof value === "bigint" ? value.toString() : String(value);
    const payload = await this.backend.raw("CONST", String(this.width), v);
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }

  async add(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureClient();
    return this.binop("ADD", a, b, a.width);
  }
  async sub(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureClient();
    return this.binop("SUB", a, b, a.width);
  }
  async and(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureClient();
    return this.binop("AND", a, b, a.width);
  }
  async or(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureClient();
    return this.binop("OR", a, b, a.width);
  }
  async xor(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureClient();
    return this.binop("XOR", a, b, a.width);
  }
  async not(a: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureClient();
    return this.unop("NOT", a, a.width);
  }
  async addConst(a: EncryptedInt, c: bigint | number): Promise<EncryptedInt> {
    await this.ensureClient();
    return this.resize(
      await this.withOp("ADDCONST", a, String(c)),
      a.width,
    );
  }
  async mulConst(
    a: EncryptedInt,
    c: bigint | number,
    ow?: number,
  ): Promise<EncryptedInt> {
    await this.ensureClient();
    const outW = ow ?? this.width;
    const payload = await this.backend.raw(
      "MULCONST",
      String(a.width),
      a.blob,
      String(c),
      String(outW),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  /**
   * MUL/DIV rất chậm trong FHE (bootstrapped every gate). Ưu tiên dùng CMP/MUX
   * thay vì MUL/DIV khi có thể.
   */
  async mul(
    a: EncryptedInt,
    b: EncryptedInt,
    ow?: number,
  ): Promise<EncryptedInt> {
    await this.ensureClient();
    const outW = ow ?? a.width + b.width;
    const payload = await this.backend.raw(
      "MUL",
      String(a.width),
      a.blob,
      String(b.width),
      b.blob,
      String(outW),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async shr(a: EncryptedInt, sh: number): Promise<EncryptedInt> {
    await this.ensureClient();
    const payload = await this.backend.raw(
      "SHR",
      String(a.width),
      a.blob,
      String(sh),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async resize(a: EncryptedInt, ow: number): Promise<EncryptedInt> {
    await this.ensureClient();
    const payload = await this.backend.raw(
      "RESIZE",
      String(a.width),
      a.blob,
      String(ow),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async cmp(
    a: EncryptedInt,
    b: EncryptedInt,
    rel: "lt" | "le" | "gt" | "ge" | "eq" | "ne",
  ): Promise<EncryptedInt> {
    await this.ensureClient();
    if (a.width !== b.width) throw new Error("cmp widths must match");
    const payload = await this.backend.raw(
      "CMP",
      rel,
      String(a.width),
      a.blob,
      b.blob,
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async mux(
    sel: EncryptedInt,
    a: EncryptedInt,
    b: EncryptedInt,
  ): Promise<EncryptedInt> {
    await this.ensureClient();
    if (a.width !== b.width) throw new Error("mux widths must match");
    const sel1 = await this.resize(sel, 1);
    const payload = await this.backend.raw(
      "MUX",
      sel1.blob,
      String(a.width),
      a.blob,
      b.blob,
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async divConst(
    a: EncryptedInt,
    d: bigint | number,
    ow?: number,
  ): Promise<EncryptedInt> {
    await this.ensureClient();
    const outW = ow ?? a.width;
    const payload = await this.backend.raw(
      "DIVCONST",
      String(a.width),
      a.blob,
      String(d),
      String(outW),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async div(
    a: EncryptedInt,
    b: EncryptedInt,
    ow?: number,
  ): Promise<EncryptedInt> {
    await this.ensureClient();
    if (a.width !== b.width) throw new Error("div widths must match");
    const outW = ow ?? a.width;
    const payload = await this.backend.raw(
      "DIV",
      String(a.width),
      a.blob,
      String(b.width),
      b.blob,
      String(outW),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }

  private async binop(
    op: "ADD" | "SUB" | "AND" | "OR" | "XOR",
    a: EncryptedInt,
    b: EncryptedInt,
    w: number,
  ): Promise<EncryptedInt> {
    if (a.width !== w || b.width !== w) throw new Error("binop width mismatch");
    const payload = await this.backend.raw(op, String(w), a.blob, b.blob);
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }

  private async unop(op: "NOT", a: EncryptedInt, w: number): Promise<EncryptedInt> {
    const payload = await this.backend.raw(op, String(w), a.blob);
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }

  private async withOp(op: string, a: EncryptedInt, arg: string): Promise<EncryptedInt> {
    const payload = await this.backend.raw(op, String(a.width), a.blob, arg);
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }

  getCloudPath(): string {
    return this.cloudPath;
  }
}

/**
 * TfheEvaluator: chỉ có cloud key, compute trên ciphertext, không thể ENC/DEC.
 * Dùng cho node coprocessor off-chain.
 */
export class TfheEvaluator {
  private backend: TfheBackend;
  private mode: { kind: "evaluator"; params: TfheParams } | null = null;
  private readonly width: number;
  private readonly ready: Promise<void>;

  constructor(backend: TfheBackend, width = 16) {
    this.backend = backend;
    this.width = width;
    this.ready = Promise.resolve();
  }

  async loadCloudKey(cloudKeyPath: string): Promise<TfheParams> {
    if (!fs.existsSync(cloudKeyPath)) {
      throw new Error(`cloud key not found: ${cloudKeyPath}`);
    }
    const payload = await this.backend.raw("LOADCLOUD", cloudKeyPath);
    const toks = payload.split(" ");
    if (toks[0] !== "evaluator") throw new Error("unexpected LOADCLOUD response");
    this.mode = {
      kind: "evaluator",
      params: {
        n: Number(toks[1]),
        N: Number(toks[2]),
        k: Number(toks[3]),
        l: Number(toks[4]),
        Bgbit: Number(toks[5]),
      },
    };
    return { ...this.mode.params };
  }

  private async ensureEvaluator(): Promise<void> {
    await this.ready;
    if (!this.mode) throw new Error("no cloud key loaded");
  }

  params(): TfheParams {
    if (!this.mode) throw new Error("no cloud key loaded");
    return { ...this.mode.params };
  }

  isEvaluator(): boolean {
    return this.mode?.kind === "evaluator";
  }

  async add(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    return this.binop("ADD", a, b, a.width);
  }
  async sub(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    return this.binop("SUB", a, b, a.width);
  }
  async and(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    return this.binop("AND", a, b, a.width);
  }
  async or(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    return this.binop("OR", a, b, a.width);
  }
  async xor(a: EncryptedInt, b: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    return this.binop("XOR", a, b, a.width);
  }
  async not(a: EncryptedInt): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    return this.unop("NOT", a, a.width);
  }
  async constant(value: bigint | number): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    const v = typeof value === "bigint" ? value.toString() : String(value);
    const payload = await this.backend.raw("CONST", String(this.width), v);
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async addConst(a: EncryptedInt, c: bigint | number): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    return this.resize(await this.withOp("ADDCONST", a, String(c)), a.width);
  }
  async mulConst(
    a: EncryptedInt,
    c: bigint | number,
    ow?: number,
  ): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    const outW = ow ?? this.width;
    const payload = await this.backend.raw(
      "MULCONST",
      String(a.width),
      a.blob,
      String(c),
      String(outW),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async mul(
    a: EncryptedInt,
    b: EncryptedInt,
    ow?: number,
  ): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    const outW = ow ?? a.width + b.width;
    const payload = await this.backend.raw(
      "MUL",
      String(a.width),
      a.blob,
      String(b.width),
      b.blob,
      String(outW),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async shr(a: EncryptedInt, sh: number): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    const payload = await this.backend.raw(
      "SHR",
      String(a.width),
      a.blob,
      String(sh),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async resize(a: EncryptedInt, ow: number): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    const payload = await this.backend.raw(
      "RESIZE",
      String(a.width),
      a.blob,
      String(ow),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async cmp(
    a: EncryptedInt,
    b: EncryptedInt,
    rel: "lt" | "le" | "gt" | "ge" | "eq" | "ne",
  ): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    if (a.width !== b.width) throw new Error("cmp widths must match");
    const payload = await this.backend.raw(
      "CMP",
      rel,
      String(a.width),
      a.blob,
      b.blob,
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async mux(
    sel: EncryptedInt,
    a: EncryptedInt,
    b: EncryptedInt,
  ): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    if (a.width !== b.width) throw new Error("mux widths must match");
    const sel1 = await this.resize(sel, 1);
    const payload = await this.backend.raw(
      "MUX",
      sel1.blob,
      String(a.width),
      a.blob,
      b.blob,
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async divConst(
    a: EncryptedInt,
    d: bigint | number,
    ow?: number,
  ): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    const outW = ow ?? a.width;
    const payload = await this.backend.raw(
      "DIVCONST",
      String(a.width),
      a.blob,
      String(d),
      String(outW),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
  async div(
    a: EncryptedInt,
    b: EncryptedInt,
    ow?: number,
  ): Promise<EncryptedInt> {
    await this.ensureEvaluator();
    if (a.width !== b.width) throw new Error("div widths must match");
    const outW = ow ?? a.width;
    const payload = await this.backend.raw(
      "DIV",
      String(a.width),
      a.blob,
      String(b.width),
      b.blob,
      String(outW),
    );
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }

  private async binop(
    op: "ADD" | "SUB" | "AND" | "OR" | "XOR",
    a: EncryptedInt,
    b: EncryptedInt,
    w: number,
  ): Promise<EncryptedInt> {
    if (a.width !== w || b.width !== w) throw new Error("binop width mismatch");
    const payload = await this.backend.raw(op, String(w), a.blob, b.blob);
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }

  private async unop(op: "NOT", a: EncryptedInt, w: number): Promise<EncryptedInt> {
    const payload = await this.backend.raw(op, String(w), a.blob);
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }

  private async withOp(op: string, a: EncryptedInt, arg?: string): Promise<EncryptedInt> {
    const args = arg === undefined
      ? [String(a.width), a.blob]
      : [String(a.width), a.blob, arg];
    const payload = await this.backend.raw(op, ...args);
    const toks = payload.split(" ");
    return { width: Number(toks[0]), blob: toks[1], backend: "tfhe-cggi" };
  }
}

/**
 * Factory: backend có thể là C++ worker (hiện tại) hoặc TFHE-rs (sau).
 */
export async function makeTfhe(opts: {
  role: "client";
  backend?: TfheBackend;
  workerPath?: string;
  width?: number;
  security?: 80 | 128;
}): Promise<{ backend: TfheBackend; worker: TfheBackend; crypto: TfheClient; role: "client" }>;
export async function makeTfhe(opts: {
  role: "evaluator";
  backend?: TfheBackend;
  workerPath?: string;
  cloudKeyPath: string;
  width?: number;
}): Promise<{
  backend: TfheBackend;
  worker: TfheBackend;
  crypto: TfheEvaluator;
  role: "evaluator";
}>;
export async function makeTfhe(opts: {
  role: "client" | "evaluator";
  backend?: TfheBackend;
  workerPath?: string;
  cloudKeyPath?: string;
  width?: number;
  security?: 80 | 128;
}): Promise<{
  backend: TfheBackend;
  crypto: TfheClient | TfheEvaluator;
  worker: TfheBackend;
  role: "client" | "evaluator";
}> {
  const width = opts.width ?? 16;
  const security = opts.security ?? 128;
  const backend =
    opts.backend ??
    new CppTfheBackend(opts.workerPath ?? DEFAULT_WORKER);

  if (opts.role === "client") {
    const crypto = new TfheClient(backend, width, security);
    await crypto.ready;
    return { backend, worker: backend, crypto, role: "client" };
  }
  if (!opts.cloudKeyPath) {
    throw new Error("cloudKeyPath required for evaluator role");
  }
  const crypto = new TfheEvaluator(backend, width);
  await crypto.loadCloudKey(opts.cloudKeyPath);
  return { backend, worker: backend, crypto, role: "evaluator" };
}
