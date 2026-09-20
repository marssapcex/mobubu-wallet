import assert from 'node:assert';
import { encodeMoneroBase58, decodeMoneroBase58 } from './src/crypto/moneroBase58.ts';
import { 
  createKeysFromSeed, 
  validateMoneroAddress, 
  createIntegratedAddress 
} from './src/crypto/keys.ts';
import { deriveSubaddress } from './src/crypto/subaddress.ts';
import { 
  generateRandomSeed, 
  seedToMnemonic, 
  mnemonicToSeed, 
  validateMnemonic 
} from './src/crypto/mnemonic.ts';
import { encryptVault, decryptVault } from './src/crypto/vault.ts';
import { calculatePrivacyPosture } from './src/services/privacyScore.ts';
import { fetchSwapQuotes } from './src/services/swapAggregator.ts';

console.log('====================================================');
console.log('🧪 RUNNING COMPREHENSIVE MOBUBU AUDIT SUITE');
console.log('====================================================\n');

// 1. Monero Base58
console.log('▶ [Test 1] Monero Base58 Encoding & Decoding...');
const testBuf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const b58 = encodeMoneroBase58(testBuf);
const decoded = decodeMoneroBase58(b58);
assert.deepStrictEqual(Array.from(decoded), Array.from(testBuf), 'Base58 roundtrip mismatch');
console.log('  ✓ Base58 roundtrip verified (16 bytes -> 22 base58 chars)');

// 2. Monero Key Derivation & Address Generation
console.log('▶ [Test 2] Monero Cryptographic Key & Address Derivation...');
const seed = generateRandomSeed();
assert.strictEqual(seed.length, 32);

const keys = createKeysFromSeed(seed, 'mainnet');
console.log('  • Primary Address:', keys.primaryAddress);
assert.strictEqual(keys.primaryAddress.length, 95, 'Primary address must be 95 chars');
assert.strictEqual(keys.primaryAddress.startsWith('4'), true, 'Mainnet primary address must start with 4');

const primaryValidation = validateMoneroAddress(keys.primaryAddress);
assert.strictEqual(primaryValidation.isValid, true, 'Primary address must pass validation');
assert.strictEqual(primaryValidation.type, 'primary');
assert.strictEqual(primaryValidation.nettype, 'mainnet');
console.log('  ✓ Primary Address format and checksum verified');

// 3. Subaddress Derivation
console.log('▶ [Test 3] Monero Subaddress Derivation (Major: 0, Minor: 1)...');
const subaddr = deriveSubaddress(keys.viewPrivateHex, keys.spendPublicHex, 0, 1, 'Test Sub');
console.log('  • Subaddress #1:', subaddr.address);
assert.strictEqual(subaddr.address.length, 95, 'Subaddress must be 95 chars');
assert.strictEqual(subaddr.address.startsWith('8'), true, 'Mainnet subaddress must start with 8');

const subValidation = validateMoneroAddress(subaddr.address);
assert.strictEqual(subValidation.isValid, true, 'Subaddress must pass validation');
assert.strictEqual(subValidation.type, 'subaddress');
assert.strictEqual(subValidation.nettype, 'mainnet');
console.log('  ✓ Subaddress derivation and checksum verified (Starts with 8)');

// 4. Integrated Address Generation
console.log('▶ [Test 4] Monero Integrated Address with 8-byte Payment ID...');
const integrated = createIntegratedAddress(keys.primaryAddress, '0123456789abcdef');
console.log('  • Integrated Address:', integrated);
assert.strictEqual(integrated.length, 106, 'Integrated address must be 106 chars');
assert.strictEqual(integrated.startsWith('4'), true, 'Integrated address starts with 4');

const integratedValidation = validateMoneroAddress(integrated);
assert.strictEqual(integratedValidation.isValid, true);
assert.strictEqual(integratedValidation.type, 'integrated');
assert.strictEqual(integratedValidation.paymentId, '0123456789abcdef');
console.log('  ✓ Integrated Address 106 chars and payment ID extraction verified');

// 5. Monero 25-Word Electrum Mnemonic
console.log('▶ [Test 5] Monero 25-Word Seed Mnemonic & CRC32 Checksum Word...');
const mnemonic = seedToMnemonic(seed);
const words = mnemonic.split(' ');
assert.strictEqual(words.length, 25, 'Monero Electrum seed must be 25 words');

// 25th word is one of the first 24 words
const first24 = words.slice(0, 24);
assert.strictEqual(first24.includes(words[24]), true, '25th word must be one of the first 24 words');

