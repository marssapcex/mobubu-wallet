// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ZamaConfig, ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHE, ebool, euint128, externalEuint128} from "@fhevm/solidity/lib/FHE.sol";
import {CoprocessorConfig} from "@fhevm/solidity/lib/Impl.sol";
import {ChainlinkPriceEpochs} from "../ChainlinkPriceEpochs.sol";
import {NativeAsset, NativeAssets} from "../NativeAssets.sol";

/// @notice Noncustodial encrypted quotes for ETH, BNB, TRX and HYPE, on a Zama Ethereum host.
/// @dev A quote is NOT a swap order, reservation, proof of note ownership, or permission to pay.
contract ZamaNativeQuotes is ZamaEthereumConfig {
    bytes32 private constant QUOTE_DOMAIN = keccak256("hcmtrail.native.zama-quote.v1");

    struct QuoteInput {
        bytes32 epochId;
        NativeAsset src;
        NativeAsset dst;
        externalEuint128 debit;
        externalEuint128 minOut;
        bool publishEligibility;
    }

    struct Parameters {
        uint128 numerator;
        uint128 denominator;
        uint128 maxDebit;
        uint64 validUntil;
    }

    enum Verdict { Unconfirmed, Rejected, Accepted }

    struct Quote {
        bytes32 epochId;
        euint128 amount;
        ebool eligible;
        address requester;
        uint64 validUntil;
        NativeAsset src;
        NativeAsset dst;
        bool publishEligibility;
        Verdict verdict;
    }

    ChainlinkPriceEpochs public immutable oracle;
    uint256 private nonce;
    mapping(bytes32 id => Quote) public quotes;

    error MissingZamaHost();
    error WrongOracle();
    error UnsupportedRate();
    error MissingEncryptedInput();
    error UnknownQuote();
    error PrivateEligibility();
    error AlreadyConfirmed();

    event QuoteRequested(bytes32 indexed id, bytes32 indexed epochId, address indexed requester,
        NativeAsset src, NativeAsset dst, uint64 validUntil, euint128 amount, ebool eligible, bool publishEligibility);
    event EligibilityConfirmed(bytes32 indexed id, bool eligible);

    constructor(ChainlinkPriceEpochs oracle_) {
        CoprocessorConfig memory host = ZamaConfig.getEthereumCoprocessorConfig();
        if (host.ACLAddress.code.length == 0 || host.CoprocessorAddress.code.length == 0
            || host.KMSVerifierAddress.code.length == 0) revert MissingZamaHost();
        if (address(oracle_).code.length == 0 || oracle_.oracleChainId() != block.chainid) revert WrongOracle();
        oracle = oracle_;
    }

    /// @notice Public rate and exact input ceiling for an active epoch; call before encrypting.
    /// @dev The FHE product must fit uint128. A route outside that envelope fails closed without approximation.
    function quoteParameters(bytes32 epochId, NativeAsset src, NativeAsset dst) public view returns (Parameters memory) {
        if (src == dst) revert NativeAssets.SameAsset();
        ChainlinkPriceEpochs.Epoch memory epoch = _active(epochId);
        uint256 n = uint256(epoch.rounds[uint8(src)].price18) * NativeAssets.units(dst)
            * (NativeAssets.BPS - oracle.feeBps());
        uint256 d = uint256(epoch.rounds[uint8(dst)].price18) * NativeAssets.units(src) * NativeAssets.BPS;
        uint256 gcd = _gcd(n, d);
        n /= gcd;
        d /= gcd;
        if (n > type(uint128).max || d > type(uint128).max) revert UnsupportedRate();

        uint256 maxDebit = NativeAssets.ceiling(src);
        // floor(debit*n/d) <= cap(dst) iff debit*n <= (cap(dst)+1)*d - 1.
        uint256 outputBound = ((NativeAssets.ceiling(dst) + 1) * d - 1) / n;
        uint256 productBound = type(uint128).max / n;
        if (outputBound < maxDebit) maxDebit = outputBound;
        if (productBound < maxDebit) maxDebit = productBound;
        if (maxDebit * n < d) revert UnsupportedRate(); // No positive output in this envelope.
        return Parameters(uint128(n), uint128(d), uint128(maxDebit), epoch.validUntil);
    }

    /// @notice Both inputs must be packed for this contract and msg.sender by the Zama SDK.
    /// @dev Only the requester can user-decrypt the two output handles. The bit is public only by explicit opt-in.
    function requestQuote(QuoteInput calldata input, bytes calldata inputProof) external returns (bytes32 id) {
        if (inputProof.length == 0 || externalEuint128.unwrap(input.debit) == 0
            || externalEuint128.unwrap(input.minOut) == 0) revert MissingEncryptedInput();
        Parameters memory p = quoteParameters(input.epochId, input.src, input.dst);
        id = keccak256(abi.encode(QUOTE_DOMAIN, block.chainid, address(this), msg.sender, ++nonce, input));
        (euint128 amount, ebool eligible) = _quote(input, inputProof, p, id);
        quotes[id] = Quote(input.epochId, amount, eligible, msg.sender, p.validUntil, input.src, input.dst,
            input.publishEligibility, Verdict.Unconfirmed);
        FHE.allowThis(amount);
        FHE.allow(amount, msg.sender);
        FHE.allowThis(eligible);
        FHE.allow(eligible, msg.sender);
        if (input.publishEligibility) FHE.makePubliclyDecryptable(eligible);
        emit QuoteRequested(id, input.epochId, msg.sender, input.src, input.dst, p.validUntil,
            amount, eligible, input.publishEligibility);
    }

    /// @notice Anyone may attest the opted-in result while its exact quote epoch is still active.
    /// @dev Verify only the stored bit, not caller-supplied handles or a clear amount. Never authorizes a transfer.
    function confirmEligibility(bytes32 id, bool eligible, bytes calldata decryptionProof) external {
        Quote storage q = quotes[id];
        if (q.requester == address(0)) revert UnknownQuote();
        if (!q.publishEligibility) revert PrivateEligibility();
        if (q.verdict != Verdict.Unconfirmed) revert AlreadyConfirmed();
        _active(q.epochId);

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(q.eligible);
        q.verdict = eligible ? Verdict.Accepted : Verdict.Rejected; // Rolls back if the KMS check fails.
        FHE.checkSignatures(handles, abi.encode(eligible), decryptionProof);
        emit EligibilityConfirmed(id, eligible);
    }

    function _quote(QuoteInput calldata input, bytes calldata proof, Parameters memory p, bytes32 id)
        private returns (euint128 amount, ebool eligible)
    {
        euint128 debit = FHE.fromExternal(input.debit, proof);
        euint128 minimum = FHE.fromExternal(input.minOut, proof);
        euint128 zero = FHE.asEuint128(0);
        // FHE arithmetic wraps: mask the debit BEFORE multiplying, including adversarial inputs.
        euint128 safeDebit = FHE.select(FHE.le(debit, p.maxDebit), debit, zero);
        euint128 out = FHE.div(FHE.mul(safeDebit, p.numerator), p.denominator);
        ebool meetsLimit = FHE.and(FHE.gt(out, uint128(0)), FHE.ge(out, minimum));
        // Zama may deduplicate equal operations in a block. Include this full request's domain in the
        // evaluated bit so neither a KMS proof nor a public ACL grant aliases another quote's handle.
        uint256 tag = uint256(id);
        eligible = FHE.and(meetsLimit, FHE.eq(FHE.asEuint256(tag), tag));
        amount = FHE.select(eligible, out, zero);
    }

    function _active(bytes32 id) private view returns (ChainlinkPriceEpochs.Epoch memory epoch) {
        epoch = oracle.activeEpoch();
        if (epoch.id != id) revert ChainlinkPriceEpochs.EpochChanged();
    }

    function _gcd(uint256 a, uint256 b) private pure returns (uint256) {
        while (b != 0) (a, b) = (b, a % b);
        return a;
    }
}
