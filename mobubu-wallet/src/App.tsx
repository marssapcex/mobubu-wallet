import React, { useState } from 'react';
import { useWallet } from './state/WalletContext';
import { Header } from './components/Header';
import { AccountCard } from './components/AccountCard';
import { ActionButtons } from './components/ActionButtons';
import { AssetsTab } from './components/Tabs/AssetsTab';
import { ActivityTab } from './components/Tabs/ActivityTab';
import { NodeTab } from './components/Tabs/NodeTab';
import { PrivacyTab } from './components/Tabs/PrivacyTab';
import { PrivacyPostureMeterModal } from './components/PrivacyPostureMeter';
import { SendModal } from './components/Modals/SendModal';
import { ReceiveModal } from './components/Modals/ReceiveModal';
import { SwapModal } from './components/Modals/SwapModal';
import { BuyModal } from './components/Modals/BuyModal';
import { NodeSelectorModal } from './components/Modals/NodeSelectorModal';
import { SettingsModal } from './components/Modals/SettingsModal';
import { DAppApprovalModal } from './components/Modals/DAppApprovalModal';
import { OnboardingFlow } from './components/Onboarding/OnboardingFlow';
import { LockScreen } from './components/LockScreen';
import { DAppPlayground } from './components/DAppPlayground';
import { 
  Coins, 
  Activity, 
  Server, 
  Shield, 
  Smartphone, 
  Monitor, 
  Globe,
  Puzzle
} from 'lucide-react';

