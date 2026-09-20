import React, { useState, useEffect } from 'react';
import { useWallet } from '../../state/WalletContext';
import { 
  X, 
  ArrowLeftRight, 
  ArrowDown, 
  Sparkles, 
  CheckCircle2, 
  Clock, 
  Copy, 
  Check, 
  ExternalLink,
  ShieldCheck,
  AlertCircle
} from 'lucide-react';
import { 
  SUPPORTED_ASSETS, 
  fetchSwapQuotes, 
  createSwapOrder 
} from '../../services/swapAggregator';
import { SwapProviderQuote, SwapOrder } from '../../types/wallet';

interface SwapModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SwapModal: React.FC<SwapModalProps> = ({ isOpen, onClose }) => {
  const { activeAccount, createSwap, activeSwaps } = useWallet();

  const [fromCoin, setFromCoin] = useState('BTC');
  const [toCoin, setToCoin] = useState('XMR');
  const [fromAmount, setFromAmount] = useState('0.025');
  const [refundAddress, setRefundAddress] = useState('');
  const [quotes, setQuotes] = useState<SwapProviderQuote[]>([]);
  const [selectedQuote, setSelectedQuote] = useState<SwapProviderQuote | null>(null);
  const [isLoadingQuotes, setIsLoadingQuotes] = useState(false);
  const [activeOrder, setActiveOrder] = useState<SwapOrder | null>(null);
  const [copiedDeposit, setCopiedDeposit] = useState(false);

  if (!isOpen || !activeAccount) return null;

  const currentAddress = activeAccount.subaddresses[activeAccount.activeSubaddressIndex]?.address || activeAccount.primaryAddress;

  // Fetch quotes whenever amount or pair changes
  useEffect(() => {
    const num = parseFloat(fromAmount) || 0;
    if (num > 0) {
      setIsLoadingQuotes(true);
      fetchSwapQuotes(fromCoin, toCoin, num)
        .then(res => {
          setQuotes(res);
          if (res.length > 0) setSelectedQuote(res[0]); // default best rate
        })
        .finally(() => setIsLoadingQuotes(false));
    } else {
      setQuotes([]);
      setSelectedQuote(null);
    }
  }, [fromCoin, toCoin, fromAmount]);

  // Keep active order updated from context
  useEffect(() => {
    if (activeOrder) {
      const match = activeSwaps.find(s => s.id === activeOrder.id);
      if (match) setActiveOrder(match);
    }
  }, [activeSwaps]);

  const handleStartSwap = async () => {
    if (!selectedQuote) return;
    const order = await createSwap(fromCoin, toCoin, selectedQuote, currentAddress, refundAddress || undefined);
    setActiveOrder(order);
  };

  const copyDeposit = () => {
    if (!activeOrder) return;
    navigator.clipboard.writeText(activeOrder.depositAddress);
    setCopiedDeposit(true);
    setTimeout(() => setCopiedDeposit(false), 2000);
  };

