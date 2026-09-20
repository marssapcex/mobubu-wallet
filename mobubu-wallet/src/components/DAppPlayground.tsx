import React, { useState } from 'react';
import { useWallet } from '../state/WalletContext';
import { 
  Globe, 
  ShoppingBag, 
  ShieldCheck, 
  CheckCircle2, 
  ArrowRight, 
  Key, 
  Terminal,
  Lock,
  Code
} from 'lucide-react';

export const DAppPlayground: React.FC = () => {
  const { activeAccount, triggerDAppSimulation, privacyScore } = useWallet();
  const [isConnected, setIsConnected] = useState(false);
  const [lastRpcResponse, setLastRpcResponse] = useState<string | null>(null);

  if (!activeAccount) return null;

  const activeSub = activeAccount.subaddresses[activeAccount.activeSubaddressIndex];
  const activeAddr = activeSub?.address || activeAccount.primaryAddress;

  const handleConnect = () => {
    triggerDAppSimulation('connect');
    setIsConnected(true);
    setLastRpcResponse(JSON.stringify({
      jsonrpc: '2.0',
      result: [activeAddr],
      id: 1
    }, null, 2));
  };

  const handleBuy = (itemName: string, amount: number) => {
    triggerDAppSimulation('send', amount);
    setLastRpcResponse(JSON.stringify({
      jsonrpc: '2.0',
      method: 'monero_sendTransaction',
      params: {
        recipient: '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkFxbANsAnJYPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H',
        amount,
        note: `Payment for ${itemName}`
      },
      id: 2
    }, null, 2));
  };

  const handleQueryPosture = () => {
    setLastRpcResponse(JSON.stringify({
      jsonrpc: '2.0',
      result: {
        score: privacyScore.totalScore,
        tier: privacyScore.tier,
        isTor: true,
        ringSize: 16,
      },
      id: 3
    }, null, 2));
  };

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      {/* Playground Banner */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-orange-500/10 text-orange-400 rounded-lg">
              <Globe className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">
                Web3 Monero Provider Testbed (`window.mobubu` / `window.monero`)
              </h3>
              <p className="text-[11px] text-slate-400">
                Simulating a privacy-conscious store communicating with Mobubu extension
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
            {isConnected ? '✓ Connected' : 'Connect Mobubu'}
          </button>
        </div>

        {isConnected && (
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs space-y-1 animate-fade-in font-mono">
            <div className="text-slate-400 text-[11px]">Active Connection (Subaddress):</div>
            <div className="text-emerald-400 truncate text-[11px]">{activeAddr}</div>
            <div className="text-[10px] text-slate-500">
              Provider: window.mobubu / EIP-1102 Monero Standard
            </div>
          </div>
        )}
      </div>

      {/* Simulated Store Items */}
      <div className="space-y-2">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
          The Cypherpunk Mercantile (Demo Merchant)
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* Product 1 */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 flex flex-col justify-between space-y-3 shadow-sm">
            <div>
              <div className="text-sm font-bold text-white">Tor WireGuard VPN (1 Year)</div>
              <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                Zero-knowledge encrypted WireGuard tunnel with multi-hop exit through Tor Onion relay.
              </p>
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="font-mono text-xs font-bold text-orange-400">0.25 XMR</span>
              <button
                onClick={() => handleBuy('Tor WireGuard VPN', 0.25)}
                disabled={!isConnected}
                className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold rounded-lg disabled:opacity-40 cursor-pointer transition-colors shadow-sm"
              >
                Buy with Mobubu
              </button>
            </div>
          </div>

          {/* Product 2 */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 flex flex-col justify-between space-y-3 shadow-sm">
            <div>
              <div className="text-sm font-bold text-white">Air-Gapped Hardware Key</div>
              <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                Physical security key programmed for air-gapped Monero key storage and Cold signing.
              </p>
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="font-mono text-xs font-bold text-orange-400">0.85 XMR</span>
              <button
                onClick={() => handleBuy('Air-Gapped Hardware Key', 0.85)}
                disabled={!isConnected}
                className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold rounded-lg disabled:opacity-40 cursor-pointer transition-colors shadow-sm"
              >
                Buy with Mobubu
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Web3 RPC Inspector */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
            <Code className="w-4 h-4 text-purple-400" />
            <span>Interactive RPC Inspector</span>
          </div>
          <button
            onClick={handleQueryPosture}
            className="text-[11px] px-2 py-0.5 bg-purple-950/60 hover:bg-purple-900/60 text-purple-300 border border-purple-800/60 rounded-lg cursor-pointer"
          >
            Call monero_getPrivacyPosture
          </button>
        </div>

        <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-[11px] text-emerald-400 max-h-40 overflow-y-auto">
          <pre>{lastRpcResponse || '// Connect wallet or click Buy to observe Web3 RPC messages'}</pre>
        </div>
      </div>
    </div>
  );
};
