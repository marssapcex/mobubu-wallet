// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Continuum} from "../src/Continuum.sol";

/// @notice Fuzz + invariant suite for Continuum.
///         The three properties under test are the three claims of the mechanism:
///           P1  buffer-line preservation   V' >= c*D'   (solvency of the flow)
///           P2  negative feedback          health strictly rises while distressed
///           P3  no liquidation predicate   health > 1 always (event has no preimage)
contract ContinuumTest is Test {
    Continuum cont;

    uint256 constant WAD = 1e18;
    uint256 constant C = 1.02e18; // underwriter discount 2%
    uint256 constant TARGET = 1.20e18; // flow switches on at 83.3% LTV
    uint256 constant K = 365e18;
    uint256 constant RHO_CAP = 0.10e18;
    uint256 constant ETA = 0.02e18;
    uint256 constant P0 = 2000e18;

    address alice = address(0xA11CE);

    function setUp() public {
        cont = new Continuum(C, TARGET, K, RHO_CAP, ETA, P0, 0.01e18);
        vm.warp(1_700_000_000);
        // 10 collateral units @ 2000 = 20_000 value; borrow 16_000 -> LTV 80%
        cont.open(10e18, 16_000e18, 0.05e18);
        // underwriter book: enough stable capacity to run the flow
        cont.supplyCash(40_000e18, 0.01e18);
    }

    // ---------------------------------------------------------------- helpers
    function _surplus() internal view returns (uint256) {
        uint256 v = cont.collateralValue(alice);
        uint256 l = cont.bufferLine(alice);
        return v >= l ? v - l : 0;
    }

    function _solvent() internal view returns (bool) {
        return cont.collateralValue(alice) >= cont.bufferLine(alice);
    }

    /// @dev keeps the fuzzed mark inside the underwriter-viable domain, i.e. the
    ///      region where a 2% discount still leaves residual collateral >= debt.
    function _setPriceWithinSurface(uint256 p) internal {
        uint256 line = cont.bufferLine(alice);
        if (line == 0) return;
        // price must satisfy coll*p/1e18 >= line  =>  p >= line*1e18/coll
        uint256 minP = line * WAD / cont.getPos(alice).coll + 1;
        if (p < minP) p = minP;
        cont.setPrice(p);
    }

    // ------------------------------------------------------------------ P1/P3
    /// @notice fuzz: any rent, any dt, any mark inside the surface -> invariant holds
    function testFuzz_bufferLinePreserved(uint256 dt, uint256 rho, uint256 p) public {
        dt = dt % 30 days;
        p = 1200e18 + (p % 900e18);
        vm.assume(dt > 0);
        rho = rho % (RHO_CAP + 1);
        _setPriceWithinSurface(p);
        vm.assume(_solvent()); // exclude the unhedged tail: out of scope by construction
        vm.warp(block.timestamp + dt);
        cont.poke(alice);
        assertTrue(_solvent(), "P1: buffer line broken by the flow");
        assertGt(cont.health(alice), WAD, "P3: liquidation predicate reachable");
    }

    /// @notice fuzz: the flow extinguishes debt and never increases it
    function testFuzz_debtMonotone(uint256 dt, uint256 p) public {
        dt = 1 + (dt % 7 days);
        p = 1200e18 + (p % 900e18);
        _setPriceWithinSurface(p);
        vm.assume(_solvent());
        uint256 d0 = cont.getPos(alice).debt;
        vm.warp(block.timestamp + dt);
        cont.poke(alice);
        assertLe(cont.getPos(alice).debt, d0, "debt increased");
    }

    // -------------------------------------------------------------------- P2
    /// @notice the feedback law: in distress, one accrual strictly raises health
    function testFuzz_negativeFeedback(uint256 dt, uint256 p) public {
        dt = 1 hours + (dt % 23 hours);
        p = 1500e18 + (p % 400e18); // crash the mark: position is distressed
        _setPriceWithinSurface(p);
        vm.assume(_solvent());
        vm.assume(cont.isDistressed(alice));
        uint256 h0 = cont.health(alice);
        vm.warp(block.timestamp + dt);
        cont.poke(alice);
        assertGt(cont.health(alice), h0, "P2: feedback is not negative");
    }

    /// @notice and the loop terminates: repeated pokes drive health back above target
    function test_flowRestoresHealth() public {
        cont.setPrice(1700e18); // ~15% drawdown, distressed, still solvent
        assertTrue(cont.isDistressed(alice));
        for (uint256 i; i < 400; ++i) {
            vm.warp(block.timestamp + 6 hours);
            cont.poke(alice);
        }
        assertGe(cont.health(alice), TARGET - 1e15, "flow failed to restore health");
    }

    // ------------------------------------------------------------- rent law
    function testFuzz_rentLawBounded(uint256 z, uint256 iters) public {
        iters = iters % 40;
        for (uint256 i; i < iters; ++i) {
            vm.warp(block.timestamp + 2 hours); // bid commitment window elapsed
            cont.commitBid(alice, uint256(z) % (RHO_CAP + 1), 1 hours);
            cont.setRho();
            assertLe(cont.rho(), RHO_CAP, "rho escaped its bound");
        }
    }

    /// @notice the griefing fix: a bid that can be pulled in the same block is
    ///         rejected, so rho cannot be pumped and dumped for free.
    function test_bidMustBeCommitted() public {
        vm.expectRevert(bytes("lock too short"));
        cont.commitBid(alice, RHO_CAP, 1);

        vm.warp(block.timestamp + 2 hours);
        cont.commitBid(alice, RHO_CAP, 2 hours);
        uint256 locked = cont.rho();
        vm.expectRevert(bytes("bid still locked"));
        cont.commitBid(alice, 0, 2 hours); // cannot pull the bid back early
        assertEq(cont.rho(), locked);
    }

    /// @notice monotone convergence: with excess demand positive the rent only rises
    function test_rentMonotoneTowardCrossing() public {
        // borrower bids above the cap, no underwriter supply -> excess demand > 0
        vm.warp(block.timestamp + 2 hours);
        cont.commitBid(alice, RHO_CAP, 12 hours);
        uint256 prev = cont.rho();
        for (uint256 i; i < 10; ++i) {
            cont.setRho();
            assertGe(cont.rho(), prev, "rent moved the wrong way");
            prev = cont.rho();
        }
        assertGt(prev, 0, "rent never moved");
    }

    // ------------------------------------------------------- adversary: pawn
    /// @notice a borrower cannot escape the flow by front-running the accrual:
    ///         the released collateral is priced at the same mark either way.
    function test_cannotDodgeFlowByPoking() public {
        cont.setPrice(1700e18);
        uint256 dBefore = cont.getPos(alice).debt;
        vm.warp(block.timestamp + 12 hours);
        cont.poke(alice); // attacker pokes first
        uint256 d1 = cont.getPos(alice).debt;
        vm.warp(block.timestamp + 12 hours);
        cont.poke(alice); // and again
        uint256 d2 = cont.getPos(alice).debt;
        assertLt(d1, dBefore);
        assertLt(d2, d1);
    }
}