export const App: React.FC = () => {
  const { isInitialized, isLocked, resetWallet } = useWallet();

  // Active Tab
  const [activeTab, setActiveTab] = useState<'assets' | 'activity' | 'node' | 'privacy'>('assets');

  // View Mode: 'popup' (realistic extension frame) | 'full' (expanded desktop tab) | 'dapp' (web3 playground)
  const [viewMode, setViewMode] = useState<'popup' | 'full' | 'dapp'>('popup');

  // Modals state
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState(false);
  const [isNodeModalOpen, setIsNodeModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [isReceiveModalOpen, setIsReceiveModalOpen] = useState(false);
  const [isSwapModalOpen, setIsSwapModalOpen] = useState(false);
  const [isBuyModalOpen, setIsBuyModalOpen] = useState(false);

  // If not initialized, show onboarding
  if (!isInitialized) {
    return <OnboardingFlow onComplete={() => {}} />;
  }

  // If locked, show lock screen
  if (isLocked) {
    return <LockScreen onResetPrompt={() => resetWallet()} />;
  }

  // The core wallet UI
  const walletContent = (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 overflow-y-auto relative">
      {/* 1. Header (Node selector, Tor/Clearnet pill, Privacy Posture Meter, Identicon) */}
      <Header
        onOpenPrivacyModal={() => setIsPrivacyModalOpen(true)}
        onOpenNodeModal={() => setIsNodeModalOpen(true)}
        onOpenSettingsModal={() => setIsSettingsModalOpen(true)}
        onToggleViewMode={() => setViewMode(curr => curr === 'popup' ? 'full' : 'popup')}
        isExpandedView={viewMode === 'full'}
      />

      {/* 2. Account Card (Name, Subaddress pill with copy, Big Balance, Fiat estimate) */}
      <AccountCard onOpenReceiveModal={() => setIsReceiveModalOpen(true)} />

      {/* 3. The 4 MetaMask-Style Action Buttons: Buy, Swap, Send, Receive */}
      <ActionButtons
        onOpenBuy={() => setIsBuyModalOpen(true)}
        onOpenSwap={() => setIsSwapModalOpen(true)}
        onOpenSend={() => setIsSendModalOpen(true)}
        onOpenReceive={() => setIsReceiveModalOpen(true)}
      />

      {/* 4. Navigation Tabs */}
      <div className="flex border-b border-slate-800 bg-slate-950/40 text-xs font-semibold px-2 sticky top-[53px] z-20 backdrop-blur-md">
        <button
          onClick={() => setActiveTab('assets')}
          className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 transition-colors cursor-pointer border-b-2 ${
            activeTab === 'assets'
              ? 'border-orange-500 text-orange-400 font-bold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Coins className="w-3.5 h-3.5" />
          <span>Assets</span>
        </button>

        <button
          onClick={() => setActiveTab('activity')}
          className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 transition-colors cursor-pointer border-b-2 ${
            activeTab === 'activity'
              ? 'border-orange-500 text-orange-400 font-bold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span>Activity</span>
        </button>

        <button
          onClick={() => setActiveTab('node')}
          className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 transition-colors cursor-pointer border-b-2 ${
            activeTab === 'node'
              ? 'border-orange-500 text-orange-400 font-bold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Server className="w-3.5 h-3.5" />
          <span>Node & Sync</span>
        </button>

        <button
          onClick={() => setActiveTab('privacy')}
          className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 transition-colors cursor-pointer border-b-2 ${
            activeTab === 'privacy'
              ? 'border-orange-500 text-orange-400 font-bold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Shield className="w-3.5 h-3.5" />
          <span>Privacy Lab</span>
        </button>
      </div>

      {/* 5. Tab Content Area */}
      <div className="flex-1 pb-6">
        {activeTab === 'assets' && <AssetsTab />}
        {activeTab === 'activity' && <ActivityTab />}
        {activeTab === 'node' && <NodeTab />}
        {activeTab === 'privacy' && <PrivacyTab />}
      </div>

      {/* 6. All Interactive Modals */}
      <PrivacyPostureMeterModal
        isOpen={isPrivacyModalOpen}
        onClose={() => setIsPrivacyModalOpen(false)}
      />

      <NodeSelectorModal
        isOpen={isNodeModalOpen}
        onClose={() => setIsNodeModalOpen(false)}
      />

      <SendModal
        isOpen={isSendModalOpen}
        onClose={() => setIsSendModalOpen(false)}
      />

      <ReceiveModal
        isOpen={isReceiveModalOpen}
        onClose={() => setIsReceiveModalOpen(false)}
      />

      <SwapModal
        isOpen={isSwapModalOpen}
        onClose={() => setIsSwapModalOpen(false)}
      />

      <BuyModal
        isOpen={isBuyModalOpen}
        onClose={() => setIsBuyModalOpen(false)}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
      />

      {/* Web3 DApp Permission Prompt */}
      <DAppApprovalModal />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-start text-slate-100">
      
      {/* Top Experience Switcher Toolbar */}
      <div className="w-full bg-slate-900 border-b border-slate-800 px-4 py-2 flex flex-wrap items-center justify-between gap-3 select-none z-40">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 font-bold text-xs tracking-wider text-orange-400 uppercase">
            <span className="text-base">🦡</span>
            <span>Mobubu Monero Extension</span>
          </div>
          <span className="text-slate-600">|</span>
          <span className="text-[11px] text-slate-400 hidden sm:inline">
            Manifest V3 • Tor Default • Feather Privacy • Cake Swaps
          </span>
        </div>

        {/* View mode toggle pills */}
        <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
          <button
            onClick={() => setViewMode('popup')}
            className={`flex items-center gap-1 px-3 py-1 rounded-lg font-medium transition-colors cursor-pointer ${
              viewMode === 'popup'
                ? 'bg-orange-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>Extension Popup</span>
          </button>

          <button
            onClick={() => setViewMode('full')}
            className={`flex items-center gap-1 px-3 py-1 rounded-lg font-medium transition-colors cursor-pointer ${
              viewMode === 'full'
                ? 'bg-orange-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>Expanded Tab</span>
          </button>

          <button
            onClick={() => setViewMode('dapp')}
            className={`flex items-center gap-1 px-3 py-1 rounded-lg font-medium transition-colors cursor-pointer ${
              viewMode === 'dapp'
                ? 'bg-orange-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Web3 Playground</span>
          </button>
        </div>
      </div>

      {/* Main View Area */}
      <div className="w-full flex-1 flex items-center justify-center p-2 sm:p-6">
        {viewMode === 'popup' && (
          /* Realistic Chrome / Firefox Extension Frame */
          <div className="w-full max-w-[390px] h-[640px] rounded-3xl overflow-hidden border border-slate-700/80 bg-slate-900 shadow-2xl flex flex-col relative ring-1 ring-white/10">
            {/* Extension Browser Chrome bar */}
            <div className="bg-slate-950 px-3 py-1.5 border-b border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 select-none">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
                <span className="font-mono font-medium text-slate-300">chrome-extension://mobubu</span>
              </div>
              <div className="flex items-center gap-2">
                <Puzzle className="w-3 h-3 text-slate-500" />
                <span className="text-[10px] text-emerald-400 bg-emerald-950/80 border border-emerald-800/70 px-1 rounded">
                  Tor Active
                </span>
              </div>
            </div>

            {/* Extension Content */}
            <div className="flex-1 overflow-hidden relative">
              {walletContent}
            </div>
          </div>
        )}

        {viewMode === 'full' && (
          /* Full Tab Expanded View (Desktop Dashboard) */
          <div className="w-full max-w-4xl min-h-[680px] rounded-2xl overflow-hidden border border-slate-800 bg-slate-900 shadow-2xl flex flex-col relative">
            <div className="flex-1 overflow-y-auto">
              {walletContent}
            </div>
          </div>
        )}

        {viewMode === 'dapp' && (
          /* Web3 DApp Playground View */
          <div className="w-full max-w-3xl min-h-[640px] rounded-2xl overflow-hidden border border-slate-800 bg-slate-900 shadow-2xl p-4">
            <DAppPlayground />
          </div>
        )}
      </div>

    </div>
  );
};
