import { expect, it } from "vite-plus/test";

import { buildProgress, initProgress, noticeable, step } from "./setupProgress.ts";

const follow = (lines: string[], parse = buildProgress()) =>
  lines.map(parse).filter((progress) => progress !== undefined);

it("measures apt's download by bytes and its installs by package, ignoring the index fetch", () => {
  const seen = follow([
    "STEP 1/12: FROM docker.io/library/debian:trixie-slim@sha256:a72b",
    "STEP 2/12: RUN apt-get update  && apt-get install -y --no-install-recommends bash",
    "Get:1 http://deb.debian.org/debian trixie InRelease [140 kB]",
    "Get:2 http://deb.debian.org/debian trixie/main amd64 Packages [9,670 kB]",
    "0 upgraded, 3 newly installed, 0 to remove and 0 not upgraded.",
    "Need to get 100 MB of archives.",
    "After this operation, 300 MB of additional disk space will be used.",
    "Get:1 http://deb.debian.org/debian trixie/main amd64 chromium amd64 142.0 [75.0 MB]",
    "Get:2 http://deb.debian.org/debian-security trixie-security/main amd64 curl amd64 8.14 [25,000 kB]",
    "Fetched 100 MB in 9s (11.1 MB/s)",
    "Setting up curl (8.14) ...",
    "Setting up chromium (142.0) ...",
    "Setting up socat (1.8) ...",
    "STEP 3/12: COPY --chmod=0755 engine.sh /usr/local/bin/bee-engine",
  ]);
  expect(seen).toEqual([
    { label: "Downloading the computer's software", fraction: 0, detail: null },
    { label: "Downloading the computer's software", fraction: 0.75, detail: "75 MB of 100 MB" },
    { label: "Downloading the computer's software", fraction: 1, detail: "100 MB of 100 MB" },
    { label: "Installing the computer's software", fraction: 1 / 3, detail: "1 of 3 packages" },
    { label: "Installing the computer's software", fraction: 2 / 3, detail: "2 of 3 packages" },
    { label: "Installing the computer's software", fraction: 1, detail: "3 of 3 packages" },
    step("Finishing the computer image"),
  ]);
});

it("reads a partly cached download by what is left to get", () => {
  const [need, got] = follow([
    "Need to get 40.0 MB/120 MB of archives.",
    "Get:7 http://deb.debian.org/debian trixie/main amd64 xvfb amd64 21.1 [10.0 MB]",
  ]);
  expect(need?.fraction).toBe(0);
  expect(got).toMatchObject({ fraction: 0.25, detail: "10 MB of 40 MB" });
});

it("names the machine's phases, which Podman prints without byte counts", () => {
  expect(
    follow(
      [
        "Looking up Podman Machine image at quay.io/podman/machine-os:5.8 to create VM",
        "Copying blob sha256:5089400f5586e7bc65505bbf5a4e193374eea681a08a792745d22d73bf75704d",
        "Importing operating system into WSL (this may take a few minutes on a new WSL install)...",
        "Configuring system...",
        "Machine init complete",
      ],
      initProgress(),
    ).map(({ label }) => label),
  ).toEqual([
    "Downloading the Linux machine",
    "Downloading the Linux machine",
    "Installing the Linux machine",
    "Configuring the Linux machine",
  ]);
});

it("passes on a change only when the owner could see it", () => {
  const at = (fraction: number | null) => ({ label: "Downloading", fraction, detail: null });
  expect(noticeable(null, at(0))).toBe(true);
  expect(noticeable(at(0.501), at(0.509))).toBe(false);
  expect(noticeable(at(0.509), at(0.51))).toBe(true);
  expect(noticeable(at(null), at(0))).toBe(true);
  expect(noticeable(at(0.2), { ...at(0.2), label: "Installing" })).toBe(true);
});
