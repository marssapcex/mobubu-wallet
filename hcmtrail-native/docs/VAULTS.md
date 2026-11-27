# Verifier chi note ETH — pin của lab

Một mã [ETH pool](ETH-POOL.md) chạy trên ba VM có cây note độc lập và [quyết toán liên mạng](ETH-CLEARING.md) chỉ bằng thông điệp. **Không phát hành tiền thật.** Staking là hợp đồng riêng nhận phí ETH, không cấp quyền chi note.

- Commitment và Merkle tree dùng Poseidon Goldilocks; mỗi deployment có cây riêng. `NativeNoteDepositsCore` chỉ nhận ETH (asset = 0); nạp lô cộng đúng `msg.value` sau phí. Join–split kiểm bảo toàn theo số nguyên qua 37 public limbs, root do pool công bố, nullifier, change, miền chế độ, hai trường địa chỉ và `notBefore`. Rút riêng ràng buộc địa chỉ staking bất biến cùng đúng mức phí trong public limbs.
- [`NativeStark.sol`](../contracts/vault/NativeStark.sol) kiểm NOXP format 7, protocol 1, tối đa 128.000 byte, image `4364151e9f54797f3bbf9c8d28465f5a7dcf8ca1aafa9c9b48eb43cedf4e2429`, params `ccba76ed5748b5ee54dfd62935fd1d10998b5c0f84e35a9dc899905cfb1eadb5`. Upstream công bố khoảng 80,1 bit cổ điển ở vòng fold giới hạn, không phải chuẩn >=256 bit. HCFR v2 không thay verifier.
- Dựng `PrepareNb_A` → `WalkNb_A(prepare)`, ba chunk runtime, `NbStraightEvaluatorAt(chunks)`, và `PoseidonGoldilocks` riêng. Pool ghim hash của prepare và Poseidon, template walk và **cả hai** liên kết prepare, template evaluator và **cả sáu** vị trí liên kết chunk cùng hash của từng chunk. Không chấp nhận một getter khai báo thay cho kiểm bytecode. Tách evaluator khỏi initcode pool để giữ dưới EIP-3860. Compiler solc 0.8.24, Paris, optimizer 200, metadata bytecode hash `none`. Lệnh `node hcmtrail-native/scripts/build-vault.mjs --pins` in template hash/offset.
- [Notice và giấy phép](../contracts/vendor/nonos/NOTICE.md) ghim verifier L1-Shield và prover NON-OS. Không có admin, proxy nâng cấp hay key dùng để ghi quyền chi.

Dùng [WASM local và test](ETH-POOL.md). `POOL_PERIODIC_CACHE` chỉ nhận tham số công khai đúng circuit; không copy cache vào note. [Chỉ mục mã hợp đồng](CONTRACTS.md) tách riêng verifier lab và FRI nghiên cứu.
