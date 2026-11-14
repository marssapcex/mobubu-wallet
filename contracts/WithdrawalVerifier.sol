// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title WithdrawalVerifier
 * @dev Groth16 SNARK verifier cho circuit Withdraw (Circom 2).
 *      Cấu trúc chuẩn từ `snarkjs zkey export solidityverifier`.
 *      Sau khi chạy trusted setup + export real zkey, thay verifyingKey bằng
 *      giá trị thực từ verification_key.json.
 */
contract WithdrawalVerifier {
    using Pairing for *;

    uint256 constant SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant PRIME_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    struct G1Point {
        uint256 X;
        uint256 Y;
    }

    struct G2Point {
        uint256[2] X;
        uint256[2] Y;
    }

    struct VerifyingKey {
        G1Point alfa1;
        G2Point beta2;
        G2Point gamma2;
        G2Point delta2;
        G1Point[] IC;
    }

    struct Proof {
        G1Point A;
        G2Point B;
        G1Point C;
    }

    // =========================================================================
    // Pairing library (bn128, precompiles 6,7,8)
    // =========================================================================
    library Pairing {
        function negate(G1Point memory p) internal pure returns (G1Point memory) {
            if (p.X == 0 && p.Y == 0) return G1Point(0, 0);
            return G1Point(p.X, PRIME_Q - (p.Y % PRIME_Q));
        }

        function plus(G1Point memory p1, G1Point memory p2) internal view returns (G1Point memory r) {
            uint256[4] memory input = [p1.X, p1.Y, p2.X, p2.Y];
            bool success;
            assembly {
                success := staticcall(sub(gas(), 2000), 6, input, 0xc0, r, 0x60)
            }
            require(success, "pairing-add-failed");
        }

        function scalar_mul(G1Point memory p, uint256 s) internal view returns (G1Point memory r) {
            uint256[3] memory input = [p.X, p.Y, s];
            bool success;
            assembly {
                success := staticcall(sub(gas(), 2000), 7, input, 0x80, r, 0x60)
            }
            require(success, "pairing-mul-failed");
        }

        function pairing(
            G1Point memory a1, G2Point memory a2,
            G1Point memory b1, G2Point memory b2,
            G1Point memory c1, G2Point memory c2,
            G1Point memory d1, G2Point memory d2
        ) internal view returns (bool) {
            G1Point[4] memory p1 = [a1, b1, c1, d1];
            G2Point[4] memory p2 = [a2, b2, c2, d2];

            uint256 inputSize = 24;
            uint256[] memory input = new uint256[](inputSize);
            for (uint256 i = 0; i < 4; i++) {
                uint256 j = i * 6;
                input[j + 0] = p1[i].X;
                input[j + 1] = p1[i].Y;
                input[j + 2] = p2[i].X[0];
                input[j + 3] = p2[i].X[1];
                input[j + 4] = p2[i].Y[0];
                input[j + 5] = p2[i].Y[1];
            }

            uint256[1] memory out;
            bool success;
            assembly {
                success := staticcall(sub(gas(), 2000), 8, add(input, 0x20), mul(inputSize, 0x20), out, 0x20)
            }
            require(success, "pairing-opcode-failed");
            return out[0] != 0;
        }
    }

    // =========================================================================
    // Verifying key (PLACEHOLDER - thay bằng giá trị thực từ snarkjs)
    // =========================================================================
    function verifyingKey() internal pure returns (VerifyingKey memory vk) {
        // TODO: Thay bằng verifying key thực từ file verification_key.json
        // Ví dụ cấu trúc từ snarkjs export:
        vk.alfa1 = G1Point(
            0x16c238e9d9a2e2c8b7f1d3e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5,
            0x2f1e3d4c5b6a79887766554433221100ffeeddccbbaa99887766554433221100
        );
        vk.beta2 = G2Point(
            [
                0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef,
                0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321
            ],
            [
                0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789,
                0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba
            ]
        );
        vk.gamma2 = G2Point(
            [
                0x1111111111111111111111111111111111111111111111111111111111111111,
                0x2222222222222222222222222222222222222222222222222222222222222222
            ],
            [
                0x3333333333333333333333333333333333333333333333333333333333333333,
                0x4444444444444444444444444444444444444444444444444444444444444444
            ]
        );
        vk.delta2 = G2Point(
            [
                0x5555555555555555555555555555555555555555555555555555555555555555,
                0x6666666666666666666666666666666666666666666666666666666666666666
            ],
            [
                0x7777777777777777777777777777777777777777777777777777777777777777,
                0x8888888888888888888888888888888888888888888888888888888888888888
            ]
        );
        // IC[0..6] - 7 public inputs: root, nullifierHash, recipient, relayer, fee, amount, (padding)
        vk.IC = new G1Point[](7);
        for (uint i = 0; i < 7; i++) {
            vk.IC[i] = G1Point(
                uint256(keccak256(abi.encodePacked("IC", i))) % PRIME_Q,
                uint256(keccak256(abi.encodePacked("ICY", i))) % PRIME_Q
            );
        }
    }

    /**
     * @dev Verify Groth16 proof.
     * @param proof     Serialized proof [A.x, A.y, B.x0, B.x1, B.y0, B.y1, C.x, C.y]
     * @param inputs    Public signals [root, nullifierHash, recipient, relayer, fee, amount]
     */
    function verifyProof(
        bytes calldata proof,
        uint256[] calldata inputs
    ) public view returns (bool) {
        require(inputs.length == 6, "VV: expected 6 public inputs");
        for (uint i = 0; i < inputs.length; i++) {
            require(inputs[i] < SNARK_SCALAR_FIELD, "VV: input >= scalar field");
        }

        // Decode proof (8 uint256 packed in 64 bytes)
        require(proof.length == 64, "VV: proof must be 64 bytes");
        uint256[8] memory p;
        assembly {
            p[0] := and(div(calldataload(add(proof, 0)), 0x1000000000000000000000000000000000000000000000000000000000000000), 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)
            // Simplified: use calldata copy for proper decoding in production
        }
        // Proper decoding using abi.decode for clarity
        (uint256 p0, uint256 p1, uint256 p2, uint256 p3, uint256 p4, uint256 p5, uint256 p6, uint256 p7) =
            abi.decode(proof, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
        p[0] = p0; p[1] = p1; p[2] = p2; p[3] = p3; p[4] = p4; p[5] = p5; p[6] = p6; p[7] = p7;

        // Validate proof points are on curve (simplified: check < PRIME_Q)
        for (uint i = 0; i < 8; i++) {
            require(p[i] < PRIME_Q, "VV: proof element >= prime q");
        }

        Proof memory _proof;
        _proof.A = G1Point(p[0], p[1]);
        _proof.B = G2Point([p[2], p[3]], [p[4], p[5]]);
        _proof.C = G1Point(p[6], p[7]);

        VerifyingKey memory vk = verifyingKey();

        // Compute vk_x = IC[0] + sum(inputs[i] * IC[i+1])
        G1Point memory vk_x = Pairing.plus(G1Point(0, 0), vk.IC[0]);
        for (uint i = 0; i < inputs.length; i++) {
            vk_x = Pairing.plus(vk_x, Pairing.scalar_mul(vk.IC[i + 1], inputs[i]));
        }

        // Groth16 verification: e(-A, B) * e(alfa1, beta2) * e(vk_x, gamma2) * e(C, delta2) == 1
        return Pairing.pairing(
            Pairing.negate(_proof.A),
            _proof.B,
            vk.alfa1,
            vk.beta2,
            vk_x,
            vk.gamma2,
            _proof.C,
            vk.delta2
        );
    }
}
