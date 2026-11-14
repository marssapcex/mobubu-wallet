// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title WithdrawalVerifier
 * @dev Groth16 SNARK verifier cho circuit Withdraw (Circom 2).
 *      File này là skeleton được generate từ `snarkjs zkey export solidityverifier`.
 *      Sau khi chạy trusted setup + export real zkey, hãy thay toàn bộ nội dung
 *      verifyingKey bằng giá trị thực từ file verification_key.json.
 */
library Pairing {
    uint256 constant PRIME_Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct G1Point {
        uint256 X;
        uint256 Y;
    }

    struct G2Point {
        uint256[2] X;
        uint256[2] Y;
    }

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

contract WithdrawalVerifier {
    using Pairing for *;

    uint256 constant SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct VerifyingKey {
        Pairing.G1Point alfa1;
        Pairing.G2Point beta2;
        Pairing.G2Point gamma2;
        Pairing.G2Point delta2;
        Pairing.G1Point[] IC;
    }

    struct Proof {
        Pairing.G1Point A;
        Pairing.G2Point B;
        Pairing.G1Point C;
    }

    // TODO: Thay bằng verifying key thực từ snarkjs zkey export verificationkey
    function verifyingKey() internal pure returns (VerifyingKey memory vk) {
        vk.alfa1 = Pairing.G1Point(1, 2);
        vk.beta2 = Pairing.G2Point([1, 2], [3, 4]);
        vk.gamma2 = Pairing.G2Point([1, 2], [3, 4]);
        vk.delta2 = Pairing.G2Point([1, 2], [3, 4]);
        vk.IC = new Pairing.G1Point[](7);
        for (uint i = 0; i < 7; i++) {
            vk.IC[i] = Pairing.G1Point(1, 2);
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

        uint256[8] memory p;
        // Decode proof (8 uint256)
        // In production, decode properly from bytes calldata
        assembly {
            // Simplified placeholder decode
        }
        p[0] = 1; p[1] = 2; p[2] = 1; p[3] = 2; p[4] = 1; p[5] = 2; p[6] = 1; p[7] = 2;

        Proof memory _proof;
        _proof.A = Pairing.G1Point(p[0], p[1]);
        _proof.B = Pairing.G2Point([p[2], p[3]], [p[4], p[5]]);
        _proof.C = Pairing.G1Point(p[6], p[7]);

        VerifyingKey memory vk = verifyingKey();

        Pairing.G1Point memory vk_x = Pairing.G1Point(0, 0);
        vk_x = Pairing.plus(vk_x, vk.IC[0]);
        for (uint i = 0; i < inputs.length; i++) {
            vk_x = Pairing.plus(vk_x, Pairing.scalar_mul(vk.IC[i + 1], inputs[i]));
        }

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
