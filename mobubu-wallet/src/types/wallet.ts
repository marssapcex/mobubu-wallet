import { SubaddressInfo } from '../crypto/subaddress';

export type NetworkType = 'mainnet' | 'stagenet' | 'testnet';
export type RoutingMode = 'tor' | 'socks5' | 'clearnet' | 'local';

export interface MoneroNode {
  id: string;
  name: string;
  url: string;
  type: 'tor_onion' | 'local_fullnode' | 'clearnet_curated' | 'custom';
  isTor: boolean;
  height: number;
  targetHeight: number;
  latencyMs: number;
  isOnline: boolean;
  isDefault?: boolean;
}

export interface AccountData {
  index: number;
  name: string;
  primaryAddress: string;
  subaddresses: SubaddressInfo[];
  activeSubaddressIndex: number; // index inside subaddresses array
  spendPublicHex: string;
  viewPublicHex: string;
  spendPrivateHex: string;
  viewPrivateHex: string;
  seedHex: string;
  mnemonic: string;
  balanceXMR: number;
  unlockedBalanceXMR: number;
  isViewOnly?: boolean;
}

export interface WalletTransaction {
  id: string;
  txHash: string;
  type: 'receive' | 'send' | 'swap' | 'churn';
  amount: number;
  fee: number;
  address: string;
  confirmations: number;
  timestamp: number;
  ringSize: number;
  status: 'pending' | 'confirmed' | 'failed';
  note?: string;
  exchangeProvider?: string;
  isLocked?: boolean;
}

export interface SwapProviderQuote {
  providerId: string;
  providerName: string;
  logo: string;
  fromAmount: number;
  toAmount: number;
  estimatedRate: number;
  etaMinutes: number;
  kycRisk: 'Zero KYC' | 'Low Risk' | 'Moderate';
  minAmount: number;
  maxAmount: number;
  networkFee: number;
  isBestRate: boolean;
  fixedRate?: boolean;
}

export interface SwapOrder {
  id: string;
  providerId: string;
  providerName: string;
  fromCoin: string;
  toCoin: string;
  fromAmount: number;
  toAmountEstimated: number;
  depositAddress: string;
  recipientAddress: string;
  refundAddress?: string;
  status: 'waiting_deposit' | 'confirming' | 'exchanging' | 'sending' | 'finished' | 'expired';
  createdAt: number;
  expiresAt: number;
  txId?: string;
}

export interface PrivacyScoreBreakdownItem {
  score: number;
  max: number;
  title: string;
  statusText: string;
  isPositive: boolean;
  detail: string;
  hint?: string;
}

export interface PrivacyRecommendation {
  id: string;
  title: string;
  description: string;
  actionText: string;
  actionType: 'switch_to_tor' | 'generate_subaddress' | 'churn_outputs' | 'connect_local_node' | 'eae_defense';
  impactPoints: number;
  severity: 'critical' | 'warning' | 'info';
}

export interface PrivacyPostureScore {
  totalScore: number; // 0 - 100
  tier: 'optimal' | 'good' | 'moderate' | 'exposed';
  tierLabel: string;
  color: string;
  transport: PrivacyScoreBreakdownItem;
  nodeTrust: PrivacyScoreBreakdownItem;
  addressHygiene: PrivacyScoreBreakdownItem;
  outputHygiene: PrivacyScoreBreakdownItem;
  eaeDefenseStatus: string;
  recommendations: PrivacyRecommendation[];
}

export interface AppSettings {
  fiatCurrency: 'USD' | 'EUR' | 'GBP' | 'BTC' | 'VND';
  xmrUsdPrice: number;
  torSocksPort: number;
  autoLockMinutes: number;
  enableTorByDefault: boolean;
  hideBalance: boolean;
  activeNetwork: NetworkType;
  enableHapticFeedback?: boolean;
}

export interface DAppPermissionRequest {
  id: string;
  origin: string;
  appName: string;
  appIcon?: string;
  type: 'connect' | 'send';
  requestedAmount?: number;
  recipientAddress?: string;
  timestamp: number;
}
