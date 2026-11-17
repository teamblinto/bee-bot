// @vitest-environment jsdom
import { createMemoryHistory } from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";

import { getRouter } from "./router";

it("has the index route", () => {
  expect(getRouter(createMemoryHistory()).routesByPath).toHaveProperty("/");
});
