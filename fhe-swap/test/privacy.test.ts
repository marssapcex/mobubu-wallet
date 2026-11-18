import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessPrivacy, enforcePrivacy } from "../src/core/privacy.js";

describe("privacy policy", () => {
  it("marks XMR->ZEC as shielded", () => {
    const report = assessPrivacy({ from: "XMR", to: "ZEC" });
    assert.equal(report.level, "shielded");
    assert.deepEqual(report.shieldedLegs, ["XMR", "ZEC"]);
  });

  it("marks BTC->XMR as mixed", () => {
    const report = assessPrivacy({ from: "BTC", to: "XMR" });
    assert.equal(report.level, "mixed");
  });

  it("marks BTC->ETH and DAI legs as transparent", () => {
    assert.equal(assessPrivacy({ from: "BTC", to: "ETH" }).level, "transparent");
    assert.equal(assessPrivacy({ from: "DAI", to: "ETH" }).level, "transparent");
  });

  it("enforces at least one shielded leg when requested", () => {
    assert.throws(
      () => enforcePrivacy({ from: "BTC", to: "ETH" }, true),
      /Privacy policy rejected/,
    );
    assert.doesNotThrow(() => enforcePrivacy({ from: "BTC", to: "XMR" }, true));
    assert.doesNotThrow(() => enforcePrivacy({ from: "XMR", to: "ZEC" }, true));
  });
});
