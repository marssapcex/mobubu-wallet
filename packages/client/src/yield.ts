/**
 * @title Client SDK — Yield Vault + EIP-7702 + Tokenized Assets
 * @dev Client-side logic:
 *   1. Tạo EIP-7702 authorization (setCode) cho EOA tạm thời
 *   2. Kết nối YieldVault: deposit, withdraw, claimYield
 *   3. Kết nối TokenizedAsset: mint, redeem
 *   4. Mã hóa authorization list để gửi EIP-7702 transaction lên Ethereum (Pectra+)
 */

import * as ethers from "ethers";
import { AbiCoder } from "ethers";

export interface YieldVaultConfig {
  vaultAddress: string;
  eip7702AuthAddress: string;
  vaultAsset: string; // ERC20 token address hoặc "0x0" cho native ETH
  yTokenAddress: string;
}

export interface TokenizedAssetConfig {
  assetAddress: string;
  priceOracle: string;
}

export interface DepositYieldParams {
  amount: bigint; // wei / smallest unit
  useEIP7702: boolean;
  ephemeralAccount?: string; // EOA tạm thời nếu dùng EIP-7702
}

export interface WithdrawYieldParams {
  yTokens: bigint;
  useEIP7702: boolean;
}

export interface MintTokenizedParams {
  amountTokens: bigint;
  collateralETH: bigint;
}

export interface RedeemTokenizedParams {
  amountTokens: bigint;
}

/**
 * Mã hóa EIP-7702 authorization list.
 * Trong thực tế, đây là authorization list của transaction EIP-7702:
 *   [ { address: contractAddress, code: codeOfContract } ]
 * EOA ký transaction này, gửi lên Ethereum. Sau đó EOA chạy code của contract.
 */
export function encodeEIP7702Authorization(
  contractAddress: string,
  code: string // hex-encoded bytecode của contract
): string {
  const abiCoder = new AbiCoder();
  // Authorization: (address contractAddress, bytes code)
  return abiCoder.encode(
    ["tuple(address,bytes)[]"],
    [[{ contractAddress, code }]]
  );
}

/**
 * Tính hash của contract code (dùng để kiểm tra authorization trên chain).
 */
export function computeCodeHash(code: string): string {
  return ethers.keccak256(code);
}

/**
 * Kết nối YieldVault contract.
 */
export class YieldVaultClient {
  private vault: ethers.Contract;
  private auth: ethers.Contract;
  private signer: ethers.Wallet | ethers.JsonRpcSigner;

  constructor(
    signer: ethers.Wallet | ethers.JsonRpcSigner,
    config: YieldVaultConfig,
    vaultABI: any[],
    authABI: any[]
  ) {
    this.signer = signer;
    this.vault = new ethers.Contract(config.vaultAddress, vaultABI, signer);
    this.auth = new ethers.Contract(config.eip7702AuthAddress, authABI, signer);
  }

  /**
   * Authorize EOA của signer để chạy code của YieldVault qua EIP-7702.
   * Trong production, caller tạo EIP-7702 transaction với authorization list.
   */
  async authorizeEOA(
    contractAddress: string,
    code: string,
    expiry: bigint = 0n
  ): Promise<any> {
    const codeHash = computeCodeHash(code);
    return this.auth.authorize(contractAddress, codeHash, expiry);
  }

  /**
   * Kiểm tra xem EOA của signer đã được authorize chưa.
   */
  async isAuthorized(contractAddress: string, code: string): Promise<boolean> {
    const codeHash = computeCodeHash(code);
    return this.auth.isAuthorized(await this.signer.getAddress(), codeHash);
  }

  /**
   * Deposit vào YieldVault.
   * Nếu useEIP7702 = true, caller phải gửi transaction dạng EIP-7702
   * (authorization list có contract address của YieldVault).
   */
  async deposit(
    params: DepositYieldParams
  ): Promise<any> {
    const { amount, useEIP7702 } = params;
    if (useEIP7702) {
      // Trong thực tế, đây là lời gọi thông qua ephemeral account (EIP-7702 tx)
      // Ở đây chúng ta gọi trực tiếp để minh họa logic contract
      return this.vault.depositViaEIP7702(amount, { value: amount });
    }
    return this.vault.deposit(amount, { value: amount });
  }

  /**
   * Withdraw yToken, nhận lại gốc + lãi.
   */
  async withdraw(params: WithdrawYieldParams): Promise<any> {
    const { yTokens, useEIP7702 } = params;
    if (useEIP7702) {
      return this.vault.withdrawViaEIP7702(yTokens);
    }
    return this.vault.withdraw(yTokens);
  }

  /**
   * Claim chỉ lãi (không withdraw gốc).
   */
  async claimYield(): Promise<any> {
    return this.vault.claimYield();
  }

  /**
   * Tính lãi pending cho signer.
   */
  async pendingYield(): Promise<bigint> {
    const address = await this.signer.getAddress();
    return this.vault.calculatePendingInterest(address);
  }

  /**
   * Tổng giá trị (gốc + lãi) của signer.
   */
  async totalValue(): Promise<bigint> {
    const address = await this.signer.getAddress();
    return this.vault.getUserTotalValue(address);
  }
}

/**
 * Kết nối TokenizedAsset (SP500 tokenized, RWA).
 */
export class TokenizedAssetClient {
  private asset: ethers.Contract;
  private signer: ethers.Wallet | ethers.JsonRpcSigner;

  constructor(
    signer: ethers.Wallet | ethers.JsonRpcSigner,
    config: TokenizedAssetConfig,
    assetABI: any[]
  ) {
    this.signer = signer;
    this.asset = new ethers.Contract(config.assetAddress, assetABI, signer);
  }

  /**
   * Mint tokenized asset (ví dụ: SP500 token) bằng cách gửi ETH collateral.
   */
  async mint(params: MintTokenizedParams): Promise<any> {
    const { amountTokens, collateralETH } = params;
    return this.asset.mint(amountTokens, { value: collateralETH });
  }

  /**
   * Redeem tokenized asset để nhận lại ETH collateral.
   */
  async redeem(params: RedeemTokenizedParams): Promise<any> {
    const { amountTokens } = params;
    return this.asset.redeem(amountTokens);
  }

  /**
   * Tính giá trị USD của một lượng token.
   */
  async tokenValueUSD(amountTokens: bigint): Promise<bigint> {
    return this.asset.tokenValueUSD(amountTokens);
  }

  /**
   * Tính số token có thể mint với một lượng ETH.
   */
  async tokensForCollateral(collateralETH: bigint): Promise<bigint> {
    return this.asset.tokensForCollateral(collateralETH);
  }
}