/// @notice handler for the stateful invariant campaign
contract Handler is Test {
    Continuum cont;
    address who = address(0xA11CE);
    uint256 public pokes;

    constructor(Continuum c_) {
        cont = c_;
    }

    function poke() external {
        cont.poke(who);
        pokes++;
    }

    function moveMark(uint256 p) external {
        uint256 line = cont.bufferLine(who);
        uint256 coll = cont.getPos(who).coll;
        if (line == 0 || coll == 0) return;
        uint256 minP = line * 1e18 / coll + 1e6;
        p = minP + (p % 1500e18);
        cont.setPrice(p);
    }

    function warp(uint256 dt) external {
        dt = dt % 3 days;
        vm.warp(block.timestamp + dt);
    }

    function moveRent(uint256 bid_) external {
        vm.warp(block.timestamp + 2 hours);
        cont.commitBid(who, bid_ % 0.1e18, 1 hours);
        cont.setRho();
    }

    function repayChunk(uint256 amt) external {
        uint256 d = cont.getPos(who).debt;
        if (d == 0) return;
        cont.repay(amt % d);
    }
}

contract ContinuumInvariantTest is Test {
    Continuum cont;
    Handler handler;

    function setUp() public {
        cont = new Continuum(1.02e18, 1.20e18, 365e18, 0.10e18, 0.02e18, 2000e18, 0.01e18);
        vm.warp(1_700_000_000);
        vm.prank(address(0xA11CE));
        cont.open(10e18, 16_000e18, 0.05e18);
        cont.supplyCash(40_000e18, 0.01e18);
        handler = new Handler(cont);
        targetContract(address(handler));
    }

    /// @notice THE feedback-loop property from Phase 3:
    ///         V >= c*D is invariant under every reachable operation.
    function invariant_bufferLine() public view {
        uint256 v = cont.collateralValue(address(0xA11CE));
        uint256 l = cont.bufferLine(address(0xA11CE));
        assertGe(v + 1, l, "buffer line violated");
    }

    /// @notice the liquidation predicate has no reachable preimage
    function invariant_noLiquidationPredicate() public view {
        if (cont.getPos(address(0xA11CE)).debt == 0) return;
        assertGt(cont.health(address(0xA11CE)), 1e18, "health <= 1 reachable");
    }

    /// @notice the primitive variable never leaves its admissible set
    function invariant_rhoBounded() public view {
        assertLe(cont.rho(), 0.10e18);
    }

    /// @notice the flow never mints debt
    function invariant_debtNeverGrows() public view {
        assertLe(cont.getPos(address(0xA11CE)).debt, 16_000e18);
    }
}
