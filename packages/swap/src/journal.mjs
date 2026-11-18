import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { encode } from './protocol.mjs';

function open(path) {
  if (path === ':memory:') throw new Error('settlement requires a persistent journal path');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('journal must be a private regular file');
  } finally { closeSync(fd); }
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;'); }
  catch (e) { db.close(); throw e; }
  return db;
}
function atomic(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function pin(db, domain, identity) {
  db.exec('CREATE TABLE IF NOT EXISTS journal_identity (slot INTEGER PRIMARY KEY CHECK(slot=1), domain TEXT NOT NULL, id TEXT NOT NULL) STRICT;');
  db.prepare('INSERT OR IGNORE INTO journal_identity VALUES (1, ?, ?)').run(domain, identity);
  const actual = db.prepare('SELECT domain, id FROM journal_identity WHERE slot=1').get();
  if (actual.domain !== domain || actual.id !== identity) throw new Error('journal is for another role, key or deployment');
}

export function openJournal(path, deployment) {
  const db = open(path);
  try {
    pin(db, 'mobubu-swap-coordinator-v1', deployment);
    db.exec(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, user_nonce TEXT NOT NULL UNIQUE, proof TEXT NOT NULL,
      funding_key TEXT UNIQUE, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS spend_claims (resource TEXT PRIMARY KEY, owner TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS btc_reserves (txid TEXT NOT NULL, idx INTEGER NOT NULL, PRIMARY KEY(txid,idx)) STRICT;`);
  } catch (e) { db.close(); throw e; }
  const addReserve = db.prepare('INSERT OR IGNORE INTO btc_reserves VALUES (?, ?)');
  return Object.freeze({
    deployment,
    register(id, userNonce, signed) {
      return atomic(db, () => {
        const old = db.prepare('SELECT id FROM orders WHERE user_nonce=?').get(userNonce);
        if (old) {
          if (old.id !== id) throw new Error('swap nonce already claimed by a different order');
          return;
        }
        db.prepare('INSERT INTO orders (id,user_nonce,proof,state) VALUES (?,?,?,?)')
          .run(id, userNonce, encode(signed), encode({ phase: 'funding' }));
      });
    },
    get(id) {
      const row = db.prepare('SELECT proof, revision, state FROM orders WHERE id=?').get(id);
      if (!row) throw new Error('unknown swap order');
      return { revision: row.revision, signed: JSON.parse(row.proof), state: JSON.parse(row.state) };
    },
    // The immutable funding identity and the chosen spend nonce/outpoint are claimed
    // in the same transaction as the versioned state update. No network I/O in a DB transaction.
    update(id, revision, state, { fundingKey, resource, reserves = [] } = {}) {
      return atomic(db, () => {
        const row = db.prepare('SELECT revision, funding_key FROM orders WHERE id=?').get(id);
        if (row?.revision !== revision) return false;
        if (fundingKey && db.prepare('SELECT id FROM orders WHERE funding_key=?').get(fundingKey)) throw new Error('funding receipt already used');
        if (resource && !db.prepare('INSERT OR IGNORE INTO spend_claims VALUES (?,?)').run(resource, id).changes) return false;
        db.prepare('UPDATE orders SET revision=revision+1, state=?, funding_key=? WHERE id=?')
          .run(encode(state), fundingKey ?? row.funding_key, id);
        for (const ref of reserves) addReserve.run(ref.txid, ref.index);
        return true;
      });
    },
    addReserve(ref) { addReserve.run(ref.txid, ref.index); },
    reserves() { return db.prepare('SELECT txid, idx AS "index" FROM btc_reserves ORDER BY txid, idx').all(); },
    claimed(resource) { return !!db.prepare('SELECT 1 FROM spend_claims WHERE resource=?').get(resource); },
    active() { return db.prepare("SELECT id FROM orders WHERE json_extract(state,'$.phase') NOT IN ('paid','refunded','review') ORDER BY rowid").all().map((r) => r.id); },
    close() { db.close(); },
  });
}

export function openSignerJournal(path, deployment, key) {
  const db = open(path);
  try {
    pin(db, 'mobubu-swap-btc-cosigner-v1', `${deployment}:${key}`);
    db.exec('CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, resource TEXT NOT NULL UNIQUE, plan TEXT NOT NULL) STRICT;');
  } catch (e) { db.close(); throw e; }
  return Object.freeze({
    approve(signer, id, resource, digest) {
      if (signer !== key) throw new Error('wrong signer journal');
      atomic(db, () => {
        const previous = db.prepare('SELECT resource, plan FROM approvals WHERE id=?').get(id);
        if (previous) {
          if (previous.resource !== resource || previous.plan !== digest) throw new Error('cosigner already committed a different spend');
          return;
        }
        if (db.prepare('SELECT id FROM approvals WHERE resource=?').get(resource)) throw new Error('cosigner already reserved this UTXO');
        db.prepare('INSERT INTO approvals VALUES (?,?,?)').run(id, resource, digest);
      });
    },
    close() { db.close(); },
  });
}
