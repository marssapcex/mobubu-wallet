import React, { useState } from 'react';
import { useWallet } from '../../state/WalletContext';
import { 
  Server, 
  Wifi, 
  Terminal, 
  CheckCircle2, 
  AlertTriangle, 
  Copy, 
  Check, 
  RefreshCw,
  ExternalLink,
  ShieldAlert
} from 'lucide-react';

export const NodeTab: React.FC = () => {
  const { nodes, activeNode, switchNode, isTorRoutingEnabled, toggleTorRouting } = useWallet();
  const [copiedCmd, setCopiedCmd] = useState(false);

  const localDaemonCmd = 'monerod --rpc-bind-ip 127.0.0.1 --rpc-bind-port 18081 --confirm-external-bind';

  const copyCommand = () => {
    navigator.clipboard.writeText(localDaemonCmd);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  return (
    <div className="p-4 space-y-4">
      {/* Active Node Telemetry Card */}
      <div className="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={`p-1.5 rounded-lg ${
              activeNode.isTor 
                ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800' 
                : activeNode.type === 'local_fullnode'
                ? 'bg-blue-950/80 text-blue-400 border border-blue-800'
                : 'bg-amber-950/80 text-amber-400 border border-amber-800'
            }`}>
              {activeNode.isTor ? <Wifi className="w-4 h-4" /> : <Server className="w-4 h-4" />}
            </div>
            <div>
              <div className="text-xs font-bold text-white flex items-center gap-1.5">
                <span>{activeNode.name}</span>
                {activeNode.isTor && (
                  <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.2 rounded font-mono">
                    🧅 ONION
                  </span>
                )}
                {activeNode.type === 'local_fullnode' && (
                  <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/30 px-1.5 py-0.2 rounded font-mono">
                    ⚡ FULL NODE
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-400 font-mono truncate max-w-[240px]">
                {activeNode.url}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] font-mono text-emerald-400 font-semibold">
              {activeNode.latencyMs}ms
            </span>
          </div>
        </div>

        {/* Sync Progress Bar */}
        <div className="space-y-1.5 pt-2 border-t border-slate-700/60 text-xs">
          <div className="flex items-center justify-between font-mono text-[11px]">
            <span className="text-slate-400">Blockchain Height:</span>
            <span className="text-slate-200 font-semibold">
              {activeNode.height.toLocaleString()} / {activeNode.targetHeight.toLocaleString()}
            </span>
          </div>
          <div className="w-full h-1.5 bg-slate-950 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 w-full" />
          </div>
          <div className="flex items-center justify-between text-[10px] text-slate-500">
            <span>Status: Synchronized (100%)</span>
            <span>Target: Fluorine Fermi v0.18</span>
          </div>
        </div>
      </div>

      {/* Tor Routing Switch */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
            <span>Enforce Tor SOCKS5 Routing</span>
            {isTorRoutingEnabled ? (
              <span className="text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-800 rounded px-1">
                Active
              </span>
            ) : (
              <span className="text-[10px] text-amber-400 bg-amber-950/60 border border-amber-800 rounded px-1">
                Disabled
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            Routes all node RPC queries through 127.0.0.1:9050 Tor proxy.
          </div>
        </div>

        <button
          onClick={toggleTorRouting}
          className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors cursor-pointer ${
            isTorRoutingEnabled ? 'bg-emerald-600 justify-end' : 'bg-slate-700 justify-start'
          }`}
        >
          <div className="w-4 h-4 rounded-full bg-white shadow-sm" />
        </button>
      </div>

      {/* Node Presets Selection */}
      <div className="space-y-2">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
          Available Nodes ({nodes.length})
        </div>

        <div className="space-y-1.5">
          {nodes.map(node => {
            const isSelected = node.id === activeNode.id;
            return (
              <button
                key={node.id}
                onClick={() => switchNode(node.id)}
                className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                  isSelected
                    ? 'bg-slate-800/90 border-orange-500/60 shadow-sm'
                    : 'bg-slate-950/60 hover:bg-slate-800/50 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className="text-sm">
                    {node.isTor ? '🧅' : node.type === 'local_fullnode' ? '⚡' : '🌐'}
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-slate-200 flex items-center gap-1">
                      <span>{node.name}</span>
                      {isSelected && (
                        <CheckCircle2 className="w-3.5 h-3.5 text-orange-400" />
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono truncate max-w-[200px]">
                      {node.url}
                    </div>
                  </div>
                </div>

                <div className="text-right font-mono text-[10px] text-slate-400">
                  <span>{node.latencyMs}ms</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Monero GUI Local Daemon Guide */}
      <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-blue-400">
          <Terminal className="w-4 h-4" />
          <span>Run Monero GUI / CLI Daemon Locally</span>
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed">
          Running your own full node is the gold standard of Monero privacy. Launch your daemon with RPC enabled:
        </p>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-2 font-mono text-[11px] text-slate-300 flex items-center justify-between gap-2 overflow-x-auto">
          <span className="truncate">{localDaemonCmd}</span>
          <button
            onClick={copyCommand}
            className="p-1 text-slate-400 hover:text-white shrink-0 cursor-pointer"
            title="Copy command"
          >
            {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
};
