import { getAddress } from 'ethers';
import { ETHEREUM, ETH_LABS, TX_GAS_CAP } from '../testnet/networks.mjs';
import { FEE_BPS, need, quoteFee } from './protocol.mjs';

const CHAIN = ETH_LABS.find((n) => n.lane === ETHEREUM).labId;
const ACTIONS = new Set(['withdraw', 'executeBatch', 'claimAcross']);
const MAX_DATA_CHARS = 270_000;

/// Payout-only relayer for the in-process Ethereum lab. The application supplies
/// a connected signer for a specific pool, not a raw RPC or signer API. It only
/// accepts canonical calldata and never decodes, requests or logs a note key.
export async function startLabRelayer({ pool, staking, signer, write, minProfitWei = null }) {
  const { provider } = signer;
  const address = await signer.getAddress();
  need(provider && String((await provider.getNetwork()).chainId) === CHAIN &&
    String(await pool.homeChainId()) === CHAIN && await pool.FEE_BPS() === FEE_BPS &&
    await pool.feeStaking() === staking.target && await staking.feeSource() === pool.target &&
    await staking.relayEnabled(), 'Relayer HCMT chỉ chạy trên pool Ethereum lab đã cấu hình.');
  need(typeof write === 'function', 'Cần hàng đợi ghi giao dịch lab.');
  need(minProfitWei === null || (typeof minProfitWei === 'bigint' && minProfitWei >= 0n), 'Sai mức lợi nhuận tối thiểu.');
  const active = () => staking.relayEligible(address);
  const requireStake = async () => need(await active(), 'Relayer cần ít nhất 100 HCMT đang stake có hiệu lực.');
  await requireStake();
  const { interface: iface } = pool;
  const [minStake, maxReward] = await Promise.all([staking.MIN_RELAY_STAKE(), staking.MAX_RELAY_REWARD()]);
  let pending = 0;

  function parse(body) {
    need(body && Object.keys(body).sort().join(',') === 'chainId,data,pool,value' &&
      body.chainId === CHAIN && body.pool === pool.target && body.value === '0' &&
      typeof body.data === 'string' && body.data.length <= MAX_DATA_CHARS && /^0x(?:[a-fA-F0-9]{2})+$/.test(body.data),
    'Chỉ nhận calldata công khai, đúng pool/mạng và value = 0.');
    const tx = iface.parseTransaction({ data: body.data });
    need(tx && ACTIONS.has(tx.name) && iface.encodeFunctionData(tx.fragment, tx.args).toLowerCase() === body.data.toLowerCase(),
      'Relayer chỉ xử lý lệnh chi trả đã định dạng chuẩn.');
    return tx;
  }

  async function payoutFee(tx) {
    if (tx.name === 'withdraw') return quoteFee(tx.args[3]).fee;
    if (tx.name === 'claimAcross') {
      need(tx.args[0].destination === ETHEREUM, 'Relayer này chỉ chi trả trên Ethereum lab.');
      return quoteFee(tx.args[0].gross).fee;
    }
    const [amount, round] = tx.args;
    const { target, count, paid } = await pool.getBatch(amount, round);
    need(count !== 0n && count === target && !paid, 'Lô chưa sẵn sàng chi.');
    // Round per recipient first, just as the contract does. A single cap applies
    // to the resulting batch reward, not a separate cap per recipient.
    return quoteFee(amount).fee * count;
  }

  async function submit(body) {
    const tx = parse(body);
    const request = { to: pool.target, data: iface.encodeFunctionData(tx.fragment, tx.args), gasLimit: TX_GAS_CAP };
    need(pending < 5, 'Relayer đang bận.');
    ++pending;
    try {
      return await write(async () => {
        await requireStake();
        const fee = await payoutFee(tx);
        // Check profitability from protocol credit, not from a fee quoted by
        // the caller. Lab sponsorship can explicitly choose no profit floor.
        if (minProfitWei !== null) {
          const reward = await staking.quoteRelayReward(address, fee);
          const gas = await signer.estimateGas(request);
          const prices = await provider.getFeeData();
          const price = prices.maxFeePerGas ?? prices.gasPrice;
          need(price !== null && gas <= TX_GAS_CAP && reward >= gas * price + minProfitWei,
            'Thưởng theo trần không đủ bù gas; dùng rút trực tiếp hoặc thử lại.');
          request.gasLimit = gas;
          if (prices.maxFeePerGas !== null && prices.maxPriorityFeePerGas !== null) {
            request.maxFeePerGas = price;
            request.maxPriorityFeePerGas = prices.maxPriorityFeePerGas;
          } else {
            request.gasPrice = price;
          }
        } else {
          // Invalid proofs and unsafe retries must not burn the sponsor's gas.
          await signer.call(request);
        }
        const receipt = await (await signer.sendTransaction(request)).wait();
        need(receipt?.status === 1, 'Relayer không xác nhận được giao dịch.');
        return receipt;
      });
    } finally { --pending; }
  }

  return Object.freeze({
    active, submit,
    send(name, args) {
      need(ACTIONS.has(name), 'Không phải thao tác chi trả.');
      return submit({ chainId: CHAIN, pool: pool.target, data: iface.encodeFunctionData(name, args), value: '0' });
    },
    async status() {
      const [eligible, position, credit, stakeToken] = await Promise.all([
        active(), staking.position(address), staking.relayCredit(address), staking.stakeToken(),
      ]);
      return { chainId: CHAIN, pool: getAddress(pool.target), operator: address, stakeToken, eligible,
        activeStake: position.active, minStake, rewardCap: maxReward, feeBps: FEE_BPS, credit, labOnly: true };
    },
  });
}
