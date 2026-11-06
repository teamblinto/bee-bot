import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";

import type { LiveTool } from "../serverConnection";
import { ThinkingRow, WorkGroup } from "./WorkLog";

const render = (node: React.ReactNode) => renderToStaticMarkup(node);
const tool = (status: LiveTool["status"]): LiveTool => ({
  id: "a",
  name: "Bash",
  detail: "ls",
  status,
});

it("shows the live Thinking row when the engine hides the thought", () => {
  const html = render(<ThinkingRow text="" />);
  expect(html).toContain("Thinking");
  expect(html).toContain("live-activity-focus");
});

it("shows the thought in place of the row when there is text", () => {
  const html = render(<ThinkingRow text={"first idea\nsecond idea"} />);
  expect(html).toContain("second idea");
  expect(html).not.toContain("first idea");
  expect(html).not.toContain("Thinking");
  expect(html).not.toContain("live-activity-focus");
});

it("folds a finished group and opens a live one", () => {
  const finished = render(<WorkGroup label="Worked" tools={[tool("done")]} />);
  expect(finished).toContain('aria-expanded="false"');
  expect(finished).not.toContain("Ran ls");

  const live = render(<WorkGroup live label="Working" tools={[tool("running")]} />);
  expect(live).toContain("Running ls");
  expect(live).toContain("live-tool-shine");
});

it("tints a failed tool and says so in words", () => {
  const html = render(<WorkGroup live label="Working" tools={[tool("failed")]} />);
  expect(html).toContain("text-danger");
  expect(html).toContain("1 failed");
  expect(html).toContain("Failed");
});
