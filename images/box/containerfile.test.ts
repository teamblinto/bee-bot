import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

import { copySources, missingSources } from "./containerfile.ts";
import { imageDir } from "./podman.ts";

it("reads the context sources of COPY and ADD, skipping flags and other stages", () => {
  const containerfile = [
    "FROM debian AS base",
    "COPY --chmod=0755 a.sh /usr/local/bin/a",
    "copy b c/ \\",
    "  /etc/",
    "ADD --chown=1:1 d.tar /",
    "COPY --from=base /etc/x /etc/x",
    "RUN echo COPY e /f",
  ].join("\n");
  expect(copySources(containerfile)).toEqual(["a.sh", "b", "c/", "d.tar"]);
});

// The packaged app ships the files .containerignore lets in; a COPY outside it fails the build.
it("has every COPY source in the image directory and in the build context", () => {
  const sources = copySources(readFileSync(join(imageDir, "Containerfile"), "utf8"));
  expect(sources.length).toBeGreaterThan(0);
  expect(missingSources(imageDir)).toEqual([]);
  const included = readFileSync(join(imageDir, ".containerignore"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("!"))
    .map((line) => line.slice(1));
  expect(sources.filter((source) => !included.includes(source.replace(/\/$/, "")))).toEqual([]);
});
