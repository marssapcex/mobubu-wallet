import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateCommittee,
  sealOrder,
  openOrder,
  orderIdOf,
  ThresholdOrderOpener,
} from "../src/privacy/threshold.js";

describe("threshold sealed orderflow", () => {
  it("opens with t shares and rejects t-1 shares", () => {
    const committee = generateCommittee(5, 3);
    const payload = { from: "BTC", to: "ETH", amountThor: "123", secret: "hide-me" };
    const { sealed, shares, orderId } = sealOrder(payload, committee);
    assert.equal(orderIdOf(sealed), orderId);
    assert.deepEqual(openOrder(sealed, shares.slice(0, 3), committee), payload);
    assert.throws(() => openOrder(sealed, shares.slice(0, 2), committee), /not enough shares/);
  });

  it("rejects tampered ciphertext", () => {
    const committee = generateCommittee(3, 2);
    const { sealed, shares } = sealOrder({ a: 1 }, committee);
    const buf = Buffer.from(sealed.ciphertext, "base64");
    buf[0] ^= 0xff;
    const tampered = { ...sealed, ciphertext: buf.toString("base64") };
    assert.throws(() => openOrder(tampered, shares.slice(0, 2), committee));
  });

  it("rejects duplicate or out-of-committee share indices", () => {
    const committee = generateCommittee(4, 2);
    const { sealed, shares } = sealOrder({ a: 1 }, committee);
    assert.throws(
      () => openOrder(sealed, [shares[0], shares[0]], committee),
      /duplicate share index/,
    );
    assert.throws(
      () => openOrder(sealed, [{ x: 99, y: "1" }, shares[1]], committee),
      /share index not in committee/,
    );
  });

  it("ThresholdOrderOpener waits for enough shares", () => {
    const committee = generateCommittee(5, 3);
    const opener = new ThresholdOrderOpener(committee);
    const { sealed, shares, orderId } = sealOrder({ hello: "world" }, committee);
    opener.submitShare(orderId, shares[0]);
    opener.submitShare(orderId, shares[1]);
    assert.equal(opener.canOpen(orderId), false);
    assert.throws(() => opener.open(orderId, sealed), /not enough shares/);
    opener.submitShare(orderId, shares[2]);
    assert.equal(opener.canOpen(orderId), true);
    assert.deepEqual(opener.open(orderId, sealed), { hello: "world" });
  });
});
