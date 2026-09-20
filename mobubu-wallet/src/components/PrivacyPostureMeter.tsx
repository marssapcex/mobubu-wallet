import React from 'react';
import { useWallet } from '../state/WalletContext';
import { 
  X, 
  ShieldCheck, 
  ShieldAlert, 
  CheckCircle2, 
  AlertTriangle, 
  ArrowRight, 
  Wifi, 
  Server, 
  KeyRound, 
  RotateCw,
  Sparkles,
  Lock
} from 'lucide-react';

interface PrivacyPostureMeterModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PrivacyPostureMeterModal: React.FC<PrivacyPostureMeterModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { privacyScore, applyPrivacyFix } = useWallet();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-md max-h-[92vh] overflow-y-auto shadow-2xl flex flex-col text-slate-100">
        
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900/95 backdrop-blur-md z-10">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold tracking-tight text-white">Mobubu Privacy Posture Meter</h2>
              <p className="text-[11px] text-slate-400">Real-time anonymity & leak diagnostics</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Big Score Hero Card */}
        <div className="p-5 border-b border-slate-800 bg-gradient-to-b from-slate-900 via-slate-900/70 to-slate-950 flex flex-col items-center text-center">
          <div className="relative mb-3">
            {/* Circular Gauge Ring */}
            <div className="w-28 h-28 rounded-full border-4 border-slate-800 flex items-center justify-center relative shadow-inner">
              <svg className="absolute inset-0 w-full h-full -rotate-90">
                <circle
                  cx="56"
                  cy="56"
                  r="48"
                  stroke="#1e293b"
                  strokeWidth="8"
                  fill="none"
                />
                <circle
                  cx="56"
                  cy="56"
                  r="48"
                  stroke={privacyScore.color}
                  strokeWidth="8"
                  fill="none"
                  strokeDasharray="301.6"
                  strokeDashoffset={301.6 - (301.6 * privacyScore.totalScore) / 100}
                  strokeLinecap="round"
                  className="transition-all duration-1000 ease-out"
                />
              </svg>
              <div className="flex flex-col items-center">
                <span className="text-3xl font-black font-mono tracking-tight text-white">
                  {privacyScore.totalScore}
                </span>
                <span className="text-[10px] text-slate-400 font-medium -mt-1">/ 100</span>
              </div>
            </div>
          </div>

          <div 
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-1"
            style={{ 
              backgroundColor: `${privacyScore.color}20`, 
              color: privacyScore.color,
              borderColor: `${privacyScore.color}40`,
              borderWidth: 1 
            }}
          >
            <Sparkles className="w-3.5 h-3.5" />
            {privacyScore.tierLabel}
          </div>
          <p className="text-xs text-slate-400 max-w-xs mt-1">
            {privacyScore.totalScore >= 90
              ? 'Your wallet traffic is routing through Tor hidden services with fresh subaddresses and ring decoys.'
              : privacyScore.totalScore >= 70
              ? 'Strong privacy configuration, but can be improved with one-click recommendations below.'
              : 'Caution: Potential metadata or IP address leakage detected. Address vulnerabilities immediately.'}
          </p>
        </div>

        {/* 1-Click Privacy Fixes Section (if any recommendations) */}
        {privacyScore.recommendations.length > 0 && (
          <div className="p-4 bg-orange-950/20 border-b border-orange-900/40">
            <div className="flex items-center gap-1.5 text-xs font-bold text-amber-300 mb-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
              <span>Recommended Privacy Fixes ({privacyScore.recommendations.length})</span>
            </div>
            <div className="space-y-2">
              {privacyScore.recommendations.map((rec) => (
                <div
                  key={rec.id}
                  className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 flex items-center justify-between gap-3 shadow-sm hover:border-slate-600 transition-colors"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-slate-100">{rec.title}</span>
                      <span className="text-[10px] text-emerald-400 font-mono font-medium">
                        +{rec.impactPoints} pts
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                      {rec.description}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      applyPrivacyFix(rec.actionType === 'churn_outputs' ? 'churn-outputs' : rec.id);
                      onClose();
                    }}
                    className="shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs px-2.5 py-1.5 rounded-lg flex items-center gap-1 transition-all cursor-pointer shadow-sm shadow-emerald-700/30"
                  >
                    <span>Fix</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 4 Pillars Breakdown */}
        <div className="p-4 space-y-3">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            Anonymity Pillars Breakdown
          </div>

          {/* Pillar 1: Network Transport */}
          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-md bg-blue-500/10 text-blue-400">
                  <Wifi className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-semibold text-slate-200">
                  {privacyScore.transport.title}
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs font-mono font-bold">
                <span className={privacyScore.transport.isPositive ? 'text-emerald-400' : 'text-amber-400'}>
                  {privacyScore.transport.score}
                </span>
                <span className="text-slate-500">/{privacyScore.transport.max}</span>
              </div>
            </div>
            <div className="text-[11px] text-slate-300 font-medium mb-0.5">
              {privacyScore.transport.statusText}
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {privacyScore.transport.detail}
            </p>
          </div>

          {/* Pillar 2: Node Trust */}
          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-md bg-purple-500/10 text-purple-400">
                  <Server className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-semibold text-slate-200">
                  {privacyScore.nodeTrust.title}
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs font-mono font-bold">
                <span className={privacyScore.nodeTrust.isPositive ? 'text-emerald-400' : 'text-amber-400'}>
                  {privacyScore.nodeTrust.score}
                </span>
                <span className="text-slate-500">/{privacyScore.nodeTrust.max}</span>
              </div>
            </div>
            <div className="text-[11px] text-slate-300 font-medium mb-0.5">
              {privacyScore.nodeTrust.statusText}
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {privacyScore.nodeTrust.detail}
            </p>
          </div>

          {/* Pillar 3: Address Hygiene */}
          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-md bg-emerald-500/10 text-emerald-400">
                  <KeyRound className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-semibold text-slate-200">
                  {privacyScore.addressHygiene.title}
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs font-mono font-bold">
                <span className={privacyScore.addressHygiene.isPositive ? 'text-emerald-400' : 'text-amber-400'}>
                  {privacyScore.addressHygiene.score}
                </span>
                <span className="text-slate-500">/{privacyScore.addressHygiene.max}</span>
              </div>
            </div>
            <div className="text-[11px] text-slate-300 font-medium mb-0.5">
              {privacyScore.addressHygiene.statusText}
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {privacyScore.addressHygiene.detail}
            </p>
          </div>

          {/* Pillar 4: Output Anonymity & Churn */}
          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-md bg-amber-500/10 text-amber-400">
                  <RotateCw className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-semibold text-slate-200">
                  {privacyScore.outputHygiene.title}
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs font-mono font-bold">
                <span className={privacyScore.outputHygiene.isPositive ? 'text-emerald-400' : 'text-amber-400'}>
                  {privacyScore.outputHygiene.score}
                </span>
                <span className="text-slate-500">/{privacyScore.outputHygiene.max}</span>
              </div>
            </div>
            <div className="text-[11px] text-slate-300 font-medium mb-0.5">
              {privacyScore.outputHygiene.statusText}
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {privacyScore.outputHygiene.detail}
            </p>
          </div>

          {/* EAE Attack Defense Banner */}
          <div className="p-3 bg-gradient-to-r from-purple-950/40 via-slate-900 to-slate-900 border border-purple-800/40 rounded-xl text-xs space-y-1">
            <div className="flex items-center justify-between font-bold text-purple-300">
              <span className="flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-purple-400" />
                <span>EAE Attack Defense:</span>
              </span>
              <span className="font-mono text-purple-200">{privacyScore.eaeDefenseStatus}</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              EAE (Exchange-Alice-Exchange) correlation is mitigated by sweeping incoming coins to fresh subaddresses through a self-churn ring.
            </p>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/80 flex items-center justify-end">
          <button
            onClick={onClose}
            className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-2 rounded-xl transition-colors cursor-pointer"
          >
            Close Inspector
          </button>
        </div>

      </div>
    </div>
  );
};
