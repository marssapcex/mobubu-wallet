import React, { useState } from 'react';
import { useWallet } from '../state/WalletContext';
import { 
  ShieldCheck, 
  ShieldAlert, 
  ChevronDown, 
  Lock, 
  Settings, 
  Maximize2,
  Users,
  Plus
} from 'lucide-react';

interface HeaderProps {
  onOpenPrivacyModal: () => void;
  onOpenNodeModal: () => void;
  onOpenSettingsModal: () => void;
  onToggleViewMode?: () => void;
  isExpandedView?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenPrivacyModal,
  onOpenNodeModal,
  onOpenSettingsModal,
  onToggleViewMode,
  isExpandedView,
}) => {
  const { 
    activeNode, 
    isTorRoutingEnabled, 
    privacyScore, 
    accounts, 
    activeAccount, 
    switchAccount, 
    createAdditionalAccount,
    lockWallet 
  } = useWallet();

  const [showAccountDropdown, setShowAccountDropdown] = useState(false);

  return (
    <header className="bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-3 py-2.5 flex items-center justify-between sticky top-0 z-30 select-none">
      {/* Left: Brand & Node / Tor status pill */}
      <div className="flex items-center gap-2">
        {/* Mobubu Mascot / Monero Logo */}
        <div className="flex items-center gap-1.5 cursor-pointer group" title="Mobubu Monero Web3 Extension">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-orange-600 via-amber-500 to-yellow-400 p-[1.5px] shadow-sm shadow-orange-500/20 group-hover:scale-105 transition-transform">
            <div className="w-full h-full bg-slate-950 rounded-[7px] flex items-center justify-center font-black text-amber-500 text-xs">
              ɱ
            </div>
          </div>
          <span className="font-extrabold text-sm tracking-tight text-white hidden xs:inline">
            Mobubu
          </span>
        </div>

        {/* Node & Routing Selector Pill */}
        <button
          onClick={onOpenNodeModal}
          className="flex items-center gap-1.5 bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/70 hover:border-slate-600 rounded-full px-2.5 py-1 text-xs text-slate-200 transition-all cursor-pointer shadow-inner"
          title={`Active Node: ${activeNode.name} (${activeNode.type})`}
        >
          {activeNode.isTor || isTorRoutingEnabled ? (
            <span className="flex items-center gap-1 text-emerald-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[11px]">🧅 Tor</span>
            </span>
          ) : activeNode.type === 'local_fullnode' ? (
            <span className="flex items-center gap-1 text-blue-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-blue-400" />
              <span className="text-[11px]">⚡ Local</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-amber-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              <span className="text-[11px]">🌐 Clearnet</span>
            </span>
          )}

          <span className="text-slate-400">|</span>
          <span className="text-[11px] font-mono text-slate-300 truncate max-w-[75px]">
            {activeNode.name.split(' ')[0]}
          </span>
          <ChevronDown className="w-3 h-3 text-slate-400" />
        </button>
      </div>

      {/* Right: Privacy Posture Meter & Actions */}
      <div className="flex items-center gap-1.5 sm:gap-2">
        {/* Privacy Posture Meter Pill */}
        <button
          onClick={onOpenPrivacyModal}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold transition-all shadow-sm cursor-pointer border ${
            privacyScore.tier === 'optimal'
              ? 'bg-emerald-950/70 border-emerald-600/70 text-emerald-300 hover:bg-emerald-900/60 shadow-emerald-900/20'
              : privacyScore.tier === 'good'
              ? 'bg-teal-950/70 border-teal-600/70 text-teal-300 hover:bg-teal-900/60'
              : privacyScore.tier === 'moderate'
              ? 'bg-amber-950/70 border-amber-600/70 text-amber-300 hover:bg-amber-900/60 animate-pulse'
              : 'bg-red-950/80 border-red-600 text-red-300 hover:bg-red-900/60 animate-bounce'
          }`}
          title="Click to inspect your Privacy Posture (0-100)"
        >
          {privacyScore.tier === 'optimal' || privacyScore.tier === 'good' ? (
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
          )}
          <span className="font-mono font-bold tracking-tight">
            {privacyScore.totalScore}/100
          </span>
          <span className="text-[10px] uppercase tracking-wider hidden xs:inline px-1 py-0.2 bg-black/40 rounded">
            {privacyScore.tier === 'optimal' ? 'Ironclad' : privacyScore.tier === 'good' ? 'Secure' : 'Warning'}
          </span>
        </button>

        {/* Account Selector Pill */}
        <div className="relative">
          <button
            onClick={() => setShowAccountDropdown(prev => !prev)}
            className="w-7 h-7 rounded-full bg-gradient-to-tr from-orange-500 via-amber-500 to-yellow-400 border border-slate-700 shadow-sm flex items-center justify-center text-[11px] font-bold text-slate-950 cursor-pointer"
            title="Switch or Create Account"
          >
            {(activeAccount?.index || 0) + 1}
          </button>

          {showAccountDropdown && (
            <div className="absolute right-0 mt-2 w-48 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-1.5 z-50 text-xs animate-fade-in">
              <div className="px-2 py-1 text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                Accounts ({accounts.length})
              </div>
              <div className="space-y-0.5">
                {accounts.map(acc => (
                  <button
                    key={acc.index}
                    onClick={() => {
                      switchAccount(acc.index);
                      setShowAccountDropdown(false);
                    }}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between cursor-pointer ${
                      acc.index === activeAccount?.index
                        ? 'bg-orange-600 text-white font-bold'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span className="truncate">{acc.name}</span>
                    <span className="font-mono text-[10px] opacity-75">
                      {acc.balanceXMR.toFixed(2)}
                    </span>
                  </button>
                ))}
              </div>

              <div className="pt-1.5 mt-1.5 border-t border-slate-800">
                <button
                  onClick={() => {
                    createAdditionalAccount(`Account ${accounts.length + 1}`);
                    setShowAccountDropdown(false);
                  }}
                  className="w-full text-left px-2.5 py-1 text-[11px] text-orange-400 hover:bg-slate-800 rounded-lg flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Create Account</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* View toggle (popup vs expanded) */}
        {onToggleViewMode && (
          <button
            onClick={onToggleViewMode}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            title={isExpandedView ? "Switch to Extension Popup View" : "Expand to Full-Tab View"}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Settings button */}
        <button
          onClick={onOpenSettingsModal}
          className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          title="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>

        {/* Lock wallet button */}
        <button
          onClick={lockWallet}
          className="p-1.5 text-slate-400 hover:text-amber-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          title="Lock Wallet"
        >
          <Lock className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};
