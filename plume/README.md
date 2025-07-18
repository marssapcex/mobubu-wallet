Quick Start Guide

 Prerequisites
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Git

Installation

1. Clone the repository

git clone https://github.com/marssapcex/raffle-gas-griefing-poc.git
cd raffle-gas-griefing-poc

2. Install dependencies

forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts
forge install OpenZeppelin/openzeppelin-contracts-upgradeable

3. Build contracts

forge build

Running the Test

1. Start local blockchain(Terminal 1)

anvil --accounts 10 --balance 10000


2. Run the exploit (Terminal 2)

forge script script/TestRealBug2.s.sol:TestRealBug2 \
  --rpc-url http://localhost:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast

What This Tests

The PoC creates thousands of 1-ticket entries to bloat storage and make winner selection prohibitively expensive. This is a critical vulnerability in the Plume Network Raffle contract.