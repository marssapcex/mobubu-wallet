# 🛡️ Obsidian: The Monero Web3 Privacy Extension

**Obsidian** is a browser extension wallet for Monero (XMR) built to bridge the gap between the familiar, frictionless user experience of **MetaMask** and the uncompromising privacy engineering of **Feather**, **Cake Wallet**, and **Monero GUI**.

---

## 💡 Solving the 4 Critical Weaknesses of Existing Monero Wallets

| Weakness of Existing Wallets | How Obsidian Solves It |
|---|---|
| **1. No browser extension form factor** (Monero GUI, Feather, Cake are desktop/mobile apps) | Built as a **Manifest V3 WebExtension** for Chrome, Firefox, Brave, and Edge. Injects a standardized `window.monero` provider into dApps and web stores. |
| **2. Hidden / Unclear Tor vs Clearnet routing** | **Dynamic Status Indicators & Toggles** on every screen. Clearly indicates whether RPC requests are routed via **🧅 Tor Onion**, **⚡ Local Loopback**, or **🌐 Clearnet** (with warnings). |
| **3. Intimidating onboarding & node setup** | **MetaMask-style 3-Step Onboarding**: Master password vault encryption (AES-256-GCM), clean 25-word seed phrase reveal, and pre-configured privacy profiles. |
| **4. High friction for Web3 / MetaMask users** | Identical UI mental model: **Buy / Swap / Send / Receive** 4-button header, Assets & Activity tabs, auto-generated subaddress pills, and dark mode by default. |

---

## 🌟 The Core Differentiator: Privacy Posture Meter (0 – 100)

Visible at the top-right of every screen, the **Privacy Posture Meter** continuously evaluates wallet privacy across **4 security pillars**:

1. **Network Transport Layer (30% weight)**:
   - Tor Onion Hidden Service (`.onion`): **+30 pts** (ISP & node cannot observe IP).
   - Local Daemon (`127.0.0.1`): **+30 pts** (Zero network leakage).
   - Clearnet Direct IP: **+5 pts** (Warning: IP exposed to node operator and ISP).

2. **Node Sovereignty & Trust (25% weight)**:
   - Local Full Node (`monerod`): **+25 pts** (Zero-trust local blockchain verification).
   - Feather Curated Onion Node: **+20 pts** (Tor cryptographic transport isolation).
   - Clearnet Curated Node: **+12 pts** (Known community node).
   - Public / Untrusted Node: **+8 pts**.

3. **Address Hygiene & Stealth (25% weight)**:
   - Fresh Single-Use Subaddress (`8...`): **+25 pts** (Zero counterparty linkability).
   - Reused Subaddress: **+20 pts**.
   - Primary Address (`4...`): **+5 pts** (Severe warning: primary addresses expose linkability).

4. **Output Anonymity & Ring Decoys (20% weight)**:
   - Ring Size 16 enforced + Fresh churned outputs: **+20 pts**.
   - Unchurned recent receipts: **+12 pts** (Recommendation: Churn outputs to break temporal analysis).

### ⚡ 1-Click Privacy Fixes
Users can click the meter badge to open the **Privacy Inspector** and apply instant fixes:
- 🧅 **"Switch to Tor Node"**: Instantly re-routes RPC via Feather Tor hidden services.
- 🔑 **"Generate Fresh Subaddress"**: Generates a pristine one-time subaddress and updates QR code.
- 🔄 **"Initiate Decoy Churn"**: Sweeps outputs to self through fresh 16-member ring signatures.
- ⚡ **"Connect Local Full Node"**: One-click configuration for `127.0.0.1:18081`.

---

## 🔀 Cake-Style Cross-Chain Swap Aggregator

Obsidian integrates a non-custodial cross-chain exchange aggregator directly into the wallet:
- **Supported Pairs**: BTC, ETH, SOL, USDT, LTC, DAI <-> XMR.
- **Providers Aggregated**:
  - **Trocador** (Onion Aggregator, best rates, zero KYC)
  - **ChangeNOW** (Instant execution)
  - **FixedFloat** (Zero-wait exchange)
  - **SimpleSwap** (Custody-free)
