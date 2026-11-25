// @vitest-environment jsdom
import type { Bot, Room, TeamRequest } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const postCommand = vi.hoisted(() => vi.fn());
vi.mock("../serverConnection", () => ({ postCommand }));

const { TeamRequestCard } = await import("./TeamRequestCard");

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

const request = (kind: TeamRequest["kind"], payload: TeamRequest["payload"]): TeamRequest => ({
  id: "4f8a5f43-5a8e-4a43-9d0b-5c1f3f0f6a11",
  kind,
  payload,
  requestedByBotId: "lead",
  runId: "run",
  status: "pending",
  result: null,
  createdAt: "2026-11-25T00:00:00.000Z",
  decidedAt: null,
});

const bots = [{ id: "kid", name: "Scout" }] as Bot[];
const rooms = [{ id: "room", kind: "group", name: "Research" }] as Room[];

const show = (shown: TeamRequest) =>
  act(() => root.render(<TeamRequestCard request={shown} bots={bots} rooms={rooms} connected />));

const button = (name: string) =>
  [...host.querySelectorAll("button")].find(({ textContent }) => textContent === name)!;

it("applies a request with one click and can't send it twice", async () => {
  let finish = (_: unknown) => {};
  postCommand.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  show(request("archive_bot", { bot_id: "kid" }));

  await act(async () => {
    button("Apply").click();
    button("Apply").click();
  });

  expect(postCommand).toHaveBeenCalledTimes(1);
  expect(postCommand).toHaveBeenCalledWith({
    type: "decide-team-request",
    requestId: "4f8a5f43-5a8e-4a43-9d0b-5c1f3f0f6a11",
    decision: "apply",
  });
  expect(button("Apply").disabled).toBe(true);
  expect(button("Decline").disabled).toBe(true);
  await act(async () => finish({ ok: true }));
});

it("shows a refusal inline and lets the owner try again", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "That request was already decided." });
  show(request("archive_bot", { bot_id: "kid" }));

  await act(async () => button("Decline").click());

  expect(host.textContent).toContain("That request was already decided.");
  expect(button("Decline").disabled).toBe(false);
});

it("names bots and rooms by their ids, and says when one is gone", () => {
  show(request("invite_to_room", { room_id: "room", bot: "gone" }));
  expect(host.textContent).toContain("Research");
  expect(host.textContent).toContain("a removed bot");

  show(request("create_bot", { name: "Kit", personality: "Careful", join_rooms: ["room"] }));
  expect(host.textContent).toContain("Kit");
  expect(host.textContent).toContain("Research");
});

it("shows the lead's whole first task, however long", () => {
  const firstTask = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: do the thing.`).join("\n");
  show(request("create_bot", { name: "Kit", first_task: firstTask }));
  expect(host.textContent).toContain(firstTask);
});
