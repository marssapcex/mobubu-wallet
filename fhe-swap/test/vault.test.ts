import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OneTimeVaultBook } from "../src/chains/vault.js";

describe("one-time vault deposit book", () => {
  it("allocates fresh addresses not derived from plaintext order fields", () => {
    let now = 100;
    const book = new OneTimeVaultBook(() => now);
    const a = book.allocate("order-1", "tag-1", "bitcoin", "BTC");
    now += 1;
    const b = book.allocate("order-2", "tag-2", "bitcoin", "BTC");
    assert.notEqual(a.address, b.address);
    assert.ok(!a.address.includes("order-1"));
    assert.ok(!a.address.includes("tag-1"));
    assert.equal(book.resolve(a.address)?.orderId, "order-1");
  });

  it("returns the same unused address for the same order/chain/asset", () => {
    const book = new OneTimeVaultBook(() => 1);
    const a = book.allocate("order-1", "tag-1", "ethereum", "ETH");
    const b = book.allocate("order-1", "tag-1", "ethereum", "ETH");
    assert.equal(a.address, b.address);
  });

  it("rejects reuse after markUsed", () => {
    const book = new OneTimeVaultBook(() => 1);
    const a = book.allocate("order-1", "tag-1", "monero", "XMR");
    book.markUsed(a.address);
    assert.throws(() => book.markUsed(a.address), /already used/);
    assert.throws(
      () => book.allocate("order-1", "tag-1", "monero", "XMR"),
      /already used/,
    );
  });
});
