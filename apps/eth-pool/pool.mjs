import { Interface, formatEther, hexlify, keccak256 } from 'ethers';
import { ARBITRUM, ETHEREUM, ETH_LABS } from '/hcmtrail-native/testnet/networks.mjs';
import { NO_PACKET_GAS, Stage, exitId, exitLeg, readRouteBackups, retryableBudget } from '/hcmtrail-native/pool/clearing.mjs';
import { makeNoteCodec } from '/hcmtrail-native/testnet/notes-core.mjs';
import { ETH, FEE_BPS, MIN_DEPOSIT, MAX_BACKUP_BYTES, MAX_KEY_LENGTH, decodeNoteKey, depositGrosses, directLeg, encodeNoteKey, json, need, parseAmount, parseProver, payoutAddress, poolDomain,
  prepareProof, privateBackup, quoteFee, readBackup, reservationLeg, splitDeposit, targetCount, ticketId, validateProof } from '/hcmtrail-native/pool/protocol.mjs';

const $ = (id) => document.getElementById(id);
const hcmtSupply = 100_000n * 10n ** 18n;
const tabs = ['deposit', 'solo', 'smart'];
const text = {
  deposit: ['NẠP VÀO POOL', 'Nạp ETH', 'Tạo note nạp'],
  solo: ['KHÔNG CHỜ HÀNG ĐỢI', 'Rút ETH ngay', 'Rút ETH thử'],
  smart: ['CÙNG MỨC CHI TRẢ', 'Rút thông minh', 'Tạo proof giữ chỗ'],
};
const fmt = (amount) => formatEther(amount).replace(/\.0$/, '').replace('.', ',');
const fieldAmount = (amount) => formatEther(amount).replace(/\.0$/, '');
const key = (b) => `${b.amount}:${b.round}`;
const short = (hash) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;
const node = (name, content, className) => {
  const elem = document.createElement(name);
  if (content !== undefined) elem.textContent = content;
  if (className) elem.className = className;
  return elem;
};
let config, codec, iface, context, live, stakingView, labSession;
let mode = 'deposit', selection, busy = false, stage, continuation, cancelWorker;
const emptyBackup = () => ({ notes: [], refunds: [], routes: [] });
const randomWord = () => hexlify(crypto.getRandomValues(new Uint8Array(32)));
let backup = emptyBackup();
let liquidity, queueStamp, routeStamp;
const routeViews = new Map();
const networkByLane = (lane) => ETH_LABS.find((n) => n.lane === lane);
const destination = () => mode === 'solo' ? ETH_LABS.find((n) => n.slug === $('destination-select').value) : undefined;
const across = () => {
  const dest = destination();
  return dest && config && dest.slug !== config.network ? dest : undefined;
};

function sessionForLab() {
  if (labSession) return labSession;
  const name = 'hcmtrail-lab-staking-session'; // not a note key or a wallet credential
  try { labSession = sessionStorage.getItem(name); } catch { /* iframe may disallow storage */ }
  if (!/^[0-9a-f]{64}$/.test(labSession ?? '')) {
    labSession = hexlify(crypto.getRandomValues(new Uint8Array(32))).slice(2);
    try { sessionStorage.setItem(name, labSession); } catch { /* use in-memory session */ }
  }
  return labSession;
}

async function request(path, payload, headers = {}) {
  if (payload) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { headers, ...(payload ? { method: 'POST', body: json(payload) } : {}) });
  const value = await response.json();
  need(response.ok, value.error ?? 'Lỗi kết nối devnet.');
  return value;
}

function api(path, payload, network = config?.network ?? 'ethereum') {
  return request(`./api/${network}/${path}`, payload, path === 'staking' ? { 'X-Lab-Session': sessionForLab() } : {});
}

async function tx(method, args, value = 0n, target = config) {
  // Only public calldata leaves the browser. The local sponsor pays devnet gas.
  return api('tx', { chainId: target.chainId, pool: target.pool, data: iface.encodeFunctionData(method, args), value }, target.network);
}

async function refreshLiquidity() {
  const active = config;
  try {
    const book = await request('./api/liquidity');
    const networks = new Map(book.networks.map((n) => [n.network, n]));
    need(book.networkDomain === active.networkDomain && networks.get(active.network)?.pool === active.pool &&
      ETH_LABS.every(({ slug, lane, labId }) => networks.get(slug)?.lane === String(lane) && networks.get(slug)?.chainId === labId),
    'Sai cấu hình thanh khoản. Hãy tải lại trang.');
    if (active === config) { liquidity = networks; updateWithdrawQuote(); }
    return networks;
  } catch (e) {
    if (active === config) { liquidity = undefined; updateWithdrawQuote(); }
    throw e;
  }
}

function updateDestination() {
  const target = destination();
  $('source-lane').textContent = config ? `· nguồn ${config.label}` : '';
  const label = target?.label ?? config?.label;
  $('recipient-label').textContent = `Địa chỉ nhận ETH${label ? ` trên ${label}` : ''}`;
  $('primary').replaceChildren(across() ? 'Tạo proof rút liên mạng' : text[mode][2], node('span', '↗'));
}

function feedback(message = '', error = false) {
  const out = $('feedback');
  out.hidden = !message;
  out.textContent = message;
  out.classList.toggle('error', error);
}

