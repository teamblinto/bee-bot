import { toErrorReport } from "@beebot/contracts";
import { createHashHistory, createRouter, type RouterHistory } from "@tanstack/react-router";

import { AppError } from "./components/AppError";
import { routeTree } from "./routeTree.gen";
import { postCommand } from "./serverConnection";

// Hash history because production loads via file://, where pathnames are disk paths.
export function getRouter(history: RouterHistory = createHashHistory()) {
  return createRouter({
    routeTree,
    history,
    defaultErrorComponent: AppError,
    defaultOnCatch: (error) =>
      void postCommand({ type: "report-error", error: toErrorReport(error, "web") }),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
