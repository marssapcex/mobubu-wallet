import { formatUnits } from 'ethers';
import { ASSETS, FEE, UNITS, setup } from '../test/local-evm.mjs';

// A run with its own embedded chain and synthetic feeds. No URLs or external keys accepted.
const f = await setup();
try {
  // The keeper is an account other than the deployer. No admin permission or user signatures are needed to publish.
  const keeper = await f.provider.getSigner(1);
  const receipt = await (await f.oracle.connect(keeper).refresh()).wait();
  const { id } = await f.oracle.activeEpoch();
  console.log('Local oracle:', f.oracle.target, '| pricing epoch:', id, '| refresh gas:', receipt.gasUsed.toString());
  console.log('Synthetic prices; fee:', FEE.toString(), 'bps; reference quotes only (not payouts).');
  for (const [src, label] of ASSETS.entries()) {
    for (const [dst, symbol] of ASSETS.entries()) {
      if (src === dst) continue;
      const out = await f.oracle.quote(id, src, dst, UNITS[src], 0);
      console.log(`1 ${label} → ${formatUnits(out, dst === 2 ? 6 : 18)} ${symbol}`);
    }
  }
} finally { f.close(); }
