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

  it("rejects noncanonical/oversized envelopes and binds the committee id to authentication", () => {
    const committee = generateCommittee(3, 2);
    const foreign = generateCommittee(3, 2);
    const { sealed, shares } = sealOrder({ local: true }, committee);
    assert.throws(() => sealOrder({ big: "x".repeat(4096) }, committee), /payload size/);
    const tag = Buffer.from(sealed.tag, "base64");
    assert.throws(() => orderIdOf({ ...sealed, tag: tag.subarray(0, 12).toString("base64") }), /tag/);
    assert.throws(() => orderIdOf({ ...sealed, iv: `${sealed.iv}\n` }), /IV/);
    assert.throws(() => orderIdOf({ ...sealed, ciphertext: Buffer.alloc(4097).toString("base64") }), /ciphertext/);
    assert.throws(() => openOrder({ ...sealed, committeeId: foreign.id }, shares, foreign), /authenticate/i);
  });

  it("bounds share values, snapshots them, and never overwrites an accepted share", () => {
    const committee = generateCommittee(3, 2);
    const opener = new ThresholdOrderOpener(committee);
    const { sealed, shares, orderId } = sealOrder({ local: true }, committee);
    assert.throws(() => new ThresholdOrderOpener({ ...committee, xs: [1, 1, 2] }), /participant indices/);
    for (const y of ["01", "0x01", "1 ", "9".repeat(100), (2n ** 256n - 1n).toString()]) {
      assert.throws(() => opener.submitShare(orderId, { x: 1, y }), /share value/);
    }
    const copied = { ...shares[0] };
    opener.submitShare(orderId, copied);
    opener.submitShare(orderId, { ...copied }); // duplicate delivery is idempotent
    const other = copied.y === "1" ? "2" : "1";
    copied.y = other;
    assert.throws(() => opener.submitShare(orderId, copied), /conflicting share/);
    opener.submitShare(orderId, shares[1]);
    assert.deepEqual(opener.open(orderId, sealed), { local: true });
    assert.equal(opener.canOpen(orderId), false);
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
