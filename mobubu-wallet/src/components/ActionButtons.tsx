import React from 'react';
import { ShoppingBag, ArrowLeftRight, ArrowUpRight, ArrowDownLeft } from 'lucide-react';

interface ActionButtonsProps {
  onOpenBuy: () => void;
  onOpenSwap: () => void;
  onOpenSend: () => void;
  onOpenReceive: () => void;
}

export const ActionButtons: React.FC<ActionButtonsProps> = ({
  onOpenBuy,
  onOpenSwap,
  onOpenSend,
  onOpenReceive,
}) => {
  return (
    <div className="grid grid-cols-4 gap-2 px-5 py-3">
      {/* 1. Buy Button */}
      <div className="flex flex-col items-center gap-1.5">
        <button
          onClick={onOpenBuy}
          className="w-11 h-11 rounded-full bg-slate-800 hover:bg-slate-700 active:scale-95 border border-slate-700/80 hover:border-slate-600 text-orange-400 flex items-center justify-center transition-all shadow-md cursor-pointer group"
          title="Buy Monero (Non-KYC / P2P Aggregator)"
        >
          <ShoppingBag className="w-5 h-5 group-hover:scale-110 transition-transform" />
        </button>
        <span className="text-xs font-medium text-slate-300">Buy</span>
      </div>

      {/* 2. Swap Button (Cake style) */}
      <div className="flex flex-col items-center gap-1.5">
        <button
          onClick={onOpenSwap}
          className="w-11 h-11 rounded-full bg-gradient-to-tr from-orange-600 to-amber-500 hover:from-orange-500 hover:to-amber-400 active:scale-95 border border-orange-500 text-white flex items-center justify-center transition-all shadow-lg shadow-orange-600/30 cursor-pointer group"
          title="Swap Cross-Chain (BTC, ETH, SOL, USDT <-> XMR)"
        >
          <ArrowLeftRight className="w-5 h-5 group-hover:rotate-180 transition-transform duration-500" />
        </button>
        <span className="text-xs font-semibold text-orange-400">Swap</span>
      </div>

      {/* 3. Send Button */}
      <div className="flex flex-col items-center gap-1.5">
        <button
          onClick={onOpenSend}
          className="w-11 h-11 rounded-full bg-slate-800 hover:bg-slate-700 active:scale-95 border border-slate-700/80 hover:border-slate-600 text-slate-200 flex items-center justify-center transition-all shadow-md cursor-pointer group"
          title="Send Monero with Ring Signatures & Tor routing"
        >
          <ArrowUpRight className="w-5 h-5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </button>
        <span className="text-xs font-medium text-slate-300">Send</span>
      </div>

      {/* 4. Receive Button */}
      <div className="flex flex-col items-center gap-1.5">
        <button
          onClick={onOpenReceive}
          className="w-11 h-11 rounded-full bg-slate-800 hover:bg-slate-700 active:scale-95 border border-slate-700/80 hover:border-slate-600 text-slate-200 flex items-center justify-center transition-all shadow-md cursor-pointer group"
          title="Receive Monero (QR Code & Fresh Subaddresses)"
        >
          <ArrowDownLeft className="w-5 h-5 group-hover:-translate-x-0.5 group-hover:translate-y-0.5 transition-transform" />
        </button>
        <span className="text-xs font-medium text-slate-300">Receive</span>
      </div>
    </div>
  );
};
