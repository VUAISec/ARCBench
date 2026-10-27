import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batches, completedRunIds, remainingRuns } from "../src/engine/resume.ts";

/**
 * Restartability for the v1.2 sweep.
 *
 * The v1.2 CLI wrote `results.jsonl` once, after every run for a model had finished, and had no
 * `--resume`. A sweep that died at hour 20 of 21 produced nothing -- which is exactly what made
 * the 10,200-run sweep unrecoverable if anything had gone wrong. The v1.1 CLI has had manifests
 * and `--resume` since the start; this brings the same idiom to v1.2.
 *
 * `results.jsonl` IS the ledger. There is no second bookkeeping file that could disagree with it.
 */
async function tmpFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "v12-resume-"));
  const path = join(dir, "results.jsonl");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("completedRunIds", () => {
  it("reads every runId already on disk", async () => {
    const path = await tmpFile(
      [JSON.stringify({ runId: "a" }), JSON.stringify({ runId: "b" })].join("\n") + "\n",
    );
    expect([...(await completedRunIds(path))].sort()).toEqual(["a", "b"]);
  });

  it("returns empty for a file that does not exist yet", async () => {
    expect((await completedRunIds(join(tmpdir(), "definitely-not-here.jsonl"))).size).toBe(0);
  });

  /**
   * The case that matters. A process killed mid-append leaves a half-written final line, and that
   * is precisely the moment resume is needed. Throwing here would make the crash unrecoverable --
   * the opposite of the point.
   */
  it("skips a truncated final line instead of throwing", async () => {
    const path = await tmpFile(
      JSON.stringify({ runId: "a" }) + "\n" + '{"runId":"b","spec":{"poli',
    );
    expect([...(await completedRunIds(path))]).toEqual(["a"]);
  });

  it("ignores blank lines", async () => {
    const path = await tmpFile("\n" + JSON.stringify({ runId: "a" }) + "\n\n");
    expect([...(await completedRunIds(path))]).toEqual(["a"]);
  });

  it("ignores a line that parses but carries no runId", async () => {
    const path = await tmpFile(
      [JSON.stringify({ note: "something else" }), JSON.stringify({ runId: "a" })].join("\n"),
    );
    expect([...(await completedRunIds(path))]).toEqual(["a"]);
  });
});

describe("remainingRuns", () => {
  const planned = [{ runId: "a" }, { runId: "b" }, { runId: "c" }];

  it("drops runs already recorded and preserves the order of the rest", () => {
    expect(remainingRuns(planned, new Set(["b"]))).toEqual([{ runId: "a" }, { runId: "c" }]);
  });

  it("returns everything when nothing is recorded", () => {
    expect(remainingRuns(planned, new Set())).toEqual(planned);
  });

  it("returns nothing when everything is recorded", () => {
    expect(remainingRuns(planned, new Set(["a", "b", "c"]))).toEqual([]);
  });
});

describe("batches", () => {
  it("splits into chunks of the requested size, last one short", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("yields one batch when the size exceeds the input", () => {
    expect(batches([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("yields nothing for empty input", () => {
    expect(batches([], 4)).toEqual([]);
  });

  /**
   * A non-positive size would loop forever or silently produce one giant batch, and the giant
   * batch is the behaviour this change exists to remove.
   */
  it("rejects a non-positive size rather than looping or degrading silently", () => {
    expect(() => batches([1], 0)).toThrow(/positive/);
    expect(() => batches([1], -3)).toThrow(/positive/);
  });
});
