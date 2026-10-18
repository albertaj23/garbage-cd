import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headers, start } from "./helpers.js";

const summary = (id: string, quick = false) => ({
  schema: "gcd.benchmark-summary/1",
  id,
  createdAt: "2026-10-18T00:00:00Z",
  environment: { cpuModel: "Test CPU", quick },
  method: { resamples: 10000, minEffect: 0.02, noiseRule: "rule" },
  collector: [
    { group: "main", workload: "W1", variant: "B", samples: 30, medianTotalMs: 10, medianCollectMs: 5, total: { ratio: 1.1, lo: 1.0, hi: 1.2, real: true }, collect: { ratio: 1, lo: 0.9, hi: 1.1, real: false } }
  ],
  hypotheses: [{ id: "H5", statement: "s", criterion: "c", verdict: "pass", evidence: "e" }],
  h2: [{ objects: 1000, snapshotMs: 1, exportMs: 0.1, ratio: 10, lo: 8, hi: 12 }],
  jvm: []
});

const root = mkdtempSync(join(tmpdir(), "gcd-bench-"));
const write = (id: string, value: unknown) => {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "summary.json"), JSON.stringify(value));
};
write("2026-10-17-test", summary("2026-10-17-test"));
write("2026-10-18-test", summary("2026-10-18-test"));
write("quick-run", summary("quick-run", true));
write("broken", { schema: "gcd.benchmark-summary/1" });
mkdirSync(join(root, "no-summary"), { recursive: true });

describe("benchmark routes", () => {
  it("lists valid committed results newest first and hides quick, broken and empty ones", async () => {
    const { app } = await start({ benchmarkRoot: root });
    try {
      const listing = (await app.inject({ method: "GET", url: "/api/benchmarks", headers })).json();
      expect(listing.map((item: { id: string }) => item.id)).toEqual(["2026-10-18-test", "2026-10-17-test"]);
      const one = await app.inject({ method: "GET", url: "/api/benchmarks/2026-10-17-test", headers });
      expect(one.statusCode).toBe(200);
      expect(one.json().hypotheses[0].id).toBe("H5");
    } finally {
      await app.close();
    }
  });

  it("only serves ids that exist as directories and rejects quick or invalid results", async () => {
    const { app } = await start({ benchmarkRoot: root });
    try {
      for (const id of ["nope", "..%2F..%2Fetc", "no-summary"]) {
        expect((await app.inject({ method: "GET", url: `/api/benchmarks/${id}`, headers })).statusCode).toBeGreaterThanOrEqual(404);
      }
      expect((await app.inject({ method: "GET", url: "/api/benchmarks/quick-run", headers })).statusCode).toBe(404);
      const broken = await app.inject({ method: "GET", url: "/api/benchmarks/broken", headers });
      expect(broken.statusCode).toBe(500);
      expect(broken.json().error.code).toBe("SCHEMA_VIOLATION");
    } finally {
      await app.close();
    }
  });

  it("returns an empty list when there is no results directory", async () => {
    const { app } = await start({ benchmarkRoot: join(root, "does-not-exist") });
    try {
      expect((await app.inject({ method: "GET", url: "/api/benchmarks", headers })).json()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
