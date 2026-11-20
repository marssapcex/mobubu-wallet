// Ordinary Osaka EVM, no override or payout. Exercise only two costs of
// porting jl_sample_mat: dense memory expansion and streaming AES-128-CTR.
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractDecoder, EdrContext, L1_CHAIN_TYPE, L1Hardfork, MineOrdering,
  l1GenesisState, l1HardforkToString, l1ProviderFactory,
} from "@nomicfoundation/edr";
import { BrowserProvider, ContractFactory, computeAddress, getBytes, parseEther, toBeHex } from "ethers";
import solc from "solc";

const root = fileURLToPath(new URL("../../", import.meta.url));
const build = resolve(process.env.MOBUBU_LAZER_BUILD_DIR ?? resolve(root, "build/lazer-spend"));
const measurements = JSON.parse(readFileSync(resolve(build, "measurements.json"), "utf8"));
const CAP = 16_777_216n;

function mul(a, b) {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) out ^= a;
    a = ((a << 1) & 255) ^ (a & 128 ? 0x1b : 0);
    b >>= 1;
  }
  return out;
}

const sbox = Buffer.from(Array.from({ length: 256 }, (_, x) => {
  let inv = 1;
  for (let i = 0; i < 254; i++) inv = mul(inv, x);
  const rotate = (n) => (inv << n | inv >>> (8 - n)) & 255;
  return inv ^ rotate(1) ^ rotate(2) ^ rotate(3) ^ rotate(4) ^ 0x63;
}));

function tables() {
  const table = Buffer.alloc(4 * 256 * 4);
  for (let j = 0; j < 256; j++) {
    const s = sbox[j];
    const col = [mul(s, 2), s, s, mul(s, 3)];
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < 4; i++) table[(row * 256 + j) * 4 + i] = col[(i - row + 4) % 4];
    }
  }
  return Buffer.concat([table, sbox]);
}

function roundKeys(key) {
  const keys = Buffer.alloc(176);
  key.copy(keys);
  for (let pos = 16, rcon = 1; pos < keys.length; pos += 4) {
    let tail = keys.subarray(pos - 4, pos);
    if (pos % 16 === 0) {
      tail = [sbox[tail[1]] ^ rcon, sbox[tail[2]], sbox[tail[3]], sbox[tail[0]]];
      rcon = mul(rcon, 2);
    }
    for (let j = 0; j < 4; j++) keys[pos + j] = tail[j] ^ keys[pos - 16 + j];
  }
  return keys;
}

const xor = (terms) => terms.reduce((a, b) => `xor(${a},${b})`);
// 128-bit AES state in the low half of the word, column-major.
const stateByte = (column, row) => `byte(${16 + 4 * ((column + row) % 4) + row},s)`;
const mixedRound = xor(Array.from({ length: 4 }, (_, column) => `shl(${32 * (3 - column)},${xor(
  Array.from({ length: 4 }, (_, row) =>
    `shr(224,mload(add(add(t,${row * 1024}),shl(2,${stateByte(column, row)}))))`),
)})`));
const finalRound = xor(Array.from({ length: 16 }, (_, i) => (
  `shl(${8 * (15 - i)},shr(248,mload(add(add(t,4096),${stateByte(i >> 2, i % 4)}))))`
)));
const source = `
pragma solidity 0.8.24;
contract JLProbe {
    function reserve(uint end) external pure returns (uint256) {
        require(end >= 160);
        assembly ("memory-safe") {
            let pos := sub(end, 32)
            if lt(pos, mload(0x40)) { revert(0, 0) }
            mstore(pos, 1)
            return(pos, 32)
        }
    }
    // Supply the already expanded round keys to understate work for the probe.
    // Stream, folding outputs to prevent the optimizer discarding the AES calls.
    function stream(bytes calldata keys, uint32 blocks) external pure returns (bytes16 result) {
        require(keys.length == 176 && blocks != 0 && blocks <= 1024);
        // Padding keeps the full final mload inside this memory allocation.
        bytes memory table = hex"${tables().toString("hex")}${"00".repeat(32)}";
        assembly ("memory-safe") {
            function rk(ptr, i) -> r { r := shr(128, calldataload(add(ptr, shl(4,i)))) }
            function round(s, t) -> r { r := ${mixedRound} }
            function last(s, t) -> r { r := ${finalRound} }
            let t := add(table, 32)
            let v := 0
            for { let i := 0 } lt(i, blocks) { i := add(i, 1) } {
                // nonce 0 || uint64le(counter), as in the pinned C AES sampler.
                let ctr := or(or(shl(56,and(i,255)),shl(40,and(i,65280))),
                              or(shl(24,and(i,16711680)),shl(8,and(i,4278190080))))
                let s := xor(ctr, rk(keys.offset,0))
                for { let r := 1 } lt(r, 10) { r := add(r, 1) } {
                    s := xor(round(s,t),rk(keys.offset,r))
                }
                v := xor(v,xor(last(s,t),rk(keys.offset,10)))
            }
            result := shl(128,v)
        }
    }
}`;