- **Live Order Tracking**: Interactive step-by-step progress (`waiting_deposit` ➔ `confirming` ➔ `exchanging` ➔ `sending` ➔ `finished`).

---

## 🖥️ Monero GUI Full Node Control

Users can connect Obsidian to a local `monerod` full node running on their machine:
```bash
monerod --rpc-bind-ip 127.0.0.1 --rpc-bind-port 18081 --confirm-external-bind
```
- Real-time blockchain sync progress (`3,248,912 / 3,248,912`).
- Block header inspection, network difficulty, and peer count telemetry.

---

## 📂 Project Architecture

```
obsidian-wallet/
├── manifest.json              # WebExtension Manifest V3
├── public/
│   ├── background.js          # Service worker (node alarms & badge counter)
│   ├── content.js             # DApp Web3 provider injection (`window.monero`)
│   ├── favicon.svg            # Vector Monero shield brand
│   └── icons/                 # Extension icon sizes
├── src/
│   ├── crypto/
│   │   ├── moneroBase58.ts    # Custom Monero CN-Base58 encode & decode
│   │   ├── keys.ts            # Ed25519 scalar reduction, spend/view keys, address validation
│   │   ├── subaddress.ts      # Subaddress derivation (Hs("SubAddr\0" || a || i || j))
│   │   ├── mnemonic.ts        # Monero 25-word Electrum mnemonic & CRC32 checksum
│   │   ├── vault.ts           # AES-256-GCM + PBKDF2 encrypted keyring vault
│   │   └── wordlist.ts        # Official Monero 1626-word dictionary
│   ├── services/
│   │   ├── nodes.ts           # Curated Feather Tor onion nodes + clearnet fallbacks
│   │   ├── privacyScore.ts    # 4-Pillar Privacy Posture Meter calculation engine
│   │   ├── swapAggregator.ts  # Multi-provider instant exchange engine
│   │   ├── moneroRpc.ts       # Daemon RPC client (/get_info, /json_rpc)
│   │   └── storage.ts         # Chrome storage / localStorage wrapper
│   ├── state/
│   │   └── WalletContext.tsx  # Central React state store
│   ├── components/
│   │   ├── Header.tsx         # MetaMask-like header with node pill & privacy badge
│   │   ├── AccountCard.tsx    # Monero balance, fiat price, subaddress copy pill
│   │   ├── ActionButtons.tsx  # Buy, Swap, Send, Receive
│   │   ├── PrivacyPostureMeter.tsx # Interactive Privacy Inspector Modal
│   │   ├── Tabs/              # Assets, Activity, Node Sync, Privacy Lab
│   │   ├── Modals/            # Send, Receive (QR), Swap, Buy, Node Picker, Settings
│   │   └── Onboarding/        # MetaMask-style frictionless onboarding
│   ├── App.tsx                # Dual-mode container (Extension Frame + Expanded Tab)
│   └── main.tsx               # Entry point
```

---

## 🚀 Running the Project

### 1. Development & Live Interactive Preview
```bash
cd obsidian-wallet
npm install
npm run dev
```
Preview is accessible on `http://localhost:3000` with interactive mode switcher:
- 📱 **Extension Popup**: 380px x 620px realistic browser extension frame.
- 🖥️ **Expanded Tab**: Desktop dashboard experience.
- 🧪 **Web3 Playground**: Simulated dApp testing `window.monero` connection and payments.

### 2. Building the WebExtension
```bash
npm run build
```
The compiled extension bundle is output to `dist/`.

### 3. Loading in Chrome / Brave / Edge
1. Navigate to `chrome://extensions`.
2. Toggle on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `obsidian-wallet/dist` directory.

### 4. Loading in Firefox
1. Navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `obsidian-wallet/dist/manifest.json`.
