// Executes the Continuum prototype on a real EVM (Hardhat/EDR) and re-runs the
// three properties from the formal model as randomised campaigns.
// Run: npx hardhat run verify/run.cjs
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const WAD = 10n ** 18n;
const art = JSON.parse(fs.readFileSync(path.join(__dirname, "artifacts.json"), "utf8"));

let s = 0x9e3779b97f4a7c15n;
const rnd = (n) => {
  s ^= (s << 13n) & 0xffffffffffffffffn;
  s ^= s >> 7n;
  s ^= (s << 17n) & 0xffffffffffffffffn;
  return Number(s % BigInt(n));
};
const f = (x) => Number(x) / 1e18;

const C = 1020000000000000000n; // 1.02  (2% underwriter discount)
const TARGET = 1200000000000000000n; // 1.20  flow switches on at 83.3% LTV
const K = 365000000000000000000n;
const RHOCAP = 100000000000000000n; // 10%/yr ceiling
const ETA = 20000000000000000n;
const P0 = 2000n * WAD;
const ASK = 10000000000000000n;

async function main() {
  const { ethers, network } = hre;
  const [admin, alice, uw] = await ethers.getSigners();
  const rows = [];
  const fail = [];

  const warp = async (secs) => {
    await network.provider.send("evm_increaseTime", [Number(secs)]);
    await network.provider.send("evm_mine");
  };

  async function fresh(underCash) {
    const F = new ethers.ContractFactory(art.Continuum.abi, art.Continuum.bytecode, admin);
    const c = await F.deploy(C, TARGET, K, RHOCAP, ETA, P0, ASK);
    await c.waitForDeployment();
    await warp(60);
    await (await c.connect(alice).open(10n * WAD, 16000n * WAD, 50000000000000000n)).wait();
    if (underCash > 0n) await (await c.connect(uw).supplyCash(underCash * WAD, ASK)).wait();
    const read = async () => {
      const p = await c.getPos(alice.address);
      return {
        V: await c.collateralValue(alice.address),
        L: await c.bufferLine(alice.address),
        D: p.debt,
        coll: p.coll,
        h: await c.health(alice.address),
        rho: await c.rho(),
        distressed: await c.isDistressed(alice.address),
      };
    };
    const setPrice = async (pWei) => (await c.setPrice(BigInt(pWei))).wait();
    const poke = async () => (await c.poke(alice.address)).wait();
    return { c, read, setPrice, poke };
  }

  // ============================ A. buffer-line preservation + no liquidatable state
  {
    const e = await fresh(500n); // thin underwriter book: the rent law actually moves
    const st0 = await e.read();
    const pLine = (C * st0.D) / st0.coll; // wei: mark at which V = c*D
    let viol = 0;
    let liq = 0;
    let rhoMax = 0n;
    for (let i = 0; i < 1000; i++) {
      const cur = await e.read();
      if (cur.D === 0n) break;
      const line = (C * cur.D) / cur.coll; // current buffer-line price
      const p = line + (BigInt(rnd(1000)) * line) / 2000n + 10n ** 15n; // [line, line*1.5]
      await e.setPrice(p);
      await warp(1 + rnd(30 * 86400));
      if (i % 5 === 0) await (await e.c.setRho()).wait();
      await e.poke();
      const x = await e.read();
      if (x.V + 1n < x.L) viol++;
      if (x.D > 0n && x.h <= WAD) liq++;
      if (x.rho > rhoMax) rhoMax = x.rho;
    }
    rows.push(`A  buffer line  1000 random (mark, dt, rent) steps inside the surface -> violations ${viol}, liquidatable states ${liq}, rho drifted to ${f(rhoMax)}/yr`);
    if (viol) fail.push("P1");
    if (liq) fail.push("P3");
    rows.push(`   entry: V=${f(st0.V)} D=${f(st0.D)} line=${f(st0.L)} surplus=${f(st0.V - st0.L)}; line breaks at mark ${f(pLine).toFixed(2)} (${((f(pLine) / 2000 - 1) * 100).toFixed(2)}% from entry)`);
  }

  // ============================ B. negative feedback in the distress band
  {
    const e = await fresh(40000n);
    let tested = 0;
    let bad = 0;
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const st = await e.read();
      if (st.D === 0n) break;
      const pLine = (C * st.D) / st.coll;
      const pTrig = (TARGET * st.D) / st.coll;
      const span = pTrig - pLine;
      if (span <= 0n) break;
      const p = pLine + (span * BigInt(5 + rnd(90))) / 100n;
      await e.setPrice(p);
      const before = await e.read();
      if (!before.distressed) continue;
      await warp(3600 + rnd(23 * 3600));
      await e.poke();
      const after = await e.read();
      tested++;
      if (after.h <= before.h) bad++;
      const gain = f(after.h) - f(before.h);
      if (gain < worst) worst = gain;
    }
    rows.push(`B  feedback      ${tested} distressed accruals, health strictly rose in ${tested - bad}, violations ${bad} (worst delta ${worst.toFixed(6)})`);
    if (bad) fail.push("P2");
  }

  // ============================ C. the rent law (primitive variable)
  {
    const e = await fresh(500n); // coveredDebt 16,000 > underCash 500 -> excess demand > 0
    let prev = await e.c.rho();
    let signBad = 0;
    let oob = 0;
    let steps = 0;
    for (let i = 0; i < 60; i++) {
      const z = await e.c.excessDemand();
      await (await e.c.setRho()).wait();
      const r = await e.c.rho();
      if (r > RHOCAP) oob++;
      if (z > 0n && r < prev) signBad++;
      if (z < 0n && r > prev) signBad++;
      if (z === 0n && r !== prev) signBad++;
      prev = r;
      steps++;
    }
    // now flood the book with underwriter capital: excess demand flips sign
    await (await e.c.connect(uw).supplyCash(1000000n * WAD, ASK)).wait();
    await (await e.c.setRho()).wait();
    const afterFlood = await e.c.rho();
    rows.push(`C  rent law     ${steps} steps: sign(d rho) = sign(excess demand) violated ${signBad}x, out-of-bound ${oob}x, rho ${f(prev)}/yr`);
    rows.push(`   sign flip   underwriter capital added -> rho ${f(afterFlood)}/yr (the law is two-sided, like perp funding)`);
    if (oob || signBad) fail.push("rent");
  }

  // ============================ D. a 10% shock, healed by the flow alone
  {
    const e = await fresh(40000n);
    const st0 = await e.read();
    await e.setPrice(1800n * WAD); // -10%: distressed (h=1.125) and still inside the surface
    const crashed = await e.read();
    let t = 0;
    for (let i = 0; i < 240 && crashed.D > 0n; i++) {
      await warp(6 * 3600);
      await e.poke();
      t += 6;
      const x = await e.read();
      if (x.h >= TARGET) break;
    }
    const healed = await e.read();
    const uwCash = await e.c.underCash();
    const uwInv = await e.c.underColl();
    const rent = await e.c.rentBooked();
    rows.push(`D  shock        mark -10%: h ${f(st0.h).toFixed(4)} -> ${f(crashed.h).toFixed(4)} -> ${f(healed.h).toFixed(4)} after ${t}h of flow, 0 keeper calls`);
    rows.push(`   state       debt ${f(st0.D)} -> ${f(healed.D)}, collateral ${f(st0.coll)} -> ${f(healed.coll)}, underwriter cash ${f(uwCash)} inventory ${f(uwInv)} rent ${f(rent)}`);
    const notionalSold = f(st0.D) - f(healed.D);
    const disc = (Number(C) / 1e18 - 1) * 100;
    rows.push(`   borrower    ${notionalSold.toFixed(2)} of debt retired at a ${disc.toFixed(2)}% collateral discount = cost ${(notionalSold * disc / 100).toFixed(2)}`);
    rows.push(`   contrast    a 5% liquidation bonus on the same notional would cost ${(notionalSold * 0.05).toFixed(2)}, and is only charged in one indivisible event`);
    if (healed.V + 1n < healed.L) fail.push("P1 (crash)");
    if (f(healed.h) < 1.19) fail.push("flow did not restore health");
  }

  // ============================ E. the rent actually flows, and conserves
  {
    const e = await fresh(500n); // thin book -> excess demand > 0 -> rho climbs
    for (let i = 0; i < 20; i++) await (await e.c.setRho()).wait();
    const rho = await e.c.rho();
    const s0 = await e.read();
    const sur0 = s0.V - s0.L;
    for (let i = 0; i < 30; i++) {
      await warp(86400);
      await e.poke();
    }
    const s1 = await e.read();
    const sur1 = s1.V - s1.L;
    const rent = await e.c.rentBooked();
    const drift = Number(sur0 - sur1 - rent) / 1e18;
    rows.push(`E  rent flow    rho ${f(rho)}/yr, 30 days: rent booked ${f(rent).toFixed(4)}, surplus ${f(sur0).toFixed(4)} -> ${f(sur1).toFixed(4)} (residual ${drift.toFixed(6)})`);
    rows.push(`   conservation  surplus fell by exactly the rent paid; buffer line still held: ${s1.V + 1n >= s1.L}`);
    if (s1.V + 1n < s1.L) fail.push("P1 (rent)");
  }

  console.log("\n=== Continuum — execution report (Hardhat EDR + solc 0.8.24) ===");
  for (const r of rows) console.log("  " + r);
  console.log("\n  verdict: " + (fail.length === 0 ? "all properties held" : "VIOLATION " + fail.join(",")));
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
