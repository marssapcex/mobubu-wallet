// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset, NativeAssets} from "../NativeAssets.sol";
import {HcmtPins} from "../dao/HcmtPins.sol";
import {HcmtTreasury} from "../dao/HcmtTreasury.sol";
import {WithdrawalOrder, WithdrawalRate, WithdrawalTerms, IFinalizedEvents} from "./WithdrawalTerms.sol";

/// @notice One immutable inbound route. LP inventory is completely separate from local custody notes.
contract CrosschainLiquidity {
    uint8 private constant RESERVED = 1;
    uint8 private constant PAID = 2;
    uint8 private constant CANCELLED = 3;
    uint256 public immutable homeChainId;
    uint256 public immutable sourceChain;
    uint256 public immutable transferCap;
    address public immutable sourceVault;
    HcmtTreasury public immutable treasury;
    IFinalizedEvents public immutable finality;

    mapping(address provider => uint256) public freeLiquidity;
    mapping(bytes32 order => uint8) public status;
    uint256 public availableNative;
    uint256 public reservedNative;
    bool private entered;

    event SettlementMessage(uint8 indexed kind, bytes32 indexed order, bytes32 data);
    event DestinationPaid(bytes32 indexed order, address indexed recipient, uint96 gross, uint96 levy, uint96 net);
    event LiquidityFunded(address indexed provider, uint256 amount);
    event LiquidityWithdrawn(address indexed provider, address to, uint256 amount);

    error BadConfig();
    error InsufficientLiquidity();
    error WrongState();
    error WrongQuote();
    error PayoutFailed();

    constructor(uint256 fromChain, address fromVault, HcmtTreasury box, IFinalizedEvents receipts) {
        NativeAsset a = WithdrawalTerms.asset(block.chainid);
        if (WithdrawalTerms.asset(fromChain) == a || fromVault == address(0) || address(receipts).code.length == 0
            || address(box).codehash != HcmtPins.treasury(a == NativeAsset.TRX) || box.homeChainId() != block.chainid) revert BadConfig();
        homeChainId = block.chainid;
        sourceChain = fromChain;
        transferCap = NativeAssets.ceiling(a);
        sourceVault = fromVault;
        treasury = box;
        finality = receipts;
    }

    modifier guard() {
        if (entered || block.chainid != homeChainId) revert WrongState();
        entered = true;
        _;
        entered = false;
    }

    function fundLiquidity() external payable guard {
        if (msg.value == 0) revert InsufficientLiquidity();
        availableNative += msg.value;
        freeLiquidity[msg.sender] += msg.value;
        emit LiquidityFunded(msg.sender, msg.value);
    }

    function withdrawLiquidity(uint256 amount, address payable to) external guard {
        if (amount == 0 || amount > transferCap || amount > freeLiquidity[msg.sender]
            || to == address(0) || to == address(this)) revert InsufficientLiquidity();
        freeLiquidity[msg.sender] -= amount;
        availableNative -= amount;
        _pay(to, amount);
        emit LiquidityWithdrawn(msg.sender, to, amount);
    }

    function reserve(WithdrawalOrder calldata o) external guard returns (bytes32 id) {
        id = _order(o);
        WithdrawalTerms.acceptanceOpen(o);
        if (msg.sender != o.destinationLP || status[id] != 0) revert WrongState();
        if (o.liquidityLimit > freeLiquidity[msg.sender] || address(this).balance < availableNative + reservedNative) revert InsufficientLiquidity();
        freeLiquidity[msg.sender] -= o.liquidityLimit;
        availableNative -= o.liquidityLimit;
        reservedNative += o.liquidityLimit;
        status[id] = RESERVED;
        emit SettlementMessage(WithdrawalTerms.RESERVED, id, bytes32(0));
    }

    /// Permissionless gas sponsor. The rate is from the proved source lock, never the current price.
    function pay(WithdrawalOrder calldata o, WithdrawalRate calldata rate, bytes calldata lockProof) external guard {
        bytes32 id = _order(o);
        if (status[id] != RESERVED || block.timestamp >= o.payBy) revert WrongState();
        (uint96 gross, uint96 levy, uint96 net) = WithdrawalTerms.payout(o, rate.priceIn18, rate.priceOut18);
        if (rate.grossOut != gross || rate.epoch == bytes32(0) || rate.acceptedAt == 0 || rate.acceptedAt >= o.acceptBy) revert WrongQuote();
        bytes32 data = keccak256(abi.encode(rate));
        WithdrawalTerms.authenticated(finality, sourceChain, sourceVault, WithdrawalTerms.LOCKED, id, data, lockProof);
        status[id] = PAID;
        _free(o, uint256(o.liquidityLimit) - gross);
        if (levy != 0) _pay(payable(address(treasury)), levy);
        _pay(payable(o.recipient), net);
        emit DestinationPaid(id, o.recipient, gross, levy, net);
        emit SettlementMessage(WithdrawalTerms.PAID, id, data);
    }

    /// Destination makes a mutually exclusive terminal decision. Elapsed time alone cannot refund source funds.
    function cancel(WithdrawalOrder calldata o) external guard {
        bytes32 id = _order(o);
        if (status[id] != RESERVED || block.timestamp < o.payBy) revert WrongState();
        status[id] = CANCELLED;
        _free(o, o.liquidityLimit);
        emit SettlementMessage(WithdrawalTerms.CANCELLED, id, bytes32(0));
    }

    function _order(WithdrawalOrder calldata o) private view returns (bytes32) {
        WithdrawalTerms.validate(o);
        if (o.sourceChain != sourceChain || o.sourceVault != sourceVault || o.destinationChain != homeChainId
            || o.destinationVault != address(this) || o.recipient == address(treasury)) revert BadConfig();
        return WithdrawalTerms.id(o);
    }

    function _free(WithdrawalOrder calldata o, uint256 surplus) private {
        reservedNative -= o.liquidityLimit;
        availableNative += surplus;
        freeLiquidity[o.destinationLP] += surplus;
    }

    function _pay(address payable to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PayoutFailed();
    }
}