function controls() {
  const disabled = busy || !!stage;
  for (const name of tabs) $(`tab-${name}`).disabled = disabled;
  for (const id of ['network-select', 'destination-select', 'deposit-amount', 'note-file', 'note-key', 'import-key', 'recipient', 'withdraw-amount', 'target', 'clear-selection', 'new-batch']) {
    $(id).disabled = disabled || !config;
  }
  $('primary').disabled = disabled || !config || (mode !== 'deposit' && (!config.canProve || !backup.notes.length));
  $('confirm').disabled = busy || !stage?.downloaded;
  $('download-note').disabled = busy;
  $('copy-note').disabled = busy;
  $('saved-key').disabled = busy;
  $('discard').disabled = busy;
  $('continue').hidden = !continuation || !!stage;
  $('continue').disabled = busy;
  for (const row of $('queue').querySelectorAll('button')) row.disabled = disabled || row.dataset.ready === 'true';
  for (const id of ['recovery-rows', 'route-rows']) {
    for (const row of $(id).querySelectorAll('button')) row.disabled = disabled;
  }
  $('open-staking').disabled = disabled || !config || !stakingView;
  for (const id of ['stake-add', 'stake-exit', 'stake-amount', 'claim-recipient', 'stake-withdraw', 'claim-rewards']) {
    $(id).disabled = disabled || !stakingView?.position;
  }
  if (stakingView?.position) {
    $('stake-add').disabled ||= BigInt(stakingView.available) === 0n;
    $('stake-exit').disabled ||= BigInt(stakingView.position.scheduled) === 0n;
    $('stake-withdraw').disabled ||= BigInt(stakingView.position.withdrawable) === 0n;
    $('claim-rewards').disabled ||= BigInt(stakingView.position.claimable) === 0n;
  }
}

function pickMode(next) {
  if (busy || stage) return;
  mode = next;
  continuation = null;
  for (const name of tabs) {
    const tab = $(`tab-${name}`);
    tab.setAttribute('aria-selected', String(name === mode));
    tab.tabIndex = name === mode ? 0 : -1;
  }
  $('operation-panel').setAttribute('aria-labelledby', `tab-${mode}`);
  $('deposit-fields').hidden = mode !== 'deposit';
  $('withdraw-fields').hidden = mode === 'deposit';
  $('batch-fields').hidden = mode !== 'smart';
  $('destination-fields').hidden = mode !== 'solo';
  const [kicker, title] = text[mode];
  $('form-kicker').textContent = kicker;
  $('form-title').textContent = title;
  updateDestination();
  $('withdraw-amount').placeholder = mode === 'smart' ? '0,00' : 'Toàn bộ số dư';
  $('withdraw-label').replaceChildren(mode === 'smart' ? 'Số ETH mỗi lượt trước phí' : 'Số ETH rút trước phí',
    ...(mode === 'solo' ? [node('span', ' · không bắt buộc')] : []));
  $('withdraw-amount-hint').textContent = mode === 'smart'
    ? 'Mỗi lượt nhận cùng số ETH sau phí 0,09%. Giữ chỗ chưa bị tính phí.' : 'Để trống để dùng toàn bộ note. ETH nhận đã trừ phí 0,09%, tính theo wei.';
  $('recipient-hint').textContent = mode === 'smart'
    ? 'Dùng địa chỉ mới. Hợp đồng nhận ETH có thể làm cả lô thất bại.' : 'Dùng địa chỉ mới mà bạn kiểm soát.';
  select(undefined, false);
  updateWithdrawQuote();
  if (mode === 'solo' && config) refreshLiquidity().catch(() => {});
  if (mode !== 'deposit' && config && !config.canProve) feedback('Trình tạo proof chưa được build, hoặc trình duyệt này không hỗ trợ số nguyên chính xác.', true);
  else feedback('');
  controls();
}

function select(row, clearAmount = true) {
  selection = row;
  $('withdraw-amount').readOnly = !!row;
  $('target').readOnly = !!row;
  $('clear-selection').hidden = !row;
  if (row) {
    $('withdraw-amount').value = fieldAmount(row.amount);
    $('target').value = row.target;
    $('batch-hint').textContent = `Lô #${row.round}: ${row.count}/${row.target} lượt · còn thiếu ${row.missing}.`;
  } else {
    if (clearAmount) $('withdraw-amount').value = '';
    $('batch-hint').textContent = 'Từ 5 đến 100 lượt. Nếu mức ETH đã mở lô, bạn tham gia lô đó.';
  }
  queueStamp = undefined;
  if (live) drawQueue(live);
  updateWithdrawQuote();
}

function drawQueue(state) {
  const stamp = json([state.batches, state.recent, selection && key(selection)]);
  if (stamp === queueStamp) return;
  queueStamp = stamp;
  $('batches-count').textContent = state.batches.length;
  const rows = state.batches.map((batch) => {
    const row = node('button', undefined, 'queue-row');
    row.type = 'button';
    row.dataset.ready = String(batch.status === 'ready');
    row.dataset.amount = batch.amount;
    row.setAttribute('aria-pressed', String(selection && key(selection) === key(batch) || false));
    const net = quoteFee(batch.amount).net;
    row.setAttribute('aria-label', `${fmt(net)} ETH nhận mỗi lượt, ${batch.count}/${batch.target} lượt, còn thiếu ${batch.missing}`);
    const head = node('div', undefined, 'row-top');
    head.append(node('strong', `${fmt(net)} ETH`), node('span', `nhận mỗi lượt · lô #${batch.round}`));
    const bar = node('progress');
    bar.max = batch.target;
    bar.value = batch.count;
    bar.setAttribute('aria-label', 'Tiến độ lô');
    const foot = node('div', undefined, 'row-bottom');
    foot.append(node('span', `${batch.count}/${batch.target} lượt đã vào`),
      node('b', batch.status === 'ready' ? 'Đủ lượt · chờ trả' : `Còn thiếu ${batch.missing}`));
    row.append(head, bar, foot);
    row.onclick = () => { pickMode('smart'); select(batch); $('note-key').focus(); };
    return row;
  });
  if (!rows.length) {
    const empty = node('div', undefined, 'empty');
    empty.append(node('strong', 'Chưa có lô đang chờ'), node('p', 'Tạo lượt đầu tiên từ một note đã nạp. Chỉ lượt có proof hợp lệ mới vào hàng đợi.'));
    rows.push(empty);
  }
  $('queue').replaceChildren(...rows);
  $('recent').hidden = !state.recent.length;
  $('recent-rows').replaceChildren(...state.recent.map((b) => {
    const row = node('div', undefined, 'recent-row');
    const hash = node('code', short(b.tx), 'hash');
    hash.title = b.tx;
    row.append(node('span', `${b.count} lượt × ${fmt(quoteFee(b.amount).net)} ETH nhận`), hash);
    return row;
  }));
  controls();
}

