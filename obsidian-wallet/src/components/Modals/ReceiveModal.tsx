import React, { useState } from 'react';
import { useWallet } from '../../state/WalletContext';
import { 
  X, 
  ArrowDownLeft, 
  Copy, 
  Check, 
  Plus, 
  ShieldCheck, 
  AlertTriangle,
  RotateCw
} from 'lucide-react';

interface ReceiveModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ReceiveModal: React.FC<ReceiveModalProps> = ({ isOpen, onClose }) => {
  const { activeAccount, generateNewSubaddress, setActiveSubaddress } = useWallet();
  const [copied, setCopied] = useState(false);
  const [createdLabel, setCreatedLabel] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  if (!isOpen || !activeAccount) return null;

  const currentSub = activeAccount.subaddresses[activeAccount.activeSubaddressIndex];
  const activeAddress = currentSub?.address || activeAccount.primaryAddress;
  const isSubaddress = activeAddress.startsWith('8') || activeAddress.startsWith('B');

  const copyAddress = () => {
    navigator.clipboard.writeText(activeAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCreateSubaddress = () => {
    generateNewSubaddress(createdLabel.trim() || undefined);
    setCreatedLabel('');
    setIsAdding(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto shadow-2xl flex flex-col text-slate-100">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900/95 backdrop-blur-md z-10">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
              <ArrowDownLeft className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Receive Monero</h2>
              <p className="text-[11px] text-slate-400">Stealth Address & QR</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col items-center space-y-4">
          
          {/* Subaddress Selector & Type Badge */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${
              isSubaddress 
                ? 'bg-purple-950/80 border-purple-700/80 text-purple-300' 
                : 'bg-amber-950/80 border-amber-700/80 text-amber-300'
            }`}>
              {isSubaddress ? `Subaddress #${currentSub?.minor || 1}` : '⚠️ Main Address'}
            </span>
            <span className="text-xs text-slate-400 font-medium">
              {currentSub?.label || 'Default'}
            </span>
          </div>

          {/* QR Code Container */}
          <div className="p-3 bg-white rounded-2xl shadow-xl flex items-center justify-center">
            {/* High-contrast QR representation */}
            <div className="w-48 h-48 bg-white flex flex-col items-center justify-center relative select-none">
              <svg viewBox="0 0 100 100" className="w-full h-full text-slate-900 fill-current">
                {/* Simplified aesthetic QR pattern */}
                <rect x="5" y="5" width="25" height="25" fill="#0f172a" />
                <rect x="9" y="9" width="17" height="17" fill="#ffffff" />
                <rect x="13" y="13" width="9" height="9" fill="#0f172a" />

                <rect x="70" y="5" width="25" height="25" fill="#0f172a" />
                <rect x="74" y="9" width="17" height="17" fill="#ffffff" />
                <rect x="78" y="13" width="9" height="9" fill="#0f172a" />

                <rect x="5" y="70" width="25" height="25" fill="#0f172a" />
                <rect x="9" y="74" width="17" height="17" fill="#ffffff" />
                <rect x="13" y="78" width="9" height="9" fill="#0f172a" />

                {/* Random decorative QR bits */}
                <rect x="35" y="8" width="8" height="4" fill="#0f172a" />
                <rect x="47" y="12" width="6" height="6" fill="#0f172a" />
                <rect x="56" y="8" width="8" height="6" fill="#0f172a" />
                <rect x="35" y="24" width="26" height="4" fill="#0f172a" />

                <rect x="8" y="35" width="6" height="10" fill="#0f172a" />
                <rect x="20" y="42" width="10" height="6" fill="#0f172a" />
                <rect x="8" y="55" width="12" height="6" fill="#0f172a" />

                <rect x="72" y="36" width="20" height="5" fill="#0f172a" />
                <rect x="76" y="46" width="12" height="8" fill="#0f172a" />
                <rect x="85" y="60" width="8" height="8" fill="#0f172a" />

                <rect x="36" y="72" width="8" height="8" fill="#0f172a" />
                <rect x="48" y="75" width="12" height="6" fill="#0f172a" />
                <rect x="65" y="82" width="28" height="6" fill="#0f172a" />
                <rect x="40" y="85" width="16" height="8" fill="#0f172a" />

                {/* Monero Center Logo */}
                <circle cx="50" cy="50" r="14" fill="#ff6600" />
                <text x="50" y="55" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="bold">ɱ</text>
              </svg>
            </div>
          </div>

          {/* Full Address Display with Copy */}
          <div className="w-full space-y-1.5">
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex flex-col gap-2">
              <div className="text-[11px] font-mono text-slate-300 break-all select-all leading-relaxed">
                {activeAddress}
              </div>
              <button
                onClick={copyAddress}
                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400">Copied to Clipboard!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Full Address</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Subaddress Hygiene Note (Feather Best Practice) */}
          <div className="w-full p-3 bg-purple-950/20 border border-purple-900/40 rounded-xl space-y-1.5 text-xs">
            <div className="flex items-center gap-1.5 text-purple-300 font-semibold">
              <ShieldCheck className="w-3.5 h-3.5 text-purple-400" />
              <span>Subaddress Stealth Hygiene</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Monero subaddresses start with <strong>8</strong>. They protect your primary key and cannot be linked on the public blockchain. Generate a new subaddress for each person or service to maximize your Privacy Posture!
            </p>

            <button
              onClick={handleCreateSubaddress}
              className="mt-1 w-full bg-purple-900/60 hover:bg-purple-800/80 border border-purple-700/60 text-purple-200 text-xs font-medium py-1.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Generate Fresh Subaddress (Rotates QR)</span>
            </button>
          </div>

        </div>
      </div>
    </div>
  );
};
