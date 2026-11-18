import { createNote, readNote, parseAmount, formatAmount, hash, assetFor } from '/packages/pool/src/notes.mjs';
import { nativeNetwork, NATIVE_ASSET_IDS } from '/fhe-swap/src/network-catalog.mjs';

const $ = (q) => document.querySelector(q);
const dep = $('#deposit'), exit = $('#exit'), from = $('#deposit-asset'), to = $('#receive-asset');
const amount = $('#amount'), feedback = $('#feedback');
const marks = {
  ETH: 'M12 1L4 12l8 4.5 8-4.5L12 1ZM4 14l8 9 8-9-8 4.5L4 14Z',
  BNB: 'M12 2l5.5 5.5-2 2L12 6 8.5 9.5l-2-2L12 2Zm0 7.4 2.6 2.6-2.6 2.6L9.4 12 12 9.4ZM4 10l2 2-2 2-2-2 2-2Zm16 0 2 2-2 2-2-2 2-2Zm-11.5 4.5L12 18l3.5-3.5 2 2L12 22l-5.5-5.5 2-2Z',
  BTC: 'M10 2h2v2h2V2h2v2.3c2.3.6 3.7 2.1 3.7 4.1 0 1.5-.7 2.7-1.8 3.3 1.7.6 2.6 1.8 2.6 3.6 0 2.7-1.8 4.5-4.5 4.7v2h-2v-2h-2v2h-2v-2H5v-2.5h2V6.4H5V4h5V2Zm0 4.5v4.2h3.9c1.7 0 2.6-.8 2.6-2.1s-.9-2.1-2.6-2.1H10Zm0 6.5v4.5h4.3c1.8 0 2.9-.8 2.9-2.3 0-1.4-1.1-2.2-2.9-2.2H10Z',
};
let draft, imported, draftRevision = 0, importRevision = 0;
for (const id of [...NATIVE_ASSET_IDS].sort((a, b) => ['ETH','BNB','BTC'].indexOf(assetFor(a).symbol) - ['ETH','BNB','BTC'].indexOf(assetFor(b).symbol))) {
  const asset = assetFor(id), chain = nativeNetwork(asset.network);
  for (const select of [from, to]) select.add(new Option(`${asset.symbol} · ${chain.name}`, id));
  const row = document.createElement('div'), icon = document.createElement('span'), label = document.createElement('div');
  const title = document.createElement('strong'), network = document.createElement('small'), state = document.createElement('span');
  row.className = 'chain'; icon.className = 'coin ' + asset.symbol.toLowerCase(); const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const shape = document.createElementNS(svg.namespaceURI, 'path');
  svg.setAttribute('viewBox', '0 0 24 24'); shape.setAttribute('d', marks[asset.symbol]); svg.append(shape); icon.append(svg);
  icon.setAttribute('aria-hidden', 'true'); title.textContent = asset.symbol; network.textContent = chain.name;
  state.className = 'status'; state.textContent = 'Chưa mở'; label.append(title, network); row.append(icon, label, state); $('#chains').append(row);
}

function setTab(showExit) {
  for (const [key, on] of [['deposit', !showExit], ['exit', showExit]]) $(`#${key}-tab`).setAttribute('aria-pressed', on);
  dep.hidden = showExit; exit.hidden = !showExit; feedback.hidden = true;
}
$('#deposit-tab').addEventListener('click', () => setTab(false));
$('#exit-tab').addEventListener('click', () => setTab(true));
function setError(error) { feedback.textContent = error; feedback.hidden = false; }
function invalidateDraft() { draftRevision++; draft = undefined; $('#draft').hidden = true; feedback.hidden = true; }
function refreshDeposit() {
  invalidateDraft();
  const asset = assetFor(from.value);
  $('#unit').textContent = asset.symbol;
  $('#precision').textContent = `Tối đa ${asset.decimals} chữ số thập phân. Không lấy giá ở bước nạp.`;
}
from.addEventListener('change', refreshDeposit);
amount.addEventListener('input', invalidateDraft);
refreshDeposit();
dep.addEventListener('submit', async (event) => {
  event.preventDefault(); invalidateDraft();
  const revision = draftRevision;
  const button = dep.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const { id, symbol } = assetFor(from.value), value = parseAmount(amount.value, id);
    // Keep preview note domains separate from deployed vault domains.
    const domain = await hash(255, new TextEncoder().encode(id));
    const note = await createNote({ asset: id, domain, value });
    if (revision !== draftRevision) return;
    draft = note;
    $('#note-line').textContent = `${formatAmount(value, id)} ${symbol} · Chưa nạp. Giữ file note trên máy của bạn.`;
    $('#draft').hidden = false;
  } catch { if (revision === draftRevision) setError(`Nhập số dương, dùng dấu chấm, tối đa ${assetFor(from.value).decimals} chữ số sau dấu chấm.`); }
  finally { button.disabled = false; }
});
$('#download').addEventListener('click', () => {
  if (!draft) return;
  const href = URL.createObjectURL(new Blob([JSON.stringify(draft)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = href; link.download = `mobubu-preview-${assetFor(draft.asset).symbol}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1_000);
});
function refreshExit() {
  const input = $('#exit-amount'), change = $('#change-info');
  input.disabled = !imported;
  $('#exit-unit').textContent = imported ? assetFor(imported.asset).symbol : '—';
  change.textContent = '';
  if (imported && input.value) {
    try {
      const debit = parseAmount(input.value, imported.asset), left = BigInt(imported.value) - debit;
      if (left < 0n) change.textContent = 'Số lượng rút vượt số ghi trên note.';
      else if (left === 0n) change.textContent = 'Rút hết note.';
      else change.textContent = `Note thừa dự kiến: ${formatAmount(left, imported.asset)} ${assetFor(imported.asset).symbol}.`;
    } catch { change.textContent = 'Nhập số lượng dương đúng độ chính xác của coin.'; }
  }
  $('#exit-hint').textContent = !imported ? 'Đọc file note trước để chọn cách rút.' : imported.asset === to.value
    ? 'Cùng mạng: không đổi giá. Cần proof hợp lệ trước khi chi.'
    : 'Khác mạng: chỉ lấy báo giá khi rút. Preview không lấy giá hoặc gửi lệnh.';
}
$('#note-file').addEventListener('change', async () => {
  const revision = ++importRevision;
  feedback.hidden = true;
  imported = undefined;
  $('#exit-amount').value = '';
  refreshExit();
  const file = $('#note-file').files[0];
  if (!file) { $('#note-info').textContent = 'File chỉ được đọc trên thiết bị này.'; refreshExit(); return; }
  try {
    if (file.size > 4096) throw new Error();
    const note = await readNote(JSON.parse(await file.text()));
    if (revision !== importRevision) return;
    imported = note;
    const { symbol } = assetFor(imported.asset);
    $('#note-info').textContent = `${formatAmount(imported.value, imported.asset)} ${symbol} ghi trên note · chưa xác nhận tiền nạp.`;
    to.value = imported.asset;
  } catch { if (revision !== importRevision) return; $('#note-info').textContent = 'Không đọc được note.'; setError('Chọn đúng file note đã tạo bằng Mobubu.'); }
  refreshExit();
});
to.addEventListener('change', refreshExit);
$('#exit-amount').addEventListener('input', refreshExit);
exit.addEventListener('submit', (event) => event.preventDefault());
refreshExit();
