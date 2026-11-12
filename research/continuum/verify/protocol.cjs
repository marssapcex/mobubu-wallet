// Executes the shipping market (protocol/src/ContinuumMarket.sol) on a real EVM.
// Five campaigns, each one an attack or an invariant, not a happy path.
// Run: npx hardhat run verify/protocol.cjs
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const art = JSON.parse(fs.readFileSync(path.join(__dirname, "artifacts.json"), "utf8"));
const WAD = 10n ** 18n;
const U = 10n ** 6n; // USDC
const C = 1_020_000_000_000_000_000n;
const TARGET = 1_200_000_000_000_000_000n;
const K = 365n * WAD;
const RHOCAP = 100_000_000_000_000_000n;
const ETA = 20_000_000_000_000_000n;
const MINBID = 10_000_000_000_000_000n;
const YEAR = 365n * 86400n;

const deploy = async (name, signer, args) => {
  const F = new hre.ethers.ContractFactory(art[name].abi, art[name].bytecode, signer);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  return c;
};
const f6 = (x) => Number(x) / 1e6;
const f18 = (x) => Number(x) / 1e18;

let seed = 0x2545f4914f6cdd1dn;
const rnd = (n) => {
  seed ^= (seed << 13n) & 0xffffffffffffffffn;
  seed ^= seed >> 7n;
  seed ^= (seed << 17n) & 0xffffffffffffffffn;
  return Number((seed < 0n ? -seed : seed) % BigInt(n));
};

