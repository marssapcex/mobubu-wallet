import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import { 
  AccountData, 
  MoneroNode, 
  WalletTransaction, 
  SwapOrder, 
  PrivacyPostureScore, 
  AppSettings,
  SwapProviderQuote,
  DAppPermissionRequest
} from '../types/wallet';
import { DEFAULT_NODES, benchmarkNodeLatency } from '../services/nodes';
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
  pendingDAppRequest: DAppPermissionRequest | null;
  createWallet: (password: string, customMnemonic?: string, isViewOnly?: boolean) => Promise<void>;
  createAdditionalAccount: (name: string) => void;
  switchAccount: (index: number) => void;
  unlockWallet: (password: string) => Promise<boolean>;
  lockWallet: () => void;
  resetWallet: () => Promise<void>;
  generateNewSubaddress: (label?: string) => SubaddressInfo;
  setActiveSubaddress: (index: number) => void;
  switchNode: (nodeId: string) => void;
  addCustomNode: (node: Omit<MoneroNode, 'id'>) => void;
  benchmarkAllNodes: () => Promise<void>;
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
    recipientAddress: string,
    refundAddress?: string
  ) => Promise<SwapOrder>;
  updateSettings: (newSettings: Partial<AppSettings>) => void;
  applyPrivacyFix: (fixId: string) => void;
  approveDAppRequest: () => Promise<void>;
  rejectDAppRequest: () => void;
  triggerDAppSimulation: (type: 'connect' | 'send', amount?: number) => void;
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
  enableHapticFeedback: true,
};

