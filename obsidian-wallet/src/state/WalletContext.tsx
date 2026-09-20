import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import { 
  AccountData, 
  MoneroNode, 
  WalletTransaction, 
  SwapOrder, 
  PrivacyPostureScore, 
  AppSettings,
  SwapProviderQuote
} from '../types/wallet';
import { DEFAULT_NODES } from '../services/nodes';
import { calculatePrivacyPosture } from '../services/privacyScore';
import { generateRandomSeed, seedToMnemonic, mnemonicToSeed } from '../crypto/mnemonic';
import { createKeysFromSeed } from '../crypto/keys';
import { deriveSubaddress, SubaddressInfo } from '../crypto/subaddress';
import { encryptVault, decryptVault, EncryptedVault } from '../crypto/vault';
import { StorageService } from '../services/storage';

interface WalletContextType {
  isInitialized: boolean;
  isLocked: boolean;
  activeAccount: AccountData | null;
  accounts: AccountData[];
  nodes: MoneroNode[];
  activeNode: MoneroNode;
  isTorRoutingEnabled: boolean;
  privacyScore: PrivacyPostureScore;
  transactions: WalletTransaction[];
  activeSwaps: SwapOrder[];
  settings: AppSettings;
  createWallet: (password: string, customMnemonic?: string) => Promise<void>;
  unlockWallet: (password: string) => Promise<boolean>;
  lockWallet: () => void;
  resetWallet: () => Promise<void>;
  generateNewSubaddress: (label?: string) => SubaddressInfo;
  setActiveSubaddress: (index: number) => void;
  switchNode: (nodeId: string) => void;
  addCustomNode: (node: Omit<MoneroNode, 'id'>) => void;
  toggleTorRouting: () => void;
  sendTransaction: (
    recipient: string, 
    amount: number, 
    priority: 'slow' | 'normal' | 'fast',
    isChurn?: boolean
  ) => Promise<WalletTransaction>;
  createSwap: (
    fromCoin: string, 
    toCoin: string, 
    quote: SwapProviderQuote, 
    recipientAddress: string
  ) => Promise<SwapOrder>;
  updateSettings: (newSettings: Partial<AppSettings>) => void;
  applyPrivacyFix: (fixId: string) => void;
}

const WalletContext = createContext<WalletContextType | null>(null);

const DEFAULT_SETTINGS: AppSettings = {
  fiatCurrency: 'USD',
  xmrUsdPrice: 172.50,
  torSocksPort: 9050,
  autoLockMinutes: 15,
  enableTorByDefault: true,
  hideBalance: false,
  activeNetwork: 'mainnet',
};

const INITIAL_MOCK_TXS: WalletTransaction[] = [
  {
    id: 'tx-001',
    txHash: 'e6a88b1b22998fcf9a1df2775a6c117dcf4d952a265f2122c3660516f86641ae',
    type: 'receive',
    amount: 1.450000000000,
    fee: 0.000028,
    address: '89aXe9...28bN',
    confirmations: 128,
    timestamp: Date.now() - 3600000 * 4,
    ringSize: 16,
    status: 'confirmed',
    note: 'Cake Wallet Swap payout',
  },
  {
    id: 'tx-002',
    txHash: '7c40b2bf5e34b1df8ac1f7aa084534efd0c75c74ea6d7353ce09b9148dce45a1',
    type: 'churn',
    amount: 0.850000000000,
    fee: 0.000031,
    address: '8Bfx71...45pQ',
    confirmations: 42,
    timestamp: Date.now() - 3600000 * 24,
    ringSize: 16,
    status: 'confirmed',
    note: 'Self-churn for decoy freshness',
  },
  {
    id: 'tx-003',
    txHash: '1f98bc19e3444acbd776d6ec98f1211756fdf164917926b177264a7cfa24fcf8',
    type: 'send',
    amount: 0.250000000000,
    fee: 0.000029,
    address: '849Xp...18Za',
    confirmations: 230,
    timestamp: Date.now() - 3600000 * 72,
    ringSize: 16,
    status: 'confirmed',
    note: 'Hosting payment (Tor proxy)',
  },
];

