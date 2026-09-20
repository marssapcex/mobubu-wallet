import React, { useState } from 'react';
import { useWallet } from '../../state/WalletContext';
import { Coins, Shield, Info, CheckCircle2, Lock, ArrowUpRight } from 'lucide-react';

export const AssetsTab: React.FC = () => {
  const { activeAccount, settings } = useWallet();
  const [showCoinControl, setShowCoinControl] = useState(false);

  if (!activeAccount) return null;

  const fiatValue = (activeAccount.balanceXMR * settings.xmrUsdPrice).toLocaleString('en-US', {
    style: 'currency',
    currency: settings.fiatCurrency,
  });

  // Simulated UTXO Outputs (like Feather's Coins tab)
  const mockOutputs = [
    {
      id: 'out-1',
      txid: 'd9a4...81f2',
      amount: 5.2020,
      height: 3248810,
      confirmations: 102,
      subaddr: '#2 (Fresh Stealth)',
      isFrozen: false,
      spendable: true,
    },
    {
      id: 'out-2',
      txid: '3c18...99e4',
      amount: 2.4000,
      height: 3248870,
      confirmations: 42,
      subaddr: '#1 (General Shop)',
      isFrozen: false,
      spendable: true,
    },
    {
      id: 'out-3',
      txid: '81f2...50ac',
      amount: 0.8500,
      height: 3248905,
      confirmations: 7,
      subaddr: '#2 (Fresh Stealth)',
      isFrozen: false,
      spendable: true,
    },
  ];

  return (
    <div className="p-4 space-y-3">
      {/* Primary Asset Card */}
      <div className="bg-slate-800/60 hover:bg-slate-800/90 border border-slate-700/60 rounded-xl p-3.5 flex items-center justify-between transition-colors shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-amber-600 to-orange-500 p-[1.5px] shadow-sm shadow-orange-500/20">
            <div className="w-full h-full bg-slate-950 rounded-full flex items-center justify-center font-black text-amber-500 text-sm">
              ɱ
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-sm text-white">Monero</span>
              <span className="text-[10px] font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded px-1.5 py-0.2">
                XMR
              </span>
            </div>
            <div className="text-xs text-slate-400 font-mono mt-0.5">
              ${settings.xmrUsdPrice.toFixed(2)} USD
              <span className="text-emerald-400 ml-1.5 font-medium">+2.4%</span>
            </div>
          </div>
        </div>

        <div className="text-right">
          <div className="text-sm font-bold font-mono text-white">
            {settings.hideBalance ? '••••••' : `${activeAccount.balanceXMR.toFixed(4)} XMR`}
          </div>
          <div className="text-xs text-slate-400 font-mono mt-0.5">
            {settings.hideBalance ? '••••••' : fiatValue}
          </div>
        </div>
      </div>

      {/* Feather-style Coin Control / Outputs Toggle */}
      <div className="pt-1">
        <button
          onClick={() => setShowCoinControl(prev => !prev)}
          className="w-full flex items-center justify-between px-3 py-2 bg-slate-950/60 hover:bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-xs text-slate-300 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Coins className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-semibold">Feather Coin Control (UTXO Outputs)</span>
            <span className="bg-slate-800 text-slate-400 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
              3 outputs
            </span>
          </div>
          <span className="text-xs text-slate-500 font-mono">
            {showCoinControl ? 'Hide ▲' : 'Inspect ▼'}
          </span>
        </button>

        {showCoinControl && (
          <div className="mt-2 space-y-2 bg-slate-950/80 border border-slate-800 rounded-xl p-3 animate-fade-in text-xs">
            <div className="text-[11px] text-slate-400 leading-relaxed mb-2 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span>
                Monero UTXO outputs are hidden by RingCT & Pedersen commitments. Each output uses 16 ring decoys when spent.
              </span>
            </div>

            <div className="space-y-1.5">
              {mockOutputs.map(out => (
                <div
                  key={out.id}
                  className="bg-slate-900/90 border border-slate-800 rounded-lg p-2 flex items-center justify-between text-[11px] font-mono"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <div>
                      <div className="font-semibold text-white">
                        {out.amount.toFixed(4)} XMR
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {out.subaddr} • {out.confirmations} confs
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="text-[10px] text-emerald-400 bg-emerald-950/50 border border-emerald-800/60 rounded px-1.5 py-0.5">
                      Spendable
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Privacy Guarantee Note */}
      <div className="p-3 bg-gradient-to-r from-emerald-950/20 via-slate-900 to-slate-900 border border-emerald-800/30 rounded-xl flex items-start gap-2.5">
        <Shield className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <div className="text-xs text-slate-300 leading-relaxed">
          <span className="font-semibold text-emerald-300">RingCT & Stealth Protection: </span>
          Amounts, sender, and recipient are mathematically shielded on-chain. Zero balance is ever publicly queryable.
        </div>
      </div>
    </div>
  );
};
