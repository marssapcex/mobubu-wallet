// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ContinuumMarket} from "../src/ContinuumMarket.sol";
import {ContinuumShares} from "../src/ContinuumShares.sol";
import {FixedOracle} from "../src/oracle/Oracles.sol";
import {IERC20} from "../src/lib/SafeTransferLib.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// @notice Suite for the market that has no liquidation function.
///         Every test names the decision it protects:
///           D1 rent, not penalty        — test_rentAccruesIntoDebt, test_rentCappedBySurplus
///           D2 no keeper                — test_accrualIsIdempotent, test_pokePaysNothing
///           D3 the invariant is the law — test_bufferLineSurvivesFlow, test_cannotWithdrawBelowLine
contract ContinuumMarketTest is Test {
    MockToken weth;
    MockToken usdc;
    FixedOracle oracle;
    ContinuumMarket market;

    address lender = address(0x1);
    address borrower = address(0x2);
    address keeper = address(0x3);
    address buyer = address(0x4);

    uint256 constant WAD = 1e18;
    uint256 constant C = 1.02e18;
    uint256 constant TARGET = 1.2e18;
    uint256 constant K = 365e18;
    uint256 constant RHO_CAP = 0.1e18;
    uint256 constant ETA = 0.02e18;
    uint256 constant MIN_BID = 0.01e18;

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockToken("Wrapped Ether", "WETH", 18);
        usdc = new MockToken("USD Coin", "USDC", 6);
        oracle = new FixedOracle(2000e18);
        market = new ContinuumMarket(_params());

        usdc.mint(lender, 1_000_000e6);
        usdc.mint(borrower, 100_000e6);
        usdc.mint(buyer, 100_000e6);
        weth.mint(borrower, 100e18);

        vm.startPrank(lender);
        usdc.approve(address(market), type(uint256).max);
        market.deposit(500_000e6);
        vm.stopPrank();

        vm.startPrank(borrower);
        weth.approve(address(market), type(uint256).max);
        usdc.approve(address(market), type(uint256).max);
        market.depositCollateral(10e18);
        market.borrow(14_000e6, 0.02e18);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers
    function _setPrice(uint256 p) internal {
        oracle.setPrice(p);
    }

    function _surplus() internal view returns (int256) {
        return market.surplusOf(borrower);
    }

    // ==================================================================== D1
    function test_rentAccruesIntoDebt() public {
        (, uint256 debt0,,,) = market.positionOf(borrower);
        uint256 supply0 = market.shares().totalSupply();
        uint256 assets0 = market.assets();

        vm.warp(block.timestamp + 30 days);
        market.poke(borrower);

        (, uint256 debt1,,,) = market.positionOf(borrower);
        // 14,000 * 1%/yr * 30/365 = 11.50
        assertGt(debt1, debt0, "rent must capitalise");
        assertApproxEqRel(debt1 - debt0, (debt0 * MIN_BID * 30 days) / (WAD * 365 days), 0.02e18, "rent size");
        // the rent is the lender's yield, not a fee to a third party
        assertGe(market.assets(), assets0, "lenders earn the rent (it is recognised before the poke too)");
        assertEq(market.shares().totalSupply(), supply0, "no new shares for rent");
    }

    function test_rentCappedBySurplus() public {
        // push the mark so the surplus is tiny, then charge a large rent
        _setPrice(1430e18); // V = 14,300, line = 1.02*14,000 = 14,280, S = 20
        int256 s0 = _surplus();
        assertLt(s0, 100e6, "fixture must be tight");
        vm.warp(block.timestamp + 365 days);
        market.poke(borrower);
        assertGe(_surplus(), 0, "rent may never break the buffer line");
    }

    // ==================================================================== D2
    function test_accrualIsIdempotent() public {
        vm.warp(block.timestamp + 7 days);
        market.poke(borrower);
        (, uint256 d1,,,) = market.positionOf(borrower);
        market.poke(borrower);
        market.poke(borrower);
        (, uint256 d2,,,) = market.positionOf(borrower);
        assertEq(d1, d2, "second poke in the same block must be a no-op");
    }

    function test_pokePaysNothing() public {
        vm.warp(block.timestamp + 30 days);
        uint256 before = usdc.balanceOf(keeper);
        vm.prank(keeper);
        market.poke(borrower);
        assertEq(usdc.balanceOf(keeper), before, "no keeper reward exists");
    }

    // ==================================================================== D3
    function test_bufferLineSurvivesFlow() public {
        uint256 s0 = uint256(_surplus());
        _setPrice(1700e18); // below target*D, flow engages
        vm.warp(block.timestamp + 1 days);
        market.poke(borrower);
        uint256 s1 = uint256(_surplus());
        // exact up to the dust of rounding collateral units down
        assertApproxEqAbs(s1, s0, 2, "S must be invariant through the flow");
        assertGt(market.healthOf(borrower), WAD, "no liquidatable state");
    }

    function test_cannotWithdrawBelowLine() public {
        // 10 WETH, 14,000 debt: the line needs V >= 14,280, i.e. 7.14 WETH
        vm.prank(borrower);
        vm.expectRevert(ContinuumMarket.BufferLine.selector);
        market.withdrawCollateral(3e18);
    }

    function test_cannotBorrowPastTarget() public {
        vm.prank(borrower);
        vm.expectRevert(ContinuumMarket.Ltv.selector);
        market.borrow(3_000e6, 0.02e18); // would make D = 17,000 > V/1.2
    }

    function test_cannotBorrowPastTarget_fuzz(uint256 amount) public {
        uint256 headroom = (20_000e6 * WAD) / TARGET - 14_000e6; // ≈ 2,666
        amount = bound(amount, headroom + 1, 100_000e6);
        vm.prank(borrower);
        vm.expectRevert(ContinuumMarket.Ltv.selector);
        market.borrow(amount, 0.02e18);
    }

    // ==================================================================== tail
    function test_priceGapCreatesBadDebtAndWriteOffRealisesIt() public {
        _setPrice(1200e18); // V = 12,000 < D = 14,000
        vm.warp(block.timestamp + 1 hours);
        market.poke(borrower);

        uint256 assetsBefore = market.assets();
        uint256 loansBefore = market.loans();
        uint256 shortfall = market.writeOff(borrower);
        assertEq(shortfall, 14_000e6 - 12_000e6, "shortfall = D - V, before any rent");
        assertEq(market.loans(), loansBefore - shortfall, "the claim shrinks to reality");
        assertLt(market.assets(), assetsBefore, "NAV falls by the shortfall");
        assertEq(market.inventory(), 10e18, "the pool took the collateral at the mark");
        // the market is still usable: lenders can redeem what is left
        assertGt(market.previewRedeem(market.shares().totalSupply()), 0, "pool not frozen");
    }

    // ================================================================ rent law
    function test_rhoStaysInBand() public {
        for (uint256 i = 0; i < 100; ++i) {
            market.updateRho();
            uint256 r = market.rho();
            assertGe(r, MIN_BID, "rent below floor");
            assertLe(r, RHO_CAP, "rent above cap");
        }
    }

    function test_updateRhoIsPermissionlessAndUnpaid() public {
        uint256 before = usdc.balanceOf(keeper);
        vm.prank(keeper);
        market.updateRho();
        assertEq(usdc.balanceOf(keeper), before, "no reward for updating the law");
    }

    // =================================================================== book
    function test_demandBookTracksRent() public {
        (, uint256 d,,,) = market.positionOf(borrower);
        assertEq(market.coveredDebt(), d, "the only borrower is covered at the floor rent");
    }

    function test_demandBookDropsWhenRentExceedsBid() public {
        // borrower bid 0.02, cap 0.10: raise rho to 0.05 by draining cash
        vm.startPrank(borrower);
        market.repay(10_000e6); // leaves 4,000 debt, cash starved relative to bids? no
        vm.stopPrank();
        // instead: withdraw lender cash so covered debt > cash
        uint256 bal = market.shares().balanceOf(lender);
        vm.prank(lender);
        market.withdraw(bal); // cash -> ~0
        for (uint256 i = 0; i < 40; ++i) market.updateRho();
        assertGt(market.rho(), 0.02e18, "rent must clear above a 2% bid when cash is gone");
        assertEq(market.coveredDebt(), 0, "a bid below the clearing rent is priced out");
    }

    // ================================================================== shares
    function test_donationAttackDoesNotInflateShares() public {
        // first-depositor inflation: mint 1 wei of shares, then donate
        ContinuumMarket m = _freshMarket();
        address attacker = address(0xBAD);
        usdc.mint(attacker, 1_000_000e6);
        vm.startPrank(attacker);
        usdc.approve(address(m), type(uint256).max);
        m.deposit(1);
        usdc.transfer(address(m), 10_000e6); // donation
        vm.stopPrank();

        uint256 sharesOut = m.previewDeposit(10_000e6);
        assertGt(sharesOut, 1e6, "virtual offset must keep shares sane");
    }

    /// @notice The point of the no-keeper design, stated as a test: NAV rises
    ///         with time alone. Nobody pokes, nobody is paid, the share price
    ///         still moves — and poking afterwards changes nothing, because the
    ///         work was already accounted for (finding F9).
    function test_sharePriceRisesWithoutAnyTransaction() public {
        uint256 p0 = market.sharePrice();
        vm.warp(block.timestamp + 365 days);
        uint256 p1 = market.sharePrice();
        assertGt(p1, p0, "rent accrual must raise the share price with zero transactions");
        market.poke(borrower);
        assertEq(market.sharePrice(), p1, "poking must not move NAV: the rent was already counted");
    }

    // ================================================================== bid lock
    function test_bidIsLocked() public {
        vm.prank(borrower);
        vm.expectRevert(ContinuumMarket.BidLocked.selector);
        market.setBid(0.05e18, 1 hours); // borrow() locked it for 1h at t0
    }

    function test_bidTooLowRejected() public {
        vm.prank(borrower);
        vm.expectRevert(ContinuumMarket.BidTooLow.selector);
        market.setBid(0, 2 hours);
    }

    // ============================================================ inventory path
    function test_poolSellsInventoryAtMark() public {
        _setPrice(1700e18);
        vm.warp(block.timestamp + 2 days);
        market.poke(borrower);
        uint256 inv = market.inventory();
        assertGt(inv, 0, "the flow must have bought collateral");
        uint256 cash0 = market.cash();
        vm.prank(buyer);
        market.buyInventory(inv, type(uint256).max);
        assertGt(market.cash(), cash0, "the pool got its cash back");
        assertEq(market.inventory(), 0, "inventory cleared");
    }

    // ---------------------------------------------------------------- internal
    function _params() internal view returns (ContinuumMarket.Params memory q) {
        q = ContinuumMarket.Params({
            collateralToken: IERC20(address(weth)),
            debtToken: IERC20(address(usdc)),
            oracle: oracle,
            c: C,
            target: TARGET,
            k: K,
            rhoCap: RHO_CAP,
            eta: ETA,
            minBid: MIN_BID,
            idleFloor: 0.2e18,
            shareName: "Continuum USDC",
            shareSymbol: "cUSDC"
        });
    }

    function _freshMarket() internal returns (ContinuumMarket m) {
        m = new ContinuumMarket(_params());
    }
}
