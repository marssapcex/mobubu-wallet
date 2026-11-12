// Executes the Continuum buffer against a Spoke stub that keeps Aave v4's
// decisions (HF gate at 1.0, bonus ramp, target-HF sizing) on a real EVM.
// Run: npx hardhat run verify/aave.cjs
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const art = JSON.parse(fs.readFileSync(path.join(__dirname, "artifacts.json"), "utf8"));
const WAD = 10n ** 18n;
const Y = 365n * 86400n;

const deploy = async (name, signer, args) => {
  const F = new hre.ethers.ContractFactory(art[name].abi, art[name].bytecode, signer);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  return c;
};
const w = (x) => Number(x) / 1e18;
const usd = (x) => Number(x) / 1e6;

async function main() {
  const { ethers, network } = hre;
  const [admin, borrower, uw, liq] = await ethers.getSigners();
  const out = [];
  const fails = [];

  const warp = async (s) => {
    await network.provider.send("evm_increaseTime", [Number(s)]);
    await network.provider.send("evm_mine");
  };

  // ---------------------------------------------------------------- fixtures
  const weth = await deploy("MockERC20", admin, ["WETH", 18]);
  const usdc = await deploy("MockERC20", admin, ["USDC", 6]);
  const spoke = await deploy("MockAaveV4Spoke", admin, [admin.address]);
  await (await spoke.setReserve(1, weth.target, 2000n * WAD, WAD, 8000n)).wait(); // cf 80%
  await (await spoke.setReserve(2, usdc.target, WAD, 10n ** 6n, 0n)).wait();
  await (await spoke.setLiquidationConfig(1_500_000_000_000_000_000n, 950_000_000_000_000_000n, 5000n, 11500n)).wait(); // target 1.5, max bonus 15%

  const continuum = await deploy("Continuum", admin, [
    1_020_000_000_000_000_000n, // c
    1_200_000_000_000_000_000n, // target
    365_000_000_000_000_000_000n, // k
    100_000_000_000_000_000n, // rhoCap
    20_000_000_000_000_000n, // eta
    2000n * WAD,
    10_000_000_000_000_000n, // ask 1%/yr
  ]);
  // the rent market that prices the buffer: some demand, less supply
  await (await continuum.supplyCash(8_000n * 10n ** 6n * 10n ** 12n, 10_000_000_000_000_000n)).wait(); // 8k in 18dp
  await (await continuum.connect(borrower).open(10n * WAD, 16_000n * WAD, 20_000_000_000_000_000n)).wait();
  await warp(60);

  const price = await deploy("MockPriceWad", admin, []);
  const buffer = await deploy("AaveV4Buffer", admin, [
    spoke.target,
    usdc.target,
    price.target,
    continuum.target,
    2, // debt reserve
    10n ** 6n, // USDC units
    1_300_000_000_000_000_000n, // floor
    1_500_000_000_000_000_000n, // target
    100_000_000_000_000_000n, // rho cap
  ]);
  await (await price.set(1n * WAD)).wait();

  // ------------------------------------------------------------- the position
  // 10 WETH @ 2000 = 20,000 ; borrow 14,000 USDC -> HF = 0.80*20000/14000 = 1.1428
  await (await weth.mint(borrower.address, 100n * WAD)).wait();
  await (await weth.mint(liq.address, 1_000n * WAD)).wait();
  await (await weth.mint(spoke.target, 200n * WAD)).wait(); // the Spoke holds the posted collateral
  await (await usdc.mint(liq.address, 1_000_000n * 10n ** 6n)).wait();
  await (await usdc.mint(admin.address, 1_000_000n * 10n ** 6n)).wait();
  await (await usdc.mint(uw.address, 1_000_000n * 10n ** 6n)).wait();

  const setPos = async (coll, debt) => (await spoke.setPosition(borrower.address, coll, debt)).wait();
  const acct = async () => {
    const a = await spoke.getUserAccountData(borrower.address);
    return { hf: a[2], cv: a[3], dvRay: a[4] };
  };

  // ============================================================ A. no buffer
  {
    await setPos(10n * WAD, 14_000n * 10n ** 6n);
    await (await spoke.setPrice(1, 1600n * WAD)).wait(); // -20%, coll 16,000
    const a = await acct();
    const hfBefore = w(a.hf);
    let covered = 0n;
    let seized = 0n;
    let bonusBps = 0n;
    if (a.hf < WAD) {
      await (await usdc.connect(liq).approve(spoke.target, ethers.MaxUint256)).wait();
      const tx = await spoke.connect(liq).liquidate(borrower.address, 5_466_666_666n); // ~ debt to target 1.5
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => { try { return spoke.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Liquidated");
      covered = ev.args[2];
      seized = ev.args[3];
      bonusBps = ev.args[4];
    }
    const after = await acct();
    const bonusCost = (Number(seized) / 1e18) * 1600 - usd(covered); // collateral value handed over - cash received
    out.push(`A  liquidation   HF ${hfBefore.toFixed(4)} at mark 1600 -> Aave event fired (bonus ${(Number(bonusBps) - 10000) / 100}%)`);
    out.push(`   paid         ${usd(covered).toFixed(0)} USDC, gave ${(Number(seized) / 1e18).toFixed(4)} WETH (= $${((Number(seized) / 1e18) * 1600).toFixed(0)})`);
    out.push(`   cost         $${bonusCost.toFixed(0)} of value destroyed in one block; HF after ${w(after.hf) === Infinity ? "inf" : w(after.hf).toFixed(4)}`);
  }

  // ================================================================ B. buffer
  {
    await setPos(0n, 0n); // reset the position for a clean run
    await (await usdc.connect(uw).approve(buffer.target, ethers.MaxUint256)).wait();
    await (await usdc.connect(admin).approve(buffer.target, ethers.MaxUint256)).wait();
    await (await usdc.connect(borrower).approve(buffer.target, ethers.MaxUint256)).wait();
    await (await buffer.connect(uw).supply(6_000n * 10n ** 6n)).wait(); // small pool: the tail is reachable
    await (await buffer.connect(borrower).register()).wait();
    await setPos(10n * WAD, 14_000n * 10n ** 6n);

    // the rent law clears near the underwriter ask: run the feedback to fixpoint
    for (let i = 0; i < 12; i++) await (await continuum.setRho()).wait();
    const rho0 = await continuum.rho();

    let minHf = 99;
    let principal = 0n;
    let covers = 0;
    const path = [1950n, 1900n, 1850n, 1800n, 1750n, 1700n, 1650n, 1600n];
    const t0 = (await ethers.provider.getBlock("latest")).timestamp;
    for (const px of path) {
      await (await spoke.setPrice(1, px * WAD)).wait();
      await warp(7 * 86400); // a week between marks
      const before = await acct();
      const tx = await buffer.cover(borrower.address, 10n ** 12n);
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => { try { return buffer.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Covered");
      if (ev) {
        covers++;
        principal += ev.args[1];
      }
      const after = await acct();
      const hfA = w(after.hf);
      if (hfA < minHf) minHf = hfA;
      out.push(
        `   mark ${px}  HF ${w(before.hf).toFixed(4)} -> ${hfA === Infinity ? "inf" : hfA.toFixed(4)}` +
          (ev ? `  covered $${usd(ev.args[1]).toFixed(0)} (rho ${w(rho0).toFixed(4)}/yr)` : "  no cover"),
      );
    }
    const t1 = (await ethers.provider.getBlock("latest")).timestamp;
    const days = Number(t1 - t0) / 86400;
    const rent = (Number(principal) / 1e6) * w(rho0) * (days / 365);
    const a = await acct();
    out.push(`B  buffer        ${covers} covers, $${usd(principal).toFixed(0)} of debt moved off Aave, HF min ${minHf.toFixed(4)} over ${days.toFixed(0)} days`);
    out.push(`   rent         $${rent.toFixed(2)} at rho ${w(rho0).toFixed(4)}/yr on the covered principal (a loan, repaid by the borrower)`);
    out.push(`   vs bonus     the same deleverage at HF<1 cost $${((Number(principal) / 1e6) * 0.15).toFixed(0)} in bonus alone at the 15% cap`);
    out.push(`   state        debt $${w(a.dvRay / 10n ** 9n).toFixed(0)}, HF ${w(a.hf).toFixed(4)}, Aave liquidations ${usd(await spoke.liquidatedDebt())} USDC`);
    if (minHf < 1.0) fails.push("P3: HF crossed 1 with the buffer on");
    if (covers === 0) fails.push("buffer never engaged");

    // ---- adversarial / edge cases
    const idem = await buffer.cover.staticCall(borrower.address, 10n ** 12n);
    out.push(`   idempotent   a second cover in the same block pays ${idem}`);
    if (idem !== 0n) fails.push("cover is not time-idempotent");

    let reverted = false;
    try {
      await buffer.cover.staticCall(liq.address, 10n ** 12n);
    } catch {
      reverted = true;
    }
    out.push(`   consent      covering a non-opted position reverts: ${reverted}`);
    if (!reverted) fails.push("cover works without consent");

    const nav1 = await buffer.nav();
    const pend = await buffer.pendingRentOf(uw.address);
    out.push(`   pool         NAV $${usd(nav1)} (cash + principal + rent receivable), supplier claim $${usd(pend)}`);
  }

  // ==================================================== C. the tail: it fails
  {
    // price to 900: collateral $9,000 against $9,000 of debt + buffer principal
    await (await spoke.setPrice(1, 700n * WAD)).wait();
    await warp(30 * 86400);
    await (await buffer.cover(borrower.address, 10n ** 12n)).wait();
    await (await spoke.setPrice(1, 400n * WAD)).wait();
    await warp(30 * 86400);
    await (await buffer.cover(borrower.address, 10n ** 12n)).wait();
    const a = await acct();
    const navBefore = await buffer.nav();
    let wroteOff = 0n;
    if (a.hf < WAD) {
      try {
        const tx = await buffer.writeOff(borrower.address);
        const rc = await tx.wait();
        const ev = rc.logs.map((l) => { try { return buffer.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Loss");
        wroteOff = ev ? ev.args[1] : 0n;
      } catch (e) {
        out.push(`   writeOff     reverted: ${String(e.message).slice(0, 80)}`);
      }
    }
    const navAfter = await buffer.nav();
    out.push(`C  the tail      mark 700 then 400, hole in the book, HF ${a.hf === 0n ? "0" : w(a.hf).toFixed(4)}: buffer wrote off $${usd(wroteOff)}, NAV $${usd(navBefore)} -> $${usd(navAfter)}`);
    out.push(`   who pays     $${usd(wroteOff)} of principal gone from a $6,000 pool (${((Number(wroteOff) / 1e6 / 6000) * 100).toFixed(1)}% of NAV): the underwriters, up front, no socialization`);
  }

  console.log("\n=== Continuum on Aave v4 — buffer vs liquidation (EVM, Aave v4 math) ===");
  for (const r of out) console.log("  " + r);
  console.log(`\n  verdict: ${fails.length === 0 ? "all properties held" : "FAILED: " + fails.join(", ")}`);
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
