import { meta, type Asset } from "../assets.js";
import type { SwapPair } from "./types.js";

export type PrivacyLevel = "shielded" | "mixed" | "transparent";

export interface PrivacyReport {
  level: PrivacyLevel;
  shieldedLegs: Asset[];
  transparentLegs: Asset[];
  warnings: string[];
}

export function assessPrivacy(pair: SwapPair): PrivacyReport {
  const assets = [pair.from, pair.to];
  const shieldedLegs = assets.filter((a) => meta(a).shielded);
  const transparentLegs = assets.filter((a) => !meta(a).shielded);

  const warnings: string[] = [];
  let level: PrivacyLevel;
  if (shieldedLegs.length === 2) {
    level = "shielded";
  } else if (shieldedLegs.length === 1) {
    level = "mixed";
    warnings.push(
      "One leg settles on a transparent chain. Amounts/addresses on that leg are public.",
    );
  } else {
    level = "transparent";
    warnings.push(
      "Both legs settle on transparent chains. FHE hides the intent from the matcher, not the final on-chain transfers.",
    );
  }

  if (pair.from === "DAI" || pair.to === "DAI") {
    warnings.push(
      "DAI is an ERC-20 on Ethereum; ERC-20 transfers are publicly traceable.",
    );
  }

  warnings.push(
    "The public intent header still reveals asset pair, destination, refund address, deadline and memo hash. FHE hides amount/minOut from the matcher, not this header.",
  );
  warnings.push(
    "A 'shielded' classification assumes correct shielded address types, wallet behavior and no transparent change leakage. This reference code does not validate real address formats or enforce network-level privacy.",
  );
  warnings.push(
    "Use fresh destination/refund addresses, avoid address reuse, and route RPC traffic through Tor/I2P where possible.",
  );

  return { level, shieldedLegs, transparentLegs, warnings };
}

export function enforcePrivacy(
  pair: SwapPair,
  requireShieldedLeg: boolean,
): PrivacyReport {
  const report = assessPrivacy(pair);
  if (requireShieldedLeg && report.level === "transparent") {
    throw new Error(
      `Privacy policy rejected ${pair.from}->${pair.to}: at least one shielded leg (XMR/ZEC) is required.`,
    );
  }
  return report;
}
