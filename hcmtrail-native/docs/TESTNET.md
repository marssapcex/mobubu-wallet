# Runbook · nạp/rút native STARK trên testnet

**Chỉ dùng coin faucet, ví testnet riêng và máy của bạn. Chưa audit; không dùng mainnet.** Đây là CLI chạy cục bộ cho nạp/rút **trên cùng một mạng**, không phải swap. FHE, Chainlink, bridge và chữ ký của operator không có quyền cấp tiền. Không có service giữ khóa, admin cứu tiền, proxy hay sweep. Hợp đồng bất biến; lỗi có thể làm mất cả tiền test.

Runbook này mặc định **profile gốc không phí giao thức** (`deploy`). Với phí 0,25%, stake HCMT và broadcaster trả gas, dùng [runbook HCMT riêng](HCMT-TESTNET.md) và `dao-deploy`; các thiết lập RPC/prover ở §1–2 vẫn áp dụng.

| `ASSET` | Chain ID bắt buộc | Contract | Đơn vị nhập CLI | RPC yêu cầu |
| --- | ---: | --- | --- | --- |
| `ETH` | `11155111` | `SepoliaVault` | wei (18 số thập phân) | Sepolia JSON-RPC có `eth_getLogs`, `eth_estimateGas` và đọc block lịch sử |
| `BNB` | `97` | `BscTestnetVault` | wei (18) | BSC testnet JSON-RPC có log và đọc state theo block |
| `TRX` | `3448148188` (`0xcd8690dc`) | `NileVault` | sun (6) | Nile base URL phục vụ cả `/jsonrpc`, `/wallet` và `/walletsolidity` trên cùng chain |
| `HYPE` | `998` | `HyperEvmTestnetVault` | wei (18) | HyperEVM testnet JSON-RPC có `eth_usingBigBlocks`, `eth_bigBlockGasPrice`, log từng tối đa 50 block |

CLI từ chối chain ID khác **trước khi ký**; constructor và đường chuyển trạng thái cũng kiểm ID. Domain gồm ID, địa chỉ, asset và STARK image. Thay RPC sang testnet không làm các wrapper mainnet cũ chạy được. `npm run build:testnet` tạo artifacts riêng (`build/evm/testnet-vaults`); `-- --tvm` dùng compiler TVM và tạo `build/tvm/testnet-vaults`. Các wrapper cũ và bốn vector hồi quy vẫn được test.

## 1. Cài và chạy kiểm tra cục bộ

Linux x86-64, Node `>=22.13`, Git, `cc`, `ar`, GNU coreutils, `curl`, `jq`, Rust 1.88.0. Dành **ít nhất 4 GB RAM khả dụng** cho một prover; chạy từng proof một. Proof dùng entropy hệ điều hành, nên byte, kích thước và thời gian grind có thể khác mỗi lần. Có thể mất vài đến nhiều phút; không hứa độ trễ realtime.

```bash
cd hcmtrail-native                   # hoặc thư mục source archive đã giải nén
npm ci --ignore-scripts
npm audit --audit-level=moderate

umask 077
mkdir -p "$HOME/hcmtrail-testnet/tools"
bash scripts/fetch-tron-solc.sh "$HOME/hcmtrail-testnet/tools/tron-solc"
export TRON_SOLC="$HOME/hcmtrail-testnet/tools/tron-solc"

rustup toolchain install 1.88.0 --profile minimal
export RUSTC="$(rustup which --toolchain 1.88.0 rustc)"
export NATIVE_STARK_PROVER_DIR="$HOME/hcmtrail-testnet/tools/prover"
# Dùng thư mục cài mới, không ghi đè bản đã có:
bash scripts/build-testnet-prover.sh "$NATIVE_STARK_PROVER_DIR"

npm run build:testnet
npm run build:testnet -- --tvm
npm run test:testnet
# Chạy STARK thật từ note vừa nạp trong EDR/TVMJS, không truy cập RPC thật:
NATIVE_TESTNET_ASSETS=ETH npm run test:testnet:fresh
# Bỏ NATIVE_TESTNET_ASSETS để chạy cả 4 domain (lâu hơn).
```

