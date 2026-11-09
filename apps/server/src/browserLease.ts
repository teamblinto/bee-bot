// One holder at a time. Every snapshot and every handback starts a new generation, and a ref only
// resolves in the generation it came from: after a person had control, the bot's old refs are stale
// and it gets a fresh snapshot before it can act on the page again. The same lease covers the
// desktop, which has no refs: `mustObserve` is set by every handback and cleared by the next
// snapshot or screenshot, and P4's computer_* tools refuse to act while it is set.
export type Lease = {
  holder: "bot" | "human";
  leaseId: string | null;
  generation: number;
  mustObserve: boolean;
};

export const freshLease: Lease = {
  holder: "bot",
  leaseId: null,
  generation: 0,
  mustObserve: false,
};

export const elementRef = (generation: number, index: number) => `${generation}:${index}`;

export function parseRef(ref: string) {
  const match = /^(\d{1,9}):(\d{1,4})$/.exec(ref);
  return match ? { generation: Number(match[1]), index: Number(match[2]) } : undefined;
}

export function takeLease(lease: Lease, leaseId: string) {
  return lease.holder === "human"
    ? { refused: "held" as const }
    : { lease: { ...lease, holder: "human" as const, leaseId } };
}

export function giveLease(lease: Lease, leaseId: string) {
  if (lease.holder !== "human" || lease.leaseId !== leaseId) {
    return { refused: "not_holder" as const };
  }
  return {
    lease: {
      holder: "bot" as const,
      leaseId: null,
      generation: lease.generation + 1,
      mustObserve: true,
    },
  };
}

// `ref` is set for a step that acts on an element.
export function botMay(lease: Lease, ref?: string) {
  if (lease.holder === "human") {
    return "human_has_control";
  }
  if (ref === undefined) {
    return "ok";
  }
  return parseRef(ref)?.generation === lease.generation ? "ok" : "stale_ref";
}

export const afterSnapshot = (lease: Lease): Lease => ({
  ...lease,
  generation: lease.generation + 1,
  mustObserve: false,
});
