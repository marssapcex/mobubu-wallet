import React, { useState } from 'react';
import { useWallet } from '../../state/WalletContext';
import { 
  ShieldCheck, 
  ArrowRight, 
  Key, 
  Lock, 
  CheckCircle2, 
  Copy, 
  Check, 
  Eye, 
  EyeOff, 
  Wifi, 
  Server,
  Sparkles,
  HelpCircle
} from 'lucide-react';
import { generateRandomSeed, seedToMnemonic } from '../../crypto/mnemonic';

interface OnboardingFlowProps {
  onComplete: () => void;
}

export const OnboardingFlow: React.FC<OnboardingFlowProps> = ({ onComplete }) => {
  const { createWallet } = useWallet();

  const [step, setStep] = useState<'welcome' | 'password' | 'seed' | 'verify' | 'node' | 'complete'>('welcome');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isImport, setIsImport] = useState(false);
  const [isViewOnly, setIsViewOnly] = useState(false);
  const [importSeed, setImportSeed] = useState('');
  const [generatedSeed] = useState<string>(() => {
    const raw = generateRandomSeed();
    return seedToMnemonic(raw);
  });
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<'tor' | 'local' | 'clearnet'>('tor');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Verification quiz state (MetaMask style)
  const seedWords = generatedSeed.split(' ');
  const quizIndex = 4; // Check word #5
  const [quizWordInput, setQuizWordInput] = useState('');

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (password.length < 8) {
      setErrorMsg('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMsg('Passwords do not match');
      return;
    }
    if (isImport) {
      handleFinalize(importSeed);
    } else {
      setStep('seed');
    }
  };

  const handleCopySeed = () => {
    navigator.clipboard.writeText(generatedSeed);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleVerifyQuiz = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (quizWordInput.trim().toLowerCase() !== seedWords[quizIndex].toLowerCase()) {
      setErrorMsg(`Incorrect word #${quizIndex + 1}. Please double check your backup.`);
      return;
    }
    setStep('node');
  };

  const handleFinalize = async (seedToUse?: string) => {
    try {
      await createWallet(password, seedToUse, isViewOnly);
      setStep('complete');
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  return (
    <div className="min-h-full flex flex-col justify-center p-4 bg-slate-950 text-slate-100 select-none">
      <div className="w-full max-w-sm mx-auto bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl space-y-5">
        
        {/* Mobubu brand header */}
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-orange-600 via-amber-500 to-yellow-400 p-[2px] shadow-lg shadow-orange-500/20">
            <div className="w-full h-full bg-slate-950 rounded-[14px] flex items-center justify-center font-black text-amber-500 text-2xl">
              ɱ
            </div>
          </div>
          <h1 className="text-xl font-extrabold tracking-tight text-white">
            Mobubu Wallet
          </h1>
          <p className="text-xs text-slate-400">
            The Private Monero Browser Extension
          </p>
        </div>

        {/* STEP 1: WELCOME */}
        {step === 'welcome' && (
          <div className="space-y-3 pt-2">
            <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-2xl space-y-1.5 text-xs">
              <div className="flex items-center gap-1.5 text-orange-400 font-bold">
                <ShieldCheck className="w-4 h-4" />
                <span>Next-Gen Web3 Monero Architecture</span>
              </div>
              <ul className="text-slate-400 space-y-1 text-[11px] list-disc list-inside">
                <li>MetaMask-familiar layout with dark UI</li>
                <li>Live <strong>Privacy Posture Meter (0-100)</strong></li>
                <li>Feather Tor Onion & Monero GUI full node support</li>
                <li>Cake-style instant cross-chain swaps</li>
              </ul>
            </div>

            <button
              onClick={() => {
                setIsImport(false);
                setIsViewOnly(false);
                setStep('password');
              }}
              className="w-full py-3 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-orange-600/30 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <span>Create New Mobubu Wallet</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => {
                setIsImport(true);
                setIsViewOnly(false);
                setStep('password');
              }}
              className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-semibold text-xs rounded-xl transition-colors cursor-pointer"
            >
              Import 25-Word Seed Phrase
            </button>
          </div>
        )}

        {/* STEP 2: CREATE PASSWORD */}
        {step === 'password' && (
          <form onSubmit={handlePasswordSubmit} className="space-y-3.5">
            <div className="text-xs font-semibold text-slate-300">
              {isImport ? 'Step 1/2: Create Vault Password' : 'Step 1/3: Create Master Password'}
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              This password encrypts your keys locally with AES-256-GCM. It will be required each time you unlock Mobubu.
            </p>

            {errorMsg && (
              <div className="p-2 bg-red-950/70 border border-red-800 rounded-lg text-xs text-red-300">
                {errorMsg}
              </div>
            )}

            {isImport && (
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-slate-400">
                  Enter 25-word Monero Seed
                </label>
                <textarea
                  rows={3}
                  value={importSeed}
                  onChange={(e) => setImportSeed(e.target.value)}
                  placeholder="word1 word2 ... word25"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2 text-xs font-mono text-white focus:outline-none focus:border-orange-500"
                  required
                />
              </div>
            )}

            <div className="space-y-2">
              <input
                type="password"
                placeholder="New Password (min 8 chars)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-orange-500"
                required
              />
              <input
                type="password"
                placeholder="Confirm Password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-orange-500"
                required
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setStep('welcome')}
                className="w-1/3 py-2.5 bg-slate-800 text-slate-400 hover:text-white text-xs font-semibold rounded-xl cursor-pointer"
              >
                Back
              </button>
              <button
                type="submit"
                className="w-2/3 py-2.5 bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold rounded-xl transition-colors cursor-pointer"
              >
                {isImport ? 'Import Wallet' : 'Continue'}
              </button>
            </div>
          </form>
        )}

        {/* STEP 3: SEED PHRASE REVEAL */}
        {step === 'seed' && (
          <div className="space-y-3">
            <div className="text-xs font-semibold text-slate-300">
              Step 2/3: Secret Recovery Phrase
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Write down or save these 25 words in secret. This seed grants full access to recover your Monero funds on any wallet.
            </p>

            {/* Seed Card */}
            <div className="relative p-3 bg-slate-950 border border-slate-800 rounded-2xl">
              {!revealed && (
                <div className="absolute inset-0 bg-slate-950/95 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center p-4 z-10 text-center">
                  <Key className="w-8 h-8 text-amber-400 mb-2" />
                  <div className="text-xs font-bold text-white mb-1">Keep it private</div>
                  <p className="text-[10px] text-slate-400 mb-3">Make sure no one is looking at your screen.</p>
                  <button
                    onClick={() => setRevealed(true)}
                    className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl cursor-pointer"
                  >
                    Reveal Seed Words
                  </button>
                </div>
              )}

              <div className="grid grid-cols-3 gap-1.5 max-h-48 overflow-y-auto pr-1">
                {seedWords.map((word, idx) => (
                  <div
                    key={idx}
                    className="bg-slate-900 border border-slate-800 rounded-lg px-1.5 py-1 flex items-center gap-1 font-mono text-[10px]"
                  >
                    <span className="text-slate-500 select-none">{idx + 1}.</span>
                    <span className="text-slate-200 font-semibold">{word}</span>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={handleCopySeed}
              className="w-full py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Copied to Clipboard</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy 25 Words</span>
                </>
              )}
            </button>

            <button
              onClick={() => setStep('verify')}
              className="w-full py-2.5 bg-orange-600 hover:bg-orange-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-orange-600/30 transition-all cursor-pointer"
            >
              I Saved My Seed Words
            </button>
          </div>
        )}

        {/* STEP 3.5: SEED VERIFICATION QUIZ (MetaMask style!) */}
        {step === 'verify' && (
          <form onSubmit={handleVerifyQuiz} className="space-y-3.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
              <HelpCircle className="w-4 h-4 text-orange-400" />
              <span>Verify Seed Backup</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Confirm you wrote down your seed correctly. Enter word <strong>#{quizIndex + 1}</strong> from your phrase:
            </p>

            {errorMsg && (
              <div className="p-2 bg-red-950/70 border border-red-800 rounded-lg text-xs text-red-300">
                {errorMsg}
              </div>
            )}

            <input
              type="text"
              placeholder={`Enter word #${quizIndex + 1}`}
              value={quizWordInput}
              onChange={(e) => setQuizWordInput(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-orange-500"
              autoFocus
              required
            />

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setStep('seed')}
                className="w-1/3 py-2.5 bg-slate-800 text-slate-400 hover:text-white text-xs font-semibold rounded-xl cursor-pointer"
              >
                Back
              </button>
              <button
                type="submit"
                className="w-2/3 py-2.5 bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold rounded-xl transition-colors cursor-pointer"
              >
                Confirm Word
              </button>
            </div>
          </form>
        )}

        {/* STEP 4: PRESET NODE ROUTING */}
        {step === 'node' && (
          <div className="space-y-3">
            <div className="text-xs font-semibold text-slate-300">
              Step 3/3: Choose Privacy Routing Mode
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Mobubu defaults to Tor Onion routing to ensure your IP address is never revealed to node operators.
            </p>

            <div className="space-y-2">
              {/* Option 1: Tor Onion */}
              <button
                type="button"
                onClick={() => setSelectedPreset('tor')}
                className={`w-full text-left p-3 rounded-2xl border transition-all cursor-pointer flex items-center justify-between ${
                  selectedPreset === 'tor'
                    ? 'bg-emerald-950/40 border-emerald-500'
                    : 'bg-slate-950/60 border-slate-800 text-slate-400'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-xl">🧅</span>
                  <div>
                    <div className="text-xs font-bold text-white flex items-center gap-1.5">
                      <span>Maximum Privacy (Tor Onion)</span>
                      <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1 rounded font-mono">
                        Score: 95/100
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Full IP cloaking via Feather Tor onion hidden services
                    </div>
                  </div>
                </div>
                {selectedPreset === 'tor' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
              </button>

              {/* Option 2: Local Full Node */}
              <button
                type="button"
                onClick={() => setSelectedPreset('local')}
                className={`w-full text-left p-3 rounded-2xl border transition-all cursor-pointer flex items-center justify-between ${
                  selectedPreset === 'local'
                    ? 'bg-blue-950/40 border-blue-500'
                    : 'bg-slate-950/60 border-slate-800 text-slate-400'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-xl">⚡</span>
                  <div>
                    <div className="text-xs font-bold text-white flex items-center gap-1.5">
                      <span>Self-Sovereign (Local Monero Node)</span>
                      <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1 rounded font-mono">
                        Score: 100/100
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Connect to 127.0.0.1:18081 monerod instance
                    </div>
                  </div>
                </div>
                {selectedPreset === 'local' && <CheckCircle2 className="w-4 h-4 text-blue-400" />}
              </button>
            </div>

            <button
              onClick={() => handleFinalize()}
              className="w-full py-3 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-orange-600/30 transition-all cursor-pointer"
            >
              Complete Setup & Open Mobubu
            </button>
          </div>
        )}

        {/* STEP 5: ALL DONE */}
        {step === 'complete' && (
          <div className="text-center space-y-4 py-2">
            <div className="w-14 h-14 rounded-full bg-emerald-950/80 border border-emerald-700 text-emerald-400 flex items-center justify-center mx-auto shadow-lg shadow-emerald-900/30">
              <Sparkles className="w-7 h-7" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Mobubu Initialized!</h2>
              <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
                Your first unlinkable stealth subaddress is generated and your Privacy Posture is armed.
              </p>
            </div>
            <button
              onClick={onComplete}
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-emerald-700/30 transition-all cursor-pointer"
            >
              Open Mobubu Dashboard
            </button>
          </div>
        )}

      </div>
    </div>
  );
};
