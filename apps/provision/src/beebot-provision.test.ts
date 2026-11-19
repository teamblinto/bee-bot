import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  assertRootOwned,
  cellIdBase,
  cellSlots,
  freeSlot,
  parseArgs,
  parseSubids,
  prepareHome,
  Refusal,
  removeTree,
  subidBase,
  subidCount,
  subidRange,
} from "./beebot-provision.ts";

const cell = "bb0123456789";

describe("parseArgs", () => {
  it("accepts each verb in its one form", () => {
    for (const verb of ["add", "suspend", "resume", "status"] as const) {
      expect(parseArgs(["user", verb, cell])).toEqual({ verb, cell });
    }
    expect(parseArgs(["user", "delete", cell, "--confirm"])).toEqual({ verb: "delete", cell });
    expect(
      parseArgs(["user", "quota", cell, "--cpu", "150%", "--tasks", "512", "--memory", "2G"]),
    ).toEqual({ verb: "quota", cell, quota: { memory: "2G", cpu: "150%", tasks: "512" } });
  });

  it.each([
    [],
    ["user"],
    ["user", "add"],
    ["group", "add", cell],
    ["user", "Add", cell],
    ["user", "add", "BB0123456789"],
    ["user", "add", "bb012345678"],
    ["user", "add", "bb01234567890"],
    ["user", "add", "bb012345678g"],
    ["user", "add", `${cell}\n`],
    ["user", "add", `${cell} `],
    ["user", "add", "../../etc/x"],
    ["user", "add", "bb0123456789/.."],
    ["user", "add", "root"],
    ["user", "add", "--help"],
    ["user", "add", cell, "--shell=/bin/sh"],
    ["user", "add", cell, ""],
    ["user", "status", cell, "x"],
    ["user", "delete", cell],
    ["user", "delete", cell, "--confirm=yes"],
    ["user", "delete", cell, "--confirm", "--confirm"],
    ["user", "delete", "--confirm", cell],
    ["user", "quota", cell, "--memory", "4G", "--cpu", "200%"],
    ["user", "quota", cell, "--memory", "4G", "--memory", "4G", "--cpu", "200%"],
    ["user", "quota", cell, "--memory", "4G", "--cpu", "200%", "--tasks", "1", "--x", "1"],
    ["user", "quota", cell, "--memory", "4g", "--cpu", "200%", "--tasks", "64"],
    ["user", "quota", cell, "--memory", "infinity", "--cpu", "200%", "--tasks", "64"],
    ["user", "quota", cell, "--memory", "0G", "--cpu", "200%", "--tasks", "64"],
    ["user", "quota", cell, "--memory", "4G\nCPUQuota=", "--cpu", "200%", "--tasks", "64"],
    ["user", "quota", cell, "--memory", "4G", "--cpu", "200", "--tasks", "64"],
    ["user", "quota", cell, "--memory", "4G", "--cpu", "200%", "--tasks", "-1"],
    ["user", "quota", cell, "--memory", "4G", "--cpu", "200%", "--tasks", "12345678"],
    ["user", "quota", cell, "--memory=4G", "--cpu", "200%", "--tasks", "64", "x"],
    ["user", "quota", cell, "--toString", "1", "--cpu", "200%", "--tasks", "64"],
  ])("refuses %j", (...argv) => {
    expect(() => parseArgs(argv)).toThrow(Refusal);
  });
});

describe("freeSlot", () => {
  it("gives distinct ids and non-overlapping ranges as cells are added", () => {
    const ids = new Set([0, 1000, cellIdBase + 1]);
    const ranges = [{ start: 100000, count: 65536 }];
    const taken: { start: number; count: number }[] = [];
    for (let added = 0; added < 50; added++) {
      const slot = freeSlot(ids, [...ranges, ...taken]);
      expect(ids.has(cellIdBase + slot)).toBe(false);
      ids.add(cellIdBase + slot);
      taken.push(subidRange(slot));
    }
    const sorted = taken.toSorted((a, b) => a.start - b.start);
    for (const [index, range] of sorted.entries()) {
      const next = sorted[index + 1];
      expect(next === undefined || range.start + range.count <= next.start).toBe(true);
      expect(range.count).toBe(subidCount);
    }
  });

  it("skips a slot whose range someone else already holds", () => {
    expect(freeSlot(new Set(), [{ start: subidBase + subidCount - 1, count: 1 }])).toBe(1);
  });

  it("keeps every range inside 31 bits", () => {
    const last = subidRange(cellSlots - 1);
    expect(last.start + last.count).toBeLessThan(2 ** 31);
  });

  it("refuses when every slot is taken", () => {
    const ids = new Set(Array.from({ length: cellSlots }, (_, slot) => cellIdBase + slot));
    expect(() => freeSlot(ids, [])).toThrow(Refusal);
  });
});

it("reads subordinate id files", () => {
  expect(parseSubids("sayem:100000:65536\n\nbb0123456789:100000000:2000000\n")).toEqual([
    { name: "sayem", start: 100000, count: 65536 },
    { name: cell, start: 100000000, count: 2000000 },
  ]);
});

it("fences every process a cell can start, whatever its uid", () => {
  const fence = NodeFs.readFileSync(
    NodePath.join(import.meta.dirname, "../system/fence.nft"),
    "utf8",
  );
  const subids = `${subidBase}-${subidRange(cellSlots - 1).start + subidCount - 1}`;
  expect(fence).toContain(`meta skuid ${cellIdBase}-${cellIdBase + cellSlots - 1} jump cell`);
  expect(fence).toContain(`meta skuid ${subids} jump cell`);
});

describe.skipIf(process.platform === "win32")("root never follows a cell's links", () => {
  const made: string[] = [];
  const scratch = () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "provision-"));
    made.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of made) {
      NodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;

  it("refuses a home that is a link", () => {
    const dir = scratch();
    const target = NodePath.join(dir, "etc");
    NodeFs.mkdirSync(target, { mode: 0o755 });
    NodeFs.symlinkSync(target, NodePath.join(dir, "home"));
    expect(() => prepareHome(NodePath.join(dir, "home"), uid, gid)).toThrow(/ELOOP|ENOTDIR/);
    expect(NodeFs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("re-adds a live cell without touching what the cell planted inside", () => {
    const dir = scratch();
    const target = NodePath.join(dir, "etc");
    NodeFs.mkdirSync(target, { mode: 0o755 });
    const cellHome = NodePath.join(dir, "home");
    prepareHome(cellHome, uid, gid);
    NodeFs.symlinkSync(target, NodePath.join(cellHome, "data"));
    prepareHome(cellHome, uid, gid);
    expect(NodeFs.statSync(cellHome).mode & 0o777).toBe(0o700);
    expect(NodeFs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("deletes a home without following a link out of it", () => {
    const dir = scratch();
    const target = NodePath.join(dir, "etc");
    NodeFs.mkdirSync(target);
    NodeFs.writeFileSync(NodePath.join(target, "passwd"), "root");
    const cellHome = NodePath.join(dir, "home");
    NodeFs.mkdirSync(NodePath.join(cellHome, "data"), { recursive: true });
    NodeFs.symlinkSync(target, NodePath.join(cellHome, "data", "link"));
    removeTree(cellHome);
    expect(NodeFs.existsSync(cellHome)).toBe(false);
    expect(NodeFs.readFileSync(NodePath.join(target, "passwd"), "utf8")).toBe("root");
  });

  it("refuses to act below a folder someone else can write", () => {
    const dir = scratch();
    NodeFs.chmodSync(dir, 0o777);
    expect(() => assertRootOwned(dir)).toThrow(Refusal);
  });
});
