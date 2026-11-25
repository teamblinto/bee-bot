// @vitest-environment jsdom
import type { Bot, Room } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const postCommand = vi.hoisted(() => vi.fn());
vi.mock("../serverConnection", () => ({ postCommand }));

const { RoomSettingsDialog } = await import("./RoomDialog");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};

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

const ids = Array.from({ length: 7 }, (_, index) => `bot-${index}`);
const bots = ids.map((id, index) => ({ id, name: `Bot ${index}` })) as Bot[];
const room = (members: string[]): Room => ({
  id: "room",
  kind: "group",
  name: "Research",
  defaultBotId: null,
  members,
  createdAt: "2026-11-25T00:00:00.000Z",
  responderMode: "mentions",
  leadBotId: null,
  bulletin: "",
  limits: {},
  held: null,
  heldUntil: null,
});

const show = (members: string[]) =>
  act(() =>
    root.render(<RoomSettingsDialog room={room(members)} bots={bots} onClose={() => {}} />),
  );

const radio = (value: string) =>
  host.querySelector<HTMLInputElement>(`input[type=radio][value=${value}]`)!;

it("saves only the settings the owner changed, and offers everyone only up to 6 members", async () => {
  show(ids);
  expect(radio("everyone_optional").disabled).toBe(true);
  expect(radio("default").disabled).toBe(true);

  show(ids.slice(0, 6));
  expect(radio("everyone_optional").disabled).toBe(false);

  postCommand.mockResolvedValue({ ok: true, body: {} });
  act(() => radio("lead").click());
  const select = host.querySelector("select")!;
  act(() => {
    select.value = "bot-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")!.requestSubmit());

  expect(postCommand).toHaveBeenCalledExactlyOnceWith({
    type: "update-room",
    roomId: "room",
    responderMode: "lead",
    leadBotId: "bot-2",
  });
});
