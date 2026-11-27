# Handoff phần zk-STARK — cái gì còn phải viết, cái gì không

Ngày: 2026-11-18 · Nhánh `arena/32000e7e-mobubu-wallet`

Mục đích: Solidity đã xong, người viết tiếp phần zk-STARK cần biết **chính xác** ranh giới
nào đang bị ghim, đổi cái gì thì phải sửa mấy phía, và số đo nào dùng để biết mình không
làm hỏng. Mọi con số ở đây đã kiểm bằng hash hoặc bằng test chạy được, không phải suy đoán.

## 1. Trạng thái hiện tại (đã khớp upstream, không phải "gần đúng")

Đối chiếu với `NON-OS/L1-Shield@9d17ad96` và `NON-OS/STARKs@a47d23ae`:

| Thứ đang ghim | Giá trị trong repo này | Trùng với |
| --- | --- | --- |
| `NativeStark.STARK_IMAGE` | `0x4364151e…2429` | `L1-Shield/deployments/sepolia.env` → `PRODUCTION_IMAGE_HASH` |
| `NativeStark.STARK_PARAMS` | `0xccba76ed…eadb5` | `L1-Shield/spec/not-before/params.json` → `A` |
| `vendor/nonos/*.sol`, `chunk0..2.hex` | sha256 | `contracts/shield/`, `spec/not-before/` (byte-identical) |
| Public words (37 limb) | `EthPoolState._consume` | `spec/not-before/transfer-eth-shape1/publics.json` |
| Commitment | `NativeNoteDeposits.commitment` | `ShieldedPool._computeCommitmentWith` |
| Prover | `build/eth-pool/prover.wasm` | build từ `nox_prover` cùng commit |

Statement đang dùng là **join-split 2-vào/2-ra** (`stark_proofs/src/shield/join/`), gọi là
`transfer-eth-shape1`, shape **A**; `not_before` chỉ là word 37. **Không phải** statement yếu.

## 2. Bốn ranh giới giao diện (đổi một cái là phải sửa cả bốn)

1. **Solidity ↔ verifier**: `EthPoolState._verifyNote(bytes proof, uint256[37] words)`.
   Words theo đúng thứ tự: root(4) · assocRoot(4) · nf0(4) · nf1(4) · cm0(4) · cm1(4) ·
   amount · fee · asset · price · recipient(4) · feeRecipient(4) · notBefore.
2. **Verifier ↔ image**: `NativeStark` ghim `STARK_IMAGE`, `STARK_PARAMS`, header
   `0x4e4f585007000100` (NOXP, format 7), và **offset byte tuyệt đối** cho đúng một shape
   (19 query, 59 periodic). `MAX_PROOF_BYTES = 128_000`.
3. **JS ↔ wasm**: `pool/protocol.mjs::prepareProof` tạo `plan.request` (16 khoá) + `plan.seed`
   + `expectedNullifier`; `pool/wasm.mjs` chỉ chuyển bytes; worker không đọc gì khác.
   wasm export `memory/alloc/prove`, import duy nhất `hcmtrail.progress`.
4. **wasm ↔ engine**: shim `pool/prover-wasm.rs` gọi `nox_prover::{prove_with, prove_keeping_cache}`.

## 3. Việc còn lại, chia ba mức

### Mức 1 — không đụng zk (việc của Solidity)

- Vòng root hữu hạn thay `knownRoot` vĩnh viễn (F-7, ~40 dòng).
- Root association / `AmountPolicy` / phí 9 bps: quyết định sản phẩm.
- Gas: 8.238.300 → mục tiêu ~3.860.000 (số upstream cho cùng shape). Ba nghi phạm đã nêu:
  gọi evaluator trực tiếp thay `StarkProofReader.verifyBatch`, 2 `_append` riêng thay
  `_insertLeavesDeferred`, `_spaceFor(2)` copy witness.

### Mức 2 — đụng build, không đụng AIR (1–3 ngày)

- Đổi **feature/cfg** khi build (`fri8`, `radix8`, `digest32`, `std`, `not_before`) nếu muốn
  build `claim` hoặc bật ràng buộc ownership (`output_spend_pk` thay `self_submit`).
- Nếu shape đổi (ví dụ 18 query thay 19): phải tính lại `HEAD_END`, `TAIL_START`,
  `CLAIMS_START`, `MIN_PROOF_BYTES` trong `NativeStark` — sai một offset là mọi proof bị
  `InvalidStarkProof`.
