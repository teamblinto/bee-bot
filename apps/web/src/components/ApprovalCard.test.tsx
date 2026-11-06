// @vitest-environment jsdom
import type { Approval, PendingApproval } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const postCommand = vi.hoisted(() => vi.fn());
vi.mock("../serverConnection", () => ({ postCommand }));

const { ApprovalCard } = await import("./ApprovalCard");

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
