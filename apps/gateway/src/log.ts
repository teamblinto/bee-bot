// One JSON object per line, for journald and anything that reads it.
export function log(level: string, msg: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`,
  );
}
