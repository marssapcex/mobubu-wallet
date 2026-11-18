import { randomBytes } from "node:crypto";

export const TREE_DEPTH = 20;
export const SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const SECRET_LIMIT = 1n << 248n;
const RECIPIENT_LIMIT = 1n << 160n;

export function unsigned(value, limit, field) {
  if (typeof value !== "bigint" && (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value))) {
    throw new TypeError(`${field} must be a bigint or canonical decimal string`);
  }
  const n = BigInt(value);
  if (n < 0n || n >= limit) throw new RangeError(`${field} is out of range`);
  return n;
}

export function nonzero(value, limit, field) {
  const n = unsigned(value, limit, field);
  if (n === 0n) throw new RangeError(`${field} must be nonzero`);
  return n;
}

/** The statement order is shared by witness validation and the Rust wire encoder. */
export function publicStatement({ root, nullifierHash, recipient, domain }) {
  return [
    nonzero(root, SCALAR_FIELD, "root"),
    nonzero(nullifierHash, SCALAR_FIELD, "nullifierHash"),
    nonzero(recipient, RECIPIENT_LIMIT, "recipient"),
    unsigned(domain, SCALAR_FIELD, "domain"),
  ];
}

function path(values, limit, field) {
  if (!Array.isArray(values) || values.length !== TREE_DEPTH) throw new RangeError(`${field} must have ${TREE_DEPTH} elements`);
  // Array.from visits holes, unlike .map(). All inputs must be present.
  return Array.from(values, (value) => unsigned(value, limit, field).toString());
}

export function sampleNoteSecret() {
  let value;
  do value = BigInt(`0x${randomBytes(31).toString("hex")}`);
  while (value === 0n);
  return value;
}

export function merkleWitnessPath(input) {
  return {
    pathElements: path(input.pathElements, SCALAR_FIELD, "pathElements"),
    pathIndices: path(input.pathIndices, 2n, "pathIndices"),
  };
}

export function withdrawalWitness(input) {
  const [root, nullifierHash, recipient, domain] = publicStatement(input).map(String);
  return {
    root, nullifierHash, recipient, domain,
    nullifier: nonzero(input.nullifier, SECRET_LIMIT, "nullifier").toString(),
    secret: nonzero(input.secret, SECRET_LIMIT, "secret").toString(),
    ...merkleWitnessPath(input),
  };
}