const recoveredSeed = mnemonicToSeed(mnemonic);
assert.deepStrictEqual(Array.from(recoveredSeed), Array.from(seed), 'Seed recovery from mnemonic must match original');

const mnemonicValid = validateMnemonic(mnemonic);
assert.strictEqual(mnemonicValid.isValid, true);
console.log('  ✓ 25-word mnemonic generation, CRC32 checksum, and recovery verified');

// 6. Encrypted Vault (AES-256-GCM + PBKDF2)
console.log('▶ [Test 6] Keyring Vault PBKDF2 + AES-256-GCM Encryption...');
const secretPayload = { accounts: [{ name: 'Test Account', keys }] };
const testPassword = 'StrongMasterPassword123!#';
const vault = await encryptVault(secretPayload, testPassword);
assert.strictEqual(vault.version, 1);
assert.strictEqual(typeof vault.cipherHex, 'string');

const decrypted = await decryptVault(vault, testPassword);
assert.strictEqual(decrypted.accounts[0].name, 'Test Account');

let failedBadPass = false;
try {
  await decryptVault(vault, 'WrongPassword456');
} catch {
  failedBadPass = true;
}
assert.strictEqual(failedBadPass, true, 'Decryption must fail with wrong password');
console.log('  ✓ Vault AES-256-GCM encryption, decryption, and authentication tag verified');

// 7. Privacy Posture Meter Diagnostics
console.log('▶ [Test 7] Privacy Posture Meter Scoring Algorithm...');
const mockTorNode = {
  id: 'tor-test',
  name: 'Tor Node',
  url: 'http://test.onion:18089',
  type: 'tor_onion',
  isTor: true,
  height: 3248915,
  targetHeight: 3248915,
  latencyMs: 380,
  isOnline: true,
};

const mockClearnetNode = {
  id: 'clearnet-test',
  name: 'Public Clearnet Node',
  url: 'http://public.node.org:18081',
  type: 'custom',
  isTor: false,
  height: 3248915,
  targetHeight: 3248915,
  latencyMs: 80,
  isOnline: true,
};

const mockFreshAccount = {
  index: 0,
  name: 'Account 1',
  primaryAddress: keys.primaryAddress,
  subaddresses: [subaddr],
  activeSubaddressIndex: 0,
  spendPublicHex: keys.spendPublicHex,
  viewPublicHex: keys.viewPublicHex,
  spendPrivateHex: keys.spendPrivateHex,
  viewPrivateHex: keys.viewPrivateHex,
  seedHex: keys.seedHex,
  mnemonic,
  balanceXMR: 5.0,
  unlockedBalanceXMR: 5.0,
};

// Test High Stealth Posture
const highPosture = calculatePrivacyPosture(mockTorNode, mockFreshAccount, true, false);
console.log(`  • High Stealth Score: ${highPosture.totalScore}/100 [${highPosture.tierLabel}]`);
assert.strictEqual(highPosture.totalScore >= 90, true, 'Tor + fresh subaddress must score >= 90');
assert.strictEqual(highPosture.tier, 'optimal');

// Test Low Clearnet Posture (Primary address + clearnet)
const mockExposedAccount = {
  ...mockFreshAccount,
  subaddresses: [],
  activeSubaddressIndex: 0,
};
const lowPosture = calculatePrivacyPosture(mockClearnetNode, mockExposedAccount, false, true);
console.log(`  • Exposed Clearnet Score: ${lowPosture.totalScore}/100 [${lowPosture.tierLabel}]`);
assert.strictEqual(lowPosture.totalScore < 40, true, 'Clearnet + primary address must score < 40');
assert.strictEqual(lowPosture.recommendations.length >= 2, true, 'Must produce actionable recommendations');
console.log('  ✓ Privacy Posture calculation, tier grading, and recommendations verified');

// 8. Swap Aggregator Quotes
console.log('▶ [Test 8] Cake-Style Cross-Chain Swap Aggregator Quotes...');
const quotes = await fetchSwapQuotes('BTC', 'XMR', 0.05);
assert.strictEqual(quotes.length > 0, true, 'Must return provider quotes');
console.log(`  • Best Rate: 0.05 BTC ➔ ${quotes[0].toAmount} XMR via ${quotes[0].providerName}`);
assert.strictEqual(quotes[0].isBestRate, true);
console.log('  ✓ Swap aggregator multi-provider rate calculation verified\n');

console.log('====================================================');
console.log('🎉 ALL 8 AUDIT MODULES PASSED WITH 100% SUCCESS');
console.log('====================================================');
