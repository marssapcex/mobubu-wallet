import React from 'react';
import { X, ShoppingBag, ExternalLink, ShieldCheck, Zap, Lock } from 'lucide-react';

interface BuyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const BUY_PROVIDERS = [
  {
    name: 'Haveno DEX (Recommended)',
    badge: '100% P2P & Open Source',
    desc: 'Decentralized P2P fiat-to-Monero exchange running over Tor with 2-of-3 multisig escrow.',
    kyc: 'Zero KYC',
    url: 'https://haveno.exchange',
    icon: '🛡️',
  },
  {
    name: 'RoboSats Lightning Bridge',
    badge: 'Lightning to XMR',
    desc: 'P2P exchange using Bitcoin Lightning hold-invoices to purchase Monero with zero identity leakage.',
    kyc: 'Zero KYC',
    url: 'https://robosats.com',
    icon: '⚡',
  },
  {
    name: 'Trocador Fiat Gateway',
    badge: 'Card / SEPA to XMR',
    desc: 'On-ramp aggregator supporting Credit Card, SEPA, and Revolut directly delivered to your stealth subaddress.',
    kyc: 'Tier 1 Minimal',
    url: 'https://trocador.app',
    icon: '🧅',
  },
  {
    name: 'Bisq 2 Network',
    badge: 'Decentralized Desktop App',
    desc: 'Arbitration-backed fiat network to buy XMR with bank transfer, cash by mail, and Revolut.',
    kyc: 'Zero KYC',
    url: 'https://bisq.network',
    icon: '🏛️',
  },
];

export const BuyModal: React.FC<BuyModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto shadow-2xl flex flex-col text-slate-100">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900/95 backdrop-blur-md z-10">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400">
              <ShoppingBag className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Buy Monero (XMR)</h2>
              <p className="text-[11px] text-slate-400">Non-KYC & Agnostic Fiat Onramps</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="p-3 bg-orange-950/20 border border-orange-800/40 rounded-xl text-xs text-amber-200 leading-relaxed flex items-start gap-2">
            <Lock className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
            <span>
              <strong>Privacy Tip:</strong> Traditional centralized exchanges enforce KYC identity linking. To protect your financial sovereignty, use P2P DEX networks or swap other crypto into Monero!
            </span>
          </div>

          <div className="space-y-2">
            {BUY_PROVIDERS.map((provider) => (
              <a
                key={provider.name}
                href={provider.url}
                target="_blank"
                rel="noreferrer"
                className="bg-slate-950/70 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 p-3 rounded-xl flex items-center justify-between gap-3 transition-colors group cursor-pointer block"
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl mt-0.5">{provider.icon}</span>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-white group-hover:text-orange-400 transition-colors">
                        {provider.name}
                      </span>
                      <span className="text-[9px] bg-emerald-950/60 text-emerald-400 border border-emerald-800/60 px-1 py-0.2 rounded font-mono font-medium">
                        {provider.kyc}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                      {provider.desc}
                    </div>
                  </div>
                </div>

                <ExternalLink className="w-4 h-4 text-slate-500 group-hover:text-white shrink-0" />
              </a>
            ))}
          </div>

          <div className="pt-2 text-center">
            <p className="text-[11px] text-slate-500">
              Already have Bitcoin, Ethereum, or USDT? Use the built-in <strong>Swap</strong> tab for instantaneous zero-wait exchange into Monero.
            </p>
          </div>
        </div>

      </div>
    </div>
  );
};
