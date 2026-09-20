import { MoneroNode, AccountData, PrivacyPostureScore, PrivacyRecommendation } from '../types/wallet';

export function calculatePrivacyPosture(
  node: MoneroNode,
  account: AccountData | null,
  isTorEnabled: boolean,
  hasRecentUnchurnedTx: boolean = false
): PrivacyPostureScore {
  let totalScore = 0;
  const recommendations: PrivacyRecommendation[] = [];

  // Pillar 1: Network Transport Layer (Max: 30)
  let transportScore = 0;
  let transportStatusText = '';
  let transportDetail = '';
  let transportPositive = false;

  const isLocalNode = node.type === 'local_fullnode' || node.url.includes('127.0.0.1') || node.url.includes('localhost');
  const isOnion = node.isTor || node.url.includes('.onion');

  if (isLocalNode) {
    transportScore = 30;
    transportStatusText = 'Local Loopback (Zero Network Leak)';
    transportDetail = 'Daemon queries are confined to 127.0.0.1. Neither ISP nor external observers can see transaction sync packets.';
    transportPositive = true;
  } else if (isOnion || isTorEnabled) {
    transportScore = 30;
    transportStatusText = 'Tor Onion Network (End-to-End Hidden)';
    transportDetail = 'RPC calls are routed end-to-end through Tor v3 onion services. Node operator cannot observe your IP address or physical location.';
    transportPositive = true;
  } else {
    transportScore = 0;
    transportStatusText = 'Clearnet Exposed (Public IP Visible)';
    transportDetail = 'CRITICAL: You are transmitting over the public internet. The remote node operator and your ISP can log your IP and query intervals.';
    transportPositive = false;

    recommendations.push({
      id: 'switch-to-tor',
      title: 'Enforce Tor Onion Routing',
      description: 'Your IP is currently exposed to the remote node operator. Switch to an onion node for total cryptographic isolation.',
      actionText: 'Switch to Tor Node',
      actionType: 'switch_to_tor',
      impactPoints: 30,
      severity: 'critical',
    });
  }
  totalScore += transportScore;

  // Pillar 2: Node Sovereignty & Trust (Max: 25)
  let nodeTrustScore = 0;
  let nodeTrustStatusText = '';
  let nodeTrustDetail = '';
  let nodeTrustPositive = false;

  if (node.type === 'local_fullnode' || isLocalNode) {
    nodeTrustScore = 25;
    nodeTrustStatusText = 'Local Full Node (Zero-Trust Sovereignty)';
    nodeTrustDetail = 'You verify the entire Monero blockchain locally. You do not trust any external party for balance scanning or decoy rings.';
    nodeTrustPositive = true;
  } else if (node.type === 'tor_onion') {
    nodeTrustScore = 20;
    nodeTrustStatusText = 'Curated Feather Onion Node';
    nodeTrustDetail = 'Reputable community onion node with Tor transport isolation. Cannot correlate queries to your identity.';
    nodeTrustPositive = true;

    recommendations.push({
      id: 'connect-local-node',
      title: 'Run Monero Full Node',
      description: 'Running local monerod on 127.0.0.1:18081 provides 100% cryptographic sovereignty and eliminates remote node trust.',
      actionText: 'Connect Local Node',
      actionType: 'connect_local_node',
      impactPoints: 5,
      severity: 'info',
    });
  } else if (node.type === 'clearnet_curated') {
    nodeTrustScore = 12;
    nodeTrustStatusText = 'Curated Clearnet Remote Node';
    nodeTrustDetail = 'Known community node (SethForPrivacy / Cake), but remote nodes can theoretically log timing of block requests.';
    nodeTrustPositive = false;
  } else {
    nodeTrustScore = 6;
    nodeTrustStatusText = 'Unverified Remote Node';
    nodeTrustDetail = 'Connecting to an unknown third-party server. High risk of sybil attacks or query logging.';
    nodeTrustPositive = false;
  }
  totalScore += nodeTrustScore;

  // Pillar 3: Address Hygiene & Subaddress Stealth (Max: 25)
  let addressScore = 0;
  let addressStatusText = '';
  let addressDetail = '';
  let addressPositive = false;

  const currentAddress = account?.subaddresses[account.activeSubaddressIndex]?.address || account?.primaryAddress || '';
  const isSubaddress = currentAddress.startsWith('8') || currentAddress.startsWith('B') || currentAddress.startsWith('7');
  const activeSub = account?.subaddresses[account.activeSubaddressIndex];
  const isFreshSub = isSubaddress && (!activeSub?.isUsed);

  if (isFreshSub) {
    addressScore = 25;
    addressStatusText = 'Fresh Single-Use Subaddress Active';
    addressDetail = 'Pristine subaddress (8...). Different counterparties receive different addresses, preventing off-chain payment graph clustering.';
    addressPositive = true;
  } else if (isSubaddress) {
    addressScore = 18;
    addressStatusText = 'Reused Subaddress (Minor Linkability Risk)';
    addressDetail = 'Subaddresses protect your wallet master keys, but reusing the exact same subaddress across multiple services can link your identity off-chain.';
    addressPositive = true;

    recommendations.push({
      id: 'generate-subaddress',
      title: 'Generate Fresh Stealth Subaddress',
      description: 'Generate a new subaddress for each counterparty to completely isolate payment streams.',
      actionText: 'Generate Subaddress',
      actionType: 'generate_subaddress',
      impactPoints: 7,
      severity: 'warning',
    });
  } else {
    addressScore = 0;
    addressStatusText = 'Primary Address Active (4...) - SEVERE RISK';
    addressDetail = 'CRITICAL: Never reveal your primary address publicly. If given to a counterparty, they can prove whether any subaddress belongs to you!';
    addressPositive = false;

    recommendations.push({
      id: 'generate-subaddress',
      title: 'Switch to Subaddress Immediately',
      description: 'Your primary address is currently active. Never publish primary addresses (4...). Use stealth subaddresses (8...) instead.',
      actionText: 'Activate Subaddress',
      actionType: 'generate_subaddress',
      impactPoints: 25,
      severity: 'critical',
    });
  }
  totalScore += addressScore;

  // Pillar 4: Output Anonymity & Churning (Max: 20)
  let outputScore = 0;
  let outputStatusText = '';
  let outputDetail = '';
  let outputPositive = false;
  let eaeStatus = 'Protected';

  if (hasRecentUnchurnedTx) {
    outputScore = 10;
    outputStatusText = 'Unchurned Outputs Detected (EAE Vulnerability)';
    outputDetail = 'You recently received funds from an external source or swap. Performing a self-churn sweeps outputs through fresh ring decoys, neutralizing EAE heuristics.';
    outputPositive = false;
    eaeStatus = 'Vulnerable to timing analysis';

    recommendations.push({
      id: 'churn-outputs',
      title: 'Initiate Decoy Churn (EAE Defense)',
      description: 'Sweep received outputs to a fresh subaddress with 16 ring decoys to break transaction graph links before spending to another entity.',
      actionText: 'Perform Churn',
      actionType: 'churn_outputs',
      impactPoints: 10,
      severity: 'warning',
    });
  } else {
    outputScore = 20;
    outputStatusText = 'Ring Size 16 Enforced & Clean Outputs';
    outputDetail = 'All outputs adhere to strict ring signature decoy selection (16 members). No temporal correlation anomalies detected.';
    outputPositive = true;
    eaeStatus = 'Hardened (Zero linkage)';
  }
  totalScore += outputScore;

  // Tier classification
  let tier: PrivacyPostureScore['tier'] = 'optimal';
  let tierLabel = 'Ironclad Stealth';
  let color = '#10B981'; // Emerald green

  if (totalScore >= 90) {
    tier = 'optimal';
    tierLabel = 'Ironclad Stealth';
    color = '#10B981';
  } else if (totalScore >= 75) {
    tier = 'good';
    tierLabel = 'Strong Privacy';
    color = '#34D399';
  } else if (totalScore >= 50) {
    tier = 'moderate';
    tierLabel = 'Moderate Leaks';
    color = '#FBBF24'; // Amber
  } else {
    tier = 'exposed';
    tierLabel = 'Clearnet Exposed';
    color = '#EF4444'; // Red
  }

  return {
    totalScore,
    tier,
    tierLabel,
    color,
    transport: {
      score: transportScore,
      max: 30,
      title: 'Network Transport',
      statusText: transportStatusText,
      isPositive: transportPositive,
      detail: transportDetail,
    },
    nodeTrust: {
      score: nodeTrustScore,
      max: 25,
      title: 'Node Trust & Sovereignty',
      statusText: nodeTrustStatusText,
      isPositive: nodeTrustPositive,
      detail: nodeTrustDetail,
    },
    addressHygiene: {
      score: addressScore,
      max: 25,
      title: 'Address & Subaddress Stealth',
      statusText: addressStatusText,
      isPositive: addressPositive,
      detail: addressDetail,
    },
    outputHygiene: {
      score: outputScore,
      max: 20,
      title: 'Ring Decoys & Output Churn',
      statusText: outputStatusText,
      isPositive: outputPositive,
      detail: outputDetail,
    },
    eaeDefenseStatus: eaeStatus,
    recommendations,
  };
}
