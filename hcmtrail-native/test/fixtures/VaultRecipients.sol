// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeVault} from "../../contracts/vault/NativeVault.sol";

/// Lab only. The proof pays a contract that first refuses, then attempts a reentrant deposit.
contract ReenterNative {
    NativeVault private immutable vault;
    bool public refusing = true;
    bool public blocked;

    constructor(NativeVault vault_) { vault = vault_; }

    function allowPayment() external { refusing = false; }

    receive() external payable {
        if (refusing) revert();
        (bool ok, bytes memory reason) = address(vault).call{value: 1}(
            abi.encodeCall(NativeVault.deposit, (bytes32(uint256(1))))
        );
        require(!ok && bytes4(reason) == NativeVault.Reentrant.selector, "unexpected reentry result");
        blocked = true;
    }
}

/// Lab only. Delivers native value without invoking deposit or changing note accounting.
contract ForceNative {
    constructor(address payable vault) payable { selfdestruct(vault); }
}
