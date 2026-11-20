import { AbiCoder, Contract, Interface, ZeroAddress, ZeroHash, getAddress, getBytes, hexlify, id } from "ethers";
import { slh_dsa_sha2_128s as slh } from "@noble/post-quantum/slh-dsa.js";

export const DEPOSIT = 1;
export const WITHDRAW = 2;
export const AUTH_DOMAIN = id("mobubu:SLH-DSA-SHA2-128s:eth-vault:v1");
export const PUBLIC_KEY_BYTES = 32;
export const SECRET_KEY_BYTES = 64;
export const SIGNATURE_BYTES = 7856;
export const PQ_VAULT_ABI = Object.freeze([
  "function AUTH_DOMAIN() view returns (bytes32)",
  "function ASSET() view returns (address)",
  "function DEPOSIT() view returns (uint8)",
  "function WITHDRAW() view returns (uint8)",
  "function accounts(bytes32 publicKey) view returns (uint256 balance, uint256 nonce)",
  "function totalLocked() view returns (uint256)",
  "function authorizationMessage(uint8 action, bytes32 publicKey, address party, uint256 amount, uint256 nonce, uint64 deadline) view returns (bytes)",
  "function deposit(bytes32 publicKey, uint256 nonce, uint64 deadline, bytes signature) payable",
  "function withdraw(bytes32 publicKey, address recipient, uint256 amount, uint256 nonce, uint64 deadline, bytes signature)",
  "error InvalidPublicKey()",
  "error InvalidAmount()",
  "error InvalidRecipient()",
  "error AuthorizationExpired()",
  "error InvalidNonce()",
  "error InvalidSignature()",
  "error InsufficientBalance()",
  "error TransferFailed()",
  "error ReentrantCall()",
  "event Deposit(bytes32 indexed publicKey, address indexed payer, uint256 amount, uint256 nonce)",
  "event Withdrawal(bytes32 indexed publicKey, address indexed recipient, uint256 amount, uint256 nonce)",
]);
const iface = new Interface(PQ_VAULT_ABI);
const abi = AbiCoder.defaultAbiCoder();
const TYPES = Object.freeze([
  "bytes32", "uint256", "address", "address", "uint8", "bytes32", "address", "uint256", "uint256", "uint64",
]);

function uint(value, bits, name, { positive = false } = {}) {
  let n;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) n = BigInt(value);
  else throw new TypeError(`${name} must be an exact unsigned integer`);
  if (n < (positive ? 1n : 0n) || n >= (1n << BigInt(bits))) throw new RangeError(`${name} is out of range`);
  return n;
}

function fixedBytes(value, length, name) {
  const bytes = getBytes(value, name);
  if (bytes.length !== length) throw new RangeError(`${name} must be ${length} bytes`);
  return bytes;
}

function address(value, name) {
  const result = getAddress(value);
  if (result === ZeroAddress) throw new RangeError(`${name} cannot be zero`);
  return result;
}

function intent(request) {
  const { action } = request;
  if (action !== DEPOSIT && action !== WITHDRAW) throw new TypeError("unsupported vault action");
  const publicKey = hexlify(fixedBytes(request.publicKey, PUBLIC_KEY_BYTES, "public key"));
  if (publicKey === ZeroHash) throw new RangeError("public key cannot be zero");
  const vault = address(request.vault, "vault");
  const party = address(request.party, action === DEPOSIT ? "payer" : "recipient");
  if (action === WITHDRAW && party === vault) throw new RangeError("recipient cannot be the vault");
  // The only accepted asset is native ETH. Do not silently sign another asset.
  if (request.asset !== undefined && getAddress(request.asset) !== ZeroAddress) throw new TypeError("native ETH only");
  return {
    action, publicKey, party, vault,
    chainId: uint(request.chainId, 256, "chain ID", { positive: true }),
    amount: uint(request.amount, 256, "wei", { positive: true }),
    nonce: uint(request.nonce, 256, "nonce"),
    deadline: uint(request.deadline, 64, "deadline", { positive: true }),
  };
}

function message(info) {
  const { chainId, vault, action, publicKey, party, amount, nonce, deadline } = info;
  return abi.encode(TYPES, [AUTH_DOMAIN, chainId, vault, ZeroAddress, action, publicKey, party, amount, nonce, deadline]);
}

/** Creates a key from the Noble library's OS/Web Crypto randomness. Back up the secret locally. */
export function createVaultKey() {
  const { publicKey, secretKey } = slh.keygen();
  return { publicKey: hexlify(publicKey), secretKey };
}

/** Canonical authorization bytes, signed using pure SLH-DSA with empty context. */
export function authorizationMessage(request) {
  return message(intent(request));
}

/** Signs locally. The secret is never passed to a contract or RPC provider. */
export function signAuthorization(secretKey, request) {
  const info = intent(request);
  // Do not use an ABI/hex decoder that could include a malformed secret in an error.
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== SECRET_KEY_BYTES) {
    throw new TypeError(`secret key must be a ${SECRET_KEY_BYTES}-byte Uint8Array`);
  }
  if (hexlify(slh.getPublicKey(secretKey)) !== info.publicKey) throw new Error("secret key does not match the account");
  return hexlify(slh.sign(getBytes(message(info)), secretKey));
}

export function verifyAuthorization(request, signature) {
  try {
    const info = intent(request);
    return slh.verify(fixedBytes(signature, SIGNATURE_BYTES, "signature"), getBytes(message(info)), getBytes(info.publicKey));
  } catch {
    return false;
  }
}

/** Encodes a transaction for a payer (deposit) or any gas relayer (withdrawal). Does not send it. */
export function encodeVaultTransaction(request, signature) {
  const info = intent(request);
  const sig = hexlify(fixedBytes(signature, SIGNATURE_BYTES, "signature"));
  const { action, publicKey, party, vault, chainId, amount, nonce, deadline } = info;
  return Object.freeze(action === DEPOSIT ? {
    chainId, to: vault, from: party, value: amount,
    data: iface.encodeFunctionData("deposit", [publicKey, nonce, deadline, sig]),
  } : {
    chainId, to: vault, value: 0n,
    data: iface.encodeFunctionData("withdraw", [publicKey, party, amount, nonce, deadline, sig]),
  });
}

/** Reader for balances and nonces. Its provider is not a spending authority. */
export function connectVault(vault, runner) {
  return new Contract(address(vault, "vault"), PQ_VAULT_ABI, runner);
}
