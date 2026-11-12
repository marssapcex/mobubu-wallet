// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {BufferMath} from "./lib/BufferMath.sol";
import {IOracle} from "./oracle/Oracles.sol";
import {ContinuumShares} from "./ContinuumShares.sol";

/// @title ContinuumMarket — a lending market with no liquidation function
/// @notice One collateral asset, one debt asset. Lenders deposit the debt asset
///         and hold `ContinuumShares`; borrowers post collateral, borrow, and pay
///         a continuous rent instead of a contingent penalty.
///
///         The three structural decisions, and where they live in this file:
///
///         1. **A penalty became a rent.** There is no bonus, no close factor and
///            no liquidation fee. `_accrue` adds `min(rho, bid) * D * dt` to the
///            borrower's debt, capped by `BufferMath.rentCap` so the rent can
///            never eat the buffer line. Lenders earn exactly that: it lands in
///            `loans`, which is part of `assets()`.
///
///         2. **There is no keeper.** `_accrue` is a pure function of (elapsed
///            time, price, rent). `poke` pays the caller nothing, so there is no
///            race to run it and no MEV to extract; the state after `poke` is
///            the state the protocol owed the borrower whether or not anyone
///            called. `_accrue` is idempotent within a block.
///
///         3. **The invariant is the safety mechanism.** `S = V - c*D >= 0` is
///            maintained by every transition, and `c > 1` makes `S >= 0` imply
///            `V > D`. A "liquidatable" state is not prevented by a keeper that
///            arrives in time; it has no preimage in the transition relation.
///
///         What this contract does **not** do, deliberately:
///           - it does not pause accrual (a pause would break decision 3);
///           - it does not promise that a price gap cannot break S. When it
///             does, `writeOff` socialises the loss immediately rather than
///             letting NAV lie;
///           - it does not take a fee. Rent is the whole revenue model.
contract ContinuumMarket {
    using SafeTransferLib for IERC20;

    // ---------------------------------------------------------------- constants
    uint256 public constant WAD = 1e18;
    uint256 public constant YEAR = 365 days;
    uint256 public constant BUCKETS = 64;
    uint256 public constant MIN_BID_LOCK = 1 hours;

    // ------------------------------------------------------------------ immutables
    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    IOracle public immutable oracle;
    ContinuumShares public immutable shares;

    uint256 public immutable collateralUnit; // 10**decimals(collateral)
    uint256 public immutable debtUnit; // 10**decimals(debt)
    uint256 public immutable c; // buffer discount, WAD, > 1
    uint256 public immutable target; // flow switches on below target*D, WAD, > c
    uint256 public immutable k; // flow speed, WAD/yr
    uint256 public immutable rhoCap; // rent ceiling, WAD/yr
    uint256 public immutable eta; // gain per call, WAD
    uint256 public immutable minBid; // floor on a borrower's rent bid, WAD/yr
    /// @notice Fraction of outstanding debt that must stay idle in the pool, WAD.
    ///         The flow can only repair what it can pay for, so protection is
    ///         only real while cash exists: at `target = 1.20` and `c = 1.02` a
    ///         fall to the buffer line costs about (1 - c/target) = 15% of the
    ///         debt. 20% is that number with a margin. Utilisation above
    ///         `1 - idleFloor` would sell protection the pool cannot deliver.
    uint256 public immutable idleFloor;
    uint256 public immutable stepCap; // half a bucket

    // --------------------------------------------------------------------- roles
    address public riskAdmin;

    // --------------------------------------------------------------------- pool
    uint256 public cash; // idle debt asset held by the pool
    uint256 public loans; // principal + capitalised rent owed by borrowers
    uint256 public inventory; // collateral units the pool bought from the flow
    uint256 public depositCap; // debt-asset units
    uint256 public borrowCap; // debt-asset units

    // --------------------------------------------------------------------- rent law
    uint256 public rho; // rent, WAD/yr
    uint256 public coveredDebtStored; // cached sum of buckets at or above rho
    uint256[64] internal demandByBucket;

    // ------------------------------------------------------------------ analytics
    uint256 public totalRent;
    /// @notice Σ over the demand book of `rate × debt`, in debt units per year.
    ///         The rent is accrued lazily per position, so `loans` only holds what
    ///         has already been materialised; this aggregate is what makes
    ///         `assets()` honest between materialisations (finding F9: a fresh
    ///         depositor could otherwise buy in at a stale NAV and capture rent
    ///         that was not theirs).
    uint256 public rateMassAbove; // debt in buckets whose upper bid edge exceeds rho
    uint256 public rateMassFixed; // Σ debt × upper(edge) / WAD for buckets at or below rho
    /// @notice Rent that has accrued but is not yet capitalised into `loans`.
    uint256 public unbookedRent;
    /// @notice Timestamp at which `unbookedRent` was last rolled forward.
    uint64 public lastRateUpdate;
    uint256 public totalDeleveraged;
    uint256 public totalWrittenOff;
    bool public borrowFrozen;

    // ------------------------------------------------------------------ positions
    struct Position {
        uint256 coll; // collateral units posted
        uint256 debt; // debt units owed
        uint256 bid; // maximum rent this borrower will pay, WAD/yr
        uint64 last; // last materialisation
        uint64 bidLock; // bid cannot be repriced before this timestamp
        uint256 bookBid; // the bid whose bucket currently carries this debt
        bool open;
    }

    mapping(address => Position) internal _pos;
    address[] public borrowers;
    mapping(address => bool) internal _known;

    // --------------------------------------------------------------------- events
    event Supplied(address indexed who, uint256 amount, uint256 shares);
    event Withdrawn(address indexed who, uint256 amount, uint256 shares);
    event CollateralDeposited(address indexed who, uint256 units, uint256 value);
    event CollateralWithdrawn(address indexed who, uint256 units);
    event Borrowed(address indexed who, uint256 amount, uint256 debt);
    event Repaid(address indexed who, uint256 amount);
    event Accrued(address indexed who, uint256 rent, uint256 deleveraged, uint256 seized, uint256 price);
    event BidSet(address indexed who, uint256 bid, uint256 lockedUntil);
    event RentUpdated(uint256 rho, int256 imbalance);
    event InventoryBought(address indexed who, uint256 units, uint256 paid);
    event BadDebtSocialised(address indexed who, uint256 shortfall, uint256 collateralSeized);
    event RiskParams(uint256 depositCap, uint256 borrowCap, bool borrowFrozen);

    // ---------------------------------------------------------------------- errors
    error ZeroAmount();
    error Ltv();
    error BufferLine();
    error NotOpen();
    error InsufficientCollateral();
    error BidTooLow();
    error BidLocked();
    error Cap();
    error Frozen();
    error InsufficientCash();
    error OnlyAdmin();
    error Reentrancy();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyAdmin() {
        if (msg.sender != riskAdmin) revert OnlyAdmin();
        _;
    }

    /// @notice Deployment parameters, grouped so the constructor cannot run out
    ///         of stack and so a deployment script can be read as a config file.
    struct Params {
        IERC20 collateralToken;
        IERC20 debtToken;
        IOracle oracle;
        uint256 c; // buffer discount, WAD, > 1
        uint256 target; // flow switches on below target*D, WAD, > c
        uint256 k; // flow speed, WAD/yr
        uint256 rhoCap; // rent ceiling, WAD/yr
        uint256 eta; // gain per rent update, WAD
        uint256 minBid; // floor on a borrower's bid, WAD/yr
        uint256 idleFloor; // fraction of debt that must stay idle, WAD
        string shareName;
        string shareSymbol;
    }

    constructor(Params memory q) {
        require(q.c > WAD, "c <= 1");
        require(q.target > q.c, "target <= c");
        require(q.rhoCap / BUCKETS > 0, "rho cap");
        require(q.minBid <= q.rhoCap, "min bid");
        require(q.k > 0, "k");
        require(q.idleFloor < WAD, "idle floor");

        collateralToken = q.collateralToken;
        debtToken = q.debtToken;
        oracle = q.oracle;
        collateralUnit = 10 ** q.collateralToken.decimals();
        debtUnit = 10 ** q.debtToken.decimals();
        c = q.c;
        target = q.target;
        k = q.k;
        rhoCap = q.rhoCap;
        eta = q.eta;
        minBid = q.minBid;
        idleFloor = q.idleFloor;
        stepCap = (q.rhoCap / BUCKETS) / 2;

        shares = new ContinuumShares(q.shareName, q.shareSymbol, q.debtToken.decimals(), address(this));
        riskAdmin = msg.sender;
        lastRateUpdate = uint64(block.timestamp);
        rho = q.minBid; // the law is two-sided; the floor is the demand side's own
    }

    // =========================================================================
    //  Views
    // =========================================================================

    function price() public view returns (uint256) {
        return oracle.price();
    }

    function collateralValueOf(uint256 units, uint256 p) public view returns (uint256) {
        return BufferMath.valueOf(units, p, collateralUnit, debtUnit);
    }

    function collateralValue(address who) public view returns (uint256) {
        return collateralValueOf(_pos[who].coll, price());
    }

    function positionOf(address who)
        external
        view
        returns (uint256 coll, uint256 debt, uint256 bid, uint64 last, uint64 bidLock)
    {
        Position memory p = _pos[who];
        return (p.coll, p.debt, p.bid, p.last, p.bidLock);
    }

    /// @notice S = V - c*D, exact, in WAD-scaled debt units. Negative means the
    ///         buffer line is broken; nothing but a price gap can do that.
    function surplusOf(address who) public view returns (int256) {
        Position memory p = _pos[who];
        return BufferMath.surplus(collateralValueOf(p.coll, price()), p.debt, c);
    }

    /// @notice V/D. The mechanism never consults it; integrators will.
    function healthOf(address who) public view returns (uint256) {
        Position memory p = _pos[who];
        return BufferMath.health(collateralValueOf(p.coll, price()), p.debt);
    }

    function inventoryValue() public view returns (uint256) {
        return collateralValueOf(inventory, price());
    }

    /// @notice Rent owed by borrowers but not yet materialised into `loans`.
    /// @dev The rate per position is `min(rho, bid)`; the aggregate uses each
    ///      bucket's **upper** edge, so it is a slight over-estimate and the
    ///      error can only ever favour the pool on entry. Bounded by one bucket
    ///      width of rate (rhoCap/64 = 15.6 bp/yr) times the elapsed time.
    function pendingRent() public view returns (uint256) {
        return unbookedRent + (rateDebt() * (block.timestamp - lastRateUpdate)) / YEAR;
    }

    /// @notice Aggregate rent rate of the book, in debt units per year.
    /// @dev Split so it stays O(1): buckets whose upper bid edge is at or below
    ///      the rent contribute a fixed amount (`rateMassFixed`); every bucket
    ///      above it contributes `rho`. So `rate = A + rho·M`, and a rent move
    ///      only reclassifies the one bucket it crosses.
    function rateDebt() public view returns (uint256) {
        return rateMassFixed + (rho * rateMassAbove) / WAD;
    }

    /// @notice Pool assets: idle cash + what borrowers owe + inventory at mark
    ///         + rent owed but not yet booked.
    function assets() public view returns (uint256) {
        return cash + loans + inventoryValue() + pendingRent();
    }

    function sharePrice() external view returns (uint256) {
        uint256 supply = shares.totalSupply();
        if (supply == 0) return WAD;
        return (assets() * WAD) / supply;
    }

    function previewDeposit(uint256 amount) public view returns (uint256) {
        uint256 supply = shares.totalSupply();
        return (amount * (supply + 1)) / (assets() + 1);
    }

    function previewRedeem(uint256 shareAmount) public view returns (uint256) {
        uint256 supply = shares.totalSupply();
        if (supply == 0) return 0;
        return (shareAmount * assets()) / supply;
    }

    function bucketOf(uint256 bid) public view returns (uint256) {
        uint256 b = (bid * BUCKETS) / (rhoCap + 1);
        return b >= BUCKETS ? BUCKETS - 1 : b;
    }

    function firstCoveredBucket(uint256 rent) public view returns (uint256) {
        uint256 b = _ceilDiv(rent * BUCKETS, rhoCap + 1);
        return b > BUCKETS ? BUCKETS : b;
    }

    /// @notice Debt whose bid is at least the current rent — the demand side of
    ///         the rent law, maintained incrementally so `updateRho` is O(1).
    function coveredDebt() public view returns (uint256) {
        return coveredDebtStored;
    }

    /// @notice Demand net of supply. The supply side is `cash`: capital that is
    ///         lent out cannot extinguish anybody's debt, so the rent prices
    ///         idle capital, exactly like a funding rate prices open interest.
    function imbalance() public view returns (int256) {
        return BufferMath.imbalance(coveredDebtStored, cash);
    }

    function demandAt(uint256 b) external view returns (uint256) {
        return demandByBucket[b];
    }

    // =========================================================================
    //  Lender side
    // =========================================================================

    /// @notice Deposit the debt asset. Rent accrues to the pool, so the share
    ///         price rises; there is no separate reward token and no gauge.
    function deposit(uint256 amount) external nonReentrant returns (uint256 minted) {
        if (amount == 0) revert ZeroAmount();
        if (cash + loans + inventoryValue() + amount > depositCap && depositCap != 0) revert Cap();
        minted = previewDeposit(amount);
        if (minted == 0) revert ZeroAmount();
        debtToken.safeTransferIn(msg.sender, amount);
        cash += amount;
        shares.mint(msg.sender, minted);
        emit Supplied(msg.sender, amount, minted);
    }

    function withdraw(uint256 shareAmount) external nonReentrant returns (uint256 amount) {
        if (shareAmount == 0) revert ZeroAmount();
        amount = previewRedeem(shareAmount);
        if (amount > cash) revert InsufficientCash();
        // burn before the transfer: no reentrancy window, no double spend
        shares.burn(msg.sender, shareAmount);
        cash -= amount;
        debtToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, shareAmount);
    }

    // =========================================================================
    //  Borrower side
    // =========================================================================

    function depositCollateral(uint256 units) external nonReentrant {
        if (units == 0) revert ZeroAmount();
        Position storage p = _pos[msg.sender];
        _materialise(msg.sender);
        collateralToken.safeTransferIn(msg.sender, units);
        p.coll += units;
        emit CollateralDeposited(msg.sender, units, collateralValueOf(units, price()));
    }

    function withdrawCollateral(uint256 units) external nonReentrant {
        if (units == 0) revert ZeroAmount();
        _materialise(msg.sender);
        Position storage p = _pos[msg.sender];
        if (units > p.coll) revert InsufficientCollateral();
        p.coll -= units;
        // the withdrawal itself may never break the buffer line
        uint256 V = collateralValueOf(p.coll, price());
        if (V < (c * p.debt) / WAD) revert BufferLine();
        collateralToken.safeTransfer(msg.sender, units);
        emit CollateralWithdrawn(msg.sender, units);
    }

    /// @notice Borrow against posted collateral. The entry gate is the *target*
    ///         line, not the buffer line: a new position starts with the whole
    ///         buffer intact, which is what makes the flow's job a repair rather
    ///         than a rescue.
    function borrow(uint256 amount, uint256 bid) external nonReentrant returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        if (borrowFrozen) revert Frozen();
        if (bid < minBid) revert BidTooLow();
        Position storage p = _pos[msg.sender];
        if (p.bid != 0 && block.timestamp < p.bidLock) revert BidLocked();

        _materialise(msg.sender);
        _borrowGates(msg.sender, amount);

        uint256 newDebt = p.debt + amount;

        if (!p.open) {
            p.open = true;
            p.last = uint64(block.timestamp);
            if (!_known[msg.sender]) {
                _known[msg.sender] = true;
                borrowers.push(msg.sender);
            }
        }
        if (p.bookBid != bid) {
            _unbook(msg.sender, p.debt);
            p.bookBid = bid;
            _book(msg.sender, p.debt);
        }
        p.bid = bid;
        p.bidLock = uint64(block.timestamp + MIN_BID_LOCK);
        p.debt = newDebt;

        _book(msg.sender, amount);
        loans += amount;
        cash -= amount;
        debtToken.safeTransfer(msg.sender, amount);

        emit Borrowed(msg.sender, amount, newDebt);
        emit BidSet(msg.sender, bid, p.bidLock);
        return amount;
    }

    /// @dev Every reason a borrow can be refused, in one place so the main
    ///      function stays readable (and compiles without `viaIR`):
    ///      cash available, idle floor, cap, and the target-LTV gate.
    function _borrowGates(address who, uint256 amount) internal view {
        if (amount > cash) revert InsufficientCash();
        uint256 newLoans = loans + amount;
        if (cash - amount < (idleFloor * newLoans) / WAD) revert InsufficientCash();
        if (newLoans > borrowCap && borrowCap != 0) revert Cap();
        if (collateralValueOf(_pos[who].coll, price()) < (target * (_pos[who].debt + amount)) / WAD) revert Ltv();
    }

    function repay(uint256 amount) external nonReentrant returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        _materialise(msg.sender);
        Position storage p = _pos[msg.sender];
        if (amount > p.debt) amount = p.debt;
        if (amount == 0) return 0;
        debtToken.safeTransferIn(msg.sender, amount);
        p.debt -= amount;
        _unbook(msg.sender, amount);
        loans -= amount;
        cash += amount;
        emit Repaid(msg.sender, amount);
        return amount;
    }

    /// @notice Reprice the rent this borrower will pay. Locked for
    ///         `MIN_BID_LOCK` so the book cannot be pumped and pulled around a
    ///         single block's rent update.
    function setBid(uint256 bid, uint256 lockSecs) external {
        if (bid < minBid) revert BidTooLow();
        Position storage p = _pos[msg.sender];
        if (block.timestamp < p.bidLock) revert BidLocked();
        if (lockSecs < MIN_BID_LOCK) revert BidLocked();
        _materialise(msg.sender);
        _unbook(msg.sender, p.debt);
        p.bookBid = bid;
        _book(msg.sender, p.debt);
        p.bid = bid;
        p.bidLock = uint64(block.timestamp + lockSecs);
        emit BidSet(msg.sender, bid, p.bidLock);
    }

    // =========================================================================
    //  The mechanism
    // =========================================================================

    /// @notice Materialise a position. Pays the caller nothing: the resulting
    ///         state does not depend on who called or in which block, only on
    ///         how much time passed. Idempotent inside a block.
    function poke(address who) external {
        _materialise(who);
    }

    function pokeMany(address[] calldata who) external {
        for (uint256 i = 0; i < who.length; ++i) _materialise(who[i]);
    }

    /// @notice Update the rent. Permissionless and unpaid: the new rent is a
    ///         function of the book, not of the caller.
    function updateRho() external returns (uint256) {
        int256 z = imbalance();
        int256 delta = BufferMath.step(z, eta, stepCap);
        uint256 old = rho;
        uint256 next = BufferMath.clip(int256(old) + delta, rhoCap);
        if (next < minBid) next = minBid; // the rent can never be free
        if (next != old) {
            _relevelCovered(old, next);
            _adjustRates(old, next);
            rho = next;
        }
        emit RentUpdated(next, z);
        return next;
    }

    function _materialise(address who) internal {
        Position storage p = _pos[who];
        if (!p.open) return;
        uint256 dt = block.timestamp - p.last;
        if (dt == 0) return; // idempotent inside a block, by construction
        p.last = uint64(block.timestamp);
        if (p.debt == 0) return;

        uint256 p0 = price();
        uint256 debtBefore = p.debt;

        uint256 rent = _chargeRent(p, collateralValueOf(p.coll, p0), dt);
        (uint256 extinguished, uint256 seized) = _deleverage(p, p0, dt);

        _syncBook(who, debtBefore);
        emit Accrued(who, rent, extinguished, seized, p0);
    }

    /// @dev Flow 1. Rent is capitalised into the debt, which is where the
    ///      lenders' yield comes from, and it is capped so it can never eat the
    ///      buffer line: c*(D+r) <= V must still hold afterwards.
    function _chargeRent(Position storage p, uint256 V, uint256 dt) internal returns (uint256 rent) {
        uint256 rate = p.bid < rho ? p.bid : rho; // never above what the borrower agreed to
        rent = (((rate * p.debt) / WAD) * dt) / YEAR;
        uint256 capRent = BufferMath.rentCap(V, p.debt, c);
        if (rent > capRent) rent = capRent;
        if (rent > 0) {
            _rollAccrual();
            p.debt += rent;
            loans += rent;
            totalRent += rent;
            // it is on the books now, so it must leave the unbooked estimate
            unbookedRent = rent >= unbookedRent ? 0 : unbookedRent - rent;
        }
    }

    /// @dev Flow 2. The pool pays the debt at par and takes collateral at the
    ///      discount. Collateral units are rounded DOWN, so the surplus can only
    ///      grow: S' = S + (c*x - seizedValue) >= S.
    function _deleverage(Position storage p, uint256 p0, uint256 dt)
        internal
        returns (uint256 extinguished, uint256 seized)
    {
        if (p.bid < rho) return (0, 0); // a bid below the clearing rent buys no service
        uint256 gapValue = BufferMath.gap(collateralValueOf(p.coll, p0), p.debt, target);
        if (gapValue == 0) return (0, 0);
        uint256 x = BufferMath.flow(gapValue, k, dt);
        if (x > p.debt) x = p.debt;
        if (x > cash) x = cash;
        // The pool may only take collateral it is paying for. Without this cap a
        // near-empty position hands over less collateral than c*x and the
        // surplus falls — the one way the flow could ever break its own
        // invariant, observed once in campaign A as S = -1.26 USDC.
        uint256 maxX = (collateralValueOf(p.coll, p0) * WAD) / c;
        if (x > maxX) x = maxX;
        if (x == 0) return (0, 0);

        seized = BufferMath.unitsForValue((c * x) / WAD, p0, collateralUnit, debtUnit);
        if (seized > p.coll) seized = p.coll;
        p.coll -= seized;
        p.debt -= x;
        inventory += seized;
        loans -= x;
        cash -= x;
        totalDeleveraged += x;
        return (x, seized);
    }

    /// @dev Keep the demand book equal to the debt it weights.
    function _syncBook(address who, uint256 debtBefore) internal {
        uint256 afterDebt = _pos[who].debt;
        if (afterDebt == debtBefore) return;
        if (afterDebt > debtBefore) _book(who, afterDebt - debtBefore);
        else _unbook(who, debtBefore - afterDebt);
    }

    // =========================================================================
    //  Inventory
    // =========================================================================

    /// @notice Buy collateral the pool acquired from the flow. The pool bought
    ///         at `1/c` of the mark and sells at the mark: that spread, not a
    ///         liquidation fee, is the underwriters' compensation for holding an
    ///         unlevered spot position.
    function buyInventory(uint256 units, uint256 maxPay) external nonReentrant returns (uint256 paid) {
        if (units == 0 || units > inventory) revert ZeroAmount();
        paid = collateralValueOf(units, price());
        if (paid > maxPay) revert Cap();
        inventory -= units;
        debtToken.safeTransferIn(msg.sender, paid);
        cash += paid;
        collateralToken.safeTransfer(msg.sender, units);
        emit InventoryBought(msg.sender, units, paid);
    }

    // =========================================================================
    //  The tail
    // =========================================================================

    /// @notice Realise a loss that a price gap created. Callable by anyone, and
    ///         required to be callable: while a position is underwater its debt
    ///         is on the books at face value, which overstates `assets()`.
    ///         The pool takes the collateral at the mark and eats the shortfall.
    function writeOff(address who) external nonReentrant returns (uint256 shortfall) {
        _materialise(who);
        Position storage p = _pos[who];
        if (!p.open) revert NotOpen();
        uint256 p0 = price();
        uint256 V = collateralValueOf(p.coll, p0);
        if (V >= p.debt) revert BufferLine(); // solvent: nothing to write off

        shortfall = p.debt - V;
        uint256 seizedUnits = p.coll;
        p.coll = 0;
        inventory += seizedUnits;
        _unbook(who, p.debt);
        p.debt = 0;
        loans -= shortfall; // the pool's claim shrinks to what the collateral is worth
        totalWrittenOff += shortfall;
        emit BadDebtSocialised(who, shortfall, seizedUnits);
    }

    // =========================================================================
    //  Risk admin — caps only, never the mechanism
    // =========================================================================

    function setRiskParams(uint256 depositCap_, uint256 borrowCap_, bool frozen_) external onlyAdmin {
        depositCap = depositCap_;
        borrowCap = borrowCap_;
        borrowFrozen = frozen_;
        emit RiskParams(depositCap_, borrowCap_, frozen_);
    }

    function setRiskAdmin(address next) external onlyAdmin {
        require(next != address(0), "zero");
        riskAdmin = next;
    }

    // =========================================================================
    //  Demand book — O(1) maintenance
    // =========================================================================

    /// @dev Capitalise the live term into `unbookedRent`. Must run before any
    ///      change to `rateDebt`, otherwise the elapsed time would be priced at
    ///      the new rate instead of the one that was in force.
    function _rollAccrual() internal {
        uint256 dt = block.timestamp - lastRateUpdate;
        if (dt > 0) unbookedRent += (rateDebt() * dt) / YEAR;
        lastRateUpdate = uint64(block.timestamp);
    }

    /// @dev Upper edge of a bucket's bid range.
    function _bucketUpper(uint256 b) internal view returns (uint256) {
        return ((b + 1) * (rhoCap + 1)) / BUCKETS;
    }

    /// @dev Rent rate attributed to a bucket: the clearing rent, capped by the
    ///      bucket's upper bid edge.
    function _bucketRate(uint256 b) internal view returns (uint256) {
        uint256 upper = _bucketUpper(b);
        return rho < upper ? rho : upper;
    }

    /// @dev Reclassify the buckets the rent crossed, without walking the book.
    ///      Moving up from `lo` to `hi`, a bucket whose upper edge lies in
    ///      `(lo, hi]` stops being priced at `rho` and becomes fixed at its edge:
    ///          b from lo*BUCKETS/(rhoCap+1) to hi*BUCKETS/(rhoCap+1), exclusive
    ///      and because one step is capped at half a bucket, that window holds at
    ///      most one bucket. `verify/attack.cjs` F14 checks the aggregate against
    ///      a full recomputation after many updates.
    function _adjustRates(uint256 oldRho, uint256 newRho) internal {
        if (oldRho == newRho) return;
        _rollAccrual();
        uint256 lo = oldRho < newRho ? oldRho : newRho;
        uint256 hi = oldRho < newRho ? newRho : oldRho;
        uint256 b0 = (lo * BUCKETS) / (rhoCap + 1);
        uint256 b1 = (hi * BUCKETS) / (rhoCap + 1);
        if (b1 > BUCKETS) b1 = BUCKETS;
        bool up = newRho > oldRho;
        for (uint256 b = b0; b < b1; ++b) {
            uint256 m = demandByBucket[b];
            if (m == 0) continue;
            uint256 fixedPart = (m * _bucketUpper(b)) / WAD;
            if (up) {
                // leaves the floating mass, becomes fixed at its edge
                rateMassAbove = m > rateMassAbove ? 0 : rateMassAbove - m;
                rateMassFixed += fixedPart;
            } else {
                // falls back under the rent, becomes floating again
                rateMassAbove += m;
                rateMassFixed = fixedPart > rateMassFixed ? 0 : rateMassFixed - fixedPart;
            }
        }
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _bucketCovered(uint256 b, uint256 rent) internal view returns (bool) {
        return b >= _ceilDiv(rent * BUCKETS, rhoCap + 1);
    }

    function _book(address who, uint256 amount) internal {
        if (amount == 0) return;
        uint256 b = bucketOf(_pos[who].bookBid);
        _rollAccrual();
        demandByBucket[b] += amount;
        if (_bucketUpper(b) <= rho) rateMassFixed += (amount * _bucketUpper(b)) / WAD;
        else rateMassAbove += amount;
        if (_bucketCovered(b, rho)) coveredDebtStored += amount;
    }

    function _unbook(address who, uint256 amount) internal {
        if (amount == 0) return;
        uint256 b = bucketOf(_pos[who].bookBid);
        _rollAccrual();
        uint256 cur = demandByBucket[b];
        uint256 cut = amount > cur ? cur : amount;
        demandByBucket[b] = cur - cut;
        if (_bucketUpper(b) <= rho) {
            uint256 fixedCut = (cut * _bucketUpper(b)) / WAD;
            rateMassFixed = fixedCut > rateMassFixed ? 0 : rateMassFixed - fixedCut;
        } else {
            rateMassAbove = cut > rateMassAbove ? 0 : rateMassAbove - cut;
        }
        if (_bucketCovered(b, rho)) {
            uint256 cov = coveredDebtStored;
            coveredDebtStored = cut > cov ? 0 : cov - cut;
        }
    }

    /// @dev Move the cached covered mass when the rent crosses bucket edges.
    ///      One step is at most half a bucket, so this loop runs at most once in
    ///      practice; it is bounded by BUCKETS so it can never be unbounded.
    function _relevelCovered(uint256 oldRho, uint256 newRho) internal {
        uint256 lo0 = firstCoveredBucket(oldRho);
        uint256 lo1 = firstCoveredBucket(newRho);
        if (lo1 > lo0) {
            for (uint256 b = lo0; b < lo1 && b < BUCKETS; ++b) {
                uint256 m = demandByBucket[b];
                uint256 cov = coveredDebtStored;
                coveredDebtStored = m > cov ? 0 : cov - m;
            }
        } else if (lo1 < lo0) {
            for (uint256 b = lo1; b < lo0 && b < BUCKETS; ++b) {
                coveredDebtStored += demandByBucket[b];
            }
        }
    }
}
