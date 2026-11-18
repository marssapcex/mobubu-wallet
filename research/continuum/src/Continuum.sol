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
///         The load-bearing algebraic fact (proved in ../lean/Continuum.lean and
///         discharged by Z3 + cvc5 as T1..T12, I1..I4):
///
///             S' = (V - c*x) - c*(D - x) = V - c*D = S
///
///         Deleveraging is EXACTLY buffer-neutral and debt-reducing, so
///         health = V/D = c + S/D rises monotonically as debt falls. That is the
///         negative feedback loop. There is no health threshold anywhere in this
///         contract: `health < 1` is unreachable while S > 0 and c > 1.
///
/// @dev    AUDIT REVISION 2 (self-audit, three findings fixed):
///         B1  `open` pushed msg.sender onto `borrowers` unconditionally, so a
///             borrower whose debt reached zero and re-opened was counted twice
///             in the demand book, inflating rho.  Fixed with `registered`.
///         B2  `_recount` scanned every borrower inside `setRho`, so the gas cost
///             of the rent law grew without bound.  Fixed with a 64-bucket demand
///             histogram (`_credit`), which is O(64) and, crucially, still
///             monotone non-increasing in rho -- the only property the
///             tatonnement theorems (T7, T8) require.
///         B3  `supplyCash(amount, ask)` let any address set the global ask with
///             one wei of capital.  Fixed with a capital-weighted ask
///             (`askNum / totalSupply`), which is O(1) and unmanipulable at dust.
library W {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
}

