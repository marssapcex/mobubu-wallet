import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class OperatorError extends Error {}
export function need(ok, message) {
  if (!ok) throw new OperatorError(message);
}

export const json = (data) => `${JSON.stringify(data, (_, v) => typeof v === 'bigint' ? String(v) : v, 2)}\n`;

export function privateText(path, maxSize = 2 * 1024 ** 2) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    need(st.isFile() && st.uid === process.getuid() && (st.mode & 0o077) === 0 && st.size <= maxSize,
      'Use a regular, owner-only file (chmod 600) within the size limit.');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export function outsideSource(path) {
  let source = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  for (let p = source; dirname(p) !== p; p = dirname(p)) {
    if (existsSync(join(p, '.git'))) { source = p; break; }
  }
  // Resolve existing parents, not just the spelling of a potentially symlinked directory.
  function physical(p) {
    if (existsSync(p)) return realpathSync(p);
    const parent = physical(dirname(p));
    return join(parent, relative(dirname(p), p));
  }
  const candidate = physical(resolve(path));
  const rel = relative(source, candidate);
  need(rel === '..' || rel.startsWith('../') || isAbsolute(rel), 'Keep signing keys and wallet state outside the source checkout.');
  return candidate;
}

export class Store {
  constructor(root) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.root);
    need(st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0,
      'Use an owner-only state directory (chmod 700).');
  }

  path(name) {
    need(/^[a-z0-9][a-zA-Z0-9_.-]{0,180}$/.test(name), 'Invalid state filename.');
    return join(this.root, name);
  }

  has(name) { return existsSync(this.path(name)); }

  read(name) {
    need(this.has(name), `Missing local ${name}.`);
    try { return JSON.parse(privateText(this.path(name))); }
    catch (e) { if (e instanceof OperatorError) throw e; throw new OperatorError(`Cannot read local ${name}.`); }
  }

  write(name, data) {
    const target = this.path(name);
    const tmp = this.path(`tmp-${randomBytes(12).toString('hex')}`);
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(fd, json(data)); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(tmp, target);
      const dir = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { rmSync(tmp, { force: true }); }
  }

  scratch() { return mkdtempSync(join(this.root, 'scratch-')); }

  async locked(run) {
    const lock = this.path('wallet.lock');
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code === 'EEXIST') throw new OperatorError('State is locked. If the previous process crashed, verify it is gone before removing wallet.lock.');
      throw e;
    }
    try { return await run(); }
    finally { rmdirSync(lock); }
  }
}

export function loadSignerKey(path) {
  need(typeof path === 'string' && path.length > 0, 'Set NATIVE_SIGNER_FILE to a local testnet-only key file (mode 600).');
  try {
    const at = outsideSource(path);
    need(!lstatSync(resolve(path)).isSymbolicLink(), 'Signer file cannot be a symlink.');
    const key = privateText(at, 256).trim().replace(/^0x/, '');
    need(/^[0-9a-f]{64}$/i.test(key), 'Signer file must contain exactly one 32-byte hex test key.');
    return `0x${key}`;
  } catch (e) {
    if (e instanceof OperatorError) throw e;
    throw new OperatorError('Could not read NATIVE_SIGNER_FILE.');
  }
}
