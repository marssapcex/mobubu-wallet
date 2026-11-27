// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthPoolHarness} from "../../test/fixtures/EthPoolFixture.sol";
import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";

/// Symbolic properties for the fee rule. Halmos proves these for every 64-bit gross,
/// not for sampled inputs. The verifier is the fixture one, so this says nothing
/// about proof soundness.
contract PoolSymbolicTest {
    EthPoolHarness private pool;

    function setUp() public {
        pool = new EthPoolHarness(address(new HcmtToken(address(this))));
    }

    function check_feeSplitIsExact(uint64 gross) public view {
        (uint256 fee, uint256 net) = pool.quoteFee(gross);
        assert(fee + net == gross);
        assert(net <= gross);
    }

    function check_feeIsFloorOfNineBps(uint64 gross) public view {
        (uint256 fee, ) = pool.quoteFee(gross);
        assert(fee * 10_000 <= uint256(gross) * 9);
        assert(uint256(gross) * 9 < (fee + 1) * 10_000);
    }

    function check_equalTicketsPayEqualNet(uint64 gross) public view {
        (uint256 feeA, uint256 netA) = pool.quoteFee(gross);
        (uint256 feeB, uint256 netB) = pool.quoteFee(gross);
        assert(feeA == feeB && netA == netB);
    }
}
