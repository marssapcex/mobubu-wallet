import React, { useState } from 'react';
import { useWallet } from '../../state/WalletContext';
import { 
  KeyRound, 
  RotateCw, 
  Plus, 
  Check, 
  Copy, 
  CheckCircle2, 
  AlertCircle, 
  ShieldCheck, 
  ExternalLink 
} from 'lucide-react';

export const PrivacyTab: React.FC = () => {
  const { 
    activeAccount, 
    generateNewSubaddress, 
    setActiveSubaddress, 
    sendTransaction,
    privacyScore 
  } = useWallet();

  const [newSubLabel, setNewSubLabel] = useState('');
  const [isCreatingSub, setIsCreatingSub] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [isChurning, setIsChurning] = useState(false);
  const [churnSuccess, setChurnSuccess] = useState(false);

  if (!activeAccount) return null;

  const handleCreateSub = (e: React.FormEvent) => {
    e.preventDefault();
    generateNewSubaddress(newSubLabel.trim() || undefined);
    setNewSubLabel('');
    setIsCreatingSub(false);
  };

  const copySubAddress = (addr: string, idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(addr);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleTriggerChurn = async () => {
    setIsChurning(true);
    try {
      const freshSub = generateNewSubaddress('Decoy Churn Sweep');
      await sendTransaction(freshSub.address, 0.45, 'normal', true);
      setChurnSuccess(true);
      setTimeout(() => setChurnSuccess(false), 4000);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setIsChurning(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      {/* 1. Subaddress Manager (Feather style) */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <KeyRound className="w-4 h-4 text-purple-400" />
            <span className="text-xs font-bold text-white uppercase tracking-wider">
              Subaddresses ({activeAccount.subaddresses.length})
            </span>
          </div>

          <button
            onClick={() => setIsCreatingSub(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-purple-950/80 hover:bg-purple-900 border border-purple-700/60 rounded-lg text-purple-300 text-xs font-semibold transition-colors cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            <span>New Subaddress</span>
          </button>
        </div>

        {/* Modal/Input to name new subaddress */}
        {isCreatingSub && (
          <form
            onSubmit={handleCreateSub}
            className="p-3 bg-slate-900 border border-purple-800/80 rounded-xl space-y-2 animate-fade-in"
          >
            <div className="text-xs font-semibold text-purple-300">
              Create Fresh Stealth Subaddress
            </div>
            <input
              type="text"
              placeholder="Label (e.g. Donations, Coffee Shop, Peer A)"
              value={newSubLabel}
              onChange={(e) => setNewSubLabel(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-purple-500"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsCreatingSub(false)}
                className="px-2.5 py-1 text-xs text-slate-400 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
              >
                Generate
              </button>
            </div>
          </form>
        )}

        {/* Subaddress list */}
        <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
          {activeAccount.subaddresses.map((sub, idx) => {
            const isActive = idx === activeAccount.activeSubaddressIndex;
            return (
              <div
                key={sub.minor}
                onClick={() => setActiveSubaddress(idx)}
                className={`p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2 ${
                  isActive
                    ? 'bg-purple-950/40 border-purple-600/70 shadow-sm'
                    : 'bg-slate-950/60 hover:bg-slate-800/50 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-slate-200 truncate">
                      {sub.label}
                    </span>
                    <span className="text-[10px] bg-slate-800 text-slate-400 rounded px-1 font-mono">
                      #{sub.minor}
                    </span>
                    {isActive && (
                      <span className="text-[9px] bg-purple-600/80 text-white rounded px-1 font-semibold uppercase">
                        Active
                      </span>
                    )}
                    {sub.isUsed ? (
                      <span className="text-[9px] text-slate-500">Used</span>
                    ) : (
                      <span className="text-[9px] text-emerald-400 font-medium">✨ Fresh</span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-slate-500 truncate mt-0.5">
                    {sub.address.slice(0, 12)}...{sub.address.slice(-12)}
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-1">
                  <button
                    onClick={(e) => copySubAddress(sub.address, idx, e)}
                    className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors cursor-pointer"
                    title="Copy this subaddress"
                  >
                    {copiedIndex === idx ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Self-Churn Mechanism (Feather Privacy feature) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-orange-500/10 text-orange-400 border border-orange-500/30">
              <RotateCw className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-bold text-white">
                Decoy Churn Engine (Self-Spend)
              </div>
              <div className="text-[11px] text-slate-400">
                Breaks timing heuristics by spending back to self
              </div>
            </div>
          </div>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          When receiving funds from an exchange or KYC counterparty, churning creates a new ring of 16 decoys to decouple your transaction history completely.
        </p>

        {churnSuccess && (
          <div className="p-2.5 bg-emerald-950/60 border border-emerald-800/80 rounded-xl text-emerald-300 text-xs font-medium flex items-center gap-1.5 animate-fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>Churn transaction submitted to mempool with 16 ring members!</span>
          </div>
        )}

        <button
          onClick={handleTriggerChurn}
          disabled={isChurning}
          className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs py-2 rounded-xl border border-slate-700 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
        >
          <RotateCw className={`w-3.5 h-3.5 ${isChurning ? 'animate-spin' : ''}`} />
          <span>{isChurning ? 'Broadcasting Churn...' : 'Initiate Decoy Churn (0.45 XMR)'}</span>
        </button>
      </div>

      {/* 3. Ring Signature Diagnostics */}
      <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-xl space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
          <ShieldCheck className="w-4 h-4" />
          <span>Monero RingCT Protocol Active</span>
        </div>
        <div className="text-[11px] text-slate-400 space-y-1">
          <div>• Ring Size: <strong>16 members</strong> (1 real + 15 cryptographic decoys)</div>
          <div>• Stealth Addresses: One-time ephemeral keys derived via ECDH</div>
          <div>• Confidential Transactions: Pedersen commitments hide amounts</div>
        </div>
      </div>
    </div>
  );
};