  const swapPairs = () => {
    const temp = fromCoin;
    setFromCoin(toCoin);
    setToCoin(temp);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-md max-h-[92vh] overflow-y-auto shadow-2xl flex flex-col text-slate-100">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900/95 backdrop-blur-md z-10">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400">
              <ArrowLeftRight className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h2 className="text-sm font-bold text-white">Cross-Chain Swap</h2>
                <span className="text-[10px] bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded px-1.5 py-0.2 font-mono">
                  Cake Multi-DEX
                </span>
              </div>
              <p className="text-[11px] text-slate-400">Zero-KYC Instant Crypto Exchange</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        {activeOrder ? (
          /* Live Order Progress View */
          <div className="p-5 space-y-4 animate-fade-in">
            <div className="text-center space-y-1">
              <div className="text-xs font-mono text-slate-500">Order ID: {activeOrder.id}</div>
              <div className="text-base font-bold text-white">
                Swapping {activeOrder.fromAmount} {activeOrder.fromCoin} ➔ {activeOrder.toAmountEstimated} {activeOrder.toCoin}
              </div>
              <div className="text-xs text-orange-400 font-medium">
                Routed through: {activeOrder.providerName}
              </div>
            </div>

            {/* Stepper Status Bar */}
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className={activeOrder.status === 'waiting_deposit' ? 'text-amber-400' : 'text-slate-500'}>
                  1. Deposit
                </span>
                <span className={activeOrder.status === 'confirming' ? 'text-blue-400' : 'text-slate-500'}>
                  2. Confirming
                </span>
                <span className={activeOrder.status === 'exchanging' ? 'text-purple-400' : 'text-slate-500'}>
                  3. Exchange
                </span>
                <span className={activeOrder.status === 'finished' ? 'text-emerald-400 font-bold' : 'text-slate-500'}>
                  4. Delivered
                </span>
              </div>

              <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                <div
                  className="bg-gradient-to-r from-orange-500 via-amber-400 to-emerald-400 h-full transition-all duration-700"
                  style={{
                    width:
                      activeOrder.status === 'waiting_deposit' ? '25%' :
                      activeOrder.status === 'confirming' ? '50%' :
                      activeOrder.status === 'exchanging' ? '75%' : '100%'
                  }}
                />
              </div>

              <div className="text-center text-xs">
                {activeOrder.status === 'waiting_deposit' && (
                  <span className="text-amber-300 animate-pulse">
                    ⏳ Waiting for your {activeOrder.fromCoin} deposit...
                  </span>
                )}
                {activeOrder.status === 'confirming' && (
                  <span className="text-blue-300 animate-pulse">
                    ⛓️ Detected on blockchain! Awaiting 1 network confirmation...
                  </span>
                )}
                {activeOrder.status === 'exchanging' && (
                  <span className="text-purple-300 animate-pulse">
                    🔄 Exchanging to Monero & generating stealth ring outputs...
                  </span>
                )}
                {activeOrder.status === 'finished' && (
                  <span className="text-emerald-400 font-bold flex items-center justify-center gap-1">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Swap Complete! Monero added to your wallet.</span>
                  </span>
                )}
              </div>
            </div>

            {/* Deposit Address Box (if waiting) */}
            {activeOrder.status !== 'finished' && (
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-300">
                  Send exactly {activeOrder.fromAmount} {activeOrder.fromCoin} to:
                </label>
                <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-between gap-2">
                  <div className="text-xs font-mono text-amber-300 break-all">
                    {activeOrder.depositAddress}
                  </div>
                  <button
                    onClick={copyDeposit}
                    className="shrink-0 p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg cursor-pointer"
                  >
                    {copiedDeposit ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <div className="text-[11px] text-slate-500 text-center">
                  Funds will be credited automatically to your active stealth subaddress.
                </div>
              </div>
            )}

            <button
              onClick={() => {
                setActiveOrder(null);
                if (activeOrder.status === 'finished') onClose();
              }}
              className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-2.5 rounded-xl transition-colors cursor-pointer"
            >
              {activeOrder.status === 'finished' ? 'Close & View Balance' : 'Back to Swapper'}
            </button>
          </div>
        ) : (
          /* Swap Setup Form */
          <div className="p-4 space-y-4">
            
            {/* From Asset Card */}
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-2xl space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>You Send</span>
                <span>Select Currency</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <input
                  type="number"
                  step="any"
                  value={fromAmount}
                  onChange={(e) => setFromAmount(e.target.value)}
                  className="w-1/2 bg-transparent text-xl font-bold font-mono text-white focus:outline-none"
                  placeholder="0.0"
                />
                <select
                  value={fromCoin}
                  onChange={(e) => setFromCoin(e.target.value)}
                  className="bg-slate-800 border border-slate-700 text-slate-100 rounded-xl px-3 py-1.5 text-xs font-bold focus:outline-none cursor-pointer"
                >
                  {Object.keys(SUPPORTED_ASSETS).map(sym => (
                    <option key={sym} value={sym} disabled={sym === toCoin}>
                      {sym} - {SUPPORTED_ASSETS[sym].name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Invert Swap Button */}
            <div className="flex justify-center -my-2 relative z-10">
              <button
                type="button"
                onClick={swapPairs}
                className="p-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full text-slate-300 hover:text-white transition-transform active:rotate-180 cursor-pointer shadow-md"
              >
                <ArrowDown className="w-4 h-4" />
              </button>
            </div>

            {/* To Asset Card */}
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-2xl space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>You Receive (Estimated)</span>
                <span>Destination Currency</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="w-1/2 text-xl font-bold font-mono text-orange-400 truncate">
                  {isLoadingQuotes ? 'Calculating...' : selectedQuote ? selectedQuote.toAmount : '0.0'}
                </div>
                <select
                  value={toCoin}
                  onChange={(e) => setToCoin(e.target.value)}
                  className="bg-slate-800 border border-slate-700 text-slate-100 rounded-xl px-3 py-1.5 text-xs font-bold focus:outline-none cursor-pointer"
                >
                  {Object.keys(SUPPORTED_ASSETS).map(sym => (
                    <option key={sym} value={sym} disabled={sym === fromCoin}>
                      {sym} - {SUPPORTED_ASSETS[sym].name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Provider Aggregator Comparison */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
                <span>Select Exchange Provider</span>
                <span className="text-[10px] text-orange-400 normal-case font-normal">
                  ⚡ Best rate auto-selected
                </span>
              </div>

              <div className="space-y-1.5">
                {quotes.map(q => {
                  const isSel = selectedQuote?.providerId === q.providerId;
                  return (
                    <div
                      key={q.providerId}
                      onClick={() => setSelectedQuote(q)}
                      className={`p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                        isSel
                          ? 'bg-orange-950/40 border-orange-500/80 shadow-sm'
                          : 'bg-slate-950/60 hover:bg-slate-800/60 border-slate-800 text-slate-400'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-base">{q.logo}</span>
                        <div>
                          <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                            <span>{q.providerName}</span>
                            {q.isBestRate && (
                              <span className="text-[9px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1 py-0.2 rounded font-bold">
                                BEST RATE
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            ETA: ~{q.etaMinutes} mins • {q.kycRisk}
                          </div>
                        </div>
                      </div>

                      <div className="text-right font-mono">
                        <div className="text-xs font-bold text-orange-400">
                          {q.toAmount} {toCoin}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          Fee: {q.networkFee} {toCoin}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Refund Address (Optional) */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-slate-400">
                Refund Address for {fromCoin} (Optional)
              </label>
              <input
                type="text"
                placeholder={`Your ${fromCoin} refund address in case trade expires`}
                value={refundAddress}
                onChange={(e) => setRefundAddress(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 font-mono focus:outline-none focus:border-slate-600"
              />
            </div>

            {/* Submit Swap Button */}
            <button
              onClick={handleStartSwap}
              disabled={!selectedQuote || isLoadingQuotes}
              className="w-full bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold text-xs py-3 rounded-xl shadow-lg shadow-orange-600/30 transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              <span>
                {selectedQuote
                  ? `Swap via ${selectedQuote.providerName}`
                  : 'Enter amount to swap'}
              </span>
            </button>
          </div>
        )}

      </div>
    </div>
  );
};