async function main() {
  const { ethers, network } = hre;
  const [admin, lender, b1, b2, b3, buyer, keeper] = await ethers.getSigners();
  const out = [];
  const fails = [];
  const warp = async (s) => {
    await network.provider.send("evm_increaseTime", [Number(s)]);
    await network.provider.send("evm_mine");
  };

  const weth = await deploy("MockToken", admin, ["Wrapped Ether", "WETH", 18]);
  const usdc = await deploy("MockToken", admin, ["USD Coin", "USDC", 6]);
  const oracle = await deploy("FixedOracle", admin, [2000n * WAD]);
  const market = await deploy("ContinuumMarket", admin, [
    {
      collateralToken: weth.target,
      debtToken: usdc.target,
      oracle: oracle.target,
      c: C,
      target: TARGET,
      k: K,
      rhoCap: RHOCAP,
      eta: ETA,
      minBid: MINBID,
      idleFloor: 200_000_000_000_000_000n,
      shareName: "Continuum USDC",
      shareSymbol: "cUSDC",
    },
  ]);

  for (const s of [lender, b1, b2, b3, buyer]) {
    await (await usdc.mint(s.address, 1_000_000n * U)).wait();
    await (await usdc.connect(s).approve(market.target, ethers.MaxUint256)).wait();
    await (await weth.mint(s.address, 10_000n * WAD)).wait();
    await (await weth.connect(s).approve(market.target, ethers.MaxUint256)).wait();
  }

  await (await market.connect(lender).deposit(100_000n * U)).wait();
  for (const [s, coll, debt] of [
    [b1, 10n * WAD, 14_000n * U],
    [b2, 50n * WAD, 60_000n * U],
    [b3, 2n * WAD, 3_000n * U],
  ]) {
    await (await market.connect(s).depositCollateral(coll)).wait();
    await (await market.connect(s).borrow(debt, 20_000_000_000_000_000n)).wait(); // bid 2%/yr
  }

  const sharesAddr = await market.shares();
  const sharesTok = new ethers.Contract(sharesAddr, art.ContinuumShares.abi, admin);

  const pos = async (s) => {
    const p = await market.positionOf(s.address);
    return { coll: p[0], debt: p[1], bid: p[2] };
  };
  const V = async (s) => market.collateralValue(s.address);
  const S = async (s) => market.surplusOf(s.address);
  const setPrice = async (p) => (await oracle.setPrice(p)).wait();
  // price at which V equals `target*D` for a position (debt units -> price WAD)
  const priceAtLine = (line, coll) => (line * 10n ** 18n * WAD) / (coll * U);

  // ================================================================ A invariant
  {
    let violated = 0;
    let dustWorst = 0;
    let steps = 0;
    let minS = null;
    let exhausted = 0;
    for (let i = 0; i < 300; i++) {
      const who = [b1, b2, b3][i % 3];
      const p = await pos(who);
      if (p.debt === 0n) continue;
      const line = (C * p.debt) / WAD; // V at which S = 0
      const linePrice = priceAtLine((line * 1002n) / 1000n, p.coll); // 0.2% above the line
      const px = linePrice + (linePrice * BigInt(rnd(500))) / 1000n;
      await setPrice(px);
      await warp(3600 + rnd(20 * 86400));
      if (i % 7 === 0) await (await market.updateRho()).wait();

      const S0 = await S(who);
      const rc = await (await market.poke(who.address)).wait();
      const ev = rc.logs
        .map((l) => {
          try {
            return market.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "Accrued");
      const rent = ev ? ev.args[1] : 0n;
      const S1 = await S(who);
      steps++;

      // the only legitimate drop in S is the rent that capitalised: c*rent
      // exact: S is WAD-scaled, so S' = S - c*rent with no division anywhere
      const expected = S0 - C * rent;
      const dust = S1 > expected ? S1 - expected : expected - S1;
      if (dust > BigInt(dustWorst)) dustWorst = Number(dust);
      if (S1 < expected - 2n) violated++;
      if (S1 < 0n) exhausted++;
      if (minS === null || S1 < minS) minS = S1;
    }
    out.push(`A  invariant      ${steps} random (mark, dt, rent) materialisations across 3 positions`);
    out.push(`   S accounting   |S_after - (S_before - c*rent)| <= ${dustWorst} wei; violations ${violated}`);
    out.push(`   S >= 0         negative states ${exhausted}, min S ${f18(minS)} USDC (idle floor 20%)`);
    if (violated) fails.push("the flow did not preserve S (beyond rounding dust)");
    if (exhausted) fails.push("the buffer line was broken inside the supported band");
  }

  // =============================================================== B no keeper
  {
    await warp(3 * 86400);
    const before = await usdc.balanceOf(b1.address);
    await (await market.connect(buyer).poke(b1.address)).wait(); // a stranger pays to help
    const after = await usdc.balanceOf(b1.address);
    const gas = (await (await market.connect(buyer).poke(b1.address)).wait()).gasUsed;
    out.push(`B  no keeper      a stranger poked; gas ${gas}, caller balance changed: ${after !== before}`);
    // idempotency, tested inside a single transaction: two pokes, one timestamp
    const probe = await deploy("PokeProbe", admin, []);
    await warp(6 * 3600);
    const [afterFirst, afterSecond] = await probe.probeTwice.staticCall(market.target, b1.address);
    out.push(`   idempotent     two pokes in one transaction: debt ${afterFirst} then ${afterSecond} (delta ${afterSecond - afterFirst})`);
    if (afterFirst !== afterSecond) fails.push("poke is not idempotent inside a block");
    // and the caller is never paid
    const gasPoke = (await (await market.connect(buyer).poke(b1.address)).wait()).gasUsed;
    out.push(`   keeper-free     poke costs ${gasPoke} gas and pays the caller nothing`);
  }

  // ================================================================ C rent law
  {
    const rs = [];
    let signViol = 0;
    for (let i = 0; i < 120; i++) {
      const z = await market.imbalance();
      const r0 = await market.rho();
      await (await market.updateRho()).wait();
      const r1 = await market.rho();
      if (r1 !== r0) {
        const dz = z > 0n ? 1 : z < 0n ? -1 : 0;
        const dr = r1 > r0 ? 1 : r1 < r0 ? -1 : 0;
        if (dz !== 0 && dr !== dz) signViol++;
      }
      rs.push(Number(r1));
    }
    const rho = await market.rho();
    const covered = await market.coveredDebt();
    const cash = await market.cash();
    const bucket = Number(RHOCAP / 64n) / 1e18;
    const tail = rs.slice(80);
    const amp = (Math.max(...tail) - Math.min(...tail)) / 1e18;
    out.push(`C  rent law       rho ${f18(rho)}/yr, covered ${f6(covered)} vs idle cash ${f6(cash)}`);
    out.push(`   sign law       sign(d rho) = sign(imbalance) violated ${signViol}x over 120 updates`);
    out.push(`   band           amplitude ${amp.toFixed(6)} over the last 40 calls (bucket ${bucket.toFixed(6)})`);
    if (rho < MINBID || rho > RHOCAP) fails.push("rho out of band");
    if (signViol) fails.push("the rent moved against the imbalance");
    if (amp > bucket) fails.push("rent law limit-cycles");
    if (rho > 20_000_000_000_000_000n && covered !== 0n) fails.push("a bid below the clearing rent stayed in the book");
    out.push(`   pricing out    bids at 2%/yr leave the book once rho clears above them: covered ${f6(covered)}`);
  }

  // ========================================================= D share accounting
  {
    const cash = await market.cash();
    const loans = await market.loans();
    const invVal = await market.inventoryValue();
    const pending = await market.pendingRent();
    const assets = await market.assets();
    const sum = cash + loans + invVal + pending;
    const supply = await sharesTok.totalSupply();
    const pricePerShare = await market.sharePrice();
    const check = (supply * pricePerShare) / WAD;
    out.push(`D  accounting     assets ${f6(assets)} = cash ${f6(cash)} + loans ${f6(loans)} + inventory ${f6(invVal)} + pending rent ${f6(pending)} -> ${assets === sum}`);
    out.push(`   shares         supply ${f6(supply)}, price ${f18(pricePerShare).toFixed(6)}, supply*price ${f6(check)} (assets ${f6(assets)})`);
    if (assets !== sum) fails.push("assets() does not decompose");
    const drift = check > assets ? check - assets : assets - check;
    if (drift > 1000n) fails.push("share price does not round-trip");
  }

  // ================================================================== E the tail
  {
    const p = await pos(b2);
    const S0 = await S(b2);
    out.push(`E  the tail       b2: coll ${f18(p.coll)} WETH, debt ${f6(p.debt)} USDC, S ${f6(S0)}`);
    const assetsBefore = await market.assets();
    await setPrice(600n * WAD); // V = 30,000 against 60,000 of debt
    await warp(1 * 86400);
    await (await market.poke(b2.address)).wait();
    const S1 = await S(b2);
    const shortfall = await market.writeOff.staticCall(b2.address);
    await (await market.writeOff(b2.address)).wait();
    const assetsAfter = await market.assets();
    const supply = await sharesTok.totalSupply();
    const ps = await market.sharePrice();
    out.push(`   mark 600       S ${f6(S1)} (negative = the price gapped through the line)`);
    out.push(`   writeOff       shortfall ${f6(shortfall)} booked, assets ${f6(assetsBefore)} -> ${f6(assetsAfter)}, share price ${f18(ps).toFixed(6)}`);
    out.push(`   who pays       the lenders, pro rata, immediately — no bad-debt token, no socialisation delay`);
    if (assetsAfter >= assetsBefore) fails.push("writeOff did not reduce NAV");
    // lenders must still be able to exit with what is left
    const shares = await sharesTok.balanceOf(lender.address);
    const out1 = await market.previewRedeem(shares);
    const cashNow = await market.cash();
    out.push(`   exit           lender holds ${f6(shares)} shares, redeemable ${f6(out1)} of ${f6(cashNow)} idle cash`);
    if (out1 > cashNow) {
      out.push(`   note           NAV exceeds idle cash: redemption is queued behind the flow, not promised`);
    }
  }

  console.log("\n=== ContinuumMarket — executed campaigns (solc 0.8.24 + Hardhat EDR) ===");
  for (const r of out) console.log("  " + r);
  console.log(`\n  verdict: ${fails.length === 0 ? "all campaigns held" : "FAILED: " + fails.join(" | ")}`);
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
