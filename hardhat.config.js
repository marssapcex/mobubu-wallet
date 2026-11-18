import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: "0.8.24",
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
});
