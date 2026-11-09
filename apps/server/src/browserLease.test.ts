import { describe, expect, it } from "vite-plus/test";

import {
  afterSnapshot,
  botMay,
  elementRef,
  freshLease,
  giveLease,
  type Lease,
  takeLease,
} from "./browserLease.ts";

function taken(lease: Lease, leaseId: string) {
  const result = takeLease(lease, leaseId);
  if (!result.lease) {
    throw new Error(result.refused);
  }
  return result.lease;
}

describe("browser control lease", () => {
  it("keeps the bot's hands off while a person holds it", () => {
    const seen = afterSnapshot(freshLease);
    const held = taken(seen, "a");
    expect(botMay(held)).toBe("human_has_control");
    expect(botMay(held, elementRef(seen.generation, 0))).toBe("human_has_control");
  });

  it("lets only one person hold it, and only the holder give it back", () => {
    const held = taken(freshLease, "a");
    expect(takeLease(held, "b")).toEqual({ refused: "held" });
    expect(giveLease(held, "b")).toEqual({ refused: "not_holder" });
    expect(giveLease(freshLease, "a")).toEqual({ refused: "not_holder" });
    expect(giveLease(held, "a").lease?.holder).toBe("bot");
  });

  it("makes the bot's refs stale after a handback", () => {
    const seen = afterSnapshot(freshLease);
    const ref = elementRef(seen.generation, 3);
    expect(botMay(seen, ref)).toBe("ok");
    const back = giveLease(taken(seen, "a"), "a").lease;
    expect(back && botMay(back, ref)).toBe("stale_ref");
    expect(back && botMay(back)).toBe("ok");
  });

  it("honours only refs from the latest snapshot", () => {
    const first = afterSnapshot(freshLease);
    const second = afterSnapshot(first);
    expect(botMay(second, elementRef(first.generation, 0))).toBe("stale_ref");
    expect(botMay(second, elementRef(second.generation, 0))).toBe("ok");
    expect(botMay(second, "nonsense")).toBe("stale_ref");
  });
});