const INITIAL_MOCK_TXS: WalletTransaction[] = [
  {
    id: 'tx-001',
    txHash: 'a8b9f012e84192bc7291a1045dae7b99c1f24d88e09f5b61184c207918a24bf4',
    type: 'receive',
    amount: 1.850000000000,
    fee: 0.000028,
    address: '89aXe9...28bN',
    confirmations: 142,
    timestamp: Date.now() - 3600000 * 3,
    ringSize: 16,
    status: 'confirmed',
    note: 'Cake Swap Payout (Trocador)',
  },
  {
    id: 'tx-002',
    txHash: '5e40a12bb891e457ca194a28f1b209d734cf1820b891e457ca194a28f1b209d7',
    type: 'churn',
    amount: 0.750000000000,
    fee: 0.000031,
    address: '8Bfx71...45pQ',
    confirmations: 64,
    timestamp: Date.now() - 3600000 * 18,
    ringSize: 16,
    status: 'confirmed',
    note: 'Self-churn for EAE decoy defense',
  },
  {
    id: 'tx-003',
    txHash: 'c7d91823bb018e77a10f8ca7235a9091e28bc4195b89a42e5883da0f1712a843',
    type: 'send',
    amount: 0.350000000000,
    fee: 0.000030,
    address: '849Xp...18Za',
    confirmations: 310,
    timestamp: Date.now() - 3600000 * 52,
    ringSize: 16,
    status: 'confirmed',
    note: 'Mullvad VPN renewal via Tor',
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
  const [pendingDAppRequest, setPendingDAppRequest] = useState<DAppPermissionRequest | null>(null);

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
        initDefaultMobubuWallet();
      }
    }
    loadInitial();
  }, []);

  function initDefaultMobubuWallet() {
    const seed = generateRandomSeed();
    const mnemonic = seedToMnemonic(seed);
    const keys = createKeysFromSeed(seed, 'mainnet');

    // Create 2 initial subaddresses: one used, one pristine fresh
    const sub1 = deriveSubaddress(keys.viewPrivateHex, keys.spendPublicHex, 0, 1, 'General / Web3 Shop');
    sub1.isUsed = true;
    const sub2 = deriveSubaddress(keys.viewPrivateHex, keys.spendPublicHex, 0, 2, 'Fresh Stealth Receive');
    sub2.isUsed = false;

    const initialAccount: AccountData = {
      index: 0,
      name: 'Mobubu Main Account',
      primaryAddress: keys.primaryAddress,
      subaddresses: [sub1, sub2],
      activeSubaddressIndex: 1, // Start on the fresh subaddress for high privacy posture
      spendPublicHex: keys.spendPublicHex,
      viewPublicHex: keys.viewPublicHex,
      spendPrivateHex: keys.spendPrivateHex,
      viewPrivateHex: keys.viewPrivateHex,
      seedHex: keys.seedHex,
      mnemonic,
      balanceXMR: 9.845000000000,
      unlockedBalanceXMR: 9.845000000000,
      isViewOnly: false,
    };

    setAccounts([initialAccount]);
    setIsInitialized(true);
    setIsLocked(false);
  }

  const createWallet = async (password: string, customMnemonic?: string, isViewOnly: boolean = false) => {
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
      name: 'Mobubu Account 1',
      primaryAddress: keys.primaryAddress,
      subaddresses: [sub1],
      activeSubaddressIndex: 0,
      spendPublicHex: keys.spendPublicHex,
      viewPublicHex: keys.viewPublicHex,
      spendPrivateHex: isViewOnly ? '' : keys.spendPrivateHex,
      viewPrivateHex: keys.viewPrivateHex,
      seedHex: keys.seedHex,
      mnemonic,
      balanceXMR: 0.0,
      unlockedBalanceXMR: 0.0,
      isViewOnly,
    };

    const newAccounts = [newAccount];
    setAccounts(newAccounts);
    setActiveAccountIndex(0);

    const vault = await encryptVault({ accounts: newAccounts }, password);
    await StorageService.set('vault', vault);

    setIsInitialized(true);
    setIsLocked(false);
  };

  const createAdditionalAccount = (name: string) => {
    if (accounts.length === 0) return;
    const baseSeed = generateRandomSeed();
    const mnemonic = seedToMnemonic(baseSeed);
    const keys = createKeysFromSeed(baseSeed, settings.activeNetwork);
    const sub1 = deriveSubaddress(keys.viewPrivateHex, keys.spendPublicHex, accounts.length, 1, 'Primary Stealth');

    const newAccount: AccountData = {
      index: accounts.length,
      name: name || `Account ${accounts.length + 1}`,
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

    const updated = [...accounts, newAccount];
    setAccounts(updated);
    setActiveAccountIndex(updated.length - 1);
  };

  const switchAccount = (index: number) => {
    if (index >= 0 && index < accounts.length) {
      setActiveAccountIndex(index);
    }
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
    initDefaultMobubuWallet();
  };

  const generateNewSubaddress = (label?: string): SubaddressInfo => {
    if (!activeAccount) throw new Error('No active account');

    const nextIndex = activeAccount.subaddresses.length + 1;
    const subName = label || `Subaddress #${nextIndex}`;
    const newSub = deriveSubaddress(
      activeAccount.viewPrivateHex,
      activeAccount.spendPublicHex,
      activeAccount.index,
      nextIndex,
      subName,
      settings.activeNetwork
    );

    const updatedAccount = {
      ...activeAccount,
      subaddresses: [...activeAccount.subaddresses, newSub],
      activeSubaddressIndex: activeAccount.subaddresses.length,
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

  const benchmarkAllNodes = async () => {
    const benchmarked = await Promise.all(
      nodes.map(async (n) => {
        const ping = await benchmarkNodeLatency(n);
        return { ...n, latencyMs: ping };
      })
    );
    setNodes(benchmarked);
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

    if (activeAccount.isViewOnly) {
      throw new Error('This account is View-Only. Spend key is not present on this device.');
    }

    const fee = priority === 'slow' ? 0.00002 : priority === 'normal' ? 0.00003 : 0.00006;
    const totalDeduction = amount + fee;

    if (activeAccount.unlockedBalanceXMR < totalDeduction && !isChurn) {
      throw new Error(`Insufficient unlocked balance. Need ${totalDeduction.toFixed(6)} XMR`);
    }

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
      confirmations: 0,
      timestamp: Date.now(),
      ringSize: 16,
      status: 'pending',
      note: isChurn ? 'EAE decoy privacy self-churn' : `Sent via ${activeNode.isTor ? 'Tor Hidden Service' : 'Clearnet'}`,
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
    recipientAddress: string,
    refundAddress?: string
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
      depositAddress: 'bc1q' + Math.random().toString(36).substring(2, 12) + 'mobubu',
      recipientAddress,
      refundAddress,
      status: 'waiting_deposit',
      createdAt: now,
      expiresAt: now + 30 * 60 * 1000,
    };

    const updatedSwaps = [newOrder, ...activeSwaps];
    setActiveSwaps(updatedSwaps);
    await StorageService.set('swaps', updatedSwaps);

    // Progression simulation
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

      if (activeAccount && toCoin === 'XMR') {
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
          note: `Swapped ${quote.fromAmount} ${fromCoin} ➔ ${quote.toAmount} XMR (${quote.providerName})`,
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
      generateNewSubaddress('Fresh Privacy Subaddress');
    } else if (fixId === 'connect-local-node') {
      const localNode = nodes.find(n => n.type === 'local_fullnode');
      if (localNode) {
        switchNode(localNode.id);
      }
    } else if (fixId === 'churn-outputs') {
      if (activeAccount) {
        const freshSub = generateNewSubaddress('EAE Churn Destination');
        sendTransaction(freshSub.address, 0.45, 'normal', true);
      }
    }
  };

  // DApp Permission Simulation
  const triggerDAppSimulation = (type: 'connect' | 'send', amount?: number) => {
    setPendingDAppRequest({
      id: 'req-' + Date.now(),
      origin: 'https://cypherpunk-bazaar.onion',
      appName: 'Cypherpunk Bazaar',
      type,
      requestedAmount: amount || 0.15,
      recipientAddress: '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkFxbANsAnJYPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H',
      timestamp: Date.now(),
    });
  };

  const approveDAppRequest = async () => {
    if (!pendingDAppRequest) return;
    if (pendingDAppRequest.type === 'send' && pendingDAppRequest.requestedAmount) {
      await sendTransaction(pendingDAppRequest.recipientAddress!, pendingDAppRequest.requestedAmount, 'normal');
    }
    setPendingDAppRequest(null);
  };

  const rejectDAppRequest = () => {
    setPendingDAppRequest(null);
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
        pendingDAppRequest,
        createWallet,
        createAdditionalAccount,
        switchAccount,
        unlockWallet,
        lockWallet,
        resetWallet,
        generateNewSubaddress,
        setActiveSubaddress,
        switchNode,
        addCustomNode,
        benchmarkAllNodes,
        toggleTorRouting,
        sendTransaction,
        createSwap,
        updateSettings,
        applyPrivacyFix,
        approveDAppRequest,
        rejectDAppRequest,
        triggerDAppSimulation,
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