function renderState(s) {
  need(s.pool === config.pool && s.chainId === config.chainId, 'Devnet đã khởi động lại. Tải lại trang trước khi tiếp tục.');
  if (live && s.block < live.block) return;
  live = s;
  $('network-status').classList.remove('offline');
  $('network-status').replaceChildren(node('i'), ` ${config.label} lab`);
  $('block-status').classList.remove('offline');
  $('block-status').replaceChildren(node('i'), ` BLOCK ${s.block}`);
  const total = fmt(BigInt(s.shielded) + BigInt(s.reserved));
  $('total-eth').classList.toggle('compact', total.length > 14);
  $('total-eth').replaceChildren(`${total} `, node('small', 'ETH'));
  $('reserved-eth').textContent = `${fmt(s.reserved)} ETH đang giữ chỗ`;
  drawQueue(s);
  if (selection) {
    const tracked = s.batches.find((r) => key(r) === key(selection));
    $('batch-hint').textContent = tracked ? `Lô #${tracked.round}: ${tracked.count}/${tracked.target} lượt · còn thiếu ${tracked.missing}.`
      : `Lô #${selection.round} đã đóng. Chọn lô khác hoặc tạo lượt mới.`;
  }
}

function spendable(s) {
  const byLeaf = new Map(backup.notes.map((n) => [n.leaf, n]));
  const spent = new Set(s.nullifiers);
  return s.leaves.flatMap((leaf, index) => {
    const note = byLeaf.get(leaf);
    return note && index > 0 && !spent.has(codec.noteNullifier(note, BigInt(index))) ? [{ note, index }] : [];
  });
}

function refundsFrom(s) {
  const reservations = new Map(s.reservations.map((r) => [r.nullifier, r]));
  const refunded = new Set(s.refunded);
  const totals = new Map();
  for (const r of s.reservations) totals.set(r.ticket, (totals.get(r.ticket) ?? 0n) + BigInt(r.value));
  return backup.refunds.flatMap((r) => {
    const matched = reservations.get(r.nullifier);
    if (matched?.refundLeaf !== r.leaf || matched.ticket !== ticketId(config.domain, r.terms)) return [];
    const round = s.history.find((b) => key(b) === key(r.terms));
    if (!round) return [];
    const funded = totals.get(matched.ticket);
    const status = refunded.has(r.nullifier) ? 'refunded' : round.paid && funded === r.terms.amount ? 'paid'
      : round.paid || round.status === 'expired' ? 'refund' : funded < r.terms.amount ? 'partial' : 'held';
    return [{ ...r, status, value: BigInt(matched.value), funded }];
  });
}

function renderBackup(s) {
  if (!backup.notes.length) return;
  const balance = spendable(s).reduce((v, row) => v + row.note.value, 0n);
  $('note-status').textContent = `Số dư note có thể dùng: ${fmt(balance)} ETH. Khóa chỉ được đọc trên thiết bị này.`;
  const rows = refundsFrom(s).map((r) => {
    const div = node('div', undefined, 'recovery-row');
    div.append(node('span', `${fmt(r.value)} ETH · lô #${r.terms.round}`));
    if (r.status === 'refund') {
      const btn = node('button', 'Hoàn về note', 'link-button');
      btn.type = 'button';
      btn.onclick = () => run(async () => {
        feedback('Đang hoàn ETH về note đã lưu…');
        const receipt = await tx('refundPart', [r.terms, r.nullifier]);
        await getSnapshot();
        feedback(`Đã hoàn ${fmt(r.value)} ETH về note. Giao dịch ${short(receipt.hash)}.`);
      });
      div.append(btn);
    } else {
      div.append(node('span', ({ held: 'Đã giữ chỗ', partial: 'Đang góp tiền cho lượt', paid: 'Đã trả', refunded: 'Đã hoàn' })[r.status]));
    }
    return div;
  });
  $('recoveries').hidden = !rows.length;
  $('recovery-rows').replaceChildren(...rows);
  controls();
}

async function getRoute(route, advance = false) {
  const active = config;
  const v = await api(`route/${route.id}`, advance ? { action: 'advance' } : undefined, active.network);
  need(v.id === route.id && v.networkDomain === active.networkDomain && (!v.found || BigInt(v.gross) === route.order.gross),
    'Lệnh không thuộc phiên lab này.');
  if (active !== config) return v;
  const previous = routeViews.get(route.id);
  if (previous?.found && (!v.found || BigInt(previous.sourceStage) > BigInt(v.sourceStage) ||
    BigInt(previous.destinationStage) > BigInt(v.destinationStage))) return previous;
  if (!advance && previous?.destinationStage === v.destinationStage && previous?.sourceStage === v.sourceStage) v.issue ??= previous?.issue;
  routeViews.set(route.id, v);
  return v;
}

function routeText(route, view) {
  const gross = route.order.gross;
  if (!view) return 'Đang đọc trạng thái công khai…';
  if (!view.found) return 'Chưa có lệnh được xác nhận. Note gốc vẫn có thể dùng nếu chưa tiêu.';
  const source = BigInt(view.sourceStage), dest = BigInt(view.destinationStage);
  if (source === Stage.Refunded) return `Đã hoàn ${fmt(gross)} ETH về note nguồn. Không thu phí rút.`;
  if (dest === Stage.Paid) {
    const { fee, net } = quoteFee(gross);
    return `Đã nhận ${fmt(net)} ETH · phí ${fmt(fee)} ETH tại mạng đích.${source === Stage.Settled ? '' : ' Nguồn đang chờ xác nhận đã chi.'}`;
  }
  if (dest === Stage.Cancelled) return 'Đã hủy ở đích. Xử lý tiếp để hoàn về note nguồn.';
  if (dest === Stage.Authorized) {
    if (BigInt(view.liquidity) < gross) return `Đang chờ thanh khoản: đích còn ${fmt(view.liquidity)} ETH, cần ${fmt(gross)} ETH. Chưa thu phí rút.`;
    if (view.issue === 'payout') return 'Đích chưa chuyển được ETH. Có thể thử lại hoặc hủy để hoàn về note.';
    return 'Đích đã xác nhận lệnh, có thể thử chi trả hoặc hủy.';
  }
  return 'Nguồn đã khóa note. Đang chờ chuyển thông điệp tới đích; có thể xử lý tiếp mà không tạo proof mới.';
}

