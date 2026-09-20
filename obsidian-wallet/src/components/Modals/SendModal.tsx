import React, { useState } from 'react';
import { useWallet } from '../../state/WalletContext';
import { 
  X, 
  ArrowUpRight, 
  ShieldCheck, 
  AlertTriangle, 
  Wifi, 
  CheckCircle2, 
  Send 
} from 'lucide-react';
import { validateMoneroAddress } from '../../crypto/keys';

interface SendModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SendModal: React.FC<SendModalProps> = ({ isOpen, onClose }) => {
  const { 
    activeAccount, 
    sendTransaction, 
    settings, 
    activeNode, 
    isTorRoutingEnabled 
  } = useWallet();

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [priority, setPriority] = useState<'slow' | 'normal' | 'fast'>('normal');
  const [isSending, setIsSending] = useState(false);
  const [txSuccess, setTxSuccess] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen || !activeAccount) return null;

  const addrValidation = recipient.trim() ? validateMoneroAddress(recipient.trim()) : null;
  const numAmount = parseFloat(amount) || 0;
  const fee = priority === 'slow' ? 0.00002 : priority === 'normal' ? 0.00003 : 0.00006;
  const totalDeduction = numAmount + fee;
  const fiatEquivalent = (numAmount * settings.xmrUsdPrice).toFixed(2);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!recipient.trim()) {
      setErrorMsg('Please enter a recipient Monero address');
      return;
    }

    if (addrValidation && !addrValidation.isValid) {
      setErrorMsg(addrValidation.error || 'Invalid Monero address format');
      return;
    }

    if (numAmount <= 0) {
      setErrorMsg('Please enter a valid amount greater than 0');
      return;
    }

    if (totalDeduction > activeAccount.unlockedBalanceXMR) {
      setErrorMsg(`Insufficient unlocked balance (Total: ${totalDeduction.toFixed(6)} XMR)`);
      return;
    }

    setIsSending(true);
    try {
      const tx = await sendTransaction(recipient.trim(), numAmount, priority);
      setTxSuccess(tx.txHash);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setIsSending(false);
    }
  };

  const handleMax = () => {
    const maxVal = Math.max(0, activeAccount.unlockedBalanceXMR - fee);
    setAmount(maxVal.toFixed(6));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto shadow-2xl flex flex-col text-slate-100">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900/95 backdrop-blur-md z-10">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400">
              <ArrowUpRight className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Send Monero</h2>
              <p className="text-[11px] text-slate-400">Private RingCT Transaction</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Success Screen */}
        {txSuccess ? (
          <div className="p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-emerald-950/80 border border-emerald-700 text-emerald-400 flex items-center justify-center mx-auto shadow-lg">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Transaction Broadcasted!</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
                Sent {numAmount} XMR with 16 ring decoys through{' '}
                {activeNode.isTor || isTorRoutingEnabled ? 'Tor Onion route' : 'Clearnet'}.
              </p>
            </div>
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-left font-mono text-[11px] space-y-1">
              <div className="text-slate-500">Transaction ID (Hash):</div>
              <div className="text-emerald-400 truncate">{txSuccess}</div>
            </div>
            <button
              onClick={() => {
                setTxSuccess(null);
                onClose();
              }}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs py-2.5 rounded-xl transition-colors cursor-pointer"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSend} className="p-4 space-y-3.5">
            {errorMsg && (
              <div className="p-2.5 bg-red-950/60 border border-red-800 rounded-xl text-xs text-red-300 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Recipient Input */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                <span>Recipient Address</span>
                {addrValidation && addrValidation.isValid && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${
                    addrValidation.type === 'subaddress' 
                      ? 'bg-purple-950/80 text-purple-300 border border-purple-800' 
                      : 'bg-amber-950/80 text-amber-300 border border-amber-800'
                  }`}>
                    {addrValidation.type === 'subaddress' ? 'Stealth Subaddress (8...)' : 'Primary Address (4...)'}
                  </span>
                )}
              </label>
              <textarea
                rows={2}
                placeholder="4... or 8... or OpenAlias"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-xs text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-orange-500 resize-none"
              />
              {addrValidation && !addrValidation.isValid && (
                <div className="text-[11px] text-red-400">
                  {addrValidation.error}
                </div>
              )}
            </div>

            {/* Amount Input */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <label className="font-semibold text-slate-300">Amount (XMR)</label>
                <div className="text-slate-400 text-[11px] font-mono">
                  Avail: {activeAccount.unlockedBalanceXMR.toFixed(4)} XMR
                </div>
              </div>
              <div className="relative flex items-center">
                <input
                  type="number"
                  step="any"
                  placeholder="0.0000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-orange-500 pr-16"
                />
                <button
                  type="button"
                  onClick={handleMax}
                  className="absolute right-2 px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-orange-400 text-xs font-bold rounded-lg cursor-pointer"
                >
                  MAX
                </button>
              </div>
              <div className="text-[11px] text-slate-400 font-mono text-right">
                ≈ ${fiatEquivalent} {settings.fiatCurrency}
              </div>
            </div>

            {/* Priority / Fee Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300">
                Transaction Priority (RingCT Fee)
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['slow', 'normal', 'fast'] as const).map((p) => {
                  const isSel = priority === p;
                  const f = p === 'slow' ? '0.00002' : p === 'normal' ? '0.00003' : '0.00006';
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={`p-2 rounded-xl border text-center transition-all cursor-pointer ${
                        isSel
                          ? 'bg-orange-950/40 border-orange-500 text-white shadow-sm'
                          : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="text-xs font-bold capitalize">{p}</div>
                      <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                        ~{f} XMR
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Privacy Shield Info Card */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 space-y-1.5 text-[11px]">
              <div className="flex items-center justify-between text-slate-300">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Ring Decoy Size:</span>
                </span>
                <span className="font-mono text-emerald-400 font-semibold">
                  16 members (15 decoys)
                </span>
              </div>

              <div className="flex items-center justify-between text-slate-300">
                <span className="flex items-center gap-1.5">
                  <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Broadcast Route:</span>
                </span>
                <span className="font-mono text-emerald-400 font-semibold">
                  {activeNode.isTor || isTorRoutingEnabled ? '🧅 Tor Hidden Service' : '🌐 Clearnet IP'}
                </span>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isSending}
              className="w-full bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold text-xs py-2.5 rounded-xl shadow-lg shadow-orange-600/30 transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Send className={`w-3.5 h-3.5 ${isSending ? 'animate-spin' : ''}`} />
              <span>{isSending ? 'Signing & Broadcasting...' : `Send ${numAmount || ''} XMR`}</span>
            </button>
          </form>
        )}

      </div>
    </div>
  );
};