contract Continuum {
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
    /// @notice tatonnement step for the rent, WAD.
    uint256 public immutable eta;
    /// @notice a repriced bid must wait this long; kills pump-and-pull (B3 note).
    uint256 public constant MIN_BID_LOCK = 1 hours;
    /// @notice demand histogram resolution over [0, rhoCap].
    uint256 public constant BUCKETS = 64;

    // ------------------------------------------------------------------- state
    struct Pos {
        uint256 coll;    // collateral units
        uint256 debt;    // debt units (stablecoin)
        uint256 last;    // last materialisation timestamp
        uint256 bid;     // max rent the borrower will pay, WAD/yr
        uint256 bidLock; // repricing is refused before this timestamp
    }

    mapping(address => Pos) public pos;
    mapping(address => bool) public registered;
    address[] public borrowers;

    /// @notice demand histogram: debt whose committed bid falls in bucket i,
    ///         where bucket i covers rents [i*w, (i+1)*w), w = rhoCap/BUCKETS.
    uint256[BUCKETS] internal demandByBucket;

    /// @notice rent per unit of debt per year, WAD. The primitive variable.
    uint256 public rho;
    /// @notice underwriter stable balance available to extinguish debt
    uint256 public underCash;
    /// @notice underwriter collateral inventory
    uint256 public underColl;
    /// @notice total committed underwriter capital, and the weighted ask numerator
    uint256 public totalSupply;
    uint256 public askNum;
    /// @notice rent income booked (informational)
    uint256 public rentBooked;
    /// @notice Cumulative rent per unit of underwriter capital, WAD. Rent used to
    ///         fall into `underCash` and was never claimable by the suppliers who
    ///         carried the risk; that is now an explicit index (audit B4).
    uint256 public accRentPerShare;
    mapping(address => uint256) public rentDebt; // supplier snapshot of the index
    mapping(address => uint256) public rentClaimed; // realised, bookkept
    uint256 public rentPaidOut;

    /// @notice collateral mark. In production this is an oracle input; note that
    ///         the *rent* law (setRho) never reads it -- only the distress gap does.
    uint256 public price;
    address public immutable admin;

    event Opened(address indexed who, uint256 coll, uint256 debt);
    event Accrued(address indexed who, uint256 rentPaid, uint256 debtExtinguished, uint256 collReleased);
    event Rho(uint256 rho, int256 excess);
    event Price(uint256 price);
    event Bid(address indexed who, uint256 bid, uint256 lockedUntil);

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
        admin = msg.sender;
        require(ask_ <= rhoCap_, "ask above cap");
    }

    // ------------------------------------------------------------------ views
    /// @notice Number of distinct addresses ever registered (B1: one entry each).
    function borrowerCount() external view returns (uint256) {
        return borrowers.length;
    }

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

    function bucketOf(uint256 bid) public view returns (uint256 b) {
        b = (bid * BUCKETS) / (rhoCap + 1);
        if (b >= BUCKETS) b = BUCKETS - 1;
    }

    /// @notice protected notional at the current rent. Counts a bucket only if its
    ///         *lower* rent bound already clears `rho`, which keeps the book
    ///         conservative and, more importantly, monotone non-increasing in rho.
    function coveredDebt() public view returns (uint256 d) {
        for (uint256 b; b < BUCKETS; ++b) {
            uint256 lower = (b * (rhoCap + 1)) / BUCKETS;
            if (lower >= rho) d += demandByBucket[b];
        }
    }

    /// @notice capital-weighted minimum acceptable rent (B3). One wei of capital
    ///         moves this by one wei / totalSupply, i.e. not at all.
    function effectiveAsk() public view returns (uint256) {
        if (totalSupply == 0) return type(uint256).max;
        return askNum / totalSupply;
    }

    // ------------------------------------------------------------- user verbs
    function open(uint256 collAmount, uint256 borrowAmount, uint256 bid_) external {
        // reopening used to overwrite `coll`, silently confiscating whatever the
        // borrower had left behind (audit B4)
        require(pos[msg.sender].debt == 0 && pos[msg.sender].coll == 0, "one position");
        pos[msg.sender] = Pos({
            coll: collAmount,
            debt: borrowAmount,
            last: block.timestamp,
            bid: bid_,
            bidLock: block.timestamp + MIN_BID_LOCK
        });
        if (!registered[msg.sender]) {
            registered[msg.sender] = true;
            borrowers.push(msg.sender);
        }
        // entry gate: V >= target*D, so S >= (target - c)*D > 0 immediately
        require(collateralValue(msg.sender) >= target * borrowAmount / W.WAD, "ltv");
        _lastBid[msg.sender] = bid_;
        demandByBucket[bucketOf(bid_)] += borrowAmount;
        emit Opened(msg.sender, collAmount, borrowAmount);
    }

    function repay(uint256 amount) external {
        _accrue(msg.sender);
        Pos storage p = pos[msg.sender];
        if (amount > p.debt) amount = p.debt;
        p.debt -= amount;
        _subWeight(msg.sender, amount);
    }

    function withdrawCollateral(uint256 units) external {
        _accrue(msg.sender);
        Pos storage p = pos[msg.sender];
        require(units <= p.coll, "coll");
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
    /// @notice commit stable capital authorised to extinguish debt, at an ask
    function supplyCash(uint256 amount, uint256 ask_) external {
        require(amount > 0, "amount");
        _settle(msg.sender);
        uint256 s = supplyOf[msg.sender];
        askNum = askNum + amount * ask_ - s * askOf[msg.sender];
        supplyOf[msg.sender] = s + amount;
        askOf[msg.sender] = ask_;
        totalSupply += amount;
        underCash += amount;
    }

    mapping(address => uint256) public supplyOf;
    mapping(address => uint256) public askOf;

    /// @notice Rent earned and not yet realised by `who`.
    function pendingRent(address who) public view returns (uint256) {
        return supplyOf[who] * (accRentPerShare - rentDebt[who]) / W.WAD;
    }

    /// @dev Realise earned rent before any share movement, so supplying or
    ///      withdrawing can never destroy a claim (B5).
    function _settle(address who) internal {
        uint256 p = pendingRent(who);
        if (p > 0) {
            rentClaimed[who] += p;
            rentPaidOut += p;
        }
        rentDebt[who] = accRentPerShare;
    }

    /// @notice Realise the rent. The prototype books the claim; a deployment
    ///         transfers the stablecoin the rent was denominated in.
    function claimRent() external returns (uint256) {
        _settle(msg.sender);
        return rentClaimed[msg.sender];
    }

    function withdrawCash(uint256 amount) external {
        _settle(msg.sender);
        uint256 s = supplyOf[msg.sender];
        require(amount <= s && amount <= underCash, "cash");
        askNum -= amount * askOf[msg.sender];
        supplyOf[msg.sender] = s - amount;
        totalSupply -= amount;
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
    function excessDemand() public view returns (int256) {
        uint256 d = coveredDebt();
        uint256 ask = effectiveAsk();
        if (ask == type(uint256).max) return -int256(underCash);
        if (rho > ask) return -int256(underCash); // underwriters are cheap: supply wins
        return int256(d) - int256(underCash);
    }

    /// @notice Dimensionless imbalance in [-WAD, +WAD]: demand net of supply,
    ///         normalised by the larger of the two sides.
    ///         This is the quantity the SMT model (T7, T7b, T8) assumes: `z` is a
    ///         *ratio*, so one step moves rho by at most `eta`, in units of rent.
    ///         Passing raw notional instead (audit B6) made the gain
    ///         scale-dependent: any book above a few hundred dollars saturated
    ///         rho at the cap on the first call, and `eta` stopped meaning
    ///         anything. Normalising here restores the modelled behaviour and
    ///         makes `eta` interpretable as "fraction of the gap closed per call".
    function imbalance() public view returns (int256) {
        uint256 d = coveredDebt();
        uint256 s = underCash;
        // underwriters are cheaper than the cleared rent: the demand side is
        // priced out, so only supply remains in the imbalance
        if (rho > effectiveAsk()) d = 0;
        uint256 norm = d > s ? d : s;
        if (norm == 0) return 0;
        int256 diff = int256(d) - int256(s);
        return (diff * int256(W.WAD)) / int256(norm);
    }

    /// @notice Closed-form negative-feedback law for the primitive variable.
    ///
    ///             rho' = clip[0, rhoCap]( rho + eta * (D(rho) - S(rho)) / N )
    ///
    ///         Excess demand is non-increasing in rho (borrowers drop out as the
    ///         rent rises, underwriters enter), so the iteration is monotone toward
    ///         the crossing and cannot oscillate while eta is inside the stability
    ///         bound (Z3/cvc5: T7, T7b, T8). Callable by anyone, pays nothing.
    function setRho() public {
        int256 z = imbalance();
        int256 step = (int256(eta) * z) / int256(W.WAD);

        // B7: `coveredDebt` is a step function of rho, so its slope is not
        // bounded and a raw eta-step limit-cycles across the whole book (rent
        // flips between 0 and the top bid, one call each). The demand book has a
        // finite resolution — one bucket — so the step is capped at half a
        // bucket: rho is monotone while it is away from the crossing and settles
        // inside a band no wider than one bucket (rhoCap / 64 = 15.6 bp/yr at the
        // deployed cap). This is the discrete statement the SMT bound covers:
        // convergence to a band, not to a point.
        int256 cap = int256((rhoCap + 1) / BUCKETS / 2);
        if (step > cap) step = cap;
        if (step < -cap) step = -cap;

        int256 next = int256(rho) + step;
        if (next < 0) next = 0;
        if (next > int256(rhoCap)) next = int256(rhoCap);
        rho = uint256(next);
        emit Rho(rho, z);
    }

    /// @dev prototype: accepts an address so the test harness can act for a user.
    ///      A bid cannot be repriced until its lock elapses, so an adversary
    ///      cannot push rho to the ceiling for one block and pull it back (B3).
    ///      A stale high bid is self-punishing: it keeps the rent high and the
    ///      bidder pays it.
    function commitBid(address who, uint256 bid_, uint256 lockSecs) external {
        require(lockSecs >= MIN_BID_LOCK, "lock too short");
        Pos storage p = pos[who];
        require(block.timestamp >= p.bidLock, "bid still locked");
        p.bid = bid_;
        p.bidLock = block.timestamp + lockSecs;
        if (p.debt > 0) {
            uint256 old = bucketOf(_lastBid[who]);
            uint256 nb = bucketOf(bid_);
            if (old != nb) {
                uint256 cur = demandByBucket[old];
                demandByBucket[old] = cur > p.debt ? cur - p.debt : 0;
                demandByBucket[nb] += p.debt;
            }
            _lastBid[who] = bid_;
        }
        emit Bid(who, bid_, p.bidLock);
    }

    function setPrice(uint256 p) external {
        require(msg.sender == admin, "admin");
        price = p;
        emit Price(p);
    }

    /// @dev Demand-weight bookkeeping. The weight of a position always sits in
    ///      the bucket of the bid it was committed at (`_lastBid`), which is what
    ///      keeps the histogram consistent without a scan.
    function _subWeight(address who, uint256 amount) internal {
        uint256 b = bucketOf(_lastBid[who]);
        uint256 cur = demandByBucket[b];
        demandByBucket[b] = cur > amount ? cur - amount : 0;
    }

    mapping(address => uint256) internal _lastBid;

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
        uint256 debtBefore = p.debt;

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
            rentBooked += rentDue;
            // rent is earned by the capital that carried the risk, not by the pool
            if (totalSupply > 0) accRentPerShare += rentDue * W.WAD / totalSupply;
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
        // keep the demand book consistent with the debt it is weighted by
        if (p.debt != debtBefore) {
            _subWeight(who, debtBefore - p.debt);
        }
        emit Accrued(who, rentDue, extinguished, released);
    }
}