function renderRoutes() {
  const stamp = json(backup.routes.map((r) => [r.id, routeViews.get(r.id)]));
  if (stamp === routeStamp) return;
  routeStamp = stamp;
  const rows = [...backup.routes].reverse().map((r) => {
    const v = routeViews.get(r.id);
    const dest = networkByLane(r.order.destination);
    const row = node('div', undefined, 'route-row');
    row.append(node('strong', `${config.label} → ${dest.label} · ${fmt(r.order.gross)} ETH trước phí`), node('p', routeText(r, v)));
    const id = node('code', short(r.id), 'hash');
    id.title = r.id;
    row.append(id);
    if (v?.payoutTx) {
      const paid = node('code', `Chi: ${short(v.payoutTx)}`, 'hash');
      paid.title = v.payoutTx;
      row.append(node('span', ' · '), paid);
    }
    if (!v?.found || [Stage.Settled, Stage.Refunded].includes(BigInt(v.sourceStage))) return row;
    const actions = node('div', undefined, 'route-actions');
    const action = (label, before = async () => {}) => {
      const b = node('button', label, 'link-button');
      b.type = 'button';
      b.onclick = () => run(async () => {
        feedback('Đang xử lý lệnh liên mạng…');
        await before();
        const updated = await getRoute(r, true);
        renderRoutes();
        await getSnapshot();
        await refreshLiquidity().catch(() => {});
        feedback(routeText(r, updated));
      });
      return b;
    };
    actions.append(action('Kiểm tra và xử lý tiếp'));
    if (BigInt(v.destinationStage) === Stage.Authorized) {
      actions.append(action('Hủy lệnh và hoàn về note', async () => {
        const target = (await refreshLiquidity()).get(dest.slug);
        // This independent, one-use cancellation preimage becomes public on
        // cancellation. There are no note openings in the transaction.
        await tx('cancelAcross', [r.order, r.cancelSecret], 0n, target);
      }));
    }
    row.append(actions);
    return row;
  });
  $('route-recoveries').hidden = !rows.length;
  $('route-rows').replaceChildren(...rows);
  controls();
}

let routeCursor = 0;
async function refreshRoutes() {
  const active = config;
  const pending = backup.routes.filter(({ id }) => {
    const v = routeViews.get(id);
    return !v?.found || ![Stage.Settled, Stage.Refunded].includes(BigInt(v.sourceStage));
  });
  // Bound the number of public lookups per poll even for imported backups.
  await Promise.allSettled(Array.from({ length: Math.min(8, pending.length) }, () => getRoute(pending[(routeCursor++) % pending.length])));
  if (active === config) renderRoutes();
}

async function getSnapshot() {
  const active = config;
  const s = await api('snapshot');
  if (active !== config) return s;
  renderState(s);
  need(s.leaves[0] === config.domainLeaf, 'Cây note không thuộc pool này.');
  renderBackup(s);
  updateWithdrawQuote();
  return s;
}

async function refreshStaking() {
  const active = config;
  const state = await api('staking');
  if (active === config) renderStaking(state);
}

async function poll() {
  const active = config;
  try {
    if (backup.notes.length) await getSnapshot();
    else {
      const state = await api('state');
      if (active === config) renderState(state);
    }
  } catch {
    if (active === config) {
      $('network-status').classList.add('offline');
      $('network-status').replaceChildren(node('i'), ' Mất kết nối devnet');
      $('block-status').classList.add('offline');
      $('block-status').replaceChildren(node('i'), ' MẤT KẾT NỐI');
    }
  } finally { setTimeout(poll, 3600); }
  if (!busy && active && active === config) {
    const updates = [refreshStaking()];
    if (mode === 'solo') updates.push(refreshLiquidity());
    if (backup.routes.length) updates.push(refreshRoutes());
    await Promise.allSettled(updates);
  }
}

async function run(work) {
  if (busy || !config) return;
  busy = true;
  controls();
  try { await work(); }
  catch (error) { feedback(error instanceof Error ? error.message : 'Thao tác không hoàn tất. Hãy giữ file note.', true); }
  finally { busy = false; controls(); }
}

function showStage(next) {
  stage = next;
  $('operation').hidden = !!stage;
  $('review').hidden = !stage;
  $('review-key').value = '';
  $('review-key').hidden = true;
  $('saved-key').hidden = true;
  if (stage) {
    $('review-title').textContent = stage.title;
    $('review-summary').textContent = stage.details;
    $('confirm').textContent = stage.confirm;
    $('download-note').textContent = 'Tải file note thay thế ↓';
    $('copy-note').textContent = 'Sao chép khóa note ↗';
  }
  controls();
}

function draftDeposit() {
  const amount = parseAmount($('deposit-amount').value, MIN_DEPOSIT);
  const groups = splitDeposit(amount, codec);
  const newNotes = { ...emptyBackup(), notes: groups.flatMap((g) => g.notes) };
  const fee = groups.reduce((a, g) => a + g.fee, 0n);
  const net = amount - fee;
  let at = 0;
  showStage({ title: 'Lưu khóa note nạp', details: `Nạp ${fmt(amount)} ETH trên ${config.label}. Phí ${fmt(fee)} ETH; note có ${fmt(net)} ETH. ${groups.length} giao dịch; gas lab trả riêng.`,
    confirm: 'Đã lưu note · Nạp ETH thử ↗', backup: newNotes, async send() {
      let last;
      for (; at < groups.length; ++at) {
        const { notes: group, gross } = groups[at];
        const terms = group.map((n) => ({ amount: n.value, ownerCommit: n.ownerCommit }));
        feedback(`Đang nạp giao dịch ${at + 1}/${groups.length}…`);
        last = await tx(group.length === 1 ? 'deposit' : 'depositBatch',
          group.length === 1 ? [group[0].ownerCommit] : [terms], gross);
      }
      backup = newNotes;
      $('note-file').value = '';
      $('deposit-amount').value = '';
      updateDepositQuote();
      renderRoutes();
      feedback(`Đã nạp ${fmt(amount)} ETH thử. Note nhận ${fmt(net)} ETH, phí ${fmt(fee)} ETH. ${short(last.hash)}.`);
    } });
}

