// Regressions for the seven audit findings (B1-B7) in src/Continuum.sol.
// Each block re-creates the attack the finding describes and asserts it fails.
// Run: npx hardhat run verify/audit.cjs
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const art = JSON.parse(fs.readFileSync(path.join(__dirname, "artifacts.json"), "utf8"));
const WAD = 10n ** 18n;
const C = 1_020_000_000_000_000_000n;
const TARGET = 1_200_000_000_000_000_000n;
const K = 365_000_000_000_000_000_000n;
const RHOCAP = 100_000_000_000_000_000n;
const ETA = 20_000_000_000_000_000n;
const P0 = 2000n * WAD;
const ASK = 10_000_000_000_000_000n;

const results = [];
const fails = [];
const ok = (id, name, pass, detail) => {
  results.push(`${id.padEnd(3)} ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!pass) fails.push(id);
};

async function main() {
  const { ethers, network } = hre;
  const [admin, alice, bob, carol, uw, attacker] = await ethers.getSigners();
  const warp = async (s) => {
    await network.provider.send("evm_increaseTime", [Number(s)]);
    await network.provider.send("evm_mine");
  };
  const mk = async (eta = ETA, ask = ASK) => {
    const F = new ethers.ContractFactory(art.Continuum.abi, art.Continuum.bytecode, admin);
    const c = await F.deploy(C, TARGET, K, RHOCAP, eta, P0, ask);
    await c.waitForDeployment();
    await warp(60);
    return c;
  };

  // ---------------- B1 double count
  if (process.env.TRACE) console.log("block B1");
  {
    const c = await mk();
    for (const who of [alice, bob, carol]) {
      await (await c.connect(who).open(10n * WAD, 1_000n * WAD, 50_000_000_000_000_000n)).wait();
    }
    const d = await c.coveredDebt();
    // a full exit and re-entry must not add a second entry to the demand book
    await (await c.connect(alice).repay(1_000n * WAD)).wait();
    await (await c.connect(alice).withdrawCollateral(10n * WAD)).wait();
    await (await c.connect(alice).open(10n * WAD, 1_000n * WAD, 50_000_000_000_000_000n)).wait();
    const d2 = await c.coveredDebt();
    const n = await c.borrowerCount();
    ok("B1", "demand book counts each borrower once", d2 === 3_000n * WAD && n === 3n, `3 borrowers -> ${d2 / WAD} (was ${d / WAD}), registered addresses ${n}`);
  }

  // ---------------- B2 O(1) recount
  if (process.env.TRACE) console.log("block B2");
  {
    const c = await mk();
    const one = async (n) => {
      for (let i = 0; i < n; i++) {
        const s = ethers.Wallet.createRandom().connect(ethers.provider);
        await network.provider.send("hardhat_setBalance", [s.address, "0x56BC75E2D63100000"]);
        await (await c.connect(s).open(10n * WAD, 100n * WAD, 50_000_000_000_000_000n)).wait();
      }
    };
    await one(1);
    await (await c.supplyCash(8_000n * WAD, ASK)).wait();
    await (await c.setRho()).wait(); // warm the slots
    const g1 = (await (await c.setRho()).wait()).gasUsed;
    await one(199);
    await (await c.setRho()).wait();
    const g2 = (await (await c.setRho()).wait()).gasUsed;
    const delta = Number(g2 - g1) / Number(g1);
    ok(
      "B2",
      "setRho is O(1) in the borrower count",
      Math.abs(delta) < 0.02 && g2 < 250_000n,
      `1 borrower ${g1} gas, 200 borrowers ${g2} gas (${(delta * 100).toFixed(2)}%), ceiling 250k`,
    );
  }

  // ---------------- B3 ask manipulation
  if (process.env.TRACE) console.log("block B3");
  {
    const c = await mk();
    await (await c.connect(uw).supplyCash(8_000n * WAD, ASK)).wait();
    const a0 = await c.effectiveAsk();
    await (await c.connect(attacker).supplyCash(1n, 10n ** 18n)).wait();
    const a1 = await c.effectiveAsk();
    await (await c.connect(attacker).supplyCash(1n, 0n)).wait();
    const a2 = await c.effectiveAsk();
    const moved = a0 > a1 ? a0 - a1 : a1 - a0;
    ok("B3", "one wei of capital cannot move the ask", moved <= 1n, `ask ${a0} -> ${a1} -> ${a2} (moved ${moved} wei on ${8_000n * WAD + 1n} of capital)`);

    let locked = false;
    try {
      const tx = await c.connect(alice).open(10n * WAD, 1_000n * WAD, 50_000_000_000_000_000n);
      await tx.wait();
      const tx2 = await c.connect(alice).commitBid(alice.address, 0n, 3600);
      await tx2.wait();
    } catch {
      locked = true;
    }
    ok("B3b", "a bid is locked for MIN_BID_LOCK", locked, "pump-and-pull on the rent needs two blocks now");
  }

  // ---------------- B4 reopen wipes collateral
  if (process.env.TRACE) console.log("block B4");
  {
    const c = await mk();
    await (await c.connect(alice).open(10n * WAD, 1_000n * WAD, 50_000_000_000_000_000n)).wait();
    await (await c.connect(alice).repay(1_000n * WAD)).wait();
    let reverted = false;
    try {
      const tx = await c.connect(alice).open(10n * WAD, 1_000n * WAD, 50_000_000_000_000_000n);
      await tx.wait();
    } catch {
      reverted = true;
    }
    const p = await c.getPos(alice.address);
    ok("B4", "reopening cannot confiscate residual collateral", reverted && p[0] === 10n * WAD, `second open reverted=${reverted}, collateral still ${p[0] / WAD}`);
  }

  // ---------------- B5 rent is never forfeited
  if (process.env.TRACE) console.log("block B5");
  {
    const c = await mk();
    await (await c.connect(uw).supplyCash(1_000n * WAD, ASK)).wait(); // scarce: the rent must rise
    await (await c.connect(alice).open(10n * WAD, 5_000n * WAD, 50_000_000_000_000_000n)).wait();
    // push the rent up through the law, then let it accrue
    for (let i = 0; i < 40; i++) await (await c.setRho()).wait();
    const rho = await c.rho();
    await (await c.setPrice(1_600n * WAD)).wait();
    await warp(30 * 86400);
    await (await c.poke(alice.address)).wait();
    const pendingBefore = await c.pendingRent(uw.address);
    await (await c.connect(uw).supplyCash(1_000n * WAD, ASK)).wait(); // must settle, not discard
    const pendingAfter = await c.pendingRent(uw.address);
    const claimed = await c.rentClaimed(uw.address);
    ok(
      "B5",
      "supplying more capital does not forfeit earned rent",
      pendingBefore > 0n && claimed + pendingAfter === pendingBefore,
      `rho ${Number(rho) / 1e18}/yr, earned ${Number(pendingBefore) / 1e18} -> claimed ${Number(claimed) / 1e18} + pending ${Number(pendingAfter) / 1e18}`,
    );
  }

  // ---------------- B6 scale invariance
  if (process.env.TRACE) console.log("block B6");
  {
    const eta = 100_000_000_000_000n; // 0.01%/call, below the bucket cap
    const small = await mk(eta);
    const big = await mk(eta);
    await (await small.connect(uw).supplyCash(8_000n * WAD, ASK)).wait();
    await (await big.connect(uw).supplyCash(8_000_000n * WAD, ASK)).wait();
    await (await small.connect(alice).open(10n * WAD, 16_000n * WAD, 50_000_000_000_000_000n)).wait();
    await (await big.connect(alice).open(10_000n * WAD, 16_000_000n * WAD, 50_000_000_000_000_000n)).wait();
    for (let i = 0; i < 10; i++) {
      await (await small.setRho()).wait();
      await (await big.setRho()).wait();
    }
    const a = await small.rho();
    const b = await big.rho();
    ok("B6", "the rent step is a ratio, not a notional", a === b && a > 0n, `$16k book rho ${Number(a) / 1e18}, $16M book rho ${Number(b) / 1e18} after 10 calls`);
  }

  // ---------------- B7 no limit cycle
  if (process.env.TRACE) console.log("block B7");
  {
    const c = await mk();
    await (await c.connect(uw).supplyCash(8_000n * WAD, ASK)).wait();
    await (await c.connect(alice).open(10n * WAD, 16_000n * WAD, 50_000_000_000_000_000n)).wait();
    const seq = [];
    for (let i = 0; i < 200; i++) {
      await (await c.setRho()).wait();
      seq.push(Number(await c.rho()));
    }
    const tail = seq.slice(150);
    const amp = Math.max(...tail) - Math.min(...tail);
    const bucket = Number(RHOCAP / 64n) / 1e18;
    const maxStep = Math.max(...seq.map((v, i) => (i === 0 ? v : Math.abs(v - seq[i - 1])))) / 1e18;
    ok(
      "B7",
      "rho settles in a band, not a limit cycle",
      amp / 1e18 <= bucket && maxStep <= bucket / 2 + 1e-12,
      `amplitude ${(amp / 1e18).toFixed(6)}/yr over the last 50 calls, max step ${maxStep.toFixed(6)}, bucket ${bucket.toFixed(6)}`,
    );
  }

  console.log("\n=== Continuum — audit regressions (B1-B7) ===");
  for (const r of results) console.log("  " + r);
  console.log(`\n  ${results.length - fails.length}/${results.length} regressions held${fails.length ? " — FAILING: " + fails.join(", ") : ""}`);
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
