import { SwapProviderQuote, SwapOrder } from '../types/wallet';

export interface SupportedAsset {
  symbol: string;
  name: string;
  network: string;
  icon: string;
  color: string;
  minAmount: number;
  maxAmount: number;
  usdPrice: number;
}

export const SUPPORTED_ASSETS: Record<string, SupportedAsset> = {
  BTC: {
    symbol: 'BTC',
    name: 'Bitcoin',
    network: 'Bitcoin Native',
    icon: '₿',
    color: '#F7931A',
    minAmount: 0.001,
    maxAmount: 2.5,
    usdPrice: 64200,
  },
  ETH: {
    symbol: 'ETH',
    name: 'Ethereum',
    network: 'ERC20',
    icon: 'Ξ',
    color: '#627EEA',
    minAmount: 0.02,
    maxAmount: 40.0,
    usdPrice: 3450,
  },
  SOL: {
    symbol: 'SOL',
    name: 'Solana',
    network: 'Solana Native',
    icon: '◎',
    color: '#14F195',
    minAmount: 0.2,
    maxAmount: 500,
    usdPrice: 152,
  },
  USDT: {
    symbol: 'USDT',
    name: 'Tether USD',
    network: 'Arbitrum / TRC20',
    icon: '₮',
    color: '#26A17B',
    minAmount: 25,
    maxAmount: 150000,
    usdPrice: 1.0,
  },
  LTC: {
    symbol: 'LTC',
    name: 'Litecoin',
    network: 'Litecoin Native',
    icon: 'Ł',
    color: '#345D9D',
    minAmount: 0.1,
    maxAmount: 500,
    usdPrice: 72,
  },
  XMR: {
    symbol: 'XMR',
    name: 'Monero',
    network: 'Monero Privacy Network',
    icon: 'ɱ',
    color: '#FF6600',
    minAmount: 0.05,
    maxAmount: 1000,
    usdPrice: 170,
  },
};

const PROVIDERS = [
  {
    id: 'trocador',
    name: 'Trocador Aggregator (Onion)',
    logo: '🧅',
    kycRisk: 'Zero KYC' as const,
    spreadPct: 0.008, // 0.8%
    speedMins: 12,
  },
  {
    id: 'changenow',
    name: 'ChangeNOW Instant',
    logo: '⚡',
    kycRisk: 'Low Risk' as const,
    spreadPct: 0.012, // 1.2%
    speedMins: 8,
  },
  {
    id: 'fixedfloat',
    name: 'FixedFloat Zero-Wait',
    logo: '🔒',
    kycRisk: 'Zero KYC' as const,
    spreadPct: 0.009, // 0.9%
    speedMins: 5,
  },
  {
    id: 'simpleswap',
    name: 'SimpleSwap Custody-Free',
    logo: '🔄',
    kycRisk: 'Low Risk' as const,
    spreadPct: 0.014, // 1.4%
    speedMins: 15,
  },
];

export async function fetchSwapQuotes(
  fromSymbol: string,
  toSymbol: string,
  fromAmount: number
): Promise<SwapProviderQuote[]> {
  const fromAsset = SUPPORTED_ASSETS[fromSymbol];
  const toAsset = SUPPORTED_ASSETS[toSymbol];

  if (!fromAsset || !toAsset || fromAmount <= 0) {
    return [];
  }

  const baseRate = fromAsset.usdPrice / toAsset.usdPrice;

  const quotes: SwapProviderQuote[] = PROVIDERS.map((p, idx) => {
    // vary slightly per provider
    const rateWithSpread = baseRate * (1 - p.spreadPct + (idx === 0 ? 0.003 : -idx * 0.002));
    const toAmount = Number((fromAmount * rateWithSpread).toFixed(6));
    const networkFee = Number((toAmount * 0.0015).toFixed(6));

    return {
      providerId: p.id,
      providerName: p.name,
      logo: p.logo,
      fromAmount,
      toAmount,
      estimatedRate: rateWithSpread,
      etaMinutes: p.speedMins,
      kycRisk: p.kycRisk,
      minAmount: fromAsset.minAmount,
      maxAmount: fromAsset.maxAmount,
      networkFee,
      isBestRate: idx === 0, // Trocador aggregator provides best rate
    };
  });

  return quotes.sort((a, b) => b.toAmount - a.toAmount);
}

function generateMockDepositAddress(coin: string): string {
  switch (coin) {
    case 'BTC':
      return 'bc1q' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    case 'ETH':
    case 'USDT':
      return '0x' + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    case 'SOL':
      return Array.from({ length: 44 }, () => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 58)]).join('');
    case 'LTC':
      return 'ltc1q' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    default:
      return '0x' + Math.random().toString(16).substring(2, 20);
  }
}

export function createSwapOrder(
  quote: SwapProviderQuote,
  fromCoin: string,
  toCoin: string,
  recipientAddress: string
): SwapOrder {
  const depositAddress = generateMockDepositAddress(fromCoin);
  const now = Date.now();

  return {
    id: 'swap-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
    providerId: quote.providerId,
    providerName: quote.providerName,
    fromCoin,
    toCoin,
    fromAmount: quote.fromAmount,
    toAmountEstimated: quote.toAmount,
    depositAddress,
    recipientAddress,
    status: 'waiting_deposit',
    createdAt: now,
    expiresAt: now + 30 * 60 * 1000, // 30 minutes
  };
}