function prove(plan) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./proof-worker.mjs', import.meta.url), { type: 'module' });
    const finish = (error, result) => {
      worker.terminate();
      clearTimeout(timer);
      $('cancel-proof').hidden = true;
      cancelWorker = undefined;
      if (error) reject(new Error(error)); else resolve(result);
    };
    const timer = setTimeout(() => finish('Hết thời gian tạo proof; chưa gửi giao dịch.'), 20 * 60_000);
    cancelWorker = () => finish('Đã hủy tạo proof. Chưa gửi giao dịch.');
    $('cancel-proof').hidden = false;
    worker.onmessage = ({ data }) => {
      if (data.working) feedback('Đang tạo STARK trên thiết bị. Quá trình có thể mất vài phút.');
      else if ('phase' in data) feedback(`Đang tạo STARK trên thiết bị · bước ${data.phase + 1}/11…`);
      else finish(data.error, data.result);
    };
    worker.onerror = () => finish('Không chạy được trình tạo proof. Chưa gửi giao dịch.');
    worker.postMessage({ plan, useCache: config.cache });
  });
}

function newAction(s) {
  need(config.canProve && backup.notes.length, 'Cần khóa note và trình tạo proof trên máy.');
  const rows = spendable(s);
  const available = rows.reduce((v, row) => v + row.note.value, 0n);
  const dest = across();
  const recipient = dest ? $('recipient').value : payoutAddress($('recipient').value, config.pool, config.staking);
  const pasted = $('withdraw-amount').value.trim();
  const amount = mode === 'solo' && !pasted ? available : parseAmount(pasted);
  need(amount > 0n, 'Note chưa có số dư sử dụng được.');
  if (mode === 'solo') return { recipient, destination: dest, amount, left: amount, sent: 0n, netSent: 0n };
  const history = s.history.filter((r) => r.amount === String(amount));
  const active = s.batches.find((r) => r.amount === String(amount));
  need(!selection || active && key(selection) === key(active), 'Lô đã đóng. Chọn lại trước khi tạo proof.');
  need(active?.status !== 'ready', 'Lô đã đủ lượt và đang chờ keeper trả.');
  if (active && !selection) select(active);
  const last = history.reduce((max, row) => BigInt(row.round) > max ? BigInt(row.round) : max, 0n);
  const round = active ? BigInt(active.round) : last + 1n;
  const target = active?.target ?? targetCount($('target').value);
  const existing = refundsFrom(s).find((r) => r.status === 'partial' && r.terms.amount === amount &&
    r.terms.round === round && r.terms.recipient === recipient);
  const terms = existing?.terms ?? { amount, round, target, recipient, salt: hexlify(crypto.getRandomValues(new Uint8Array(32))) };
  return { recipient, amount, terms, left: amount - (existing?.funded ?? 0n), sent: existing?.funded ?? 0n };
}

