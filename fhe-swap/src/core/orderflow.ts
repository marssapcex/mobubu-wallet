import { normalizeSealedOrder, orderIdOf, type SealedOrder } from "../privacy/threshold.js";

/**
 * Private orderflow layer.
 *
 * The public relayer/mempool stores only sealed blobs. It cannot see asset pair,
 * amount, minOut, destination, refund address, or streaming schedule. Those are
 * revealed only to the vault committee after threshold opening.
 *
 * This is a reference in-memory orderflow. Production would use a private
 * relayer network, committee share channels, and anti-censorship inclusion.
 */
export class PrivateOrderFlow {
  private orders = new Map<string, SealedOrder>();

  submit(sealed: SealedOrder): string {
    const envelope = normalizeSealedOrder(sealed);
    const id = orderIdOf(envelope);
    if (this.orders.has(id)) throw new Error("sealed order already exists");
    this.orders.set(id, envelope);
    return id;
  }

  get(orderId: string): SealedOrder | undefined {
    const order = this.orders.get(orderId);
    return order ? structuredClone(order) : undefined;
  }

  has(orderId: string): boolean {
    return this.orders.has(orderId);
  }

  listSealed(): SealedOrder[] {
    return [...this.orders.values()].map((order) => structuredClone(order));
  }

  size(): number {
    return this.orders.size;
  }
}
