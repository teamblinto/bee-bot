// @vitest-environment jsdom
import type { Approval, ApprovalChange, Continuation, PendingApproval } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const postCommand = vi.hoisted(() => vi.fn());
vi.mock("../serverConnection", () => ({ postCommand }));

const { ApprovalCard, ContinuationCard } = await import("./ApprovalCard");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  postCommand.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const approval: Approval = {
  id: "approval",
  runId: "run",
  botId: "bot",
  tool: "Edit",
  digest: "the-digest",
  status: "pending",
  reason: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  decidedAt: null,
};

const pending = (change: PendingApproval["change"]): PendingApproval => ({
  id: approval.id,
  detail: "notes.txt",
  change,
  canAlwaysAllow: false,
  expiresAt: "2026-11-06T00:05:00.000Z",
});

const edit = { action: "edit", removed: "old", added: "new", hiddenChars: 0, replaceAll: false };

const show = (change: PendingApproval["change"]) =>
  act(() =>
    root.render(
      <ApprovalCard name="Ada" approval={approval} pending={pending(change)} connected />,
    ),
  );

const preview = () => host.querySelector('[aria-label="Proposed change"]');

it("marks each side of an edit with a prefix, not colour alone", () => {
  show({ ...edit, action: "edit" });
  expect(preview()?.textContent).toBe("- old+ new");
  expect(preview()?.getAttribute("tabindex")).toBe("0");
  expect(preview()?.children).toHaveLength(2);
});

it("shows no preview for a call with nothing to change", () => {
  show(null);
  expect(preview()).toBeNull();
  expect(host.textContent).not.toContain("not shown");
});

it("says a write is empty rather than showing a blank preview", () => {
  show({ action: "create", removed: null, added: "", hiddenChars: 0, replaceAll: false });
  expect(preview()).toBeNull();
  expect(host.textContent).toContain("New file");
  expect(host.textContent).toContain("Empty file");
});

const patch = (files: NonNullable<ApprovalChange["files"]>, hiddenChars = 0): ApprovalChange => ({
  action: "patch",
  removed: null,
  added: "",
  hiddenChars,
  replaceAll: false,
  files,
});

const groups = () => [...host.querySelectorAll('[role="group"]')];

it("labels each file of a patch inside one scrolling preview", () => {
  show(
    patch([
      { path: "a.ts", removed: "old", added: "new" },
      { path: "b.ts", removed: "", added: "more" },
    ]),
  );
  expect(host.querySelectorAll('[aria-label="Proposed change"]')).toHaveLength(1);
  expect(groups().map((group) => group.getAttribute("aria-label"))).toEqual(["a.ts", "b.ts"]);
  expect(groups().map((group) => group.textContent)).toEqual(["a.ts- old+ new", "b.ts+ more"]);
  expect(groups()[0]?.querySelector(".text-danger")?.textContent).toBe("- old");
  expect(groups()[0]?.querySelector(".text-honey")?.textContent).toBe("+ new");
});

it("still names a patched file with no lines, and never calls a patch an empty file", () => {
  show(patch([{ path: "empty.txt", removed: "", added: "" }]));
  expect(preview()?.textContent).toBe("empty.txt");
  expect(host.textContent).not.toContain("Empty file");
});

it("makes characters hidden in a patched path or line visible", () => {
  show(patch([{ path: "safe\u202Etxt.exe", removed: "", added: "zero\u200Bwidth" }]));
  expect(groups()[0]?.getAttribute("aria-label")).toBe("safe[U+202E]txt.exe");
  expect(preview()?.textContent).toBe("safe[U+202E]txt.exe+ zero[U+200B]width");
});

it("says what a patch's preview leaves out", () => {
  show(patch([{ path: "a.ts", removed: "", added: "new" }], 1));
  expect(host.textContent).toContain("1 more character not shown.");
});

it("says what is hidden right above the buttons, and Allow stays enabled", () => {
  show({ ...edit, action: "edit", hiddenChars: 12_345 });
  const line = host.querySelector(".justify-end")?.previousElementSibling;
  expect(line?.textContent).toBe(
    "12,345 more characters not shown. Allowing applies the whole change.",
  );
  const allow = [...host.querySelectorAll("button")].find(
    ({ textContent }) => textContent === "Allow once",
  );
  expect(allow?.disabled).toBe(false);
});

it("decides with the digest", async () => {
  postCommand.mockResolvedValue({ ok: true });
  show({ ...edit, action: "edit" });
  const allow = [...host.querySelectorAll("button")].find(
    ({ textContent }) => textContent === "Allow once",
  );
  await act(async () => allow?.click());
  expect(postCommand).toHaveBeenCalledWith({
    type: "decide-approval",
    approvalId: approval.id,
    digest: approval.digest,
    decision: "allow",
  });
});

const continuation: Continuation = {
  id: "continuation",
  botId: "bot",
  runId: "run",
  kind: "approval",
  tool: "Bash",
  shown: "Bash: npm publish",
  digest: "shown-digest",
  status: "waiting",
  reason: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  expiresAt: "2026-11-06T00:30:00.000Z",
  decidedAt: null,
  finishedAt: null,
};

const button = (label: string) =>
  [...host.querySelectorAll("button")].find(({ textContent }) => textContent === label);

it("answers a Box bot's action bound to the digest of exactly what it shows", async () => {
  postCommand.mockResolvedValue({ ok: true });
  act(() => root.render(<ContinuationCard name="Ada" continuation={continuation} connected />));
  expect(host.querySelector('[aria-label="Exact request"]')?.textContent).toBe("Bash: npm publish");
  await act(async () => button("Approve")?.click());
  await act(async () => button("Deny")?.click());
  expect(postCommand).toHaveBeenCalledTimes(1);
  expect(postCommand).toHaveBeenCalledWith({
    type: "decide-continuation",
    continuationId: continuation.id,
    digest: continuation.digest,
    decision: "approve",
  });
});

it("asks the owner to do a hand_off themselves, and never offers to run it", () => {
  act(() =>
    root.render(
      <ContinuationCard
        name="Ada"
        continuation={{ ...continuation, kind: "hand_off" }}
        connected
      />,
    ),
  );
  expect(button("Approve")).toBeUndefined();
  expect(button("I did it")).toBeDefined();
  expect(host.textContent).toContain("Bee never does this itself");
});
