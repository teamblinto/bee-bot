import { parseConfig, startEgress } from "./proxy.ts";

// Start contract: the parent writes one line of JSON config to stdin and keeps stdin open. The
// proxy prints `{"ev":"ready",...}` once every listener is bound and exits when stdin closes, so
// it never outlives whoever started it. Keys arrive later, over the control socket only.
let buffered = "";
let started = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (started) {
    return;
  }
  buffered += chunk;
  const newline = buffered.indexOf("\n");
  if (newline === -1) {
    return;
  }
  started = true;
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(JSON.parse(buffered.slice(0, newline)));
  } catch {
    config = "config is not JSON";
  }
  buffered = "";
  if (typeof config === "string") {
    process.stderr.write(`egress: ${config}\n`);
    process.exit(2);
  }
  startEgress(config).then(
    ({ ports }) => process.stdout.write(`${JSON.stringify({ ev: "ready", ports })}\n`),
    (error: NodeJS.ErrnoException) => {
      process.stderr.write(`egress: could not start: ${error.code ?? error.message}\n`);
      process.exit(1);
    },
  );
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