async function prepareAndSend(action, s) {
  continuation = undefined;
  const rows = spendable(s);
  need(rows.reduce((v, r) => v + r.note.value, 0n) >= action.left && action.left > 0n, 'Số dư note không đủ cho khoản còn lại.');
  if (action.terms) {
    const latest = s.history.find((b) => key(b) === key(action.terms));
    need(!latest || latest.status === 'waiting', 'Lô không còn nhận lượt. Nếu đã giữ chỗ, kiểm tra phần hoàn note.');
  }
  const row = rows[0];
  const value = row.note.value < action.left ? row.note.value : action.left;
  const refund = action.terms || action.destination ? codec.openNote(ETH, value) : null;
  let route, leg;
  if (action.destination) {
    const target = (await refreshLiquidity()).get(action.destination.slug);
    need(BigInt(target.free) >= action.left, `${action.destination.label} chưa đủ thanh khoản tự do cho khoản rút này. Chưa khóa note.`);
    const cancelSecret = randomWord();
    const order = { source: BigInt(config.lane), destination: action.destination.lane, gross: value,
      recipient: payoutAddress(action.recipient, target.pool, target.staking), refundOwner: refund.ownerCommit,
      cancelHash: keccak256(cancelSecret), salt: randomWord() };
    route = { order, cancelSecret, refundLeaf: refund.leaf, id: exitId(config.networkDomain, order) };
    leg = exitLeg(config.domain, config.networkDomain, order);
  } else {
    leg = refund ? reservationLeg(config.domain, action.terms, value, refund.ownerCommit) : directLeg(action.recipient, value, config.staking);
  }
  feedback('Đang kiểm tra cây note công khai…');
  need(codec.rebuildRoot(s.leaves) === s.root, 'Cây note công khai không khớp root, chưa gửi giao dịch.');
  const plan = prepareProof(codec, s, row, leg);
  feedback('Đang tải trình tạo proof cục bộ…');
  const raw = await prove(plan);
  const { proof, spend, change } = validateProof(codec, plan, raw.proof, parseProver(raw.publicAndChange));
  const newNotes = { notes: [...backup.notes, ...change, ...(refund ? [refund] : [])],
    refunds: [...backup.refunds, ...(action.terms ? [{ terms: action.terms, leaf: refund.leaf, nullifier: spend.nullifiers[0] }] : [])],
    routes: [...backup.routes, ...(route ? [route] : [])] };
  const send = async () => {
    feedback('Đang gửi proof công khai lên devnet…');
    if (route) {
      const { order } = route;
      // Retry or recover after an uncertain response without spending the note again.
      let status = await getRoute(route).catch(() => undefined);
      if (!status?.found) {
        const arb = order.source === ETHEREUM && order.destination === ARBITRUM;
        const bid = arb ? config.arbitrumPacketGas : NO_PACKET_GAS;
        try {
          const receipt = await tx('withdrawAcross', [proof, spend, order, bid], arb ? retryableBudget(bid) : 0n);
          need(receipt.id === route.id, 'Mã lệnh không khớp. Giữ khóa note để khôi phục.');
        } catch (e) {
          status = await getRoute(route).catch(() => undefined);
          if (!status?.found) throw e;
        }
      }
      backup = newNotes;
      action.left -= value;
      continuation = action.left > 0n ? action : undefined;
      const rest = continuation ? ` Còn ${fmt(action.left)} ETH chưa khóa.` : '';
      const next = await getRoute(route, true).catch(() => undefined);
      renderRoutes();
      feedback(`${next ? routeText(route, next) : 'Đã gửi lệnh. Mở lại khóa note để kiểm tra và xử lý tiếp.'}${rest}`);
      return;
    }
    const receipt = refund ? await tx('reserve', [proof, spend, action.terms, value, refund.ownerCommit])
      : await tx('withdraw', [proof, spend, action.recipient, value]);
    backup = newNotes;
    action.left -= value;
    action.sent += value;
    if (!refund) action.netSent += leg.amount;
    continuation = action.left > 0n ? action : undefined;
    if (continuation) {
      feedback(`${refund ? 'Đã giữ' : 'Đã trả'} ${fmt(refund ? action.sent : action.netSent)} ETH. Còn ${fmt(action.left)} ETH trước phí cần proof tiếp theo. Giao dịch ${short(receipt.hash)}.`);
    } else {
      feedback(refund ? `Lượt đã vào lô #${action.terms.round}. Khi lô trả, bạn nhận ${fmt(quoteFee(action.amount).net)} ETH. ${short(receipt.hash)}.`
        : `Đã nhận ${fmt(action.netSent)} ETH sau phí ${fmt(action.amount - action.netSent)} ETH tại ${short(action.recipient)}. ${short(receipt.hash)}.`);
    }
  };
  if (!refund && !change.length) {
    await send();
    await getSnapshot().catch(() => {});
    return;
  }
  const changeValue = change.reduce((sum, n) => sum + n.value, 0n);
  if (route) {
    const { fee, net } = quoteFee(value);
    showStage({ title: 'Lưu khóa theo dõi và hoàn note',
      details: `${config.label} → ${action.destination.label}. Khóa ${fmt(value)} ETH; phí khi trả ${fmt(fee)} ETH; nhận ${fmt(net)} ETH tại ${short(route.order.recipient)}. Note dư ${fmt(changeValue)} ETH. Gas thử trả riêng. Thanh khoản không được đặt trước.`,
      backup: newNotes, send, confirm: 'Đã lưu khóa · Gửi lệnh liên mạng ↗' });
    feedback('Proof đã sẵn sàng. Chưa khóa note hay gửi giao dịch.');
    return;
  }
  showStage({ title: refund ? 'Lưu note để có thể hoàn' : 'Lưu note tiền dư',
    details: `${refund ? `Giữ chỗ ${fmt(value)} ETH, không thu phí lúc giữ.` : `Nhận ${fmt(leg.amount)} ETH, phí ${fmt(leg.fee)} ETH.`} Đích ${short(action.recipient)}. Tiền dư vào note: ${fmt(changeValue)} ETH.`,
    backup: newNotes, send, confirm: refund ? 'Đã lưu note · Xác nhận giữ chỗ ↗' : 'Đã lưu note · Rút ETH thử ↗' });
  feedback('Proof đã sẵn sàng. Chưa gửi giao dịch.');
}

$('operation').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    if (mode === 'deposit') draftDeposit();
    else {
      const s = await getSnapshot();
      await prepareAndSend(newAction(s), s);
    }
  });
};
async function openBackup(data) {
  const network = ETH_LABS.find((n) => n.labId === data?.chainId);
  need(network, 'Khóa không thuộc ba mạng lab hiện tại.');
  await connectNetwork(network.slug, data);
  await getSnapshot();
  await Promise.allSettled([refreshLiquidity(), refreshRoutes()]);
  feedback('Đã mở khóa note trên thiết bị. Kiểm tra địa chỉ nhận trước khi rút.');
}

$('import-key').onclick = () => run(async () => {
  let data;
  try { data = decodeNoteKey($('note-key').value); }
  catch { throw new Error('Khóa note sai phiên bản hoặc checksum. Không nhập private key ví.'); }
  finally { $('note-key').value = ''; }
  await openBackup(data);
});
$('note-key').maxLength = MAX_KEY_LENGTH;
$('note-key').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); $('import-key').click(); } };
$('note-file').onchange = () => run(async () => {
  const file = $('note-file').files[0];
  $('note-file').value = '';
  if (!file) return;
  need(file.size <= MAX_BACKUP_BYTES, 'File note vượt giới hạn kích thước.');
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('File note không hợp lệ.'); }
  await openBackup(data);
});
const stagedBackup = () => ({ ...privateBackup(context, stage.backup.notes, stage.backup.refunds),
  ...(stage.backup.routes.length ? { networkDomain: config.networkDomain, routes: stage.backup.routes } : {}) });
