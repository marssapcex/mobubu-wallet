# Các mã nguồn đã đối chiếu

Giữ các checkout tham chiếu ngoài cây ứng dụng. Ngoại lệ: [một import closure MIT của verifier Solidity và ba evaluator code chunks](../contracts/vendor/nonos/NOTICE.md) cần để build bốn vault độc lập; không lưu toolchain, cache hoặc khóa thật. Các proof vector của vault được sinh riêng từ trạng thái mô phỏng.

| Mã nguồn | Revision đã đọc | Áp dụng / không áp dụng |
| --- | --- | --- |
| [StarkEx contracts](https://github.com/starkware-libs/starkex-contracts) | [`f3b250690c5d927a6e398e9c1735d9193a643034`](https://github.com/starkware-libs/starkex-contracts/tree/f3b250690c5d927a6e398e9c1735d9193a643034) | `evm-verifier/solidity/contracts`: tham khảo cách tách Merkle/FRI/transcript và bind Cairo program. Không plug-in cho quan hệ hcmtrail. |
| [Winterfell](https://github.com/facebook/winterfell) | [`2f78ee9bf667a561bdfcdfa68668d0f9b18b8315`](https://github.com/facebook/winterfell/tree/2f78ee9bf667a561bdfcdfa68668d0f9b18b8315) | README nói rõ witness có thể rò; không chọn cho private spend. |
| [NØNOS/STARKs](https://github.com/NON-OS/STARKs) và [L1-Shield](https://github.com/NON-OS/L1-Shield) | [`a47d23ae969e23b5f841e30b49a1d483a80a6b02`](https://github.com/NON-OS/STARKs/tree/a47d23ae969e23b5f841e30b49a1d483a80a6b02) / [`9d17ad969812ed953143e5d832816a3e20dc7834`](https://github.com/NON-OS/L1-Shield/tree/9d17ad969812ed953143e5d832816a3e20dc7834) | Reference Goldilocks/DEEP-FRI kiểm trực tiếp bằng Solidity, không Groth16. Ngoài năm proof upstream, [VAULTS.md](VAULTS.md) ghi riêng các vector nạp/rút của chính vault, với compiler EVM và TVM. Chưa audit độc lập và chưa có relation đổi giá liên mạng. Xem `PARAMS.md`/`THREAT.md`: không lấy số conjectured hoặc kết quả replay làm chứng nhận hậu lượng tử. |

## Lặp lại bài kiểm STARK upstream, không fork chain

Dùng Linux x86-64, Foundry `forge` 1.4.4, `solc` EVM **native** 0.8.24 (`e11b9ed9`, SHA-256 `fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f`). Binary chính thức có trong [solc-bin](https://github.com/ethereum/solc-bin/tree/gh-pages/linux-amd64); không dùng compiler TRON ở bước này.

```sh
refs=$(mktemp -d)
git clone https://github.com/NON-OS/L1-Shield.git "$refs/l1-shield"
git -C "$refs/l1-shield" checkout --detach 9d17ad969812ed953143e5d832816a3e20dc7834
git -C "$refs/l1-shield" submodule update --init --recursive --depth 1
STARK_REFERENCE="$refs/l1-shield" SOLC_EVM=/path/to/solc npm run test:stark
```

Lệnh trên chỉ chạy `NotBeforeVerifierTest` trong checkout độc lập với FFI bị tắt, không cần RPC/khóa. Kiểm cả pin program/width; năm biến thể proof thật được chấp nhận và từ chối cùng proof khi đổi mốc `notBefore` hoặc cắt public statement. Gas suite in ra là tổng theo mỗi test chứa cả case đúng và sai, **không phải báo giá gas một giao dịch payout**. Bài kiểm không chứng minh quan hệ đổi giá/hợp đồng hcmtrail, không kiểm độ ẩn danh thực tế và không xác nhận giới hạn mainnet.