Builder lấy đúng [NON-OS `a47d23a`](https://github.com/NON-OS/STARKs/tree/a47d23ae969e23b5f841e30b49a1d483a80a6b02) (AGPL-3.0-or-later) và [BLAKE3 `f3149ec`](https://github.com/BLAKE3-team/BLAKE3/tree/f3149ec5bb5449af877ba20377a11008ff499fa2) (1.8.7). Bản tái lập chạy `rustc 1.88.0` release optimization với BLAKE3 C portable qua shim nhỏ, không sửa circuit, không dùng `RUSTC_BOOTSTRAP`. `nox_bench` tạo STARK `not_before/fri8/radix8/digest32`, `nox_share` xác minh rồi xuất format 7. `prover.json` lưu commit, phiên bản và SHA-256 hai binary; chỉ chạy binary tự build và tin cậy. Bộ cài chép giấy phép; nếu phân phối binary prover, xem nghĩa vụ cung cấp nguồn và giấy phép tương ứng. Archive này **không phân phối binary AGPL**.

## 2. Chọn mạng và ngân sách

Một thư mục state **nằm ngoài checkout** cho mỗi deployment. Tạo ví gas testnet riêng; dùng ứng dụng ví tin cậy tạo khóa và lưu bằng trình soạn thảo vào file **chmod 600** trên máy của bạn. Nội dung chỉ một khóa 32 byte dạng hex (có thể có `0x`). Không viết khóa trong lệnh shell, Git, chat, RPC URL hoặc `.env` của repo. Không chia sẻ file này. Với CLI này, không ký giao dịch khác từ cùng signer trong khi còn giao dịch chưa xác minh.

Ví dụ Sepolia; chọn RPC và địa chỉ bạn kiểm soát. Các cap dưới đây là **ví dụ cấu hình**, không phải báo giá hay cam kết đủ coin.

```bash
export ASSET=ETH
export NATIVE_RPC_URL='https://YOUR-SEPOLIA-RPC'
export NATIVE_STATE_DIR="$HOME/hcmtrail-testnet/sepolia-1"
export NATIVE_SIGNER_FILE="$HOME/hcmtrail-testnet/sepolia-test.key"
export NATIVE_GAS_PRICE_CAP_WEI=10000000000  # trần giá gas do bạn chọn, ví dụ 10 gwei
export NATIVE_CONFIRMATIONS=8               # bỏ để dùng mặc định theo mạng

tn() { npm run --silent testnet -- "$ASSET" "$@"; }
```

- **EVM:** `NATIVE_EVM_GAS_CAP` mặc định và tối đa `16777216`. Ước tính có dư 10% (không quá cap), kiểm balance cho `value + gasLimit × gasPrice` trước ký. Mặc định xác nhận theo độ sâu 8 (ETH) / 12 (BNB/HYPE); depth **không phải** chứng minh finality. `NATIVE_EVM_FINALIZED_TAG=1` yêu cầu RPC có tag `finalized` và chờ lâu hơn. Dùng cùng policy khi deploy, recover và rút. `NATIVE_WAIT_SECONDS` mặc định 1200, `NATIVE_RPC_TIMEOUT_SECONDS` mặc định 60.
- **Nile:** `ASSET=TRX`, `NATIVE_RPC_URL=https://nile.trongrid.io` (không thêm `/jsonrpc`), `TRON_SOLC` như bước 1. Có thể cung cấp `TRON_PRO_API_KEY` qua môi trường **máy riêng** nếu endpoint yêu cầu; không ghi vào repo/audit. Signer/recipient test nên là tài khoản Nile đã kích hoạt. Bắt buộc đặt `NATIVE_TRON_FEE_LIMIT_SUN` dương, không vượt `15000000000` sun (15.000 TRX); **tự chọn** theo test budget. Ước lượng từ native constant call, đọc giá Energy và resource khả dụng. Code yêu cầu `energyEstimate × sunPerEnergy <= feeLimit` kể cả khi có Energy stake. Balance phải trả được phần chưa stake, ngoài call value; Bandwidth và dynamic Energy còn có thể phát sinh. Simulate không cam kết được admit, CPU, phí hay Energy thực. Dùng signer có đủ coin faucet/được cấp Energy, đo từng tx; nếu RPC không cho mô phỏng create hoặc proof lớn, đổi sang Nile node hỗ trợ, không bỏ bước kiểm. Client dựng TAPOS, protobuf và ký cục bộ; nhận biên nhận chỉ khi `walletsolidity` trả cả tx và kết quả `SUCCESS`. Không gửi TRX bằng `eth_sendRawTransaction`.
- **HyperEVM testnet:** `ASSET=HYPE`, `NATIVE_RPC_URL=https://rpc.hyperliquid-testnet.xyz/evm` hoặc RPC testnet tương thích. Trước deploy/withdraw dùng công cụ HyperCore testnet gửi `{"type":"evmUserModify","usingBigBlocks":true}` cho **mỗi địa chỉ ký** (hàm [`use_big_blocks(true)` của SDK chính thức](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/hyperliquid/exchange.py), cấu hình `TESTNET_API_URL`). Cần tài khoản Core đã tồn tại. CLI đọc cờ qua RPC, lấy giá block lớn và từ chối gửi nếu chưa bật. Fast block 3M theo [tài liệu](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture) không phù hợp stack này. Chờ large block; đo bằng receipt thật. Không đổi cờ khi tx còn pending. [Các RPC được hỗ trợ](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc) chỉ cho đọc latest state trên endpoint tham chiếu.

## 3. Deploy → nạp → rút thử một phần → dùng change

```bash
tn deploy                 # 6 tx: prepare, walk, 3 chunk và vault (tự tạo evaluator/Poseidon)
tn inspect                # xác nhận manifest và runtime, chain/asset, domain/leaf 0

# Ví dụ 0,001 coin EVM; với TRX thay bằng 1000000 (1 TRX).
DEPOSIT_BASE=1000000000000000
PAYOUT_BASE=400000000000000  # với TRX: 400000
REST_BASE=600000000000000    # với TRX: 600000
TO='0xYOUR_TESTNET_RECIPIENT' # địa chỉ thật, nên là EOA khác signer; TRX nhận cả Base58/41-hex

NOTE=$(tn note-new "$DEPOSIT_BASE" | jq -er .note)
# Sao lưu file note-$NOTE.json + manifest.json qua kênh riêng/mã hóa TRƯỚC khi nạp.
tn deposit "$NOTE"
tn recover "$NOTE"                    # có thể thêm TX_ID nếu indexer không đủ log

PLAN=$(tn prove "$NOTE" "$PAYOUT_BASE" "$TO")
EXIT=$(jq -er .exitId <<<"$PLAN")
CHANGE=$(jq -er .changeNote <<<"$PLAN")
# Sao lưu note-$CHANGE.json; chưa thấy change leaf trên chain cho đến khi rút thành công.
tn preflight "$EXIT"                  # thử verifier/payout; không broadcast
tn inspect                            # lưu snapshot vault; đo riêng balance recipient trên node/explorer
tn withdraw "$EXIT"                   # đối chiếu recipient, amount, cả hai nullifier và hai leaf change
tn recover-exit "$EXIT"                # không gửi thêm giao dịch
tn preflight "$EXIT"                  # PHẢI báo AlreadySpent; không cần cố đốt gas để kiểm replay

tn recover "$CHANGE"
TAIL=$(tn prove "$CHANGE" "$REST_BASE" "$TO" | jq -er .exitId)
tn preflight "$TAIL"
tn withdraw "$TAIL"
tn inspect                             # một mình bạn dùng vault: accountedNative về 0
```

`note-new` dùng Poseidon local và các limb ngẫu nhiên canonical. `deposit` chỉ gửi commitment công khai và value; không gửi key/blinding/spend public-key preimage lên node. Không chuyển native thẳng vào địa chỉ vault. `prove` đọc biên nhận, trang log từ block deploy, kiểm index liên tiếp và tự tái tạo root sâu 32 với leaf domain số 0. Neo tại `RootPublished` trong biên nhận đã xác nhận, so với `knownRoot`; trên Sepolia/BSC còn đối chiếu `leafCount/currentRoot` theo block. Nile/HyperEVM không phụ thuộc historic `eth_call`: nếu RPC bỏ **cả đuôi** log, một root cũ hợp lệ vẫn có thể dùng khi note đã nằm trong đó. RPC sai hoặc thiếu dữ liệu có thể chặn rút. Chỉ dùng endpoint tin cậy; công cụ này không chạy light client/finality proof.

Profile CLI dùng **một input funded + một dummy**, phí giao thức bằng 0, lượng rút tùy chọn không quá note; phí gas/Energy vẫn do signer trả. Với phần dư dương, CLI kiểm quyền mở change rồi fsync note **trước** khi xuất proof. `preflight` gửi proof **công khai** vào RPC mô phỏng; node hoặc bên thấy proof có thể relay trước bạn, nhưng không đổi được payout. Khi đó dùng `recover-exit` thay vì tạo tx khác. Không có đảm bảo ẩn danh: amount, payout, timing và sender là công khai; query nullifier/membership và IP có thể liên kết qua RPC. JS BigInt không constant-time. Scratch của prover là file riêng cục bộ, không RPC. Dùng disk mã hóa, giữ riêng `note-*`, `plan-*`, `tx-*`, khóa signer và mọi `scratch-*`; xóa scratch vụ crash chỉ sau khi chắc chắn prover đã dừng. Không có mnemonic recovery từ địa chỉ gas; **mất opening là mất note**.

## 4. Khôi phục và lấy bằng chứng audit

- `tx-*.json` ghi bền vững giao dịch ký và ID trước broadcast. Timeout/đứt mạng **không** có nghĩa là tx thất bại. Làm lại đúng lệnh dùng lại **cùng byte giao dịch**, hoặc dùng `recover`/`recover-exit` với ID từ stderr/explorer. Không nạp lại bằng note mới chỉ vì RPC chưa trả receipt. `wallet.lock` còn lại sau crash: kiểm tiến trình CLI/prover đã dừng rồi mới xóa thư mục lock rỗng. Không xóa state để “thử lại”.
- Nếu khôi phục từ backup, chép manifest + note riêng vào state `0700`, kiểm `tn inspect` đúng domain. Với note nạp, `recover NOTE [TX_ID]` kiểm `Deposited`, leaf, amount và root trong receipt. Note change giữ public exit của cha, có thể dùng `recover CHANGE [TX_ID]` ngay cả khi mất file proof/index (cần vẫn có **opening** change). Giao dịch thay thế ở cùng nonce, khác hash hoặc nhiều nạp trùng commitment cần đối soát thủ công; CLI không tự chọn một vị trí khác.
- Giao dịch đã **confirmed failed**: không có nạp/rút hoặc change thành công. Sửa cấu hình trước; với rút, nếu cả hai nullifier chưa spent, đối soát rồi tạo proof mới từ note gốc. Không xóa proof/backup của một lần gửi chưa rõ kết quả. Nile TAPOS hết hạn hoặc EVM phí quá thấp: không tự tăng phí, đổi nonce hay ký một tx mới. Đối soát trạng thái ở node đáng tin và explorer; với deploy thử nghiệm chưa có tiền có thể tạo state/deployment mới sau khi xác minh tình trạng. Không có đường override verifier dù node từ chối.
- **Đưa cho auditor:** commit/source archive + checksum; compiler/version/settings, build ID trong manifest, stack địa chỉ + bytecode pins, `prover.json`, manifest và tx IDs/receipt công khai cho cả bốn mạng. Ghi `signedBytes`, proof SHA-256/bytes, chain/block hash, độ sâu/solidified, gasUsed/effectiveGasPrice hoặc Energy/Bandwidth/fee/CPU lỗi, balance recipient trước/sau (trừ phí nếu dùng chung signer), kiểm replay và kết quả chi change. `exit-*.json` chỉ chứa public proof/exit; chỉ gửi sau khi đã đối soát, không gửi note/witness/raw journal hoặc khóa. Có thể tự tái lập audit offline bằng `npm run test:testnet:fresh`.

**Cổng live trước khi chốt bản để audit:** dựng stack trên **từng testnet**; đủ receipt và runtime; nạp đã xác nhận; preflight và payout proof đúng; replay bị từ chối; khôi phục change và rút nốt; đo giới hạn thực, đặc biệt HyperEVM large-block và Nile Energy/CPU/byte admission/solidified. [TESTNET-RESULTS.md](TESTNET-RESULTS.md) tách số đo local khỏi các cổng còn mở. “Đưa đi audit được” không có nghĩa đã audit, đạt chuẩn mainnet, ẩn danh hay hậu lượng tử. [VAULTS.md](VAULTS.md) mô tả rủi ro giao thức.
