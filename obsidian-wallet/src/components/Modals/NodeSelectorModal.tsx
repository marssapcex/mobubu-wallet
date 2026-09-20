import React, { useState } from 'react';
import { useWallet } from '../../state/WalletContext';
import { 
  X, 
  Server, 
  Wifi, 
  Terminal, 
  CheckCircle2, 
  Plus, 
  AlertTriangle,
  Globe
} from 'lucide-react';

interface NodeSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NodeSelectorModal: React.FC<NodeSelectorModalProps> = ({ isOpen, onClose }) => {
  const { nodes, activeNode, switchNode, addCustomNode } = useWallet();

  const [isAddingCustom, setIsAddingCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [isTorOnion, setIsTorOnion] = useState(false);

  if (!isOpen) return null;

  const handleAddCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName || !customUrl) return;

    addCustomNode({
      name: customName.trim(),
      url: customUrl.trim(),
      type: isTorOnion ? 'tor_onion' : 'custom',
      isTor: isTorOnion,
      height: 3248912,
      targetHeight: 3248912,
      latencyMs: isTorOnion ? 390 : 80,
      isOnline: true,
    });

    setIsAddingCustom(false);
    setCustomName('');
    setCustomUrl('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto shadow-2xl flex flex-col text-slate-100">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900/95 backdrop-blur-md z-10">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400">
              <Server className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Select Monero Node</h2>
              <p className="text-[11px] text-slate-400">Tor Onion, Local Full Node, or Clearnet</p>
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
          
          {/* Node Category: Tor Hidden Services (Feather standard) */}
          <div className="space-y-1.5">
            <div className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
              <span>🧅 Tor Onion Nodes (Maximum Privacy)</span>
            </div>
            <div className="space-y-1">
              {nodes.filter(n => n.isTor).map(node => {
                const isSelected = node.id === activeNode.id;
                return (
                  <button
                    key={node.id}
                    onClick={() => {
                      switchNode(node.id);
                      onClose();
                    }}
                    className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'bg-emerald-950/40 border-emerald-500/80'
                        : 'bg-slate-950/60 hover:bg-slate-800/60 border-slate-800 text-slate-400'
                    }`}
                  >
                    <div>
                      <div className="text-xs font-semibold text-white flex items-center gap-1">
                        <span>{node.name}</span>
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono truncate max-w-[220px]">
                        {node.url}
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-emerald-400">
                      ~{node.latencyMs}ms
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Node Category: Local Full Node (Monero GUI) */}
          <div className="space-y-1.5">
            <div className="text-xs font-bold text-blue-400 flex items-center gap-1.5">
              <span>⚡ Self-Sovereign Full Node (Monero GUI)</span>
            </div>
            <div className="space-y-1">
              {nodes.filter(n => n.type === 'local_fullnode').map(node => {
                const isSelected = node.id === activeNode.id;
                return (
                  <button
                    key={node.id}
                    onClick={() => {
                      switchNode(node.id);
                      onClose();
                    }}
                    className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'bg-blue-950/40 border-blue-500/80'
                        : 'bg-slate-950/60 hover:bg-slate-800/60 border-slate-800 text-slate-400'
                    }`}
                  >
                    <div>
                      <div className="text-xs font-semibold text-white flex items-center gap-1">
                        <span>{node.name}</span>
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-blue-400" />}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono truncate max-w-[220px]">
                        {node.url}
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-blue-400">
                      {node.latencyMs}ms
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Node Category: Clearnet Nodes */}
          <div className="space-y-1.5">
            <div className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
              <span>🌐 Clearnet Nodes (Lower Privacy Posture)</span>
            </div>
            <div className="space-y-1">
              {nodes.filter(n => !n.isTor && n.type !== 'local_fullnode').map(node => {
                const isSelected = node.id === activeNode.id;
                return (
                  <button
                    key={node.id}
                    onClick={() => {
                      switchNode(node.id);
                      onClose();
                    }}
                    className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'bg-amber-950/30 border-amber-500/80'
                        : 'bg-slate-950/60 hover:bg-slate-800/60 border-slate-800 text-slate-400'
                    }`}
                  >
                    <div>
                      <div className="text-xs font-semibold text-slate-300 flex items-center gap-1">
                        <span>{node.name}</span>
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-amber-400" />}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono truncate max-w-[220px]">
                        {node.url}
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">
                      {node.latencyMs}ms
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Add Custom Node */}
          {isAddingCustom ? (
            <form onSubmit={handleAddCustom} className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
              <div className="text-xs font-semibold text-white">Add Custom Monero RPC Node</div>
              <input
                type="text"
                placeholder="Node Name (e.g. My Private Onion Node)"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none"
                required
              />
              <input
                type="text"
                placeholder="RPC URL (e.g. http://mydaemon.onion:18089 or http://192.168.1.100:18081)"
                value={customUrl}
                onChange={(e) => {
                  setCustomUrl(e.target.value);
                  if (e.target.value.includes('.onion')) setIsTorOnion(true);
                }}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white font-mono focus:outline-none"
                required
              />
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isTorOnion}
                  onChange={(e) => setIsTorOnion(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-700 text-orange-500 focus:ring-0"
                />
                <span>Route through Tor Onion proxy (SOCKS5)</span>
              </label>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsAddingCustom(false)}
                  className="px-2.5 py-1 text-xs text-slate-400 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1 bg-orange-600 hover:bg-orange-500 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                >
                  Add Node
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setIsAddingCustom(true)}
              className="w-full py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-xs font-semibold text-slate-300 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Custom RPC Node</span>
            </button>
          )}

        </div>

      </div>
    </div>
  );
};
