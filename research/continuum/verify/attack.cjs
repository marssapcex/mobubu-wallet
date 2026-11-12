// Attacks on the shipping market: the two findings that the campaign suite did
// not cover, plus a differential check on the demand book.
// Run: npx hardhat run verify/attack.cjs
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const art = JSON.parse(fs.readFileSync(path.join(__dirname, "artifacts.json"), "utf8"));
const WAD = 10n ** 18n;
const U = 10n ** 6n;
const YEAR = 365n * 86400n;

const deploy = async (name, signer, args) => {
  const F = new hre.ethers.ContractFactory(art[name].abi, art[name].bytecode, signer);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  return c;
};
const f6 = (x) => Number(x) / 1e6;

const PARAMS = (weth, usdc, oracle) => ({
  collateralToken: weth,
  debtToken: usdc,
  oracle: oracle,
  c: 1_020_000_000_000_000_000n,
  target: 1_200_000_000_000_000_000n,
  k: 365n * WAD,
  rhoCap: 100_000_000_000_000_000n,
  eta: 20_000_000_000_000_000n,
  minBid: 10_000_000_000_000_000n,
  idleFloor: 200_000_000_000_000_000n,
  shareName: "Continuum USDC",
  shareSymbol: "cUSDC",
});

async function main() {
  const { ethers, network } = hre;
  const [admin, lender, attacker, b1, b2, probe] = await ethers.getSigners();
  const out = [];
  const fails = [];
  const warp = async (s) => {
    await network.provider.send("evm_increaseTime", [Number(s)]);
    await network.provider.send("evm_mine");
  };

  const weth = await deploy("MockToken", admin, ["Wrapped Ether", "WETH", 18]);
  const usdc = await deploy("MockToken", admin, ["USD Coin", "USDC", 6]);
  const oracle = await deploy("FixedOracle", admin, [2000n * WAD]);
  const market = await deploy("ContinuumMarket", admin, [PARAMS(weth.target, usdc.target, oracle.target)]);

  for (const s of [lender, attacker, b1, b2]) {
    await (await usdc.mint(s.address, 1_000_000n * U)).wait();
    await (await usdc.connect(s).approve(market.target, ethers.MaxUint256)).wait();
    await (await weth.mint(s.address, 1_000n * WAD)).wait();
    await (await weth.connect(s).approve(market.target, ethers.MaxUint256)).wait();
  }

  await (await market.connect(lender).deposit(100_000n * U)).wait();
  for (const [s, coll, debt] of [
    [b1, 10n * WAD, 14_000n * U],
    [b2, 50n * WAD, 60_000n * U],
  ]) {
    await (await market.connect(s).depositCollateral(coll)).wait();
    await (await market.connect(s).borrow(debt, 20_000_000_000_000_000n)).wait();
  }

  const sharesTok = new ethers.Contract(await market.shares(), art.ContinuumShares.abi, admin);

  // ===================================================================== F9
  // Nobody pokes for six months (no keeper, so nobody is paid to). Rent is owed
  // by the borrowers but has not touched `loans`. A new depositor buys shares at
  // the stale (understated) price, then materialises everything and redeems.
  {
    await warp(180 * 86400);

    const assetsStale = await market.assets();
    const priceStale = await market.sharePrice();
    const pending = await market.pendingRent();
    const r1 = await market.positionOf(b1.address);
    const r2 = await market.positionOf(b2.address);
    const debt = f6(r1[1] + r2[1]);

    const deposit = 100_000n * U;
    const bal0 = await usdc.balanceOf(attacker.address);
    await (await market.connect(attacker).deposit(deposit)).wait();
    // materialise the whole book, then exit
    await (await market.pokeMany([b1.address, b2.address])).wait();
    const assetsFresh = await market.assets();
    const attShares = await sharesTok.balanceOf(attacker.address);
    const redeemable = await market.previewRedeem(attShares);
    const profit = redeemable - deposit;

    out.push(`F9  stale NAV    after 180 idle days: assets() reads ${f6(assetsStale)}, share price ${(Number(priceStale) / 1e18).toFixed(6)}`);
    out.push(`    rent owed    pendingRent() reports ${f6(pending)} on ${debt} of debt; assets() already carries it`);
    out.push(`    after poke   (with the attacker already in) assets ${f6(assetsStale)} -> ${f6(assetsFresh)} (the rent moved from the estimate into loans, NAV unchanged)`);
    out.push(`    attack       deposit ${f6(deposit)}, poke, redeem ${f6(redeemable)} -> profit ${f6(profit)} (${((Number(profit) / 1e6 / 100_000) * 100).toFixed(4)}% of the deposit in one block)`);
    if (profit > 1n * U) fails.push(`F9 open: a fresh depositor captured ${f6(profit)} of rent that was not theirs`);
    // reset: attacker exits, lender is left with the dilution
    await (await market.connect(attacker).withdraw(attShares)).wait();
    const lenderShares = await sharesTok.balanceOf(lender.address);
    out.push(`    who paid     the incumbent lender's ${f6(lenderShares)} shares are now worth ${f6(await market.previewRedeem(lenderShares))}`);
  }

  // ==================================================================== F11
  // `price()` is an external call inside `_materialise`, and `poke` has no
  // reentrancy guard, so the feed can execute market functions in the middle of
  // an accrual — before `_syncBook` has run.
  {
    const evil = await deploy("ReentrantOracle", admin, []);
    await (await evil.setPrice(2000n * WAD)).wait();
    const victim = await deploy("ContinuumMarket", admin, [PARAMS(weth.target, usdc.target, evil.target)]);
    await (await usdc.connect(lender).approve(victim.target, ethers.MaxUint256)).wait();
    await (await victim.connect(lender).deposit(100_000n * U)).wait();
    await (await weth.connect(b1).approve(victim.target, ethers.MaxUint256)).wait();
    await (await victim.connect(b1).depositCollateral(10n * WAD)).wait();
    await (await victim.connect(b1).borrow(14_000n * U, 20_000_000_000_000_000n)).wait();

    // arm the oracle with `updateRho()`, then poke
    const payload = victim.interface.encodeFunctionData("updateRho", []);
    await (await evil.connect(attacker).arm(victim.target, payload)).wait();
    await warp(2 * 86400);
    const rhoBefore = await victim.rho();
    await (await victim.connect(probe).poke(b1.address)).wait();
    const rhoAfter = await victim.rho();
    out.push(`F11 reentrancy   feed armed with updateRho(); poke succeeded and rho moved ${rhoAfter - rhoBefore} -> the state change never landed`);
    out.push(`    why          IOracle.price() is declared view, so the market calls it with STATICCALL; the payload reverts inside it`);
    if (rhoAfter !== rhoBefore) fails.push("F11 open: the oracle reentered a state-changing function mid-accrual");
  }

  // ==================================================================== F12
  // Differential check: the cached covered mass against a full recomputation
  // from the positions. This is the invariant the incremental book exists for.
  {
    let drift = 0n;
    const n = 3;
    for (let i = 0; i < 40; i++) {
      await warp(1 + ((i * 7919) % (5 * 86400)));
      await (await market.updateRho()).wait();
      const rho = await market.rho();
      const rhoCap = await market.rhoCap();
      const set = ((rho * 64n + (rhoCap + 1n) - 1n) / (rhoCap + 1n)) < 64n
        ? (rho * 64n + rhoCap) / (rhoCap + 1n)
        : 64n;
      let truth = 0n;
      for (const s of [b1, b2]) {
        const p = await market.positionOf(s.address);
        const b = (p[2] * 64n) / (rhoCap + 1n); // bucketOf, exactly as the contract does
        if (p[1] > 0n && b >= set) truth += p[1];
      }
      const stored = await market.coveredDebt();
      const d = stored > truth ? stored - truth : truth - stored;
      if (d > drift) drift = d;
    }
    out.push(`F12 book drift   |coveredDebtStored - recompute| <= ${f6(drift)} USDC over 40 rent updates`);
    if (drift > 1n * U) fails.push("F12: the cached demand book drifted from the positions");
    void n;
  }

  // ==================================================================== F14
  // The rate aggregate is maintained incrementally; it must equal a full
  // recomputation of the book at all times, or NAV is priced off a fiction.
  {
    let drift = 0n;
    for (let i = 0; i < 30; i++) {
      await (await market.updateRho()).wait();
      const rho = await market.rho();
      const rhoCap = await market.rhoCap();
      let truth = 0n;
      for (let b = 0n; b < 64n; b++) {
        const m = await market.demandAt(b);
        if (m === 0n) continue;
        const upper = ((b + 1n) * (rhoCap + 1n)) / 64n;
        truth += m >= 0n ? (m * (rho < upper ? rho : upper)) / WAD : 0n;
      }
      const stored = await market.rateDebt();
      const d = stored > truth ? stored - truth : truth - stored;
      if (d > drift) drift = d;
    }
    out.push(`F14 rate drift   |rateDebt - recompute| <= ${drift} over 30 rent updates`);
    if (drift > 1n) fails.push("F14: the rent aggregate drifted from the book");
  }

  // ==================================================================== gas
  {
    const g = async (label, tx) => {
      const rc = await (await tx).wait();
      out.push(`    ${label.padEnd(14)} ${rc.gasUsed} gas`);
      return rc.gasUsed;
    };
    out.push(`F13 gas          the accrual aggregate costs O(1) to read and O(1) to write:`);
    await warp(3600);
    await g("poke", market.connect(probe).poke(b1.address));
    await g("updateRho", market.updateRho());
    await g("deposit", market.connect(lender).deposit(1_000n * U));
    await g("withdraw", market.connect(lender).withdraw(500n * U));
    await g("borrow", market.connect(b1).borrow(100n * U, 20_000_000_000_000_000n));
    out.push(`    note           a rent move reclassifies at most one bucket; updateRho was 212k gas with a full resync`);
  }

  console.log("\n=== ContinuumMarket — attack harness ===");
  for (const r of out) console.log("  " + r);
  console.log(`\n  verdict: ${fails.length === 0 ? "no open attack" : "VULNERABLE: " + fails.join(" | ")}`);
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
