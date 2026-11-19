import { Interface, ZeroAddress } from 'ethers';
import { HCMT_LOCAL_SUPPLY } from './dao-policy.mjs';
import { callSpec, receiptSummary, view } from './deployment.mjs';
import { uint } from './notes.mjs';
import { address } from './rpc.mjs';
import { need, OperatorError } from './store.mjs';

export const daoArity = Object.freeze({ 'dao-status': [1, 2], 'hcmt-transfer': [3], stake: [2], unstake: [2], release: [1], close: [2], claim: [2] });
const U64 = (1n << 64n) - 1n;
const positive = (n, max, name) => {
  const value = uint(n, max, name);
  need(value > 0n, `${name} must be positive.`);
  return value;
};
const hcmt = (value) => positive(value, HCMT_LOCAL_SUPPLY, 'HCMT base-unit amount');

export async function daoCommand(chain, txs, manifest, a, command, args) {
  need(manifest.dao && a.token && a.treasury, 'This command requires a DAO fee vault manifest.');
  const { token, treasury } = manifest.dao;
  const tokenAbi = new Interface(a.token.abi), treasuryAbi = new Interface(a.treasury.abi);
  const read = (method, args = []) => view(chain, treasuryAbi, treasury, method, args);
  if (command === 'dao-status') {
    const who = address(chain.network, args[0]);
    const period = await read('currentPeriod');
    const query = args.length === 2 ? positive(args[1], U64, 'period') : period;
    return { who, token, treasury, period, startedAt: await read('startedAt'), nextToClose: await read('nextToClose'),
      hcmtBalance: await view(chain, tokenAbi, token, 'balanceOf', [who]),
      activeStake: await read('stakeAt', [who, period]), nextStake: await read('stakeAt', [who, period + 1n]),
      isBroadcaster: await read('isBroadcaster', [who]), nativeInPeriod: await read('receiptsByPeriod', [period]),
      claimablePeriod: query, claimableNative: await read('claimable', [who, query]) };
  }
  const [op, ...p] = args;
  need(/^[a-z0-9][a-z0-9-]{0,47}$/.test(op), 'OP_ID: use 1–48 lowercase letters, digits or hyphens, starting with a letter or digit.');
  const label = `dao-${command}-${op}`;
  let spec;
  switch (command) {
    case 'hcmt-transfer': {
      const to = address(chain.network, p[0]);
      // A raw token transfer into the treasury does not create a stake or a release record.
      need(to !== ZeroAddress && to !== token && to !== treasury && to !== manifest.vault, 'Send HCMT to a holder, not to the token, vault or treasury.');
      spec = callSpec(tokenAbi, token, 'transfer', [to, hcmt(p[1])]);
      break;
    }
    case 'stake': {
      const amount = hcmt(p[0]);
      await txs.submit(`${label}-approve`, callSpec(tokenAbi, token, 'approve', [treasury, amount]));
      spec = callSpec(treasuryAbi, treasury, 'stake', [amount]);
      break;
    }
    case 'unstake': spec = callSpec(treasuryAbi, treasury, 'requestUnstake', [hcmt(p[0])]); break;
    case 'release': spec = callSpec(treasuryAbi, treasury, 'releaseStake'); break;
    case 'close': spec = callSpec(treasuryAbi, treasury, 'closePeriods', [positive(p[0], 24n, 'close batch')]); break;
    case 'claim': {
      need(p[0].length <= 700, 'Claim must specify a comma-separated batch of at most 32 period IDs.');
      const periods = p[0].split(',').map((n) => positive(n, U64, 'period'));
      need(periods.length <= 32 && new Set(periods).size === periods.length, 'Claim 1–32 distinct period IDs.');
      spec = callSpec(treasuryAbi, treasury, 'claim', [periods]);
      break;
    }
    default: throw new OperatorError('Unknown DAO command.');
  }
  return receiptSummary(await txs.submit(label, spec));
}
