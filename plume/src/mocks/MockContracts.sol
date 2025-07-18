// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

contract MockSpin {
    mapping(address => uint256) public raffleTickets;
    
    function spendRaffleTickets(address user, uint256 amount) external {
        require(raffleTickets[user] >= amount, "Insufficient tickets");
        raffleTickets[user] -= amount;
    }
    
    function getUserData(address user) external view returns (
        uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) {
        return (0, 0, 0, 0, raffleTickets[user], 0, 0);
    }
    
    function mintTickets(address user, uint256 amount) external {
        raffleTickets[user] = amount;
    }
}

contract MockSupraRouter {
    uint256 private nonce;
    
    function generateRequest(
        string memory,
        uint256,
        uint256,
        uint256,
        address
    ) external returns (uint256) {
        nonce++;
        return nonce;
    }
}
