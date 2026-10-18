import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headers, runRequest, runToEnd, start } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  ({ app } = await start());
}, 30_000);
afterAll(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: "GET", url, headers });
const churn = Array.from({ length: 40 }, (_, index) => `x = new Object();\n${index % 10 === 9 ? "gc();\n" : ""}`).join("");
const linked = "a = new Object();\nb = new Object();\na.next = b;\nb.next = a;\nc = new Object();\nc.next = a;\na = null;\nb = null;\ngc();\n";

type Collection = { freed: { value: number }; liveAfter: { value: number }; slotsScanned: { value: number } };
const custom = (source: string, options: Record<string, unknown>) =>
  runToEnd(app, runRequest("custom", source, { custom: { traceLevel: "mutator", snapshots: true, ...options } }));

describe("regions and slot reuse over HTTP", () => {
  it("serves a verified region graph per collection and at program end", async () => {
    const result = await custom(linked, { regionSize: 16 });
    expect(result.status).toBe("succeeded");
    expect(result.engineResult.runtime.heap).toMatchObject({ regionSize: 16, slotReuse: false });
    expect(result.engineResult.regionGraphs.map((entry: { point: string }) => entry.point)).toEqual(["gc_end", "program_end"]);

    const gc1 = (await get(`/api/runs/${result.runId}/regions?gc=1`)).json();
    expect(gc1).toMatchObject({ schema: "gcd.region-graph/1", point: "gc_end", gcIndex: 1, regionSize: 16, verified: true });
    expect(gc1.regions).toHaveLength(1);
    expect(gc1.regions[0]).toMatchObject({ slotStart: 0, slotEnd: 15, allocatedTotal: 3, liveObjects: 3, freedLastGc: 0, rootTargets: 1 });
    // a.next = b, b.next = a, c.next = a: everything stays reachable through root c.
    expect(gc1.regions[0].intraEdges).toBe(3);

    const end = (await get(`/api/runs/${result.runId}/regions`)).json();
    expect(end.point).toBe("program_end");
    expect((await get(`/api/runs/${result.runId}/regions?gc=end`)).json().index).toBe(end.index);
  }, 60_000);

  it("reports cross-region edges when objects span regions", async () => {
    const source = Array.from({ length: 20 }, (_, index) => `o${index} = new Object();\n`).join("") + "o0.far = o19;\ngc();\n";
    const result = await custom(source, { regionSize: 16 });
    const graph = (await get(`/api/runs/${result.runId}/regions?gc=1`)).json();
    expect(graph.regions).toHaveLength(2);
    expect(graph.edges).toEqual([{ from: 0, to: 1, count: 1 }]);
    expect(graph.verified).toBe(true);
    const snapshot = (await get(`/api/runs/${result.runId}/snapshots/0`)).json();
    expect(snapshot.objects.find((object: { slot: number }) => object.slot === 19).region).toBe(1);
  }, 60_000);

  it("validates region requests", async () => {
    const result = await custom(linked, { regionSize: 32 });
    expect((await get(`/api/runs/${result.runId}/regions?gc=abc`)).statusCode).toBe(400);
    expect((await get(`/api/runs/${result.runId}/regions?gc=9`)).statusCode).toBe(404);
    const plain = await custom(linked, {});
    expect((await get(`/api/runs/${plain.runId}/regions`)).statusCode).toBe(404);
    const jvm = await runToEnd(app, runRequest("jvm", "public class Main { public static void main(String[] a){} }"));
    const response = await get(`/api/runs/${jvm.runId}/regions`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("HotSpot");
  }, 60_000);

  it("changes neither freed counts nor live sets across region and slot-reuse variants (I9)", async () => {
    const freed = async (options: Record<string, unknown>) => {
      const result = await custom(churn + linked, options);
      expect(result.status).toBe("succeeded");
      const collections = result.engineResult.collections as Collection[];
      return { freed: collections.map((item) => item.freed.value), live: collections.map((item) => item.liveAfter.value), scanned: collections.map((item) => item.slotsScanned.value) };
    };
    const base = await freed({});
    for (const options of [{ regionSize: 16 }, { regionSize: 256 }, { slotReuse: true }, { regionSize: 64, slotReuse: true }]) {
      const variant = await freed(options);
      expect(variant.freed).toEqual(base.freed);
      expect(variant.live).toEqual(base.live);
    }
    const reuse = await freed({ slotReuse: true });
    // Slot reuse stops collection cost from growing with total allocations (E.6).
    expect(base.scanned.at(3)).toBeGreaterThan(base.scanned.at(0)!);
    expect(reuse.scanned.at(3)).toBeLessThanOrEqual(reuse.scanned.at(1)! + 2);
  }, 120_000);

  it("rejects unsupported region sizes at the request schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers,
      payload: JSON.stringify(runRequest("custom", linked, { custom: { regionSize: 48 } }))
    });
    expect(response.statusCode).toBe(400);
  });
});
