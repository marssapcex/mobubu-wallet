import React, { useState } from 'react';
import { useWallet } from '../../state/WalletContext';
import { 
  X, 
  Settings, 
  Key, 
  Shield, 
  RotateCcw, 
  Eye, 
  EyeOff, 
  Copy, 
  Check, 
  AlertTriangle,
  FileText
} from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { settings, updateSettings, activeAccount, resetWallet } = useWallet();
  const [showSeed, setShowSeed] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [copiedSeed, setCopiedSeed] = useState(false);
  const [copiedViewKey, setCopiedViewKey] = useState(false);
  const [isResetConfirm, setIsResetConfirm] = useState(false);

  if (!isOpen) return null;

  const copySeed = () => {
    if (!activeAccount) return;
    navigator.clipboard.writeText(activeAccount.mnemonic);
    setCopiedSeed(true);
    setTimeout(() => setCopiedSeed(false), 2000);
  };

  const copyViewKey = () => {
    if (!activeAccount) return;
    navigator.clipboard.writeText(activeAccount.viewPrivateHex);
    setCopiedViewKey(true);
    setTimeout(() => setCopiedViewKey(false), 2000);
  };

  const handleReset = async () => {
    await resetWallet();
    setIsResetConfirm(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-md max-h-[92vh] overflow-y-auto shadow-2xl flex flex-col text-slate-100">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900/95 backdrop-blur-md z-10">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-slate-800 text-slate-300">
              <Settings className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Mobubu Settings</h2>
              <p className="text-[11px] text-slate-400">Security, Network & Key Management</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          
          {/* General Preferences */}
          <div className="space-y-3">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Preferences
            </div>

            {/* Currency selector */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-slate-200">Fiat Currency</div>
                <div className="text-[11px] text-slate-400">For balance valuation</div>
              </div>
              <select
                value={settings.fiatCurrency}
                onChange={(e) => updateSettings({ fiatCurrency: e.target.value as any })}
                className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-2.5 py-1 text-xs focus:outline-none cursor-pointer"
              >
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
                <option value="GBP">GBP (£)</option>
                <option value="BTC">BTC (₿)</option>
                <option value="VND">VND (₫)</option>
              </select>
            </div>

            {/* Tor SOCKS5 Port */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-slate-200">Tor SOCKS5 Port</div>
                <div className="text-[11px] text-slate-400">Default daemon: 9050, Tor Browser: 9150</div>
              </div>
              <input
                type="number"
                value={settings.torSocksPort}
                onChange={(e) => updateSettings({ torSocksPort: parseInt(e.target.value) || 9050 })}
                className="w-20 bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-2 py-1 text-xs text-right font-mono focus:outline-none"
              />
            </div>
          </div>

          {/* Security & Seed Phrase */}
          <div className="pt-3 border-t border-slate-800 space-y-2.5">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Backup & Secret Keys
            </div>

            {/* 25-word Seed */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                  <Key className="w-3.5 h-3.5 text-amber-400" />
                  <span>25-Word Monero Recovery Seed</span>
                </div>
                <button
                  onClick={() => setShowSeed(prev => !prev)}
                  className="flex items-center gap-1 text-[11px] text-orange-400 hover:text-orange-300 font-semibold cursor-pointer"
                >
                  {showSeed ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  <span>{showSeed ? 'Hide' : 'Reveal'}</span>
                </button>
              </div>

              {showSeed && activeAccount && (
                <div className="space-y-2 pt-1 animate-fade-in">
                  <div className="p-2.5 bg-slate-900 border border-slate-700 rounded-lg font-mono text-[11px] text-slate-300 leading-relaxed select-all">
                    {activeAccount.mnemonic}
                  </div>
                  <button
                    onClick={copySeed}
                    className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-1.5 rounded-lg flex items-center justify-center gap-1 cursor-pointer transition-colors"
                  >
                    {copiedSeed ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Copied Seed!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Seed Words</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Private View Key (For View-Only audit wallets) */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                  <FileText className="w-3.5 h-3.5 text-blue-400" />
                  <span>Private View Key (View-Only Auditing)</span>
                </div>
                <button
                  onClick={() => setShowKeys(prev => !prev)}
                  className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 font-semibold cursor-pointer"
                >
                  {showKeys ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  <span>{showKeys ? 'Hide' : 'Reveal'}</span>
                </button>
              </div>

              {showKeys && activeAccount && (
                <div className="space-y-2 pt-1 animate-fade-in">
                  <p className="text-[10px] text-slate-400">
                    A private view key allows an auditor or cold watch wallet to see incoming transactions without spend access.
                  </p>
                  <div className="p-2 bg-slate-900 border border-slate-700 rounded-lg font-mono text-[10px] text-slate-300 break-all select-all">
                    {activeAccount.viewPrivateHex}
                  </div>
                  <button
                    onClick={copyViewKey}
                    className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-1.5 rounded-lg flex items-center justify-center gap-1 cursor-pointer transition-colors"
                  >
                    {copiedViewKey ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Copied View Key!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Private View Key</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Danger Zone */}
          <div className="pt-3 border-t border-slate-800 space-y-2">
            <div className="text-xs font-bold text-red-400 uppercase tracking-wider">
              Danger Zone
            </div>

            {isResetConfirm ? (
              <div className="p-3 bg-red-950/40 border border-red-800/80 rounded-xl space-y-2 animate-fade-in text-xs">
                <div className="flex items-center gap-2 text-red-300 font-bold">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>Are you absolutely sure?</span>
                </div>
                <p className="text-[11px] text-slate-300">
                  This will erase your encrypted vault and saved transactions from this browser. Ensure you backed up your 25-word seed!
                </p>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    onClick={() => setIsResetConfirm(false)}
                    className="px-3 py-1 bg-slate-800 text-slate-300 text-xs rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleReset}
                    className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer"
                  >
                    Yes, Erase & Reset
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setIsResetConfirm(true)}
                className="w-full py-2 bg-red-950/30 hover:bg-red-950/60 border border-red-900/60 text-red-400 text-xs font-semibold rounded-xl transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Wallet & Erase Vault</span>
              </button>
            )}
          </div>

        </div>

      </div>
    </div>
  );
};
