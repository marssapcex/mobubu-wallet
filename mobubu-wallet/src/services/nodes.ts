import { MoneroNode } from '../types/wallet';

export const DEFAULT_NODES: MoneroNode[] = [
  // 1. Tor Onion Nodes (Feather Wallet backbone)
  {
    id: 'tor-monerolove',
    name: 'MoneroLove Onion (Tor v3)',
    url: 'http://loveanvthlsepingenr7opdqy6nlhn5jidwvzzxfmwsw2rry5mn2gfqd.onion:18089',
    type: 'tor_onion',
    isTor: true,
    height: 3248915,
    targetHeight: 3248915,
    latencyMs: 380,
    isOnline: true,
    isDefault: true,
  },
  {
    id: 'tor-plowsof',
    name: 'PlowsOf Onion (Tor v3)',
    url: 'http://plowsof3t5hogddwabaeiyrno25efmzfxyro2vligremt7sxpsclfaid.onion:18089',
    type: 'tor_onion',
    isTor: true,
    height: 3248915,
    targetHeight: 3248915,
    latencyMs: 410,
    isOnline: true,
  },
  {
    id: 'tor-rucknium',
    name: 'Rucknium Research Onion (Tor v3)',
    url: 'http://rucknium757bokwv3ss35ftgc3gzb7hgbvvglbg3hisp7tsj2fkd2nyd.onion:18081',
    type: 'tor_onion',
    isTor: true,
    height: 3248915,
    targetHeight: 3248915,
    latencyMs: 440,
    isOnline: true,
  },

  // 2. Local Full Node (Monero GUI full node)
  {
    id: 'local-fullnode',
    name: 'Local Daemon (127.0.0.1:18081)',
    url: 'http://127.0.0.1:18081',
    type: 'local_fullnode',
    isTor: false,
    height: 3248915,
    targetHeight: 3248915,
    latencyMs: 3,
    isOnline: true,
  },

  // 3. Curated Clearnet Nodes (Fallback with privacy score alert)
  {
    id: 'clearnet-seth',
    name: 'SethForPrivacy Node (SSL)',
    url: 'https://node.sethforprivacy.com:18089',
    type: 'clearnet_curated',
    isTor: false,
    height: 3248915,
    targetHeight: 3248915,
    latencyMs: 64,
    isOnline: true,
  },
  {
    id: 'clearnet-cake',
    name: 'Cake Wallet Node (SSL)',
    url: 'https://xmr-node.cakewallet.com:18081',
    type: 'clearnet_curated',
    isTor: false,
    height: 3248915,
    targetHeight: 3248915,
    latencyMs: 78,
    isOnline: true,
  },
  {
    id: 'clearnet-monerodevs',
    name: 'Monero Devs Node (SSL)',
    url: 'https://node.monerodevs.org:18089',
    type: 'clearnet_curated',
    isTor: false,
    height: 3248915,
    targetHeight: 3248915,
    latencyMs: 92,
    isOnline: true,
  },
];

/**
 * Benchmark node latency simulator / tester
 */
export async function benchmarkNodeLatency(node: MoneroNode): Promise<number> {
  // Tor onion simulated latency: 320ms - 520ms
  // Local: 2ms - 6ms
  // Clearnet: 45ms - 110ms
  if (node.type === 'local_fullnode') {
    return Math.floor(Math.random() * 4) + 2;
  }
  if (node.isTor) {
    return Math.floor(Math.random() * 150) + 320;
  }
  return Math.floor(Math.random() * 60) + 50;
}
