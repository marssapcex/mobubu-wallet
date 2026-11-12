// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISpoke, IERC20Min} from "./AaveV4.sol";
import {AaveV4Math} from "./AaveV4Math.sol";

interface IRentLaw {
    function rho() external view returns (uint256);
}

interface IPriceWad {
    function priceWad() external view returns (uint256);
}

/// @title AaveV4Buffer — Continuum's rent market in front of an Aave v4 Spoke
/// @notice The same one mechanism, applied to a live lending market. A borrower
///         opts in; while the position's health factor sits under `hfFloor`
///         (strictly above Aave's hard gate at 1.0) the buffer repays the Spoke
///         on the borrower's behalf, continuously, for a rent priced by the
///         buffer's own feedback law `rho`.
///
///         What the buffer is *not*: a liquidator. It never calls
///         `liquidationCall`, never takes a bonus, never chooses a moment. The
///         state transition `cover()` is a pure function of (health factor,
///         elapsed time), so it pays no keeper and cannot be raced.
///
///         Borrower consent is the only admission rule, because a cover is a
///         debt the borrower owes the pool: `register()` is the opt-in.
///         If the position still crosses Aave's gate the borrower is liquidated
///         by Aave as before, and the pool's principal is impaired — that is
///         the risk underwriters are paid for, sized by `rho`, not hidden.
contract AaveV4Buffer {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant YEAR = 365 days;

    ISpoke public immutable spoke;
    IERC20Min public immutable cash; // the Spoke's debt asset (also the pool asset)
    IPriceWad public immutable price; // debt asset price, WAD
    IRentLaw public immutable law; // Continuum, the source of rho

    uint256 public immutable debtReserveId;
    uint256 public immutable unit; // debt asset unit (1e6 USDC, 1e18 DAI)
    uint256 public immutable hfFloor; // cover switches on below this
    uint256 public immutable hfTarget; // and restores to this
    uint256 public immutable rhoCap; // hard ceiling on what the pool may charge

    struct Cover {
        uint128 principal; // cash the pool has paid into the Spoke for this user
        uint128 rentOwed; // accrued, unpaid rent
        uint64 last; // last accrual
        bool opted;
    }

    mapping(address => Cover) public covers;
    address[] public users;

    // ---- pool -----------------------------------------------------------------
    uint256 public poolCash; // cash available to cover
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    uint256 public accRentPerShare; // WAD, cumulative
    mapping(address => uint256) public rentDebt; // per-supplier accumulator snapshot
    mapping(address => uint256) public rentClaimed;
    uint256 public rentPaidOut;
    uint256 public writtenOff;

    event Registered(address indexed user);
    event Covered(address indexed user, uint256 paid, uint256 principal);
    event Repaid(address indexed user, uint256 toRent, uint256 toPrincipal);
    event Loss(address indexed user, uint256 principal);
    event Supplied(address indexed who, uint256 amount, uint256 shares);
    event Withdrawn(address indexed who, uint256 amount, uint256 shares);
    event RentClaimed(address indexed who, uint256 amount);

    constructor(
        ISpoke spoke_,
        IERC20Min cash_,
        IPriceWad price_,
        IRentLaw law_,
        uint256 debtReserveId_,
        uint256 unit_,
        uint256 hfFloor_,
        uint256 hfTarget_,
        uint256 rhoCap_
    ) {
        require(hfFloor_ > WAD, "floor must sit above Aave's gate");
        require(hfTarget_ > hfFloor_, "target must sit above floor");
        require(rhoCap_ > 0, "cap");
        spoke = spoke_;
        cash = cash_;
        price = price_;
        law = law_;
        debtReserveId = debtReserveId_;
        unit = unit_;
        hfFloor = hfFloor_;
        hfTarget = hfTarget_;
        rhoCap = rhoCap_;
    }

    // ------------------------------------------------------------- borrower side
    function register() external {
        Cover storage k = covers[msg.sender];
        if (!k.opted) {
            k.opted = true;
            k.last = uint64(block.timestamp);
            users.push(msg.sender);
            emit Registered(msg.sender);
        }
    }

    /// @notice Current rent, WAD/yr: the buffer's feedback law, capped.
    function rho() public view returns (uint256 r) {
        r = law.rho();
        if (r > rhoCap) r = rhoCap;
    }

    /// @notice Accrued rent for a user, including the period not yet materialised.
    function pendingRent(address user) public view returns (uint256) {
        Cover memory k = covers[user];
        if (k.principal == 0) return k.rentOwed;
        uint256 dt = block.timestamp - k.last;
        return k.rentOwed + (rho() * k.principal * dt) / (WAD * YEAR);
    }

    /// @notice Health factor of a covered position, straight from the Spoke.
    function healthOf(address user) public view returns (uint256, uint256, uint256) {
        ISpoke.UserAccountData memory a = spoke.getUserAccountData(user);
        return (a.healthFactor, a.totalCollateralValue, a.totalDebtValueRay);
    }

    /// @notice The whole mechanism, on a real Spoke. Idempotent in time: calling
    ///         it twice in one block pays nothing the second time. Anyone may
    ///         call it; the caller receives nothing, so there is no keeper race.
    /// @param user the covered borrower
    /// @param maxAmount cap on this call's cash outlay (units of the debt asset)
    /// @return paid units actually repaid into the Spoke
    function cover(address user, uint256 maxAmount) external returns (uint256 paid) {
        Cover storage k = covers[user];
        require(k.opted, "not opted in");
        _accrueRent(user, k);
        if (k.principal == 0 && k.rentOwed == 0 && k.last == 0) k.last = uint64(block.timestamp);

        (uint256 hf, uint256 collValue,) = healthOf(user);
        if (hf >= hfFloor) return 0; // flow is off above the floor
        if (hf == 0) return 0;

        // value (WAD) that must be repaid to lift hf to hfTarget; the same closed
        // form Aave uses for its own target-HF sizing, with penalty 0 since the
        // buffer pays the debt at par (no bonus is transferred anywhere).
        uint256 debtValue = _debtValueWad(user);
        uint256 valueToRepay = (debtValue * (hfTarget - hf)) / hfTarget;
        uint256 p = price.priceWad();
        uint256 units = (valueToRepay * unit) / p;
        if (units > maxAmount) units = maxAmount;
        if (units > poolCash) units = poolCash;
        if (units == 0) return 0;

        require(cash.approve(address(spoke), units), "approve");
        (uint256 repaid,) = spoke.repay(debtReserveId, units, user);
        paid = repaid == 0 ? units : repaid;

        poolCash -= paid;
        k.principal = uint128(k.principal + paid);
        emit Covered(user, paid, k.principal);
    }

    /// @notice Borrower pays the pool back: rent first, then principal.
    function pay(uint256 amount) external {
        Cover storage k = covers[msg.sender];
        _accrueRent(msg.sender, k);
        require(amount > 0, "amount");
        require(cash.transferFrom(msg.sender, address(this), amount), "transferFrom");
        uint256 toRent = amount < k.rentOwed ? amount : k.rentOwed;
        k.rentOwed = uint128(k.rentOwed - toRent);
        uint256 rest = amount - toRent;
        uint256 toPrincipal = rest < k.principal ? rest : k.principal;
        k.principal = uint128(k.principal - toPrincipal);
        // what is not rent is liquidity again (principal returned), the rent is
        // distributed to the suppliers that carried the risk
        poolCash += toPrincipal;
        if (toRent > 0) _distribute(toRent);
        emit Repaid(msg.sender, toRent, toPrincipal);
    }

    /// @notice Aave liquidated the position first: the buffer's claim is junior.
    ///         Permissionless: the loss is a fact of the Spoke's state, not a
    ///         judgement. Removes the principal from the pool's NAV.
    function writeOff(address user) external {
        Cover storage k = covers[user];
        require(k.principal > 0, "nothing to write off");
        (uint256 hf,,) = healthOf(user);
        require(hf < WAD || _debtValueWad(user) == 0, "position still healthy");
        uint256 loss = k.principal;
        k.principal = 0;
        k.rentOwed = 0; // unsecured rent is not a claim on the pool
        writtenOff += loss;
        emit Loss(user, loss);
    }

    // ------------------------------------------------------------ supplier side
    function supply(uint256 amount) external returns (uint256 minted) {
        require(amount > 0, "amount");
        require(cash.transferFrom(msg.sender, address(this), amount), "transferFrom");
        _settle(msg.sender); // never forfeit rent already earned (B5)
        minted = totalShares == 0 ? amount : (amount * totalShares) / _nav();
        shares[msg.sender] += minted;
        totalShares += minted;
        poolCash += amount;
        emit Supplied(msg.sender, amount, minted);
    }

    function withdraw(uint256 amount) external returns (uint256 burned) {
        _settle(msg.sender);
        uint256 nav = _nav();
        burned = totalShares == 0 ? 0 : (amount * totalShares + nav - 1) / nav; // ceil
        require(burned <= shares[msg.sender], "shares");
        require(amount <= poolCash, "illiquid");
        shares[msg.sender] -= burned;
        totalShares -= burned;
        poolCash -= amount;
        require(cash.transfer(msg.sender, amount), "transfer");
        emit Withdrawn(msg.sender, amount, burned);
    }

    function pendingRentOf(address who) public view returns (uint256) {
        return (shares[who] * (accRentPerShare - rentDebt[who])) / WAD;
    }

    function claimRent() external returns (uint256 amount) {
        amount = pendingRentOf(msg.sender);
        rentDebt[msg.sender] = accRentPerShare;
        rentClaimed[msg.sender] += amount;
        rentPaidOut += amount;
        emit RentClaimed(msg.sender, amount);
    }

    /// @notice Pool NAV: idle cash + principal at par + rent receivable.
    function _nav() internal view returns (uint256) {
        uint256 receivables;
        uint256 n = users.length;
        for (uint256 i = 0; i < n; ++i) {
            Cover memory k = covers[users[i]];
            receivables += k.principal + k.rentOwed;
        }
        return poolCash + receivables;
    }

    function nav() external view returns (uint256) {
        return _nav();
    }

    /// @dev Realise what `who` has already earned. Called on every share
    ///      movement, so a supplier can never lose earned rent by supplying or
    ///      withdrawing (B5 in the audit log).
    function _settle(address who) internal {
        if (totalShares == 0) {
            rentDebt[who] = accRentPerShare;
            return;
        }
        uint256 pending = pendingRentOf(who);
        if (pending > 0) {
            rentClaimed[who] += pending;
            rentPaidOut += pending;
            emit RentClaimed(who, pending);
        }
        rentDebt[who] = accRentPerShare;
    }

    function _distribute(uint256 amount) internal {
        if (totalShares == 0) return;
        accRentPerShare += (amount * WAD) / totalShares;
    }

    function _accrueRent(address user, Cover storage k) internal {
        if (k.last == 0) k.last = uint64(block.timestamp);
        uint256 dt = block.timestamp - k.last;
        if (dt == 0) return;
        k.last = uint64(block.timestamp);
        if (k.principal == 0) return;
        uint256 r = (rho() * k.principal * dt) / (WAD * YEAR);
        if (r > 0) k.rentOwed = uint128(k.rentOwed + r);
    }

    function _debtValueWad(address user) internal view returns (uint256) {
        ISpoke.UserAccountData memory a = spoke.getUserAccountData(user);
        return a.totalDebtValueRay / 1e9; // RAY -> WAD
    }
}
