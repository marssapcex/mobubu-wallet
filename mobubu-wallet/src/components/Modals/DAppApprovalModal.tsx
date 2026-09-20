import React from 'react';
import { useWallet } from '../../state/WalletContext';
import { Globe, ShieldCheck, AlertCircle, Check, X, Send } from 'lucide-react';

export const DAppApprovalModal: React.FC = () => {
  const { pendingDAppRequest, approveDAppRequest, rejectDAppRequest, activeAccount } = useWallet();

  if (!pendingDAppRequest || !activeAccount) return null;

  const currentSub = activeAccount.subaddresses[activeAccount.activeSubaddressIndex];
  const activeAddress = currentSub?.address || activeAccount.primaryAddress;

  const isConnect = pendingDAppRequest.type === 'connect';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/85 backdrop-blur-sm animate-fade-in select-none">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl flex flex-col text-slate-100">
        
        {/* Top Header */}
        <div className="p-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-orange-600/20 border border-orange-500/40 flex items-center justify-center text-xs font-bold text-orange-400">
              ɱ
            </div>
            <span className="text-xs font-bold text-white">Mobubu Web3 Prompt</span>
          </div>
          <span className="text-[10px] bg-emerald-950/80 text-emerald-400 border border-emerald-800 px-1.5 py-0.2 rounded font-mono">
            Tor Enforced
          </span>
        </div>

        {/* Request Content */}
        <div className="p-5 space-y-4 text-center">
          <div className="w-12 h-12 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center mx-auto text-xl shadow-md">
            🌐
          </div>

          <div>
            <h3 className="text-sm font-bold text-white">
              {isConnect ? 'Connect Request' : 'Confirm Monero Payment'}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5 font-mono truncate">
              {pendingDAppRequest.origin}
            </p>
          </div>

          {isConnect ? (
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-left text-xs space-y-2">
              <div className="text-slate-400 text-[11px]">
                This site would like to view your stealth subaddress:
              </div>
              <div className="p-2 bg-slate-900 border border-slate-700/80 rounded-lg font-mono text-[10px] text-emerald-400 truncate">
                {activeAddress}
              </div>
              <div className="text-[10px] text-slate-500 flex items-center gap-1">
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                <span>Your private spend and view keys remain locked in your vault.</span>
              </div>
            </div>
          ) : (
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-left text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Amount:</span>
                <span className="font-mono text-base font-bold text-orange-400">
                  {pendingDAppRequest.requestedAmount} XMR
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Network Fee:</span>
                <span className="font-mono text-slate-300">~0.00003 XMR</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Ring Size:</span>
                <span className="font-mono text-emerald-400">16 members (15 decoys)</span>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              onClick={rejectDAppRequest}
              className="py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs rounded-xl transition-colors cursor-pointer"
            >
              Reject
            </button>
            <button
              onClick={approveDAppRequest}
              className="py-2.5 bg-orange-600 hover:bg-orange-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-orange-600/30 transition-all cursor-pointer"
            >
              {isConnect ? 'Connect' : 'Approve & Send'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
