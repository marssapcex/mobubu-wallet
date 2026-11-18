// SPDX-License-Identifier: ISC
pragma solidity 0.8.24;

import {SlhDsaSha2_128s} from "./lib/SlhDsaSha2_128s.sol";

/// @notice Native ETH custody keyed by SLH-DSA-SHA2-128s public keys.
/// @dev Public accounts, not a privacy pool. No owner, proxy, attester or
/// ECDSA/Groth16 fallback. Ethereum's outer gas transaction is separate.
contract PostQuantumVault {
    bytes32 public constant AUTH_DOMAIN = keccak256("mobubu:SLH-DSA-SHA2-128s:eth-vault:v1");
    uint8 public constant DEPOSIT = 1;
    uint8 public constant WITHDRAW = 2;
    // Native ETH; kept in the signed domain so it cannot name another asset.
    address public constant ASSET = address(0);

    struct Account { uint256 balance; uint256 nonce; }
    mapping(bytes32 publicKey => Account) public accounts;
    uint256 public totalLocked;
    bool private paying;

    error InvalidPublicKey();
    error InvalidAmount();
    error InvalidRecipient();
    error AuthorizationExpired();
    error InvalidNonce();
    error InvalidSignature();
    error InsufficientBalance();
    error TransferFailed();
    error ReentrantCall();

    event Deposit(bytes32 indexed publicKey, address indexed payer, uint256 amount, uint256 nonce);
    event Withdrawal(bytes32 indexed publicKey, address indexed recipient, uint256 amount, uint256 nonce);

    /// @notice Pure SLH-DSA signs the canonical message with an empty context.
    /// `party` is the transaction sender for DEPOSIT, recipient for WITHDRAW.
    function authorizationMessage(
        uint8 action, bytes32 publicKey, address party, uint256 amount, uint256 nonce, uint64 deadline
    ) public view returns (bytes memory) {
        return abi.encode(AUTH_DOMAIN, block.chainid, address(this), ASSET, action, publicKey, party, amount, nonce, deadline);
    }

    /// @notice Credit actual msg.value only after proof of possession of the PQ key.
    function deposit(bytes32 publicKey, uint256 nonce, uint64 deadline, bytes calldata signature) external payable {
        if (paying) revert ReentrantCall();
        if (msg.value == 0) revert InvalidAmount();
        Account storage account = accounts[publicKey];
        _authorize(account, DEPOSIT, publicKey, msg.sender, msg.value, nonce, deadline, signature);
        account.balance += msg.value;
        totalLocked += msg.value;
        emit Deposit(publicKey, msg.sender, msg.value, nonce);
    }

    /// @notice Anyone can relay; only the signed recipient gets the exact signed wei.
    function withdraw(
        bytes32 publicKey, address payable recipient, uint256 amount, uint256 nonce, uint64 deadline, bytes calldata signature
    ) external {
        if (paying) revert ReentrantCall();
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        Account storage account = accounts[publicKey];
        if (amount > account.balance) revert InsufficientBalance();
        _authorize(account, WITHDRAW, publicKey, recipient, amount, nonce, deadline, signature);
        account.balance -= amount;
        totalLocked -= amount;
        paying = true;
        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert TransferFailed(); // Restores nonce and both balances as well.
        paying = false;
        emit Withdrawal(publicKey, recipient, amount, nonce);
    }

    function _authorize(
        Account storage account, uint8 action, bytes32 publicKey, address party, uint256 amount,
        uint256 nonce, uint64 deadline, bytes calldata signature
    ) private {
        if (publicKey == bytes32(0)) revert InvalidPublicKey();
        if (deadline < block.timestamp) revert AuthorizationExpired();
        if (account.nonce != nonce) revert InvalidNonce();
        bytes memory message = authorizationMessage(action, publicKey, party, amount, nonce, deadline);
        if (!SlhDsaSha2_128s.verify(publicKey, message, signature)) revert InvalidSignature();
        account.nonce = nonce + 1;
    }
}