$('copy-note').onclick = async () => {
  if (!stage || busy) return;
  const expected = stage;
  try {
    const text = encodeNoteKey(stagedBackup());
    try {
      await navigator.clipboard.writeText(text);
      if (stage !== expected) return;
      stage.downloaded = true;
      $('copy-note').textContent = 'Đã sao chép · lưu vào nơi riêng';
    } catch {
      if (stage !== expected) return;
      $('review-key').value = text;
      $('review-key').hidden = false;
      $('saved-key').hidden = false;
      $('review-key').focus();
      $('review-key').select();
    }
    controls();
  } catch (error) { feedback(error.message, true); }
};
$('saved-key').onclick = () => {
  if (!stage) return;
  stage.downloaded = true;
  $('review-key').value = '';
  $('review-key').hidden = true;
  $('saved-key').hidden = true;
  controls();
};
$('download-note').onclick = () => {
  if (!stage) return;
  try {
    const file = new Blob([`${json(stagedBackup())}\n`], { type: 'application/json' });
    need(file.size <= MAX_BACKUP_BYTES, 'Bản sao quá lớn; tách file note trước khi tiếp tục.');
    const url = URL.createObjectURL(file);
    const a = node('a');
    a.href = url;
    a.download = `hcmtrail-eth-note-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    stage.downloaded = true;
    $('download-note').textContent = 'Tải lại note ↓';
    controls();
  } catch (e) { feedback(e.message, true); }
};
$('confirm').onclick = () => run(async () => {
  need(stage?.downloaded, 'Lưu khóa note trước khi gửi giao dịch.');
  await stage.send();
  showStage(undefined);
  await getSnapshot().catch(() => {});
});
$('discard').onclick = () => { showStage(undefined); feedback('Đã quay lại. Nếu đã gửi, kiểm tra số dư devnet; đừng xóa file note.'); };
$('continue').onclick = () => run(async () => prepareAndSend(continuation, await getSnapshot()));
$('cancel-proof').onclick = () => cancelWorker?.();
$('new-batch').onclick = () => { pickMode('smart'); select(); $('withdraw-amount').focus(); };
$('clear-selection').onclick = () => select();
for (const [i, name] of tabs.entries()) {
  $(`tab-${name}`).onclick = () => pickMode(name);
  $(`tab-${name}`).onkeydown = (event) => {
    const next = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: 2 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    pickMode(tabs[next]);
    $(`tab-${tabs[next]}`).focus();
  };
}

function updateDestinationHint(gross) {
  const text = $('destination-hint');
  const dest = across();
  const available = dest && liquidity?.get(dest.slug)?.free;
  const shortfall = gross !== undefined && available !== undefined && gross > BigInt(available);
  text.classList.toggle('short', shortfall);
  text.textContent = !dest ? 'Rút cùng mạng từ số dư note.' : available === undefined ? 'Đang đọc thanh khoản tự do tại đích…'
    : `${dest.label} còn ${fmt(available)} ETH thanh khoản tự do.${shortfall ? ' Không đủ cho khoản trước phí.' : ' Không đặt chỗ trước.'}`;
}

function updateDepositQuote() {
  const out = $('deposit-quote'), field = $('deposit-amount').value.trim();
  if (!field) { out.textContent = 'Tối thiểu 0,01 ETH trước phí. Phí 0,09% vào staking; gas thử trả riêng.'; return; }
  try {
    const gross = parseAmount(field, MIN_DEPOSIT);
    const parts = depositGrosses(gross);
    const fee = parts.reduce((v, part) => v + quoteFee(part).fee, 0n);
    out.textContent = `Nạp ${fmt(gross)} ETH · phí ${fmt(fee)} ETH · note nhận ${fmt(gross - fee)} ETH. Gas thử trả riêng.`;
  } catch (e) { out.textContent = e.message; }
}

function updateWithdrawQuote() {
  if (mode === 'deposit') return;
  const text = $('withdraw-amount-hint'), field = $('withdraw-amount').value.trim();
  updateDestinationHint();
  try {
    const rows = mode === 'solo' && live?.leaves && backup.notes.length ? spendable(live) : [];
    const available = rows.reduce((n, r) => n + r.note.value, 0n);
    if (!field && (mode === 'smart' || available === 0n)) {
      text.textContent = mode === 'smart' ? 'Mỗi lượt nhận cùng số ETH sau phí 0,09%. Giữ chỗ chưa bị tính phí.'
        : 'Để trống để dùng toàn bộ số dư note. ETH nhận đã trừ phí 0,09%, tính theo wei.';
      return;
    }
    const gross = field ? parseAmount(field) : available;
    updateDestinationHint(gross);
    const title = `Trước phí ${fmt(gross)} ETH`;
    if (mode === 'solo' && rows.length) {
      if (gross > available) { text.textContent = 'Số ETH vượt số dư note dùng được.'; return; }
      let fee = 0n, left = gross, count = 0;
      for (const { note } of rows) {
        if (left === 0n) break;
        const part = note.value < left ? note.value : left;
        fee += quoteFee(part).fee;
        left -= part;
        ++count;
      }
      text.textContent = `${title} · phí ${fmt(fee)} ETH · nhận ${fmt(gross - fee)} ETH · ${count} ${across() ? 'lệnh' : 'giao dịch rút'}. Gas thử trả riêng.`;
      return;
    }
    const { fee, net } = quoteFee(gross);
    text.textContent = `${title} · phí ${fmt(fee)} ETH · nhận ${fmt(net)} ETH. ${mode === 'smart'
      ? 'Chỉ tính khi lô chi trả.' : 'Ước tính cho một note; gas thử trả riêng.'}`;
  } catch { text.textContent = 'Nhập số ETH dương, tối đa 18 chữ số thập phân.'; }
}
$('deposit-amount').oninput = updateDepositQuote;
$('withdraw-amount').oninput = updateWithdrawQuote;
$('destination-select').onchange = () => {
  $('recipient').value = '';
  continuation = undefined;
  updateDestination();
  updateWithdrawQuote();
  controls();
  refreshLiquidity().catch(() => {});
};

function renderStaking(s) {
  if (s.chainId !== config.chainId || (stakingView && s.block < stakingView.block)) return;
  stakingView = s;
  const { epoch, position: p } = s;
  const symbol = config.stakeSymbol;
  $('staking-epoch').replaceChildren(node('i'), ` KỲ ${BigInt(epoch.epoch) + 1n}`);
  $('staking-pot').textContent = `${fmt(epoch.potWei)} ETH`;
  $('stake-active').textContent = `${fmt(p?.active ?? 0n)} ${symbol}`;
  $('claimable').textContent = `${fmt(p?.claimable ?? 0n)} ETH`;
  $('staking-date').textContent = `Chốt kỳ: ${new Date(Number(epoch.closesAt) * 1000).toLocaleString('vi-VN')} · Tổng đang stake: ${fmt(epoch.active)} ${symbol}.`;
  $('open-staking').hidden = !!p;
  $('staking-user').hidden = !p;
  if (p) {
    $('stake-account').textContent = s.address;
    $('stake-balance').textContent = fmt(s.available);
    $('stake-pending').textContent = `Kỳ sau: ${fmt(p.scheduled)} ${symbol} stake · ${fmt(p.exiting)} ${symbol} đang chờ rút · ${fmt(p.withdrawable)} ${symbol} đã mở khóa.`;
  }
  controls();
}

function stakeFeedback(text, error = false) {
  const el = $('staking-feedback');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.hidden = !text;
}

function stakeAmount() {
  try { return { amount: parseAmount($('stake-amount').value) }; }
  catch { throw new Error(`Nhập số ${config.stakeSymbol} dương, tối đa 18 chữ số thập phân.`); }
}

function doStake(action, payload = () => ({})) {
  return run(async () => {
    try {
      const fields = payload();
      stakeFeedback('Đang xác nhận trên mạng lab…');
      const s = await api('staking', { action, ...fields });
      renderStaking(s);
      stakeFeedback(action === 'open' ? 'Đã tạo ví thử riêng cho phiên này.'
        : action === 'claim' ? `Đã nhận thưởng ETH. Giao dịch ${short(s.hash)}.` : `Đã xác nhận. Giao dịch ${short(s.hash)}.`);
    } catch (e) { stakeFeedback(e.message, true); }
  });
}
$('open-staking').onclick = () => doStake('open');
for (const [button, action] of [['stake-add', 'stake'], ['stake-exit', 'exit']]) {
  $(button).onclick = () => doStake(action, stakeAmount);
}
$('stake-withdraw').onclick = () => doStake('withdraw', () => ({ amount: stakingView.position.withdrawable }));
$('claim-rewards').onclick = () => doStake('claim', () => ({ to: $('claim-recipient').value }));

async function connectNetwork(slug, data) {
  const selected = ETH_LABS.find((n) => n.slug === slug);
  need(selected, 'Mạng lab không hỗ trợ.');
  const initial = await api('config', null, slug);
  need(initial.chainId === selected.labId && initial.network === slug && initial.feeBps === FEE_BPS.toString() &&
    initial.domain === poolDomain(initial.chainId, initial.pool) && initial.lane === String(selected.lane) &&
    /^0x[0-9a-f]{64}$/.test(initial.networkDomain) && initial.releasePolicy?.releaseAllowed === false, 'Sai cấu hình mạng ETH thử.');
  // An already-running lab from before HCMT integration serves LAB only.
  const stakeSymbol = initial.stakeSymbol ?? 'LAB';
  const validToken = initial.stakeSymbol === undefined || (slug === 'ethereum'
    ? stakeSymbol === 'HCMT' && initial.stakeSupply === String(hcmtSupply)
    : stakeSymbol === 'LAB' && initial.stakeSupply === null);
  need(validToken, 'Sai cấu hình token staking lab.');
  const nextContext = { chainId: initial.chainId, pool: initial.pool, domain: initial.domain };
  let nextBackup = emptyBackup();
  if (data) {
    try {
      const read = readBackup(data, nextContext, codec);
      nextBackup = { ...read, routes: readRouteBackups(data, initial, read.notes) };
    } catch { throw new Error('Khóa note không hợp lệ hoặc thuộc phiên lab khác.'); }
  }
  const nextInterface = new Interface(initial.abi);
  const changed = config?.network !== slug || config.pool !== initial.pool;
  config = { ...initial, stakeSymbol, label: selected.label, canProve: initial.wasm && typeof JSON.rawJSON === 'function' && typeof WebAssembly === 'object' };
  context = nextContext;
  iface = nextInterface;
  backup = nextBackup;
  live = liquidity = undefined;
  queueStamp = routeStamp = undefined;
  routeViews.clear();
  routeCursor = 0;
  stakingView = undefined;
  continuation = undefined;
  if (changed) select();
  $('recoveries').hidden = true;
  $('recovery-rows').replaceChildren();
  $('note-key').value = '';
  $('note-file').value = '';
  $('note-status').textContent = 'Khóa chỉ được đọc trên thiết bị; không nhập private key của ví.';
  $('network-select').value = slug;
  $('destination-select').replaceChildren(...ETH_LABS.map((n) => {
    const opt = node('option', n.slug === slug ? `${n.label} · cùng mạng` : n.label);
    opt.value = n.slug;
    return opt;
  }));
  $('destination-select').value = slug;
  updateDestination();
  renderRoutes();
  updateWithdrawQuote();
  $('pool-address').textContent = config.pool;
  $('staking-address').textContent = config.staking;
  $('stake-symbol').textContent = stakeSymbol;
  $('stake-token-symbol').textContent = stakeSymbol;
  $('stake-token-address').textContent = config.stakeToken ?? '—';
  $('stake-amount-label').textContent = `Số ${stakeSymbol}`;
  $('open-staking').replaceChildren(`Tạo ví thử · nhận 100 ${stakeSymbol} `, node('span', '↗'));
  $('staking-token-note').textContent = stakeSymbol === 'HCMT'
    ? 'HCMT thử: 100.000 token được cấp một lần; ví thử nhận qua chuyển token, không mint thêm.'
    : 'LAB chỉ là token thử, không phải HCMT.';
  $('source').hidden = !config.wasm;
  if (changed) {
    $('recipient').value = '';
    $('claim-recipient').value = '';
    $('staking-user').hidden = true;
    stakeFeedback('');
  }
  await Promise.allSettled([refreshStaking(), ...(mode === 'solo' ? [refreshLiquidity()] : []), api('state').then(renderState)]);
  need(live, 'Không đọc được trạng thái pool mới.');
  controls();
}

$('network-select').onchange = () => run(async () => {
  try { await connectNetwork($('network-select').value); feedback(''); }
  finally { $('network-select').value = config.network; }
});

try {
  const r = await fetch('./poseidon.sol');
  need(r.ok && globalThis.crypto?.getRandomValues, 'Không thể khởi tạo trình tạo note an toàn.');
  codec = makeNoteCodec(await r.text(), (n) => crypto.getRandomValues(new Uint8Array(n)));
  await connectNetwork('ethereum');
  await poll();
} catch {
  feedback('Không khởi tạo được phiên ETH Pool mới. Hãy mở lại preview ETH Vault đang chạy. Note thử của phiên cũ không dùng ở đây.', true);
}
