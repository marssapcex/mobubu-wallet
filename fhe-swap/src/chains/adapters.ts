import { createHash } from "node:crypto";
import { ASSET_META, chainOf, type Asset, type Chain } from "../assets.js";
import type {
  InboundObservation,
  OutboundInstruction,
} from "../core/types.js";
import { JsonRpcClient, type JsonRpcConfig } from "./rpc.js";
import type { ChainAdapter } from "./types.js";

export interface RpcVaultConfig {
  address: string;
  requiredConfirmations: number;
}

export interface RpcAdapterConfig {
  rpc: JsonRpcConfig;
  vaults: Partial<Record<Asset, RpcVaultConfig>>;
}

abstract class BaseRpcAdapter implements ChainAdapter {
  abstract readonly chain: Chain;
  abstract readonly assets: readonly Asset[];
  protected readonly rpc: JsonRpcClient;
  protected readonly vaults: Partial<Record<Asset, RpcVaultConfig>>;

  constructor(cfg: RpcAdapterConfig) {
    this.rpc = new JsonRpcClient(cfg.rpc);
    this.vaults = cfg.vaults;
  }

  vaultAddress(asset: Asset): string {
    const vault = this.vaults[asset];
    if (!vault) throw new Error(`no vault configured for ${asset}`);
    return vault.address;
  }

  requiredConfirmations(asset: Asset): number {
    const vault = this.vaults[asset];
    if (!vault) throw new Error(`no vault configured for ${asset}`);
    return vault.requiredConfirmations;
  }

  abstract scanInbound(
    intentId: string,
    asset: Asset,
  ): Promise<InboundObservation | null>;
  abstract getConfirmations(txHash: string): Promise<number>;
  abstract buildOutbound(instruction: OutboundInstruction): Promise<string>;
  abstract broadcast(rawTx: string): Promise<string>;

  protected assertAsset(asset: Asset): void {
    if (!this.assets.includes(asset) || chainOf(asset) !== this.chain) {
      throw new Error(`asset ${asset} not supported on ${this.chain}`);
    }
  }
}

/**
 * Bitcoin Core watch-only + sendrawtransaction adapter.
 *
 * Scaffold only: `fheswap_findInbound` is a custom indexer RPC, not a Bitcoin
 * Core method. `buildOutbound` returns an unsigned PSBT placeholder, not a
 * broadcastable transaction. Do not point this at mainnet with real funds.
 */
export class BitcoinRpcAdapter extends BaseRpcAdapter {
  readonly chain = "bitcoin" as const;
  readonly assets = ["BTC"] as const;

  async scanInbound(
    intentId: string,
    asset: Asset,
  ): Promise<InboundObservation | null> {
    this.assertAsset(asset);
    // Production: use a vault indexer / electrum watcher keyed by OP_RETURN memoHash.
    // Core RPC alone does not index arbitrary OP_RETURN efficiently.
    const txid = await this.rpc.call<string | null>(
      "fheswap_findInbound",
      [this.vaultAddress(asset), intentId],
    ).catch(() => null);
    if (!txid) return null;
    const tx = await this.rpc.call<{
      confirmations?: number;
      vout: Array<{ value: number; scriptPubKey: { address?: string } }>;
    }>("getrawtransaction", [txid, true]);
    const sats = tx.vout
      .filter((o) => o.scriptPubKey.address === this.vaultAddress(asset))
      .reduce((acc, o) => acc + BigInt(Math.round(o.value * 1e8)), 0n);
    return {
      intentId,
      chain: this.chain,
      asset,
      txHash: txid,
      amountBaseUnits: sats,
      confirmations: tx.confirmations ?? 0,
      observedAt: Date.now(),
    };
  }

  async getConfirmations(txHash: string): Promise<number> {
    const tx = await this.rpc.call<{ confirmations?: number }>(
      "getrawtransaction",
      [txHash, true],
    );
    return tx.confirmations ?? 0;
  }

  async buildOutbound(instruction: OutboundInstruction): Promise<string> {
    this.assertAsset(instruction.asset);
    // Unsigned PSBT placeholder. Real signing happens in ThresholdSigner/FROST.
    return JSON.stringify({
      type: "psbt-unsigned",
      to: instruction.to,
      sats: instruction.amountBaseUnits.toString(),
      memoHash: instruction.memoHash ?? null,
    });
  }

