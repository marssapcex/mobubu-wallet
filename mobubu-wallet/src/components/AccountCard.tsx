import React, { useState } from 'react';
import { useWallet } from '../state/WalletContext';
import { Copy, Check, Eye, EyeOff, QrCode, Plus, Sparkles, Shield } from 'lucide-react';

interface AccountCardProps {
  onOpenReceiveModal: () => void;
}

export const AccountCard: React.FC<AccountCardProps> = ({ onOpenReceiveModal }) => {
  const { activeAccount, settings, updateSettings, generateNewSubaddress } = useWallet();
  const [copied, setCopied] = useState(false);
  const [justGeneratedSub, setJustGeneratedSub] = useState(false);

  if (!activeAccount) return null;

  const currentSub = activeAccount.subaddresses[activeAccount.activeSubaddressIndex];
  const activeAddress = currentSub?.address || activeAccount.primaryAddress;
  const isSubaddress = activeAddress.startsWith('8') || activeAddress.startsWith('B') || activeAddress.startsWith('7');

  const shortAddress = activeAddress.length > 18
    ? `${activeAddress.slice(0, 8)}...${activeAddress.slice(-8)}`
    : activeAddress;

  const copyAddress = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(activeAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleQuickNewSub = (e: React.MouseEvent) => {
    e.stopPropagation();
    generateNewSubaddress('Quick Stealth Subaddress');
    setJustGeneratedSub(true);
    setTimeout(() => setJustGeneratedSub(false), 2500);
  };

  const fiatValue = (activeAccount.balanceXMR * settings.xmrUsdPrice).toLocaleString('en-US', {
    style: 'currency',
    currency: settings.fiatCurrency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <div className="px-4 pt-3.5 pb-2 flex flex-col items-center text-center">
      {/* Account Switcher Header */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-xs font-bold text-slate-200">
          {activeAccount.name}
        </span>
        {activeAccount.isViewOnly && (
          <span className="text-[9px] bg-slate-800 text-amber-400 border border-amber-800 px-1 py-0.2 rounded font-mono">
            VIEW-ONLY
          </span>
        )}
      </div>

      {/* Address Pill (MetaMask style) */}
      <div className="flex items-center gap-1.5 mb-2.5">
        <button
          onClick={copyAddress}
          className="group flex items-center gap-1.5 bg-slate-800/90 hover:bg-slate-700/80 border border-slate-700 hover:border-slate-600 rounded-full px-3 py-1 text-xs text-slate-300 transition-all cursor-pointer shadow-sm"
          title="Click to copy full Monero address"
        >
          <span className="font-mono text-xs text-slate-300 group-hover:text-white transition-colors">
            {shortAddress}
          </span>
          {copied ? (
            <span className="flex items-center gap-1 text-emerald-400 font-medium text-[11px]">
              <Check className="w-3 h-3" />
              <span>Copied!</span>
            </span>
          ) : (
            <Copy className="w-3 h-3 text-slate-400 group-hover:text-white transition-colors" />
          )}
        </button>

        {/* Quick QR View */}
        <button
          onClick={onOpenReceiveModal}
          className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-full border border-slate-700/60 transition-colors cursor-pointer"
          title="View Address QR Code"
        >
          <QrCode className="w-3 h-3" />
        </button>

        {/* Quick Subaddress Rotator (+ icon) */}
        <button
          onClick={handleQuickNewSub}
          className="p-1 text-purple-400 hover:text-purple-300 hover:bg-purple-950/40 rounded-full border border-purple-800/50 transition-colors cursor-pointer"
          title="Generate fresh single-use subaddress for new counterparty"
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>

      {justGeneratedSub && (
        <div className="mb-2 text-[11px] text-purple-300 bg-purple-950/60 border border-purple-800/70 rounded-full px-2.5 py-0.5 animate-fade-in font-medium">
          ✨ Fresh stealth subaddress generated & active!
        </div>
      )}

      {/* Balance Section */}
      <div className="my-1 flex flex-col items-center">
        <div className="flex items-baseline justify-center gap-1.5">
          <span className="text-3xl font-extrabold font-mono tracking-tight text-white">
            {settings.hideBalance ? '••••••' : activeAccount.balanceXMR.toFixed(4)}
          </span>
          <span className="text-lg font-bold text-orange-400 font-mono">
            XMR
          </span>
          <button
            onClick={() => updateSettings({ hideBalance: !settings.hideBalance })}
            className="text-slate-500 hover:text-slate-300 transition-colors ml-1 cursor-pointer"
            title={settings.hideBalance ? "Show balance" : "Hide balance for privacy"}
          >
            {settings.hideBalance ? (
              <EyeOff className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {/* Fiat Equivalent */}
        <div className="text-xs text-slate-400 font-mono mt-0.5">
          {settings.hideBalance ? '••••••' : fiatValue}
        </div>

        {/* Spendable / Unlocked status bar */}
        <div className="mt-2 text-[11px] flex items-center gap-2 text-slate-400 bg-slate-950/70 border border-slate-800/80 rounded-full px-3 py-0.5 font-mono">
          <span className="text-emerald-400 font-medium">
            Unlocked: {settings.hideBalance ? '•••' : `${activeAccount.unlockedBalanceXMR.toFixed(4)} XMR`}
          </span>
          <span className="text-slate-600">•</span>
          <span className="text-slate-400">
            {isSubaddress ? `Subaddress #${currentSub?.minor || 1}` : '⚠️ Main Address'}
          </span>
        </div>
      </div>
    </div>
  );
};
