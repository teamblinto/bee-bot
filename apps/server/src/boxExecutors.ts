import { finished } from "node:stream/promises";

import { z } from "zod";

import type { Execute } from "./approvals.ts";
import type { BoxLayout } from "./boxEngine.ts";
import type { BoxExec, BoxRuntime } from "./boxRuntime.ts";

const maxOutputBytes = 1_000_000;
const defaultBashMs = 120_000;
const maxBashMs = 600_000;
const fileStepMs = 60_000;

// stderr joins stdout: a box attach carries only one stream. The command comes on stdin, never argv.
const bashScript = 'exec 2>&1; script=$(cat); eval "$script"';
const writeScript = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';

const Bash = z.object({ command: z.string(), timeout: z.number().int().positive().optional() });
const Write = z.object({ file_path: z.string().min(1), content: z.string() });
const Edit = z.object({
  file_path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().default(false),
});
const Payload = z.object({ input: z.record(z.string(), z.unknown()) });

function inputOf<T extends z.ZodType>(schema: T, payload: string) {
  try {
    return schema.safeParse(Payload.parse(JSON.parse(payload)).input).data;
  } catch {
    return undefined;
  }
}

// The same rules as the engine's own Edit, so an approved edit lands where the owner saw it.
export function applyEdit(
  text: string,
  { old_string: before, new_string: after, replace_all: every }: z.infer<typeof Edit>,
) {
  if (before === "") {
    return { error: "old_string is empty." };
  }
  const count = text.split(before).length - 1;
  if (count === 0) {
    return { error: "old_string was not found in the file." };
  }
  if (count > 1 && !every) {
    return { error: `old_string matches ${count} places, and replace_all is off.` };
  }
  return { text: every ? text.split(before).join(after) : text.replace(before, () => after) };
}

type Step = { code: number; output: string; timedOut: boolean; truncated: boolean };

export function boxExecutors({
  runtime,
  layout,
}: {
  runtime: BoxRuntime;
  layout: Pick<BoxLayout, "env" | "workdir">;
}) {
  // A box that went away mid-step throws, so the outcome is unknown and never retried.
  async function step(botId: string, argv: string[], stdin: string, timeoutMs: number) {
    const exec: BoxExec = { argv, env: layout.env, cwd: layout.workdir };
    const { stream, exited } = await runtime.execAttach(botId, exec);
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      if (size < maxOutputBytes) {
        chunks.push(chunk);
      }
      size += chunk.length;
    });
    stream.on("error", () => {});
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stream.destroy();
    }, timeoutMs);
    stream.end(stdin);
    const [code] = await Promise.all([
      exited.finally(() => clearTimeout(timer)),
      finished(stream, { writable: false }).catch(() => {}),
    ]);
    if (code === null && !timedOut) {
      throw new Error("box_exec_lost");
    }
    const output = Buffer.concat(chunks).toString("utf8");
    return { code: code ?? -1, output, timedOut, truncated: size > maxOutputBytes } satisfies Step;
  }

  const refused = { ok: false, output: "Not run: the approved call didn't parse." };

  const bash: Execute = async ({ botId, payload }) => {
    const input = inputOf(Bash, payload);
    if (!input) {
      return refused;
    }
    const timeoutMs = Math.min(input.timeout ?? defaultBashMs, maxBashMs);
    const { code, output, timedOut } = await step(
      botId,
      ["bash", "-c", bashScript],
      input.command,
      timeoutMs,
    );
    if (timedOut) {
      return { ok: false, output: `${output}\nStopped after ${timeoutMs / 1000} s.` };
    }
    return { ok: code === 0, output: code === 0 ? output : `${output}\nExit code ${code}` };
  };

  async function writeFile(botId: string, path: string, content: string) {
    const { code, output } = await step(
      botId,
      ["sh", "-c", writeScript, "sh", path],
      content,
      fileStepMs,
    );
    return code === 0 ? { ok: true, output: `Wrote ${path}` } : { ok: false, output };
  }

  const write: Execute = async ({ botId, payload }) => {
    const input = inputOf(Write, payload);
    return input ? writeFile(botId, input.file_path, input.content) : refused;
  };

  const edit: Execute = async ({ botId, payload }) => {
    const input = inputOf(Edit, payload);
    if (!input) {
      return refused;
    }
    const read = await step(botId, ["cat", "--", input.file_path], "", fileStepMs);
    if (read.code !== 0 || read.truncated) {
      return { ok: false, output: read.truncated ? "The file is too large to edit." : read.output };
    }
    const edited = applyEdit(read.output, input);
    if (edited.text === undefined) {
      return { ok: false, output: edited.error };
    }
    const written = await writeFile(botId, input.file_path, edited.text);
    return written.ok ? { ok: true, output: `Edited ${input.file_path}` } : written;
  };

  return new Map([
    ["Bash", bash],
    ["Write", write],
    ["Edit", edit],
  ]);
}