  async broadcast(rawTx: string): Promise<string> {
    return this.rpc.call<string>("sendrawtransaction", [rawTx]);
  }
}

/**
 * Ethereum adapter for native ETH and ERC-20 DAI.
 *
 * Scaffold only: requires a custom `fheswap_findInbound` indexer and a real
 * EIP-1559 builder/threshold signer. The DAI log filter below is intentionally
 * strict about contract address, Transfer topic, and recipient.
 */
export class EthereumRpcAdapter extends BaseRpcAdapter {
  readonly chain = "ethereum" as const;
  readonly assets = ["ETH", "DAI"] as const;

  async scanInbound(
    intentId: string,
    asset: Asset,
  ): Promise<InboundObservation | null> {
    this.assertAsset(asset);
    const txHash = await this.rpc.call<string | null>(
      "fheswap_findInbound",
      [this.vaultAddress(asset), intentId, asset],
    ).catch(() => null);
    if (!txHash) return null;
    const receipt = await this.rpc.call<{
      blockNumber: string;
      status: string;
      logs: Array<{ address: string; data: string; topics: string[] }>;
    }>("eth_getTransactionReceipt", [txHash]);
    if (receipt.status !== "0x1") return null;

    let amount = 0n;
    const vault = this.vaultAddress(asset).toLowerCase();
    if (asset === "ETH") {
      const tx = await this.rpc.call<{ value: string; to: string }>(
        "eth_getTransactionByHash",
        [txHash],
      );
      if (tx.to?.toLowerCase() === vault) {
        amount = BigInt(tx.value);
      }
    } else if (asset === "DAI") {
      // DAI Transfer(address,address,uint256). Only count logs emitted by the
      // canonical DAI contract whose indexed `to` topic is this vault.
      const transferTopic =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const dai = ASSET_META.DAI.erc20!.contract.toLowerCase();
      const vaultTopic = `0x${vault.replace(/^0x/, "").padStart(64, "0")}`;
      for (const log of receipt.logs) {
        if (
          log.address.toLowerCase() === dai &&
          log.topics[0]?.toLowerCase() === transferTopic &&
          log.topics.length >= 3 &&
          log.topics[2]?.toLowerCase() === vaultTopic
        ) {
          amount += BigInt(log.data);
        }
      }
    } else {
      throw new Error(`Ethereum adapter cannot settle ${asset}`);
    }

    const head = await this.rpc.call<string>("eth_blockNumber", []);
    const confirmations =
      BigInt(head) - BigInt(receipt.blockNumber) + 1n;
    return {
      intentId,
      chain: this.chain,
      asset,
      txHash,
      amountBaseUnits: amount,
      confirmations: Number(confirmations < 0n ? 0n : confirmations),
      observedAt: Date.now(),
    };
  }

  async getConfirmations(txHash: string): Promise<number> {
    const receipt = await this.rpc.call<{ blockNumber: string } | null>(
      "eth_getTransactionReceipt",
      [txHash],
    );
    if (!receipt) return 0;
    const head = await this.rpc.call<string>("eth_blockNumber", []);
    const n = BigInt(head) - BigInt(receipt.blockNumber) + 1n;
    return Number(n < 0n ? 0n : n);
  }

  async buildOutbound(instruction: OutboundInstruction): Promise<string> {
    this.assertAsset(instruction.asset);
    return JSON.stringify({
      type: "eip1559-unsigned",
      asset: instruction.asset,
      to: instruction.to,
      amountBaseUnits: instruction.amountBaseUnits.toString(),
      memoHash: instruction.memoHash ?? null,
    });
  }

  async broadcast(rawTx: string): Promise<string> {
    return this.rpc.call<string>("eth_sendRawTransaction", [rawTx]);
  }
}

/**
 * Monero wallet RPC adapter. Use fresh subaddresses for vaults.
 *
 * Scaffold only: `get_transfers` does not return a `confirmations` field in
 * standard monero-wallet-rpc; a production watcher must derive unlock height /
 * confirmations from the daemon. `buildOutbound` is an unsigned placeholder.
 */
