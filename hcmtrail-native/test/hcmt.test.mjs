import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interface, MaxUint256, ZeroAddress, getAddress, id, parseUnits, toBeHex } from 'ethers';
import { compileSolidity } from '../scripts/compile.mjs';
import { TX_GAS_CAP } from '../testnet/networks.mjs';
import { LOCAL_ID, localEvm } from './local-evm.mjs';

const path = 'contracts/ethereum/HcmtToken.sol';
const opts = { gasLimit: TX_GAS_CAP };
const units = (n) => parseUnits(String(n), 18);
const has = (name) => (e) => e.revert?.name === name || e.data?.startsWith(id(`${name}()`).slice(0, 10));
const send = async (fn, ...args) => (await fn(...args, opts)).wait();

test('HCMT: a single 100,000-token genesis; ERC-20 transfers only, with no mint, burn, or admin entry point', async (t) => {
  const vm = await localEvm(LOCAL_ID);
  t.after(vm.close);
  const deployer = vm.signer, holder = await vm.provider.getSigner(1);
  const recipient = getAddress(toBeHex(0x48434d54n, 20));
  const { artifact } = compileSolidity([path]);
  const code = artifact(path, 'HcmtToken');
  await assert.rejects(vm.deploy(code, ZeroAddress, opts));
  const token = await vm.deploy(code, holder.address, opts);
  const cap = units(100_000);
  const receipt = await token.deploymentTransaction().wait();
  assert.deepEqual(receipt.logs.map((raw) => {
    const log = token.interface.parseLog(raw);
    return [log.name, ...log.args];
  }), [['Transfer', ZeroAddress, holder.address, cap]]);
  assert.equal(await token.name(), 'hcmtrail');
  assert.equal(await token.symbol(), 'HCMT');
  assert.equal(await token.decimals(), 18n);
  assert.equal(await token.totalSupply(), cap);
  assert.equal(await token.balanceOf(holder.address), cap);
  assert.equal(await token.balanceOf(deployer.address), 0n);
  assert.deepEqual(token.interface.fragments.filter((f) => f.type === 'function').map((f) => f.format('sighash')).sort(), [
    'allowance(address,address)', 'approve(address,uint256)', 'balanceOf(address)', 'decimals()', 'name()', 'symbol()',
    'totalSupply()', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)',
  ]);
  const unavailable = new Interface(['function mint(address,uint256)', 'function burn(uint256)', 'function owner() view returns (address)']);
  for (const from of [deployer.address, holder.address]) {
    for (const [method, args] of [['mint', [recipient, 1n]], ['burn', [1n]], ['owner', []]]) {
      await assert.rejects(vm.provider.call({ from, to: token.target, data: unavailable.encodeFunctionData(method, args) }));
    }
  }

  const wallet = token.connect(holder);
  await assert.rejects(wallet.transfer.staticCall(ZeroAddress, 1n), has('InvalidAccount'));
  await assert.rejects(wallet.transfer.staticCall(token.target, 1n), has('InvalidAccount'));
  await assert.rejects(wallet.transfer.staticCall(recipient, cap + 1n), has('InsufficientBalance'));
  await assert.rejects(token.transferFrom.staticCall(ZeroAddress, recipient, 0n), has('InvalidAccount'));
  await assert.rejects(token.transferFrom.staticCall(holder.address, recipient, 1n), has('InsufficientAllowance'));
  await assert.rejects(wallet.approve.staticCall(ZeroAddress, 1n), has('InvalidAccount'));
  await send(wallet.transfer, holder.address, units(1)); // self-transfer cannot create tokens
  const zero = await send(wallet.transfer, recipient, 0n);
  assert.deepEqual(token.interface.parseLog(zero.logs[0]).args.toArray(), [holder.address, recipient, 0n]);
  await send(wallet.transfer, recipient, units(2));
  const approval = await send(wallet.approve, deployer.address, units(5));
  assert.deepEqual(token.interface.parseLog(approval.logs[0]).args.toArray(), [holder.address, deployer.address, units(5)]);
  await send(token.transferFrom, holder.address, deployer.address, units(3));
  assert.equal(await token.allowance(holder.address, deployer.address), units(2));
  await assert.rejects(send(token.transferFrom, holder.address, ZeroAddress, units(1)));
  assert.equal(await token.allowance(holder.address, deployer.address), units(2));
  await send(wallet.approve, deployer.address, MaxUint256);
  await send(token.transferFrom, holder.address, recipient, units(4));
  assert.equal(await token.allowance(holder.address, deployer.address), MaxUint256);
  assert.deepEqual(await Promise.all([holder.address, deployer.address, recipient].map((a) => token.balanceOf(a))), [
    cap - units(9), units(3), units(6),
  ]);
  assert.equal(await token.totalSupply(), cap);
});
