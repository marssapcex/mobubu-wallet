import { AbiCoder, getAddress, id, getBytes, hexlify, sha256, ZeroAddress } from 'ethers';
import { slh_dsa_sha2_128s } from '@noble/post-quantum/slh-dsa.js';
import { destination, pqSign, pqVerify, unixSeconds } from '../../swap/src/protocol.mjs';
import { ZERO, assetFor, baseUnits, bytes, concat, hex, readNote, createNote, word, nonzero32, noteNullifier, merkleRoot } from './notes.mjs';
import { openWithdrawalQuote } from './withdrawal-quote.mjs';

const abi = AbiCoder.defaultAbiCoder();
export const EXIT_DOMAIN = id('mobubu:shielded-pool:exit:v1');
export const EXIT_TUPLE = 'tuple(bytes32 root,uint32 count,bytes32 nullifier,uint128 debit,bytes32 change,bytes32 destination,bytes32 recipient,uint128 amountOut,bytes32 quote,bytes32 key,uint64 deadline,address submitter)';
export const exitMessage = (domain, terms) => abi.encode(['bytes32', 'bytes32', EXIT_TUPLE], [EXIT_DOMAIN, domain, terms]);
export const journalBytes = (domain, terms) => abi.encode(['bytes32','bytes32','uint32','bytes32','uint128','bytes32','bytes32'],
  [domain, terms.root, terms.count, terms.nullifier, terms.debit, terms.change, sha256(exitMessage(domain, terms))]);

export function witnessBytes(note, path, changeNote) {
  return hex(concat(bytes(note.secret, 32), word(BigInt(note.value), 16), word(BigInt(path.index), 4),
    ...path.siblings.map((x) => bytes(x, 32)), bytes(changeNote?.secret ?? ZERO, 32)));
}

/** Authorization preparation only. The signer's proof and the canonical root
 * still need to be verified. Never send the nonenumerable witness/changeNote. */
async function prepareExit({ note, anchor, debit, recipient, submitter, deadline, now, leg }) {
  debit = baseUnits(debit, note.asset);
  const value = BigInt(note.value);
  if (debit > value) throw new Error('amount exceeds this note');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(deadline) || deadline <= now || deadline - now > 3_600) throw new Error('invalid exit deadline');
  const { siblings, index, count, root } = anchor;
  // Snapshot the path before async hashing so the witness uses the same authenticated data.
  const path = { index, siblings: [...siblings] };
  if (await merkleRoot(note.leaf, index, path.siblings, count) !== root) throw new Error('path does not open to the selected root');
  const relay = getAddress(submitter);
  if (relay === ZeroAddress) throw new Error('zero submitter');
  const changeNote = value !== debit ? await createNote({ asset: note.asset, domain: note.domain, value: value - debit }) : null;
  const { publicKey, secretKey } = slh_dsa_sha2_128s.keygen();
  try {
    const terms = Object.freeze({ root, count, nullifier: await noteNullifier(note.domain, note.secret, note.leaf), debit,
      change: changeNote?.leaf ?? ZERO, destination: leg.domain, recipient: leg.recipientHash, amountOut: leg.out, quote: leg.quote,
      key: hexlify(publicKey), deadline, submitter: relay });
    const message = exitMessage(note.domain, terms);
    const pack = { terms, recipient, signature: pqSign(secretKey, terms.key, getBytes(message)), journal: journalBytes(note.domain, terms) };
    Object.defineProperties(pack, { witness: { value: witnessBytes(note, path, changeNote) }, changeNote: { value: changeNote } });
    return Object.freeze(pack);
  } finally { secretKey.fill(0); }
}

export async function prepareLocalExit({ note: raw, anchor, debit, recipient, submitter, deadline, now = unixSeconds() }) {
  const note = await readNote(raw);
  if (assetFor(note.asset).symbol === 'BTC') throw new Error('BTC exits do not execute in the EVM vault');
  const to = getAddress(recipient);
  if (to === ZeroAddress) throw new Error('zero exit address');
  return prepareExit({ note, anchor, debit, recipient: to, submitter, deadline, now,
    leg: { domain: note.domain, recipientHash: sha256(to), out: baseUnits(debit, note.asset), quote: ZERO } });
}

/** Cross-chain plan only; this cannot submit to either chain or spend a note.
 * The caller pins targetDomain and policy from its deployment, not the desk. */
export async function prepareQuotedExit({ note: raw, anchor, client, request, reply, deskKey, targetDomain,
  recipient, policy, submitter, deadline, now = unixSeconds }) {
  const note = await readNote(raw);
  const quote = await openWithdrawalQuote({ client, request, reply, deskKey, now });
  if (quote.source !== note.domain || quote.from !== note.asset || quote.destination !== targetDomain ||
      targetDomain === note.domain || deadline > quote.expires) throw new Error('quote does not match the selected pools or deadline');
  const payee = destination(policy, assetFor(quote.to).symbol, recipient);
  return prepareExit({ note, anchor, debit: quote.debit, recipient: payee.address, submitter, deadline, now: now(),
    leg: { domain: targetDomain, recipientHash: payee.hash, out: quote.out, quote: quote.id } });
}

export function verifyExitSignature(domain, terms, signature) {
  nonzero32(domain);
  return pqVerify(terms.key, getBytes(exitMessage(domain, terms)), signature);
}
