// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  Continuum — a buffer-rent market for credit
/// @notice Replaces the liquidation EVENT with a liquidation RATE.
///
///         Every borrow position decomposes into exactly two quantities at the
///         current collateral mark V and debt D:
///
///             buffer line     L = c * D          (c = 1 + underwriter discount)
///             buffer surplus  S = V - L          (S >= 0 is the safety invariant)
///
///         Two continuous flows act on the position, both proportional to dt:
///
///           (1) RENT      borrower -> underwriters, rate rho, charged ONLY against S
///           (2) DELEVER   underwriter -> lender (debt extinguished), collateral
///                         released at price c * x, rate proportional to distress
///
///         The load-bearing algebraic fact (proved in ../lean/Continuum.lean):
///
///             S' = (V - c*x) - c*(D - x) = V - c*D = S
///
///         Deleveraging is EXACTLY buffer-neutral and debt-reducing, so
///         health = V/D = c + S/D rises monotonically as debt falls. That is the
///         negative feedback loop. There is no health threshold anywhere in this
///         contract: `health < 1` is unreachable while S > 0 and c > 1.
library W {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
}

contract Continuum {
    using W for uint256;

    // ---------------------------------------------------------------- geometry
    /// @notice buffer line multiplier, WAD. Underwriters pay 1 unit of debt for
    ///         `c` units of collateral value; (c-1) is their gross discount.
    uint256 public immutable c;
    /// @notice health at which the deleverage flow switches on, WAD. Must exceed `c`.
    uint256 public immutable target;
    /// @notice flow gain: fraction of the distress gap closed per year, WAD.
    uint256 public immutable k;
    /// @notice hard ceiling on the rent, WAD per year (per unit of debt).
    uint256 public immutable rhoCap;
    /// @notice minimum commitment for a bid. A bid that can be posted and pulled
    ///         in the same block is free optionality and lets an adversary pump
    ///         rho to the ceiling and bleed the borrower's surplus at rhoCap.
    uint256 public constant MIN_BID_LOCK = 1 hours;
    /// @notice tatonnement step for the rent, WAD.
    uint256 public immutable eta;

    // ------------------------------------------------------------------- state
    struct Pos {
        uint256 coll;    // collateral units
        uint256 debt;    // debt units (stablecoin)
        uint256 last;    // last materialisation timestamp
        uint256 bid;     // max rent the borrower will pay, WAD/yr
        uint256 bidLock; // a bid only counts while `now < bidLock`
    }

    mapping(address => Pos) public pos;
    address[] public borrowers;

    /// @notice rent per unit of debt per year, WAD. The primitive variable.
    uint256 public rho;
    /// @notice underwriter stable balance available to extinguish debt
    uint256 public underCash;
    /// @notice underwriter collateral inventory
    uint256 public underColl;
    /// @notice underwriters' minimum acceptable rent, WAD/yr
    uint256 public ask;
    /// @notice total debt protected at the current rho
    uint256 public coveredDebt;
    /// @notice rent income booked (informational)
    uint256 public rentBooked;

    /// @notice collateral mark. In production this is an oracle input; note that
    ///         the *rent* law (setRho) never reads it -- only the distress gap does.
    uint256 public price;
    address public immutable admin;

    event Opened(address indexed who, uint256 coll, uint256 debt);
    event Accrued(address indexed who, uint256 rentPaid, uint256 debtExtinguished, uint256 collReleased);
    event Rho(uint256 rho, int256 excess);
    event Price(uint256 price);

    constructor(uint256 c_, uint256 target_, uint256 k_, uint256 rhoCap_, uint256 eta_, uint256 price_, uint256 ask_) {
        require(c_ > W.WAD, "c must exceed 1");
        require(target_ > c_, "target must exceed c");
        require(eta_ > 0 && k_ > 0, "gains");
        c = c_;
        target = target_;
        k = k_;
        rhoCap = rhoCap_;
        eta = eta_;
        price = price_;
        ask = ask_;
        admin = msg.sender;
    }

    // ------------------------------------------------------------------ views
    function getPos(address who) external view returns (Pos memory) {
        return pos[who];
    }

    function collateralValue(address who) public view returns (uint256) {
        return pos[who].coll * price / W.WAD;
    }

    function bufferLine(address who) public view returns (uint256) {
        return c * pos[who].debt / W.WAD;
    }

    /// @notice the safety invariant's left-hand side; must stay >= 0
    function surplus(address who) public view returns (uint256) {
        uint256 v = collateralValue(who);
        uint256 l = bufferLine(who);
        return v > l ? v - l : 0;
    }

    function health(address who) public view returns (uint256) {
        uint256 d = pos[who].debt;
        if (d == 0) return type(uint256).max;
        return collateralValue(who) * W.WAD / d;
    }

    function isDistressed(address who) public view returns (bool) {
        return collateralValue(who) * W.WAD < target * pos[who].debt;
    }

    // ------------------------------------------------------------- user verbs
    function open(uint256 collAmount, uint256 borrowAmount, uint256 bid_) external {
        require(pos[msg.sender].debt == 0, "one position");
        pos[msg.sender] = Pos({
            coll: collAmount,
            debt: borrowAmount,
            last: block.timestamp,
            bid: bid_,
            bidLock: block.timestamp + MIN_BID_LOCK
        });
        borrowers.push(msg.sender);
        // entry gate: S > 0 with room, i.e. V >= target*D. Since target > c this
        // implies the strict safety invariant immediately.
        require(collateralValue(msg.sender) >= target * borrowAmount / W.WAD, "ltv");
        emit Opened(msg.sender, collAmount, borrowAmount);
    }

    function repay(uint256 amount) external {
        _accrue(msg.sender);
        Pos storage p = pos[msg.sender];
        if (amount > p.debt) amount = p.debt;
        p.debt -= amount;
    }

    function withdrawCollateral(uint256 units) external {
        _accrue(msg.sender);
        Pos storage p = pos[msg.sender];
        p.coll -= units;
        // never allow the withdrawal itself to break the buffer line
        require(collateralValue(msg.sender) >= bufferLine(msg.sender), "buffer");
    }

    /// @notice Permissionless materialisation. Pays the caller NOTHING: the state
    ///         transition is a pure function of (elapsed time, price), so there is
    ///         no rent to race for and no keeper class. That is the point.
    function poke(address who) external {
        _accrue(who);
    }

    // --------------------------------------------------------- underwriter side
    /// @notice commit stable capital that is allowed to extinguish debt
    function supplyCash(uint256 amount, uint256 ask_) external {
        underCash += amount;
        ask = ask_;
    }

    function withdrawCash(uint256 amount) external {
        require(amount <= underCash, "cash");
        underCash -= amount;
    }

    /// @notice sell collateral inventory acquired from the flow. The underwriter
    ///         holds an unlevered spot position; it has no liquidation price.
    function sellInventory(uint256 units, address to) external {
        require(units <= underColl, "inv");
        underColl -= units;
        // prototype: inventory is accounted, not transferred (no ERC20 in this cut)
        to; // silence
    }

    // ------------------------------------------------------------ the rent law
    /// @notice Excess demand for buffer access at the current rent, in debt units.
    ///         Borrowers bid, underwriters ask; the crossing is discovered.
    function excessDemand() public view returns (int256) {
        uint256 d = coveredDebt;
        uint256 s = underCash;
        if (rho > ask) return -int256(s); // underwriters are cheap: supply wins
        return int256(d) - int256(s);
    }

    /// @notice Closed-form negative-feedback law for the primitive variable.
    ///
    ///             rho_{n+1} = clip[0, rhoCap]( rho_n + eta * (D(rho_n) - S(rho_n)) / N )
    ///
    ///         Excess demand is non-increasing in rho (borrowers drop out as the
    ///         rent rises, underwriters enter), so the iteration is monotone toward
    ///         the crossing and cannot oscillate while eta is inside the stability
    ///         bound. Callable by anyone, pays nothing: same argument as poke().
    function setRho() public {
        int256 z = excessDemand();
        // N = one unit of notional, so eta is dimensionless
        int256 step = (int256(eta) * z) / int256(W.WAD);
        int256 next = int256(rho) + step;
        if (next < 0) next = 0;
        if (next > int256(rhoCap)) next = int256(rhoCap);
        rho = uint256(next);
        _recount();
        emit Rho(rho, z);
    }

    /// @dev prototype: accepts an address so the test handler can act for a user.
    ///      A bid cannot be repriced until its commitment window has elapsed, and
    ///      a fresh bid must be committed for at least MIN_BID_LOCK. This is the
    ///      fix for the rent-book griefing vector (README §6.2): without it, an
    ///      adversary posts a huge bid, pumps rho to rhoCap for one block, pulls
    ///      it, and repeats -- draining the borrower's surplus at the ceiling.
    function commitBid(address who, uint256 bid_, uint256 lockSecs) external {
        require(lockSecs >= MIN_BID_LOCK, "lock too short");
        Pos storage p = pos[who];
        require(block.timestamp >= p.bidLock, "bid still locked");
        p.bid = bid_;
        p.bidLock = block.timestamp + lockSecs;
        _recount();
    }

    function _recount() internal {
        uint256 d;
        for (uint256 i; i < borrowers.length; ++i) {
            Pos storage p = pos[borrowers[i]];
            // a bid counts only inside its commitment window
            if (p.debt > 0 && p.bid >= rho && block.timestamp < p.bidLock) d += p.debt;
        }
        coveredDebt = d;
    }

    function setPrice(uint256 p) external {
        require(msg.sender == admin, "admin");
        price = p;
        emit Price(p);
    }

    // ------------------------------------------------------------- the accrual
    /// @dev The whole mechanism. Two flows, both O(dt), no branch on a threshold
    ///      that pays a caller. Rounding is always in favour of the buffer line.
    function _accrue(address who) internal {
        Pos storage p = pos[who];
        uint256 dt = block.timestamp - p.last;
        if (dt == 0) return;
        p.last = block.timestamp;
        if (p.debt == 0) return;

        uint256 v = p.coll * price / W.WAD;

        // ---- flow 1: rent, charged only against the surplus -------------------
        uint256 line = c * p.debt / W.WAD;
        uint256 s = v > line ? v - line : 0;
        uint256 rentDue = rho * p.debt / W.WAD * dt / W.YEAR;
        if (rentDue > s) rentDue = s; // never eat the buffer line
        if (rentDue > 0) {
            uint256 burn = rentDue * W.WAD / price;
            if (burn > p.coll) burn = p.coll;
            p.coll -= burn;
            rentDue = burn * price / W.WAD; // re-quantise
            underCash += rentDue;
            rentBooked += rentDue;
            v -= rentDue;
        }

        // ---- flow 2: deleverage, proportional to distress ---------------------
        uint256 extinguished;
        uint256 released;
        uint256 trig = target * p.debt / W.WAD;
        if (v < trig) {
            uint256 gap = trig - v;
            uint256 x = k * gap / W.WAD * dt / W.YEAR;
            if (x > p.debt) x = p.debt;
            if (x > underCash) x = underCash;
            if (x > 0) {
                uint256 seizeVal = c * x / W.WAD;
                uint256 seizeUnits = seizeVal * W.WAD / price;
                if (seizeUnits > p.coll) seizeUnits = p.coll;
                p.coll -= seizeUnits;
                p.debt -= x;
                underCash -= x;
                underColl += seizeUnits;
                extinguished = x;
                released = seizeUnits;
            }
        }
        emit Accrued(who, rentDue, extinguished, released);
    }
}
