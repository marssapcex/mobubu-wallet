// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StakeCampaign} from "./StakeCampaign.sol";

interface StakeAuditVm {
    function warp(uint256) external;
    function deal(address, uint256) external;
}

contract WarpStakeCampaign is StakeCampaign {
    StakeAuditVm private constant vm = StakeAuditVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function jump(uint8 periods, uint32 fraction) external {
        vm.warp(block.timestamp + uint256(periods % 5) * 30 days + uint256(fraction) % 30 days);
        _sync();
        _assertPositions();
    }
}

contract StakingInvariantTest {
    StakeAuditVm private constant vm = StakeAuditVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    WarpStakeCampaign private model;

    function setUp() public {
        model = new WarpStakeCampaign();
        vm.deal(address(model), 1_000 ether);
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(model);
    }

    function invariant_stakingAndRelayerEscrowAreBacked() external view {
        assert(model.echidna_staking_backing());
    }
}
