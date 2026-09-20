import React from 'react';
import { useWallet } from '../state/WalletContext';
import { 
  ShieldCheck, 
  ShieldAlert, 
  Radio, 
  ChevronDown, 
  ExternalLink, 
  Lock, 
  Settings, 
  Maximize2,
  Copy,
  Check
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
  const { activeNode, isTorRoutingEnabled, privacyScore, activeAccount, lockWallet } = useWallet();
  const [copied, setCopied] = React.useState(false);

  const copyShortAddress = () => {
    const addr = activeAccount?.subaddresses[activeAccount.activeSubaddressIndex]?.address || activeAccount?.primaryAddress || '';
    navigator.clipboard.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <header className="bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 py-2.5 flex items-center justify-between sticky top-0 z-30 select-none">
      {/* Left: Brand & Node / Tor status pill */}
      <div className="flex items-center gap-2">
        {/* Obsidian Monero Logo */}
        <div className="flex items-center gap-1.5 cursor-pointer group" title="Obsidian Monero Wallet">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-amber-600 via-orange-500 to-amber-400 p-[1.5px] shadow-sm shadow-orange-500/20 group-hover:scale-105 transition-transform">
            <div className="w-full h-full bg-slate-950 rounded-[7px] flex items-center justify-center font-black text-amber-500 text-xs">
              ɱ
            </div>
          </div>
          <span className="font-bold text-sm tracking-tight text-white hidden sm:inline">
            Obsidian
          </span>
        </div>

        {/* Node & Routing Selector Pill */}
        <button
          onClick={onOpenNodeModal}
          className="flex items-center gap-1.5 bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/70 hover:border-slate-600 rounded-full px-2.5 py-1 text-xs text-slate-200 transition-all cursor-pointer shadow-inner"
          title={`Active Node: ${activeNode.name} (${activeNode.type})`}
        >
          {/* Tor vs Clearnet Indicator */}
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
          <span className="text-[11px] font-mono text-slate-300 truncate max-w-[85px]">
            {activeNode.name.split(' ')[0]}
          </span>
          <ChevronDown className="w-3 h-3 text-slate-400" />
        </button>
      </div>

      {/* Right: Privacy Posture Meter & Actions */}
      <div className="flex items-center gap-2">
        {/* Privacy Posture Meter Pill (The core differentiator!) */}
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