function compile() {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources: { "JLProbe.sol": { content: source } },
    settings: {
      evmVersion: "paris", viaIR: true, optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  })));
  const errors = (out.errors ?? []).filter((error) => error.severity === "error");
  assert.equal(errors.length, 0, errors.map((e) => e.formattedMessage).join("\n"));
  return out.contracts["JLProbe.sol"].JLProbe;
}

async function localEvm() {
  const context = new EdrContext();
  await context.registerProviderFactory(L1_CHAIN_TYPE, l1ProviderFactory());
  const fork = L1Hardfork.Osaka;
  const key = toBeHex(1, 32); // public local fixture, not a wallet key
  const blockGasLimit = 30_000_000n;
  const edr = await context.createProvider(L1_CHAIN_TYPE, {
    allowBlocksWithSameTimestamp: true, allowUnlimitedContractSize: false,
    bailOnCallFailure: true, bailOnTransactionFailure: false,
    chainId: 31_337n, networkId: 31_337n, coinbase: new Uint8Array(20),
    hardfork: l1HardforkToString(fork), initialBaseFeePerGas: 1_000_000_000n, minGasPrice: 0n,
    genesisState: [...l1GenesisState(fork), { address: getBytes(computeAddress(key)), balance: parseEther("10000") }],
    mining: { autoMine: true, blockGasLimit, memPool: { order: MineOrdering.Fifo } },
    network: { genesisBlockGasLimit: blockGasLimit },
    ownedAccounts: [key], observability: {}, precompileOverrides: [],
  }, { enable: false, decodeConsoleLogInputsCallback: () => [], printLineCallback: () => {} },
  { subscriptionCallback: () => {} }, new ContractDecoder());
  let id = 0;
  return new BrowserProvider({ async request({ method, params }) {
    const { data } = await edr.handleRequest(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }));
    const { error, result } = typeof data === "string" ? JSON.parse(data) : data;
    if (error) throw new Error(error.message);
    return result;
  } }, undefined, { cacheTimeout: -1 });
}

function aesReference(key, n) {
  const input = Buffer.alloc(16 * n);
  for (let i = 0; i < n; i++) input.writeBigUInt64LE(BigInt(i), 16 * i + 8);
  const cipher = createCipheriv("aes-128-ecb", key, null).setAutoPadding(false);
  const output = Buffer.concat([cipher.update(input), cipher.final()]);
  const result = Buffer.alloc(16);
  for (let i = 0; i < output.length; i++) result[i % 16] ^= output[i];
  return `0x${result.toString("hex")}`;
}

const memoryCost = (size) => {
  const words = (BigInt(size) + 31n) / 32n;
  return words * 3n + words * words / 512n;
};

const { abi, evm } = compile();
const provider = await localEvm();
try {
  const signer = await provider.getSigner();
  const probe = await new ContractFactory(abi, `0x${evm.bytecode.object}`, signer).deploy();
  await probe.waitForDeployment();
  async function send(method, args) {
    const payload = probe.interface.encodeFunctionData(method, args);
    const tx = await signer.sendTransaction({ to: probe.target, data: payload, gasLimit: CAP });
    const receipt = await provider.send("eth_getTransactionReceipt", [tx.hash]);
    assert.ok(receipt);
    return { status: Number(receipt.status), gas: BigInt(receipt.gasUsed) };
  }

  const small = await send("reserve", [1024 * 1024]);
  assert.equal(small.status, 1);
  assert.ok(small.gas >= memoryCost(1024 * 1024));
  const aesKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const keys = roundKeys(aesKey);
  for (const n of [1, 32, 64, 257]) assert.equal(await probe.stream(keys, n), aesReference(aesKey, n));
  const stream32 = await send("stream", [keys, 32]);
  const stream64 = await send("stream", [keys, 64]);
  assert.equal(stream32.status, 1);
  assert.equal(stream64.status, 1);
  const streamGasPerBlock = (stream64.gas - stream32.gas) / 32n;
  assert.ok(streamGasPerBlock > 0n);
  const summary = { fork: "osaka", tx_cap: CAP, reserve_1m_gas: small.gas,
    stream_32_gas: stream32.gas, stream_64_gas: stream64.gas, stream_gas_per_aes_block: streamGasPerBlock, depths: {} };
  for (const [depth, m] of Object.entries(measurements)) {
    const bound = memoryCost(m.jl_largest_buffer);
    assert.ok(bound > CAP);
    const full = await send("reserve", [m.jl_largest_buffer]);
    assert.equal(full.status, 0);
    assert.equal(full.gas, CAP);
    const aesBlocks = BigInt(m.jl_total_bytes) / 16n;
    summary.depths[depth] = {
      jl_largest_buffer: m.jl_largest_buffer, memory_expansion_only: bound,
      reserve_tx_status: full.status, reserve_tx_gas_used: full.gas,
      aes_blocks: aesBlocks, streaming_aes_only_extrapolation: aesBlocks * streamGasPerBlock,
    };
  }
  const json = JSON.stringify(summary, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";
  writeFileSync(resolve(build, "evm-measurements.json"), json);
  console.log(json.trimEnd());
} finally {
  provider.destroy();
}
