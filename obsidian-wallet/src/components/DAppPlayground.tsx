import React, { useState } from 'react';
import { useWallet } from '../state/WalletContext';
import { 
  Globe, 
  ShoppingBag, 
  ShieldCheck, 
  CheckCircle2, 
  ArrowRight, 
  Key, 
  CreditCard,
  Lock
} from 'lucide-react';

export const DAppPlayground: React.FC = () => {
  const { activeAccount, sendTransaction } = useWallet();
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState<string | null>(null);

  if (!activeAccount) return null;

  const activeSub = activeAccount.subaddresses[activeAccount.activeSubaddressIndex];
  const activeAddr = activeSub?.address || activeAccount.primaryAddress;

  const handleConnect = () => {
    setIsConnected(true);
  };

  const handleBuyItem = async (itemName: string, priceXmr: number) => {
    setIsProcessing(true);
    setPaymentSuccess(null);
    try {
      // Send transaction to merchant stealth address
      const merchantAddress = '8914Abcd998811XmRMerchantStealthAddressFakePayload001234567890abcdef1234567890abcdef1234567890abc';
      const tx = await sendTransaction(merchantAddress, priceXmr, 'normal');
      setPaymentSuccess(`Purchased "${itemName}" for ${priceXmr} XMR! TX Hash: ${tx.txHash.slice(0, 16)}...`);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="p-4 space-y-4 max-w-xl mx-auto">
      {/* Playground Banner */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-blue-500/10 text-blue-400 rounded-lg">
              <Globe className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">
                Web3 Monero Provider Testbed (`window.monero`)
              </h3>
              <p className="text-[11px] text-slate-400">
                Simulating a web store connecting to Obsidian browser extension
              </p>
            </div>
          </div>

          <button
            onClick={isConnected ? () => setIsConnected(false) : handleConnect}
            className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all cursor-pointer ${
              isConnected
                ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-700'
                : 'bg-orange-600 hover:bg-orange-500 text-white shadow-md'
            }`}
          >
            {isConnected ? '✓ Connected' : 'Connect Wallet'}
          </button>
        </div>

        {isConnected && (
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs space-y-1 animate-fade-in font-mono">
            <div className="text-slate-400 text-[11px]">Active Connection (Subaddress):</div>
            <div className="text-emerald-400 truncate text-[11px]">{activeAddr}</div>
            <div className="text-[10px] text-slate-500">
              Provider: window.monero / EIP-1102 Monero Standard
            </div>
          </div>
        )}
      </div>

      {paymentSuccess && (
        <div className="p-3 bg-emerald-950/70 border border-emerald-800 rounded-xl text-xs text-emerald-300 flex items-center gap-2 animate-fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{paymentSuccess}</span>
        </div>
      )}

      {/* Simulated Store Items */}
      <div className="space-y-2">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
          The Cypherpunk Mercantile (Demo Store)
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* Product 1 */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col justify-between space-y-3">
            <div>
              <div className="text-sm font-bold text-white">Tor Onion VPN (1 Month)</div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Zero-log WireGuard proxy with multi-hop exit through Tor relay.
              </p>
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="font-mono text-xs font-bold text-orange-400">0.05 XMR</span>
              <button
                onClick={() => handleBuyItem('Tor Onion VPN', 0.05)}
                disabled={!isConnected || isProcessing}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-lg disabled:opacity-40 cursor-pointer"
              >
                1-Click Buy
              </button>
            </div>
          </div>

          {/* Product 2 */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col justify-between space-y-3">
            <div>
              <div className="text-sm font-bold text-white">Hardware Key (FIDO2)</div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Physical security key programmed for air-gapped signature verification.
              </p>
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="font-mono text-xs font-bold text-orange-400">0.25 XMR</span>
              <button
                onClick={() => handleBuyItem('Hardware Key', 0.25)}
                disabled={!isConnected || isProcessing}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-lg disabled:opacity-40 cursor-pointer"
              >
                1-Click Buy
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
