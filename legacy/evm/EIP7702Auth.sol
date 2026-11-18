// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title EIP7702Auth
 * @dev Quản lý mã ủy quyền cho EOA tạm thời theo EIP-7702.
 *
 * EIP-7702 cho phép EOA bình thường gửi transaction có authorization list,
 * trong đó họ ký để "set code" của mình thành một smart contract address.
 * Sau đó, các lời gọi đến EOA sẽ delegatecall đến code của contract đó.
 *
 * Contract này lưu trữ mã hash của smart contract được ủy quyền cho mỗi EOA,
 * cung cấp hàm kiểm tra xem một EOA có được phép chạy code của contract YieldVault hay không.
 *
 * Trong production, client sẽ tạo EIP-7702 transaction (authorization list)
 * với contract address này, ký và gửi lên Ethereum (Pectra+).
 */
contract EIP7702Auth {
    address public immutable owner;

    // EOA address => hash của contract code được ủy quyền
    mapping(address => bytes32) public authorizedCodeHash;
    // EOA address => thời gian hết hạn ủy quyền (0 = vĩnh viễn)
    mapping(address => uint256) public authorizationExpiry;

    event AuthorizationSet(address indexed eoA, bytes32 codeHash, uint256 expiry);
    event AuthorizationRevoked(address indexed eoA);

    constructor() {
        owner = msg.sender;
    }

    /**
     * @dev Cho phép EOA chạy code của contract có codeHash.
     *      Chỉ owner hoặc chính EOA đó có thể gọi.
     */
    function authorize(
        address eoA,
        bytes32 codeHash,
        uint256 expiry
    ) external {
        require(msg.sender == owner || msg.sender == eoA, "EIP7702: not authorized to set");
        authorizedCodeHash[eoA] = codeHash;
        authorizationExpiry[eoA] = expiry;
        emit AuthorizationSet(eoA, codeHash, expiry);
    }

    /**
     * @dev Thu hồi quyền ủy quyền của EOA.
     */
    function revoke(address eoA) external {
        require(msg.sender == owner || msg.sender == eoA, "EIP7702: not authorized to revoke");
        delete authorizedCodeHash[eoA];
        delete authorizationExpiry[eoA];
        emit AuthorizationRevoked(eoA);
    }

    /**
     * @dev Kiểm tra xem EOA có được phép chạy code của contract này hay không.
     */
    function isAuthorized(address eoA, bytes32 expectedCodeHash) external view returns (bool) {
        if (authorizedCodeHash[eoA] == bytes32(0)) {
            return false;
        }
        if (authorizationExpiry[eoA] != 0 && block.timestamp > authorizationExpiry[eoA]) {
            return false;
        }
        return authorizedCodeHash[eoA] == expectedCodeHash;
    }

    /**
     * @dev Lấy code hash đã ủy quyền cho EOA.
     */
    function getAuthorizedCodeHash(address eoA) external view returns (bytes32) {
        return authorizedCodeHash[eoA];
    }

    function onlyOwner() internal view {
        require(msg.sender == owner, "EIP7702: not owner");
    }
}
