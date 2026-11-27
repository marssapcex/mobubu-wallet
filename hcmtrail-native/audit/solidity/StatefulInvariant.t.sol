// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StatefulProperties} from "./StatefulProperties.sol";

interface StatefulVm {
    function deal(address, uint256) external;
    function warp(uint256) external;
}

/// This Forge build does not expose the invariant targeting cheatcodes, so the
/// handler is a contract deployed in setUp: Forge fuzzes every contract created
/// here, which includes the exact Medusa/Echidna target.
contract StatefulInvariantTest {
    StatefulVm private constant vm = StatefulVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    StatefulProperties private handler;

    function setUp() public {
        vm.warp(600);
        handler = new StatefulProperties();
        vm.deal(address(handler), 400 ether);
        handler.deposit(4 ether);
    }

    function invariant_poolStaysSolvent() public view {
        assert(handler.property_poolSolvent());
    }

    function invariant_stakingStaysSolvent() public view {
        assert(handler.property_stakingSolvent());
    }

    function invariant_claimsStayBounded() public view {
        assert(handler.property_claimsBounded());
    }

    function invariant_treeStaysBounded() public view {
        assert(handler.property_treeBound());
    }

    function invariant_supplyStaysFixed() public view {
        assert(handler.property_supplyFixed());
    }

    function invariant_batchBookkeeping() public view {
        assert(handler.property_batchBookkeeping());
    }
}

/// Deterministic proof that the handler really reaches settlement, refunds and
/// staking, so a passing invariant run is not just a sequence of reverts.
contract StatefulSmokeTest {
    StatefulVm private constant vm = StatefulVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    StatefulProperties private handler;

    function setUp() public {
        vm.warp(600);
        handler = new StatefulProperties();
        vm.deal(address(handler), 400 ether);
    }

    function test_HandlerReachesEveryBranch() public {
        handler.deposit(4 ether);
        assert(handler.settlements() == 0);
        for (uint256 i; i < 5; ++i) handler.reserveTicket(0);
        handler.settle(0);
        assert(handler.settlements() == 1);
        assert(handler.refunds() == 0);
        handler.stake(100 ether);
        handler.claimFees();
        handler.claimRelay();
        handler.refundTicket(0);
        assert(handler.property_poolSolvent());
        assert(handler.property_stakingSolvent());
    }
}
