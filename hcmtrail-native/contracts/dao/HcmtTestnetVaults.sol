// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset} from "../NativeAssets.sol";
import {HcmtFeeVault} from "./HcmtFeeVault.sol";
import {HcmtTreasury} from "./HcmtTreasury.sol";

/// New deployments; intentionally cannot alter or import notes from the original no-fee vaults.
contract SepoliaFeeVault is HcmtFeeVault {
    constructor(address p, address w, address[3] memory c, HcmtTreasury t)
        HcmtFeeVault(NativeAsset.ETH, 11155111, p, w, c, t) {}
}
contract BscTestnetFeeVault is HcmtFeeVault {
    constructor(address p, address w, address[3] memory c, HcmtTreasury t)
        HcmtFeeVault(NativeAsset.BNB, 97, p, w, c, t) {}
}
contract NileFeeVault is HcmtFeeVault {
    constructor(address p, address w, address[3] memory c, HcmtTreasury t)
        HcmtFeeVault(NativeAsset.TRX, 0xcd8690dc, p, w, c, t) {}
}
contract HyperEvmTestnetFeeVault is HcmtFeeVault {
    constructor(address p, address w, address[3] memory c, HcmtTreasury t)
        HcmtFeeVault(NativeAsset.HYPE, 998, p, w, c, t) {}
}