- Sau khi build: chạy lại `npm run test:pool:key` (verify thật trên EVM) và
  `PROVER_BROWSER=1 npm run test:prover:browser` (worker thật).

### Mức 3 — viết zk-STARK thật (statement mới; nhiều tuần)

Chỉ làm khi cần statement khác hẳn (ví dụ: batch nhiều intent trong một proof như
`settleBatch` của họ, hoặc chứng minh luật 9 bps). Phải sửa **trong repo upstream**, không
phải repo này:

1. AIR/circuit: `stark_proofs/src/shield/join/{shape,publics,notes,intent,pool}.rs`
   (hoặc `stark_proofs/src/shield/batch/` nếu làm batch).
2. Witness/host: `stark_proofs/src/host/spend.rs`.
3. Prover API + policy: `nox_prover/src/{api,proof,policy}.rs`.
4. Đóng băng publics: `PublicWords` phía Solidity (`INTENT_WORDS` 11/12/13 tương ứng
   layout 31/35/37 limb) và bảng offset trong `NativeStark`.
5. Sinh lại bộ ghim: `program.bin`, `image.bin`, `blob0/1.bin`, `params.json`, `meta.json`
   (mẫu: `L1-Shield/spec/not-before/`), rồi cập nhật `STARK_IMAGE`/`STARK_PARAMS` và
   `chunk0..2.hex`.
6. Vector chuẩn: một bộ `request.json` + `publics.json` + `proof.bin` như
   `transfer-eth-shape1/` để test không cần prover.

Điều kiện kỹ thuật bắt buộc khi viết mức 3: soundness ≥ 80 bit (`SOUNDNESS_FLOOR_BITS`),
proof ≤ `MAX_PROOF_BYTES` 128.000 B, `not_before` phải nằm trên lưới 600 s, và số word mỗi
intent phải khớp tuyệt đối với bảng offset đã ghim.

## 4. Bẫy đã gặp, đừng lặp lại

1. `rustc` phải **đúng 1.88.0** + target `wasm32-unknown-unknown`; script từ chối mọi bản khác.
   Sandbox hiện tại **không có rustc** nên không build lại được — binary đang dùng là bản build sẵn.
2. `proof-worker.mjs` fetch `./prover.wasm` **tương đối theo URL của worker**
   (`/apps/eth-pool/prover.wasm`), không phải theo gốc site. Thiếu alias là worker chỉ trả
   một câu lỗi chung, không nói lý do.
3. `catch` trong worker nuốt mọi exception (để không lộ witness). Khi debug phải dùng bản vá
   riêng, đừng sửa file production rồi commit.
4. Prover chậm: **343,8 s** cho một proof trong Chromium headless, **95.656 B**. Đổi statement
   làm proof to hơn có thể vượt giới hạn gas block, không chỉ vượt 128 KB.
5. `public_amount` nằm trong publics ⇒ **mệnh giá lộ**. Muốn anonymity set lớn phải ép mệnh
   giá (`AmountPolicy` của họ: 1, 2, 5 × 10ⁿ) hoặc chuyển sang batch settlement.

## 5. Definition of done cho mỗi lần đổi

```bash
# 1. hash ghim không đổi (hoặc đã cập nhật có chủ ý)
sha256sum contracts/vendor/nonos/chunk*.hex | cut -c1-16

# 2. Solidity vẫn xanh
./build/audit/bin/forge test --offline --use "$PWD/build/audit/bin/solc" --threads 1 \
  --no-match-contract '^StatefulInvariantTest$' --summary      # 34 test

# 3. verifier thật vẫn nhận proof thật
npm run test:pool:key          # ~330 s, proof ~95 KB, withdraw ~8,2 M gas

# 4. worker trong trình duyệt thật vẫn chạy
PROVER_BROWSER=1 CHROMIUM_LIBS=<libnss> npm run test:prover:browser

# 5. JS suite
npm test                       # 22 test
```

## 6. Hai điều không phải viết lại

- Engine `nonos-stark` / `nox_prover` / `nox_verify_wasm`: đã có, AGPL-3.0.
- Verifier Solidity + Poseidon + chunk: đã có, MIT, đã ghim hash.

Viết lại hai thứ đó chỉ có nghĩa nếu muốn thoát AGPL hoặc đổi sang proof system khác
(Groth16/Plonky3…), và khi đó mọi pin/offset/test ở trên đều phải làm lại từ đầu.
