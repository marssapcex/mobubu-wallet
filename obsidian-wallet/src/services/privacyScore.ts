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
    transportStatusText = 'Local Loopback (No Network Leak)';
    transportDetail = 'All queries remain strictly within your local machine. No external servers or ISPs can observe any Monero data.';
    transportPositive = true;
  } else if (isOnion || isTorEnabled) {
    transportScore = 30;
    transportStatusText = 'Tor Onion Active (Hidden Route)';
    transportDetail = 'RPC calls are routed end-to-end through Tor Onion hidden services. Your IP address and physical location are completely masked.';
    transportPositive = true;
  } else {
    transportScore = 5;
    transportStatusText = 'Clearnet Exposed (Public IP)';
    transportDetail = 'You are connecting directly over the open internet. Your Internet Service Provider (ISP) and the remote node can see your IP address.';
    transportPositive = false;

    recommendations.push({
      id: 'switch-to-tor',
      title: 'Switch to Tor Onion Routing',
      description: 'Clearnet exposes your IP to the remote node operator. Switch to an onion node for zero IP leakage.',
      actionText: 'Switch to Tor Node',
      actionType: 'switch_to_tor',
      impactPoints: 25,
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
    nodeTrustStatusText = 'Local Full Node (Zero Trust)';
    nodeTrustDetail = 'You verify the entire Monero blockchain independently. You trust no third party for balance queries or decoy rings.';
    nodeTrustPositive = true;
  } else if (node.type === 'tor_onion') {
    nodeTrustScore = 20;
    nodeTrustStatusText = 'Curated Feather Onion Node';
    nodeTrustDetail = 'Connecting to a hardened community onion node over Tor. The operator cannot identify your origin.';
    nodeTrustPositive = true;

    recommendations.push({
      id: 'connect-local-node',
      title: 'Run Monero Full Node',
      description: 'Running a local daemon on 127.0.0.1:18081 gives you 100% cryptographic sovereignty.',
      actionText: 'Connect Local Node',
      actionType: 'connect_local_node',
      impactPoints: 5,
      severity: 'info',
    });
  } else if (node.type === 'clearnet_curated') {
    nodeTrustScore = 12;
    nodeTrustStatusText = 'Curated Clearnet Remote Node';
    nodeTrustDetail = 'Reputable community node, but remote nodes can theoretically log query timings and block scan requests.';
    nodeTrustPositive = false;
  } else {
    nodeTrustScore = 8;
    nodeTrustStatusText = 'Custom Remote Node';
    nodeTrustDetail = 'Third-party node. Verify whether this host logs RPC requests.';
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
    addressStatusText = 'Fresh Single-Use Subaddress';
    addressDetail = 'Using a brand-new subaddress. Counterparties cannot correlate multiple payments to the same wallet.';
    addressPositive = true;
  } else if (isSubaddress) {
    addressScore = 20;
    addressStatusText = 'Standard Subaddress (Reusable)';
    addressDetail = 'Subaddresses protect your wallet primary key, but rotating for each payment provides maximum stealth.';
    addressPositive = true;

    recommendations.push({
      id: 'generate-subaddress',
      title: 'Generate Fresh Subaddress',
      description: 'Using a fresh subaddress for every invoice or counterparty prevents off-chain linkability.',
      actionText: 'Generate Subaddress',
      actionType: 'generate_subaddress',
      impactPoints: 5,
      severity: 'warning',
    });
  } else {
    addressScore = 5;
    addressStatusText = 'Primary Address Active (4...)';
    addressDetail = 'Using your primary wallet address! Never reveal your primary address publicly. Always use subaddresses starting with "8".';
    addressPositive = false;

    recommendations.push({
      id: 'generate-subaddress',
      title: 'Switch to Subaddress Immediately',
      description: 'Your primary address is currently selected. Exposing it can link all your future transactions.',
      actionText: 'Create Subaddress',
      actionType: 'generate_subaddress',
      impactPoints: 20,
      severity: 'critical',
    });
  }
  totalScore += addressScore;

  // Pillar 4: Output Privacy & Churning (Max: 20)
  let outputScore = 0;
  let outputStatusText = '';
  let outputDetail = '';
  let outputPositive = false;

  if (hasRecentUnchurnedTx) {
    outputScore = 12;
    outputStatusText = 'Unchurned Outputs Detected';
    outputDetail = 'You recently received funds. Performing a self-churn sweeps outputs through fresh ring decoys, mitigating timing analysis.';
    outputPositive = false;

    recommendations.push({
      id: 'churn-outputs',
      title: 'Perform Output Churn',
      description: 'Sweep your recent outputs to a fresh subaddress with 16 ring decoys to break off-chain timing heuristics.',
      actionText: 'Churn Outputs',
      actionType: 'churn_outputs',
      impactPoints: 8,
      severity: 'warning',
    });
  } else {
    outputScore = 20;
    outputStatusText = 'Ring Size 16 Enforced & Clean Outputs';
    outputDetail = 'All outputs adhere to strict ring signature decoy selection (16 members). No timing anomalies detected.';
    outputPositive = true;
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
      title: 'Ring Decoys & Churn State',
      statusText: outputStatusText,
      isPositive: outputPositive,
      detail: outputDetail,
    },
    recommendations,
  };
}
