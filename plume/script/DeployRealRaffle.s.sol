// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "forge-std/Script.sol";
import "../src/spin/Raffle.sol";
import "../src/mocks/MockContracts.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract DeployRealRaffle is Script {
    function run() external {
        vm.startBroadcast();
        
        console.log("=== DEPLOYING REAL RAFFLE CONTRACT ===");
        
        // Deploy mocks for dependencies (vì chưa có real Spin/Supra)
        MockSpin spin = new MockSpin();
        MockSupraRouter supra = new MockSupraRouter();
        
        console.log("Mock Spin deployed:", address(spin));
        console.log("Mock Supra deployed:", address(supra));
        
        // Deploy REAL Raffle implementation (code gốc từ repo)
        Raffle raffleImpl = new Raffle();
        console.log("Real Raffle implementation:", address(raffleImpl));
        
        // Deploy proxy với real Raffle
        bytes memory initData = abi.encodeWithSelector(
            Raffle.initialize.selector,
            address(spin),
            address(supra)
        );
        
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(raffleImpl),
            initData
        );
        
        Raffle raffle = Raffle(payable(address(proxy)));
        console.log("Real Raffle proxy:", address(raffle));
        
        // Grant roles for testing
        raffle.grantRole(raffle.SUPRA_ROLE(), msg.sender);
        console.log("SUPRA_ROLE granted to:", msg.sender);
        
        // Add real prize với multiple winners (để test Bug #1)
        raffle.addPrize(
            "iPhone 15 Pro Max", 
            "Latest iPhone with 1TB storage", 
            1200 * 1e6, // $1200 value
            3 // 3 winners possible
        );
        
        console.log("Prize added: iPhone 15 Pro Max (3 winners)");
        
        console.log("\n=== REAL RAFFLE READY FOR ATTACK ===");
        console.log("This is the ACTUAL vulnerable contract from the repo!");
        console.log("All bugs are present and exploitable!");
        
        vm.stopBroadcast();
    }
}