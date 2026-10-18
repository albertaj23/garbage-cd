import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { headers, runRequest, runToEnd, start, submit, waitForRun } from "./helpers.js";

let app: FastifyInstance;
let config: Config;

beforeAll(async () => {
  ({ app, config } = await start());
}, 30_000);
afterAll(async () => {
  await app.close();
});

const java = (body: string, name = "Main") => `public class ${name} { ${body} }`;
const jvm = (source: string, options?: unknown) => runToEnd(app, runRequest("jvm", source, options));
const codes = (result: { errors: Array<{ code: string }> }) => result.errors.map((error) => error.code);

describe("Engine J", () => {
  it("runs a valid churn program with stdout, parsed GC events and MXBean totals", async () => {
    const result = await jvm(java(`public static void main(String[] a){ Object[] k=new Object[64];
      for(int i=0;i<2000000;i++){ k[i%64]=new byte[256]; } System.out.println("done"); }`));
    expect(result.status).toBe("succeeded");
    expect(result.output.stdout).toBe("done\n");
    expect(result.engineResult.collections.length).toBeGreaterThanOrEqual(1);
    expect(result.engineResult.totals.gcCount.provenance).toBe("measured");
    expect(result.engineResult.totals.gcCount.value).toBeGreaterThanOrEqual(1);
    expect(result.engineResult.totals.objectsReclaimed.provenance).toBe("unavailable");
  }, 60_000);

  it("reports syntax errors with line and column", async () => {
    const result = await jvm("public class Main { public static void main(String[] a) { int x = ; } }");
    expect(result.status).toBe("compile_error");
    expect(codes(result)).toContain("COMPILE_ERROR");
    expect(result.staticAnalysis.diagnostics[0]).toMatchObject({ location: { line: 1, column: expect.any(Number) } });
    expect(result.phases.execute.status).not.toBe("ok");
  }, 60_000);

  it("reports type errors", async () => {
    const result = await jvm(java(`public static void main(String[] a){ int x = "s"; }`));
    expect(result.status).toBe("compile_error");
    expect(codes(result)).toContain("COMPILE_ERROR");
  }, 60_000);

  it("reports a missing main method", async () => {
    const result = await jvm(java(`static void other(){}`));
    expect(result.status).toBe("compile_error");
    expect(codes(result)).toContain("NO_MAIN_METHOD");
  }, 60_000);

  it("runs a packaged class with its fully qualified name", async () => {
    const result = await jvm(`package demo.pkg; public class Main { public static void main(String[] a){ System.out.println("pkg"); } }`);
    expect(result.status).toBe("succeeded");
    expect(result.staticAnalysis.java.mainClass).toBe("demo.pkg.Main");
    expect(result.output.stdout).toBe("pkg\n");
  }, 60_000);

  it("maps an uncaught exception with class name and at most 20 frames", async () => {
    const result = await jvm(java(`static void r(int n){ if(n==0) throw new IllegalStateException("boom"); r(n-1); }
      public static void main(String[] a){ r(60); }`));
    expect(result.status).toBe("program_error");
    const error = result.errors.find((item: { code: string }) => item.code === "UNCAUGHT_EXCEPTION");
    expect(error.detail.exceptionClass).toBe("java.lang.IllegalStateException");
    expect(error.detail.stackTop.length).toBeLessThanOrEqual(20);
  }, 60_000);

  it("times out an infinite loop near the configured limit", async () => {
    const started = Date.now();
    const result = await jvm(java(`public static void main(String[] a){ while(true){} }`), { jvm: { timeoutMs: 1500 } });
    expect(result.status).toBe("timeout");
    expect(codes(result)).toContain("TIMEOUT");
    expect(result.phases.execute.durationMs.value).toBeGreaterThanOrEqual(1400);
    expect(result.phases.execute.durationMs.value).toBeLessThan(2500);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("maps an allocation bomb to OUT_OF_MEMORY", async () => {
    const result = await jvm(java(`public static void main(String[] a){ java.util.List<long[]> l=new java.util.ArrayList<>(); while(true){ l.add(new long[1_000_000]); } }`), { jvm: { heapMiB: 32 } });
    expect(result.status).toBe("program_error");
    expect(codes(result)).toContain("OUT_OF_MEMORY");
  }, 60_000);

  it("stops output floods with output_limit and a truncated stdout", async () => {
    const result = await jvm(java(`public static void main(String[] a){ String s="x".repeat(1023)+"\\n"; for(int i=0;i<10240;i++) System.out.print(s); }`));
    expect(result.status).toBe("output_limit");
    expect(codes(result)).toContain("OUTPUT_LIMIT");
    expect(Buffer.byteLength(result.output.stdout)).toBeLessThanOrEqual(65_536);
    expect(result.output.stdoutTruncated).toBe(true);
  }, 60_000);

  it("reports System.exit(7) and still writes launcher metrics", async () => {
    const result = await jvm(java(`public static void main(String[] a){ System.exit(7); }`));
    expect(result.status).toBe("program_error");
    expect(codes(result)).toContain("PROGRAM_EXIT");
    expect(result.engineResult.totals.wallTimeMs.provenance).toBe("measured");
    expect(result.engineResult.totals.gcCount.provenance).toBe("measured");
  }, 60_000);

  it("kills the process group when non-daemon threads never exit", async () => {
    const result = await jvm(java(`public static void main(String[] a){ for(int i=0;i<3;i++){ Thread t=new Thread(() -> { while(true){ try{Thread.sleep(1000);}catch(Exception e){} } }); t.start(); } }`), { jvm: { timeoutMs: 1500 } });
    expect(result.status).toBe("timeout");
  }, 60_000);

  it("supports the G1 collector", async () => {
    const result = await jvm(java(`public static void main(String[] a){ System.out.println("g1"); }`), { jvm: { collector: "g1" } });
    expect(result.status).toBe("succeeded");
    expect(result.engineResult.jvm.collector).toBe("g1");
  }, 60_000);
});

describe("Engine C", () => {
  it("runs a toy program through gcd_runner", async () => {
    const result = await runToEnd(app, runRequest("custom", "var a = 1;\n"));
    expect(["succeeded", "program_error"]).toContain(result.status);
    expect(result.engine).toBe("custom");
    expect(result.engineResult.kind).toBe("custom");
  }, 60_000);

  it("maps toy parse errors to PARSE_ERROR", async () => {
    const result = await runToEnd(app, runRequest("custom", "var = ;"));
    expect(result.status).toBe("program_error");
    expect(codes(result)).toEqual(expect.arrayContaining([expect.stringMatching(/PARSE_ERROR|LEX_ERROR/)]));
  }, 60_000);
});

describe("controller behaviour", () => {
  it("returns 409 BUSY for a second run while one is active, then cancels within 1 s", async () => {
    const first = await submit(app, runRequest("jvm", java(`public static void main(String[] a){ while(true){} }`)));
    expect(first.statusCode).toBe(202);
    const runId = first.json().runId as string;
    const second = await submit(app, runRequest("custom", "var a = 1;"));
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("BUSY");
    // let the JVM start executing before cancelling
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const cancelStarted = Date.now();
    const cancel = await app.inject({ method: "POST", url: `/api/runs/${runId}/cancel`, headers, payload: "{}" });
    expect(cancel.statusCode).toBe(202);
    const result = await waitForRun(app, runId);
    expect(result.status).toBe("cancelled");
    expect(Date.now() - cancelStarted).toBeLessThan(1_000);
  }, 60_000);

  it("rejects cross-origin and non-JSON POSTs", async () => {
    const body = JSON.stringify(runRequest("custom", "var a = 1;"));
    const cross = await app.inject({ method: "POST", url: "/api/runs", headers: { ...headers, origin: "http://evil.example" }, payload: body });
    expect(cross.statusCode).toBe(403);
    const text = await app.inject({ method: "POST", url: "/api/runs", headers: { ...headers, "content-type": "text/plain" }, payload: body });
    expect(text.statusCode).toBe(415);
    const badHost = await app.inject({ method: "POST", url: "/api/runs", headers: { ...headers, host: "evil.example" }, payload: body });
    expect(badHost.statusCode).toBe(403);
  });

  it("validates requests and enforces the source limit", async () => {
    expect((await submit(app, { engine: "jvm", source: "x" })).statusCode).toBe(400);
    const big = await submit(app, runRequest("jvm", "x".repeat(65_537)));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("SOURCE_TOO_LARGE");
  });

  it("serves health, samples, analyze and 404 stubs", async () => {
    const health = (await app.inject({ method: "GET", url: "/api/health", headers })).json();
    expect(health.jdk.found).toBe(true);
    expect(health.customRunner.found).toBe(true);
    const samples = (await app.inject({ method: "GET", url: "/api/samples", headers })).json();
    expect(samples.jvm).toHaveLength(5);
    expect(samples.custom).toHaveLength(4);
    const analysis = await app.inject({ method: "POST", url: "/api/analyze", headers, payload: JSON.stringify({ engine: "custom", source: "var a = 1;" }) });
    expect(analysis.statusCode).toBe(200);
    for (const url of ["/api/runs/x/trace", "/api/runs/x/snapshots/0", "/api/runs/x/regions"]) {
      expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
    }
  }, 30_000);

  it("leaves no orphan processes and keeps run directories bounded", async () => {
    for (let index = 0; index < 10; index++) {
      const result = await runToEnd(app, runRequest("custom", "var a = 1;"));
      expect(result.status).not.toBe("running");
    }
    const leftover = (() => {
      try {
        return execSync(`pgrep -f ${JSON.stringify(config.runRoot)} || true`, { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })();
    expect(leftover).toBe("");
    expect(existsSync(config.runRoot)).toBe(true);
    expect(readdirSync(config.runRoot).filter((name) => !name.startsWith(".")).length).toBeLessThanOrEqual(20);
  }, 120_000);
});

describe("JDK unavailable", () => {
  it("reports health not found and ENGINE_UNAVAILABLE-style failure", async () => {
    const { app: broken } = await start({ javaPath: "/nonexistent/bin/java", javaJarPath: "/nonexistent/tools.jar" });
    try {
      const health = (await broken.inject({ method: "GET", url: "/api/health", headers })).json();
      expect(health.jdk.found).toBe(false);
      const response = await submit(broken, runRequest("jvm", java(`public static void main(String[] a){}`)));
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("ENGINE_UNAVAILABLE");
    } finally {
      await broken.close();
    }
  });
});
