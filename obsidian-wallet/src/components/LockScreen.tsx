import React, { useState } from 'react';
import { useWallet } from '../state/WalletContext';
import { Lock, ArrowRight, ShieldCheck, KeyRound } from 'lucide-react';

interface LockScreenProps {
  onResetPrompt: () => void;
}

export const LockScreen: React.FC<LockScreenProps> = ({ onResetPrompt }) => {
  const { unlockWallet, activeAccount } = useWallet();
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsSubmitting(true);

    try {
      const ok = await unlockWallet(password);
      if (!ok) {
        setErrorMsg('Incorrect password. Please try again.');
      }
    } catch {
      setErrorMsg('Error unlocking vault.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-full flex flex-col justify-center p-4 bg-slate-950 text-slate-100 select-none">
      <div className="w-full max-w-sm mx-auto bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl space-y-6 text-center">
        
        {/* Brand Icon */}
        <div className="flex flex-col items-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-orange-600 via-amber-500 to-yellow-400 p-[2px] shadow-lg shadow-orange-500/20">
            <div className="w-full h-full bg-slate-950 rounded-[14px] flex items-center justify-center font-black text-amber-500 text-2xl">
              ɱ
            </div>
          </div>
          <h1 className="text-xl font-extrabold tracking-tight text-white">
            Obsidian Monero
          </h1>
          <p className="text-xs text-slate-400">
            Welcome back! Enter your password to unlock.
          </p>
        </div>

        {/* Password Form */}
        <form onSubmit={handleUnlock} className="space-y-3.5">
          {errorMsg && (
            <div className="p-2 bg-red-950/70 border border-red-800 rounded-xl text-xs text-red-300 animate-fade-in">
              {errorMsg}
            </div>
          )}

          <div className="relative">
            <input
              type="password"
              placeholder="Master Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-orange-500"
              autoFocus
              required
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2.5 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-orange-600/30 transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>{isSubmitting ? 'Decrypting Vault...' : 'Unlock Wallet'}</span>
          </button>
        </form>

        <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-xs text-slate-500">
          <button
            onClick={onResetPrompt}
            className="hover:text-orange-400 transition-colors cursor-pointer"
          >
            Forgot password / Reset
          </button>
          <span className="text-[11px] text-emerald-400 flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" />
            <span>AES-256 Vault</span>
          </span>
        </div>

      </div>
    </div>
  );
};