export class MoneroRpcAdapter extends BaseRpcAdapter {
  readonly chain = "monero" as const;
  readonly assets = ["XMR"] as const;

  async scanInbound(
    intentId: string,
    asset: Asset,
  ): Promise<InboundObservation | null> {
    this.assertAsset(asset);
    const transfers = await this.rpc.call<{
      in?: Array<{
        txid: string;
        amount: number;
        confirmations?: number;
        payment_id?: string;
      }>;
    }>("get_transfers", [{ in: true, account_index: 0 }]);
    const found = transfers.in?.find((t) => t.payment_id === intentId);
    if (!found) return null;
    return {
      intentId,
      chain: this.chain,
      asset,
      txHash: found.txid,
      amountBaseUnits: BigInt(found.amount),
      confirmations: found.confirmations ?? 0,
      observedAt: Date.now(),
    };
  }

  async getConfirmations(txHash: string): Promise<number> {
    const res = await this.rpc.call<{
      confirmations?: number;
      transfer?: { confirmations?: number };
    }>("get_transfer_by_txid", [{ txid: txHash, account_index: 0 }]);
    return res.confirmations ?? res.transfer?.confirmations ?? 0;
  }

  async buildOutbound(instruction: OutboundInstruction): Promise<string> {
    this.assertAsset(instruction.asset);
    return JSON.stringify({
      type: "monero-unsigned",
      to: instruction.to,
      atomic: instruction.amountBaseUnits.toString(),
      memoHash: instruction.memoHash ?? null,
    });
  }

  async broadcast(rawTx: string): Promise<string> {
    const res = await this.rpc.call<{ tx_hash: string }>("submit_transfer", [
      rawTx,
    ]);
    return res.tx_hash;
  }
}

/**
 * Zcash shielded RPC adapter. Prefer Orchard/sapling z-addrs.
 *
 * Scaffold only: standard z_listunspent notes do not carry a `confirmations`
 * field; a production watcher must join note data with wallet/daemon height.
 * `buildOutbound` is an unsigned placeholder, not a ZIP-317 transaction.
 */
export class ZcashRpcAdapter extends BaseRpcAdapter {
  readonly chain = "zcash" as const;
  readonly assets = ["ZEC"] as const;

  async scanInbound(
    intentId: string,
    asset: Asset,
  ): Promise<InboundObservation | null> {
    this.assertAsset(asset);
    const notes = await this.rpc.call<
      Array<{ txid: string; amount: number; confirmations?: number; memo?: string }>
    >("z_listunspent", [1, 9999999, true, [this.vaultAddress(asset)]]).catch(() => []);
    const found = notes.find((n) => n.memo === intentId);
    if (!found) return null;
    return {
      intentId,
      chain: this.chain,
      asset,
      txHash: found.txid,
      amountBaseUnits: BigInt(Math.round(found.amount * 1e8)),
      confirmations: found.confirmations ?? 0,
      observedAt: Date.now(),
    };
  }

  async getConfirmations(txHash: string): Promise<number> {
    const tx = await this.rpc.call<{ confirmations?: number }>(
      "gettransaction",
      [txHash],
    ).catch(() => ({ confirmations: 0 }));
    return tx.confirmations ?? 0;
  }

  async buildOutbound(instruction: OutboundInstruction): Promise<string> {
    this.assertAsset(instruction.asset);
    return JSON.stringify({
      type: "zcash-unsigned",
      to: instruction.to,
      zatoshi: instruction.amountBaseUnits.toString(),
      memoHash: instruction.memoHash ?? null,
    });
  }

  async broadcast(rawTx: string): Promise<string> {
    return this.rpc.call<string>("sendrawtransaction", [rawTx]);
  }
}

export function adapterForChain(
  chain: Chain,
  cfg: RpcAdapterConfig,
): ChainAdapter {
  switch (chain) {
    case "bitcoin":
      return new BitcoinRpcAdapter(cfg);
    case "ethereum":
      return new EthereumRpcAdapter(cfg);
    case "monero":
      return new MoneroRpcAdapter(cfg);
    case "zcash":
      return new ZcashRpcAdapter(cfg);
    default: {
      const exhaustive: never = chain;
      throw new Error(`unsupported chain ${exhaustive}`);
    }
  }
}

export function txHashOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
