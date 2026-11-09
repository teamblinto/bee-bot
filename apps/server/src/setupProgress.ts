import type { BoxAvailability } from "@beebot/contracts";

export type SetupProgress = NonNullable<BoxAvailability["progress"]>;

export const step = (label: string): SetupProgress => ({ label, fraction: null, detail: null });

const unitBytes: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9 };

function bytes(amount: string, unit: string) {
  return Number(amount.replaceAll(",", "")) * (unitBytes[unit] ?? 1);
}

function megabytes(count: number) {
  return `${Math.max(1, Math.round(count / 1e6))} MB`;
}

// `podman machine init` without a terminal prints its phases but no byte counts.
const initPhases: [RegExp, string][] = [
  [/^(Looking up|Getting image source|Copying blob)/, "Downloading the Linux machine"],
  [/^Extracting compressed file/, "Unpacking the Linux machine"],
  [/^Importing operating system/, "Installing the Linux machine"],
  [/^Configuring system/, "Configuring the Linux machine"],
];

export function initProgress() {
  return (line: string) => {
    const phase = initPhases.find(([pattern]) => pattern.test(line));
    return phase && step(phase[1]);
  };
}

// Follows apt inside `podman build`: "Need to get" sets the download's size, each "Get:" line
// adds one package's bytes, "newly installed" counts the packages and each "Setting up" is one
// installed. The index fetches of `apt-get update` come before "Need to get" and are not counted.
export function buildProgress() {
  let total: number | undefined;
  let fetched = 0;
  let packages: number | undefined;
  let installed = 0;
  return (line: string): SetupProgress | undefined => {
    const need = /^Need to get ([\d.,]+) (B|kB|KB|MB|GB)\b/.exec(line);
    if (need) {
      total = bytes(need[1] ?? "0", need[2] ?? "B");
      return { label: "Downloading the computer's software", fraction: 0, detail: null };
    }
    const count = /(\d+) newly installed/.exec(line);
    if (count) {
      packages = Number(count[1]);
      return undefined;
    }
    const got = /^Get:\d+ .*\[([\d.,]+) (B|kB|KB|MB|GB)\]/.exec(line);
    if (got && total !== undefined) {
      fetched += bytes(got[1] ?? "0", got[2] ?? "B");
      return {
        label: "Downloading the computer's software",
        fraction: Math.min(1, fetched / total),
        detail: `${megabytes(Math.min(fetched, total))} of ${megabytes(total)}`,
      };
    }
    if (/^Setting up /.test(line) && packages) {
      installed += 1;
      return {
        label: "Installing the computer's software",
        fraction: Math.min(1, installed / packages),
        detail: `${Math.min(installed, packages)} of ${packages} packages`,
      };
    }
    if (/^STEP \d+\/\d+: COPY /.test(line)) {
      return step("Finishing the computer image");
    }
    return undefined;
  };
}

// Whether the owner would see a difference: a new step, or the bar moving a whole percent.
export function noticeable(before: SetupProgress | null, after: SetupProgress) {
  return (
    before === null ||
    before.label !== after.label ||
    (before.fraction === null) !== (after.fraction === null) ||
    Math.floor((before.fraction ?? 0) * 100) !== Math.floor((after.fraction ?? 0) * 100)
  );
}
