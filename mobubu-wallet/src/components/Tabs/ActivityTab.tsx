import React, { useState } from 'react';
import { useWallet } from '../../state/WalletContext';
import { 
  ArrowUpRight, 
  ArrowDownLeft, 
  ArrowLeftRight, 
  RotateCw, 
  ExternalLink, 
  CheckCircle2, 
  Clock, 
  Copy, 
  Check, 
  ShieldCheck 
} from 'lucide-react';
import { WalletTransaction } from '../../types/wallet';

export const ActivityTab: React.FC = () => {
  const { transactions, settings } = useWallet();
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const copyTxHash = (hash: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const toggleExpand = (id: string) => {
    setExpandedTxId(curr => (curr === id ? null : id));
  };

  if (transactions.length === 0) {
    return (
      <div className="p-8 text-center text-slate-500">
        <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <div className="text-sm font-semibold text-slate-400">No activity yet</div>
        <div className="text-xs text-slate-500 mt-1">
          Your sent, received, and swap transactions will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-2">
      {transactions.map((tx) => {
        const isExpanded = expandedTxId === tx.id;
        const dateStr = new Date(tx.timestamp).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

        const isOutgoing = tx.type === 'send' || tx.type === 'churn';
        const sign = tx.type === 'send' ? '-' : tx.type === 'receive' ? '+' : '';

        return (
          <div
            key={tx.id}
            onClick={() => toggleExpand(tx.id)}
            className="bg-slate-800/60 hover:bg-slate-800/90 border border-slate-700/60 rounded-xl p-3 transition-colors cursor-pointer shadow-sm select-none"
          >
            {/* Main Row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {/* Transaction Icon */}
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center border shadow-sm ${
                    tx.type === 'receive'
                      ? 'bg-emerald-950/70 border-emerald-700 text-emerald-400'
                      : tx.type === 'send'
                      ? 'bg-blue-950/70 border-blue-700 text-blue-400'
                      : tx.type === 'swap'
                      ? 'bg-orange-950/70 border-orange-700 text-orange-400'
                      : 'bg-purple-950/70 border-purple-700 text-purple-400'
                  }`}
                >
                  {tx.type === 'receive' && <ArrowDownLeft className="w-4 h-4" />}
                  {tx.type === 'send' && <ArrowUpRight className="w-4 h-4" />}
                  {tx.type === 'swap' && <ArrowLeftRight className="w-4 h-4" />}
                  {tx.type === 'churn' && <RotateCw className="w-4 h-4" />}
                </div>

                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-white capitalize">
                      {tx.type === 'churn' ? 'Decoy Churn' : tx.type}
                    </span>
                    {tx.status === 'confirmed' ? (
                      <span className="flex items-center gap-0.5 text-[10px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 rounded px-1.5 py-0.2">
                        <CheckCircle2 className="w-2.5 h-2.5" />
                        <span>Confirmed</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-0.5 text-[10px] text-amber-400 bg-amber-950/40 border border-amber-800/50 rounded px-1.5 py-0.2 animate-pulse">
                        <Clock className="w-2.5 h-2.5" />
                        <span>Mempool</span>
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                    {dateStr}
                  </div>
                </div>
              </div>

              {/* Amount */}
              <div className="text-right">
                <div
                  className={`text-xs font-bold font-mono ${
                    tx.type === 'receive'
                      ? 'text-emerald-400'
                      : tx.type === 'send'
                      ? 'text-slate-200'
                      : 'text-orange-400'
                  }`}
                >
                  {settings.hideBalance
                    ? '••••••'
                    : `${sign}${tx.amount.toFixed(4)} XMR`}
                </div>
                <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                  {settings.hideBalance
                    ? '••••••'
                    : `≈ $${(tx.amount * settings.xmrUsdPrice).toFixed(2)}`}
                </div>
              </div>
            </div>

            {/* Expanded Details Drawer */}
            {isExpanded && (
              <div className="mt-3 pt-3 border-t border-slate-700/60 space-y-2 text-[11px] animate-fade-in font-mono">
                <div className="flex items-center justify-between text-slate-400">
                  <span>Privacy Ring Size:</span>
                  <span className="flex items-center gap-1 text-emerald-400 font-semibold">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{tx.ringSize} (1 real + 15 decoys)</span>
                  </span>
                </div>

                <div className="flex items-center justify-between text-slate-400">
                  <span>Network Fee:</span>
                  <span className="text-slate-200">{tx.fee.toFixed(6)} XMR</span>
                </div>

                <div className="flex items-center justify-between text-slate-400">
                  <span>Confirmations:</span>
                  <span className="text-slate-200">{tx.confirmations} blocks</span>
                </div>

                {tx.note && (
                  <div className="flex items-center justify-between text-slate-400">
                    <span>Memo:</span>
                    <span className="text-slate-300 font-sans italic">{tx.note}</span>
                  </div>
                )}

                {/* TX Hash with Copy & Explorer */}
                <div className="pt-1.5 flex items-center justify-between gap-2 border-t border-slate-800">
                  <div className="text-slate-500 truncate max-w-[170px] text-[10px]">
                    Hash: {tx.txHash.slice(0, 10)}...{tx.txHash.slice(-10)}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={(e) => copyTxHash(tx.txHash, e)}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white transition-colors cursor-pointer text-[10px]"
                    >
                      {copiedHash === tx.txHash ? (
                        <>
                          <Check className="w-2.5 h-2.5 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-2.5 h-2.5" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                    <a
                      href={`https://xmrchain.net/search?value=${tx.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-orange-400 hover:text-orange-300 transition-colors text-[10px]"
                      title="View on XMRChain block explorer"
                    >
                      <span>Explorer</span>
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
