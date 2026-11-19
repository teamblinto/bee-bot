import * as NodeUtil from "node:util";

const levels = { log: "info", info: "info", warn: "warn", error: "error" } as const;

// Server mode: every console line becomes one JSON object on stdout, for journald and collectors.
export function logJson(write: (line: string) => unknown = (line) => process.stdout.write(line)) {
  for (const [method, level] of Object.entries(levels)) {
    console[method as keyof typeof levels] = (...args: unknown[]) => {
      const error = args.find((arg) => arg instanceof Error);
      const msg = NodeUtil.format(...args.filter((arg) => arg !== error)).replace(/^beebotd: /, "");
      const entry = {
        ts: new Date().toISOString(),
        level,
        msg: msg || error?.message || "",
        ...(error && { error: { name: error.name, stack: error.stack } }),
      };
      write(`${JSON.stringify(entry)}\n`);
    };
  }
}