export const WalletProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [isLocked, setIsLocked] = useState<boolean>(true);
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [activeAccountIndex, setActiveAccountIndex] = useState<number>(0);
  const [nodes, setNodes] = useState<MoneroNode[]>(DEFAULT_NODES);
  const [activeNodeId, setActiveNodeId] = useState<string>('tor-monerolove');
  const [isTorRoutingEnabled, setIsTorRoutingEnabled] = useState<boolean>(true);
  const [transactions, setTransactions] = useState<WalletTransaction[]>(INITIAL_MOCK_TXS);
  const [activeSwaps, setActiveSwaps] = useState<SwapOrder[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const activeNode = useMemo(() => {
    return nodes.find(n => n.id === activeNodeId) || nodes[0];
  }, [nodes, activeNodeId]);

  const activeAccount = useMemo(() => {
    return accounts[activeAccountIndex] ?? null;
  }, [accounts, activeAccountIndex]);

  // Dynamic Privacy Posture calculation
  const privacyScore = useMemo(() => {
    const hasUnchurned = transactions.some(t => t.type === 'receive' && t.confirmations < 20);
    return calculatePrivacyPosture(activeNode, activeAccount, isTorRoutingEnabled, hasUnchurned);
  }, [activeNode, activeAccount, isTorRoutingEnabled, transactions]);

  // Load saved state on mount
  useEffect(() => {
    async function loadInitial() {
      const savedVault = await StorageService.get<EncryptedVault>('vault');
      const savedSettings = await StorageService.get<AppSettings>('settings');
      const savedTxs = await StorageService.get<WalletTransaction[]>('txs');
      const savedSwaps = await StorageService.get<SwapOrder[]>('swaps');

      if (savedSettings) setSettings(savedSettings);
      if (savedTxs) setTransactions(savedTxs);
      if (savedSwaps) setActiveSwaps(savedSwaps);

      if (savedVault) {
        setIsInitialized(true);
        setIsLocked(true);
      } else {
        // Automatically create a demo ready wallet for instant evaluation, or allow user to create
        initDemoWallet();
      }
    }
    loadInitial();
  }, []);

  function initDemoWallet() {
    const seed = generateRandomSeed();
    const mnemonic = seedToMnemonic(seed);
    const keys = createKeysFromSeed(seed, 'mainnet');

    // Create 2 initial subaddresses: one already used, one pristine fresh
    const sub1 = deriveSubaddress(keys.viewPrivateHex, keys.spendPublicHex, 0, 1, 'General / Web3 Shop');
    sub1.isUsed = true;
    const sub2 = deriveSubaddress(keys.viewPrivateHex, keys.spendPublicHex, 0, 2, 'Fresh Stealth Receive');
    sub2.isUsed = false;

    const initialAccount: AccountData = {
      index: 0,
      name: 'Account 1 (Primary)',
      primaryAddress: keys.primaryAddress,
      subaddresses: [sub1, sub2],
      activeSubaddressIndex: 1, // Start on the fresh subaddress for high privacy posture
      spendPublicHex: keys.spendPublicHex,
      viewPublicHex: keys.viewPublicHex,
      spendPrivateHex: keys.spendPrivateHex,
      viewPrivateHex: keys.viewPrivateHex,
      seedHex: keys.seedHex,
      mnemonic,
      balanceXMR: 8.452000000000,
      unlockedBalanceXMR: 8.452000000000,
    };

    setAccounts([initialAccount]);
    setIsInitialized(true);
    setIsLocked(false);
  }

  const createWallet = async (password: string, customMnemonic?: string) => {
    let seed: Uint8Array;
    let mnemonic: string;

    if (customMnemonic && customMnemonic.trim().length > 0) {
      mnemonic = customMnemonic.trim();
      seed = mnemonicToSeed(mnemonic);
    } else {
      seed = generateRandomSeed();
      mnemonic = seedToMnemonic(seed);
    }

    const keys = createKeysFromSeed(seed, settings.activeNetwork);
    const sub1 = deriveSubaddress(keys.viewPrivateHex, keys.spendPublicHex, 0, 1, 'Default Subaddress #1');

    const newAccount: AccountData = {
      index: 0,
      name: 'Account 1',
      primaryAddress: keys.primaryAddress,
      subaddresses: [sub1],
      activeSubaddressIndex: 0,
      spendPublicHex: keys.spendPublicHex,
      viewPublicHex: keys.viewPublicHex,
      spendPrivateHex: keys.spendPrivateHex,
      viewPrivateHex: keys.viewPrivateHex,
      seedHex: keys.seedHex,
      mnemonic,
      balanceXMR: 0.0,
      unlockedBalanceXMR: 0.0,
    };

    const newAccounts = [newAccount];
    setAccounts(newAccounts);
    setActiveAccountIndex(0);

    const vault = await encryptVault({ accounts: newAccounts }, password);
    await StorageService.set('vault', vault);

    setIsInitialized(true);
    setIsLocked(false);
  };

  const unlockWallet = async (password: string): Promise<boolean> => {
    try {
      const vault = await StorageService.get<EncryptedVault>('vault');
      if (!vault) {
        setIsLocked(false);
        return true;
      }
      const data = await decryptVault<{ accounts: AccountData[] }>(vault, password);
      setAccounts(data.accounts);
      setIsLocked(false);
      return true;
    } catch {
      return false;
    }
  };

  const lockWallet = () => {
    setIsLocked(true);
  };

  const resetWallet = async () => {
    await StorageService.remove('vault');
    await StorageService.remove('txs');
    await StorageService.remove('swaps');
    setIsInitialized(false);
    setIsLocked(true);
    setAccounts([]);
    initDemoWallet();
  };

  const generateNewSubaddress = (label?: string): SubaddressInfo => {
    if (!activeAccount) throw new Error('No active account');

    const nextIndex = activeAccount.subaddresses.length + 1;
    const subName = label || `Subaddress #${nextIndex}`;
    const newSub = deriveSubaddress(
      activeAccount.viewPrivateHex,
      activeAccount.spendPublicHex,
      0,
      nextIndex,
      subName,
      settings.activeNetwork
    );

    const updatedAccount = {
      ...activeAccount,
      subaddresses: [...activeAccount.subaddresses, newSub],
      activeSubaddressIndex: activeAccount.subaddresses.length, // switch to it
    };

    const updatedAccounts = accounts.map((acc, idx) =>
      idx === activeAccountIndex ? updatedAccount : acc
    );

    setAccounts(updatedAccounts);
    return newSub;
  };

  const setActiveSubaddress = (index: number) => {
    if (!activeAccount || index < 0 || index >= activeAccount.subaddresses.length) return;
    const updatedAccount = {
      ...activeAccount,
      activeSubaddressIndex: index,
    };
    setAccounts(accounts.map((acc, idx) => (idx === activeAccountIndex ? updatedAccount : acc)));
  };

  const switchNode = (nodeId: string) => {
    const target = nodes.find(n => n.id === nodeId);
    if (!target) return;
    setActiveNodeId(nodeId);
    if (target.isTor) {
      setIsTorRoutingEnabled(true);
    }
  };

  const addCustomNode = (nodeData: Omit<MoneroNode, 'id'>) => {
    const newId = 'custom-' + Date.now();
    const newNode: MoneroNode = { ...nodeData, id: newId };
    const updated = [...nodes, newNode];
    setNodes(updated);
    setActiveNodeId(newId);
  };

  const toggleTorRouting = () => {
    setIsTorRoutingEnabled(prev => !prev);
  };

  const sendTransaction = async (
    recipient: string,
    amount: number,
    priority: 'slow' | 'normal' | 'fast',
    isChurn: boolean = false
  ): Promise<WalletTransaction> => {
    if (!activeAccount) throw new Error('No active account');

    const fee = priority === 'slow' ? 0.00002 : priority === 'normal' ? 0.00003 : 0.00006;
    const totalDeduction = amount + fee;

    if (activeAccount.unlockedBalanceXMR < totalDeduction && !isChurn) {
      throw new Error(`Insufficient unlocked balance. Need ${totalDeduction.toFixed(6)} XMR`);
    }

    // Generate random realistic Monero TX hash (64 hex characters)
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const txHash = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const newTx: WalletTransaction = {
      id: 'tx-' + Date.now(),
      txHash,
      type: isChurn ? 'churn' : 'send',
      amount,
      fee,
      address: recipient,
      confirmations: 0, // Unconfirmed in mempool
      timestamp: Date.now(),
      ringSize: 16,
      status: 'pending',
      note: isChurn ? 'Decoy privacy self-churn' : `Sent via ${activeNode.isTor ? 'Tor' : 'Clearnet'}`,
    };

    const newBalance = Math.max(0, activeAccount.balanceXMR - (isChurn ? fee : totalDeduction));
    const updatedAccount = {
      ...activeAccount,
      balanceXMR: Number(newBalance.toFixed(6)),
      unlockedBalanceXMR: Number(newBalance.toFixed(6)),
    };

    const updatedAccounts = accounts.map((acc, idx) =>
      idx === activeAccountIndex ? updatedAccount : acc
    );

    setAccounts(updatedAccounts);
    const updatedTxs = [newTx, ...transactions];
    setTransactions(updatedTxs);
    await StorageService.set('txs', updatedTxs);

    return newTx;
  };

  const createSwap = async (
    fromCoin: string,
    toCoin: string,
    quote: SwapProviderQuote,
    recipientAddress: string
  ): Promise<SwapOrder> => {
    const now = Date.now();
    const newOrder: SwapOrder = {
      id: 'SWAP-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
      providerId: quote.providerId,
      providerName: quote.providerName,
      fromCoin,
      toCoin,
      fromAmount: quote.fromAmount,
      toAmountEstimated: quote.toAmount,
      depositAddress: 'bc1q' + Math.random().toString(36).substring(2, 12) + 'xmr',
      recipientAddress,
      status: 'waiting_deposit',
      createdAt: now,
      expiresAt: now + 30 * 60 * 1000,
    };

    const updatedSwaps = [newOrder, ...activeSwaps];
    setActiveSwaps(updatedSwaps);
    await StorageService.set('swaps', updatedSwaps);

    // Simulate swap progressing in background
    setTimeout(() => {
      setActiveSwaps(prev =>
        prev.map(s => s.id === newOrder.id ? { ...s, status: 'confirming' } : s)
      );
    }, 4000);

    setTimeout(() => {
      setActiveSwaps(prev =>
        prev.map(s => s.id === newOrder.id ? { ...s, status: 'exchanging' } : s)
      );
    }, 9000);

    setTimeout(() => {
      setActiveSwaps(prev =>
        prev.map(s => s.id === newOrder.id ? { ...s, status: 'finished' } : s)
      );

      // Add to balance & transactions when finished
      if (activeAccount) {
        const receivedTx: WalletTransaction = {
          id: 'tx-swap-' + Date.now(),
          txHash: Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join(''),
          type: 'swap',
          amount: quote.toAmount,
          fee: quote.networkFee,
          address: recipientAddress,
          confirmations: 1,
          timestamp: Date.now(),
          ringSize: 16,
          status: 'confirmed',
          note: `Swapped ${quote.fromAmount} ${fromCoin} -> ${quote.toAmount} XMR (${quote.providerName})`,
          exchangeProvider: quote.providerName,
        };

        setTransactions(curr => [receivedTx, ...curr]);
        setAccounts(currAccs =>
          currAccs.map((acc, i) =>
            i === activeAccountIndex
              ? {
                  ...acc,
                  balanceXMR: Number((acc.balanceXMR + quote.toAmount).toFixed(6)),
                  unlockedBalanceXMR: Number((acc.unlockedBalanceXMR + quote.toAmount).toFixed(6)),
                }
              : acc
          )
        );
      }
    }, 16000);

    return newOrder;
  };

  const updateSettings = (newSettings: Partial<AppSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      StorageService.set('settings', updated);
      return updated;
    });
  };

  const applyPrivacyFix = (fixId: string) => {
    if (fixId === 'switch-to-tor') {
      const onionNode = nodes.find(n => n.isTor);
      if (onionNode) {
        switchNode(onionNode.id);
        setIsTorRoutingEnabled(true);
      }
    } else if (fixId === 'generate-subaddress') {
      generateNewSubaddress('Quick Privacy Subaddress');
    } else if (fixId === 'connect-local-node') {
      const localNode = nodes.find(n => n.type === 'local_fullnode');
      if (localNode) {
        switchNode(localNode.id);
      }
    } else if (fixId === 'churn-outputs') {
      if (activeAccount) {
        const freshSub = generateNewSubaddress('Churn Destination');
        sendTransaction(freshSub.address, 0.5, 'normal', true);
      }
    }
  };

  return (
    <WalletContext.Provider
      value={{
        isInitialized,
        isLocked,
        activeAccount,
        accounts,
        nodes,
        activeNode,
        isTorRoutingEnabled,
        privacyScore,
        transactions,
        activeSwaps,
        settings,
        createWallet,
        unlockWallet,
        lockWallet,
        resetWallet,
        generateNewSubaddress,
        setActiveSubaddress,
        switchNode,
        addCustomNode,
        toggleTorRouting,
        sendTransaction,
        createSwap,
        updateSettings,
        applyPrivacyFix,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
};

export const useWallet = (): WalletContextType => {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
};
