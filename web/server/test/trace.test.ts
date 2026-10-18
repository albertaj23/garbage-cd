import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageTrace, parseTrace, summarizeTrace } from "../src/trace-store.js";
import { headers, runRequest, runToEnd, start, submit } from "./helpers.js";

const cycle = "a = new Object();\nb = new Object();\na.next = b;\nb.next = a;\na = null;\nb = null;\ngc();\n";

let app: FastifyInstance;
beforeAll(async () => {
  ({ app } = await start());
}, 30_000);
afterAll(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: "GET", url, headers });

describe("trace store", () => {
  const batch = (n: number, first: number, count: number) =>
    JSON.stringify({
      schema: "gcd.trace-batch/1",
      runId: "r",
      batch: n,
      firstSeq: first,
      lastSeq: first + count - 1,
      droppedTotal: 0,
      strings: {},
      events: Array.from({ length: count }, (_, index) => [first + index, "SB", 0])
    });
  const text = [batch(0, 1, 3), batch(1, 4, 3), batch(2, 7, 3), '{"type":"end","lastSeq":9,"complete":true,"droppedByKind":{}}'].join("\n");

  it("pages whole batches without skipping or repeating sequence numbers", () => {
    const trace = parseTrace(text);
    const seen: number[] = [];
    let after = -1;
    for (let guard = 0; guard < 10; guard++) {
      const page = pageTrace(trace, after, 4);
      seen.push(...page.batches.flatMap((item) => item.events.map((event) => (event as number[])[0]!)));
      if (page.next === null) {
        expect(page.trailer?.complete).toBe(true);
        break;
      }
      after = page.next;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("always returns at least one batch even when it exceeds maxEvents", () => {
    expect(pageTrace(parseTrace(text), -1, 1).batches).toHaveLength(1);
  });

  it("reports a missing trailer or drops as incomplete", () => {
    expect(summarizeTrace(parseTrace(batch(0, 1, 3))).complete).toBe(false);
    const dropped = `${batch(0, 1, 3)}\n{"type":"end","lastSeq":3,"complete":true,"droppedByKind":{"MV":5}}`;
    expect(summarizeTrace(parseTrace(dropped))).toMatchObject({ complete: false, droppedCount: 5, eventCount: 3 });
    expect(summarizeTrace(null).available).toBe(false);
  });

  it("rejects malformed lines", () => {
    expect(() => parseTrace("not json")).toThrow();
    expect(() => parseTrace('{"hello":1}')).toThrow();
  });
});

describe("trace and snapshot routes", () => {
  it("serves a paginated trace and heap snapshots for a traced custom run", async () => {
    const result = await runToEnd(
      app,
      runRequest("custom", cycle, { custom: { traceLevel: "full", batchSize: 3, snapshots: true } })
    );
    expect(result.status).toBe("succeeded");
    expect(result.trace).toMatchObject({ available: true, complete: true, droppedCount: 0 });
    expect(result.trace.batchCount).toBeGreaterThan(3);

    const seqs: number[] = [];
    let after = -1;
    let trailer: unknown = null;
    for (let guard = 0; guard < 100; guard++) {
      const page = (await get(`/api/runs/${result.runId}/trace?afterSeq=${after}&maxEvents=5`)).json();
      for (const item of page.batches) for (const event of item.events) seqs.push(event[0]);
      if (page.next === null) {
        trailer = page.trailer;
        break;
      }
      after = page.next;
    }
    expect(seqs).toHaveLength(result.trace.eventCount);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(trailer).toMatchObject({ type: "end", complete: true });

    const kinds = new Set<string>();
    const everything = (await get(`/api/runs/${result.runId}/trace?maxEvents=50000`)).json();
    for (const item of everything.batches) for (const event of item.events) kinds.add(event[1]);
    expect(kinds).toEqual(expect.objectContaining({}));
    expect(["A", "RS", "FW", "GB", "GE", "SF"].every((kind) => kinds.has(kind))).toBe(true);

    const snapshot = (await get(`/api/runs/${result.runId}/snapshots/0`)).json();
    expect(snapshot).toMatchObject({ schema: "gcd.heap-snapshot/1", point: "mark_complete", gcIndex: 1, totalObjects: 2 });
    expect(snapshot.objects.every((object: { marked: boolean }) => object.marked === false)).toBe(true);
    const end = (await get(`/api/runs/${result.runId}/snapshots/1`)).json();
    expect(end.point).toBe("program_end");
    expect(result.engineResult.snapshots).toHaveLength(2);
  }, 60_000);

  it("shows the bundled sample's two unrooted objects as freed with their ref edge, and a chain's discovery path", async () => {
    const { readFileSync } = await import("node:fs");
    const sample = readFileSync(new URL("../samples/custom/sample.gc", import.meta.url), "utf8");
    const options = { custom: { traceLevel: "mutator", snapshots: true } };
    const sampleRun = await runToEnd(app, runRequest("custom", sample, options));
    const snap = (await get(`/api/runs/${sampleRun.runId}/snapshots/0`)).json();
    expect(snap.objects).toHaveLength(2);
    expect(snap.objects.every((object: { marked: boolean }) => object.marked === false)).toBe(true);
    expect(snap.objects.flatMap((object: { fields: Array<{ name: string }> }) => object.fields.map((field) => field.name))).toContain("ref");
    expect(snap.roots).toEqual([]);

    const chain = readFileSync(new URL("../samples/custom/chain.gc", import.meta.url), "utf8");
    const chainRun = await runToEnd(app, runRequest("custom", chain, options));
    const chainSnap = (await get(`/api/runs/${chainRun.runId}/snapshots/0`)).json();
    const byId = new Map<string, { marked: boolean; discoveredBy?: { parent: string | null; root: string | null } }>(
      chainSnap.objects.map((object: { id: string }) => [object.id, object])
    );
    const tail = chainSnap.objects.find((object: { discoveredBy?: { parent: string | null } }) => object.discoveredBy?.parent);
    expect(tail.marked).toBe(true);
    const head = byId.get(tail.discoveredBy.parent)!;
    expect(head.discoveredBy?.root).toBe("root");
  }, 60_000);

  it("validates parameters and reports missing data", async () => {
    const result = await runToEnd(app, runRequest("custom", cycle, { custom: { traceLevel: "mutator" } }));
    expect((await get(`/api/runs/${result.runId}/trace?maxEvents=50001`)).statusCode).toBe(400);
    expect((await get(`/api/runs/${result.runId}/trace?afterSeq=abc`)).statusCode).toBe(400);
    expect((await get(`/api/runs/${result.runId}/trace?afterSeq=-2`)).statusCode).toBe(400);
    expect((await get(`/api/runs/${result.runId}/trace`)).statusCode).toBe(200);
    expect((await get(`/api/runs/${result.runId}/snapshots/0`)).statusCode).toBe(404);
    expect((await get(`/api/runs/${result.runId}/snapshots/99`)).statusCode).toBe(404);
    expect((await get(`/api/runs/${result.runId}/snapshots/..%2Fx`)).statusCode).toBe(400);
    expect((await get(`/api/runs/${result.runId}/snapshots/-1`)).statusCode).toBe(400);
    const untraced = await runToEnd(app, runRequest("custom", cycle));
    expect(untraced.trace.available).toBe(false);
    expect((await get(`/api/runs/${untraced.runId}/trace`)).statusCode).toBe(404);
    expect((await get(`/api/runs/NOSUCHRUN/trace`)).statusCode).toBe(404);
  }, 60_000);

  it("explains that HotSpot runs have no heap graph, and rejects in-progress runs", async () => {
    const jvm = await runToEnd(app, runRequest("jvm", "public class Main { public static void main(String[] a){} }"));
    const response = await get(`/api/runs/${jvm.runId}/snapshots/0`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("HotSpot");
    const first = await submit(app, runRequest("jvm", "public class Main { public static void main(String[] a){ while(true){} } }", { jvm: { timeoutMs: 1500 } }));
    const id = first.json().runId as string;
    const live = await get(`/api/runs/${id}/trace`);
    expect([404, 409]).toContain(live.statusCode);
    const live2 = await submit(app, runRequest("custom", cycle));
    expect(live2.statusCode).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
  }, 60_000);
});
