import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, startServer } from "../src/server.js";
import { headers, runRequest, runToEnd, start, submit, testConfig, TEST_PORT, waitForRun } from "./helpers.js";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pgrep = (pattern: string): string => {
  try {
    return execSync(`pgrep -f ${JSON.stringify(pattern)} || true`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const java = (body: string) => `public class Main { ${body} }`;

let app: FastifyInstance;
beforeAll(async () => {
  ({ app } = await start());
}, 30_000);
afterAll(async () => {
  await app.close();
});

const get = (url: string, extra: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers: { host: headers.host, ...extra } });

describe("hostile requests (H.1: drive-by web pages, DNS rebinding)", () => {
  it("rejects every Host that is not loopback on the controller's port", async () => {
    for (const host of ["localhost.evil.com:4177", "127.0.0.1.evil.com:4177", "evil.example", "[::1]:4177", "127.0.0.1:9999", "0.0.0.0:4177", ""]) {
      const response = await app.inject({ method: "GET", url: "/api/health", headers: { host } });
      expect(response.statusCode, `Host "${host}"`).toBe(403);
    }
    expect((await get("/api/health")).statusCode).toBe(200);
    expect((await get("/api/health", { host: `localhost:${TEST_PORT}` })).statusCode).toBe(200);
    expect((await get("/api/health", { host: "localhost" })).statusCode).toBe(403);  // no port means port 80
  });

  it("never approves a CORS preflight and never sends Access-Control headers", async () => {
    for (const origin of ["http://evil.example", "http://127.0.0.1:5173", "null"]) {
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/api/runs",
        headers: { host: headers.host, origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }
      });
      expect(preflight.statusCode).toBe(403);
      expect(Object.keys(preflight.headers).filter((name) => name.startsWith("access-control"))).toEqual([]);
    }
    const sameOrigin = await app.inject({ method: "OPTIONS", url: "/api/runs", headers: { host: headers.host, origin: `http://${headers.host}` } });
    expect(Object.keys(sameOrigin.headers).filter((name) => name.startsWith("access-control"))).toEqual([]);
    const ok = await get("/api/health");
    expect(Object.keys(ok.headers).filter((name) => name.startsWith("access-control"))).toEqual([]);
  });

  it("sets defensive headers on the dashboard and the API", async () => {
    for (const url of ["/", "/api/health"]) {
      const response = await get(url);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(String(response.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
      expect(String(response.headers["content-security-policy"])).toContain("default-src 'self'");
    }
    expect((await get("/api/health")).headers["cache-control"]).toBe("no-store");
  });

  it("validates bodies strictly", async () => {
    const post = (payload: string, extra: Record<string, string> = {}) =>
      app.inject({ method: "POST", url: "/api/runs", headers: { ...headers, ...extra }, payload });
    expect((await post("x".repeat(600 * 1024))).statusCode).toBe(413);
    expect((await post("{not json")).statusCode).toBe(400);
    expect((await post("[]")).statusCode).toBe(400);
    expect((await post(JSON.stringify({ ...runRequest("jvm", "x"), extra: 1 }))).statusCode).toBe(400);
    expect((await post(JSON.stringify({ ...runRequest("jvm", "x"), engine: "rust" }))).statusCode).toBe(400);
    expect((await post(JSON.stringify({ ...runRequest("jvm", "x"), source: 5 }))).statusCode).toBe(400);
    expect((await post(JSON.stringify(runRequest("jvm", "x", { jvm: { timeoutMs: 999999 } })))).statusCode).toBe(400);
    expect((await post(JSON.stringify(runRequest("jvm", "x", { jvm: { heapMiB: 100000 } })))).statusCode).toBe(400);
    expect((await post(JSON.stringify(runRequest("jvm", "x", { custom: { regionSize: 64 } })))).statusCode).toBe(400);
    expect((await post("{}", { "content-type": "application/json; charset=utf-8" })).statusCode).toBe(400);
    expect((await post("{}", { "content-type": "multipart/form-data" })).statusCode).toBe(415);
    expect((await post("{}", { "content-type": "application/x-www-form-urlencoded" })).statusCode).toBe(415);
  });

  it("serves only files from the client build: no traversal, no listings", async () => {
    for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/etc/passwd", "/assets/", "/assets", "//etc/passwd", "/assets/..%2f..%2f..%2fpackage.json", "/%00", "/.git/config", "/../../../etc/hosts"]) {
      const response = await get(path);
      expect(response.statusCode, path).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain("root:");
      expect(response.body).not.toContain("garbage-cd-web");
    }
  });

  it("only listens on the IPv4 loopback address", async () => {
    const config = testConfig({ port: 4192 });
    const listening = await startServer(config);
    try {
      const address = listening.server.address();
      expect(address).toMatchObject({ address: "127.0.0.1", port: 4192 });
      const refused = (host: string) =>
        new Promise<string>((resolve) => {
          const socket = connect({ host, port: 4192, timeout: 1500 });
          socket.once("connect", () => { socket.destroy(); resolve("connected"); });
          socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
          socket.once("timeout", () => { socket.destroy(); resolve("timeout"); });
        });
      expect(await refused("::1")).not.toBe("connected");
      const external = Object.values(networkInterfaces()).flat().find((item) => item && item.family === "IPv4" && !item.internal);
      if (external) expect(await refused(external.address)).not.toBe("connected");
    } finally {
      await listening.close();
    }
  });
});

describe("one controller per run directory, orphan sweep", () => {
  it("refuses a second controller process on a live run directory and takes over a stale lock", async () => {
    const config = testConfig();
    const first = await createServer(config);
    await first.ready();
    const launch = (port: number) =>
      spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: serverRoot,
        env: { ...process.env, GCD_PORT: String(port), GCD_RUN_ROOT: config.runRoot },
        stdio: ["ignore", "ignore", "pipe"]
      });
    try {
      const second = launch(4194);
      let stderr = "";
      second.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => second.once("exit", (exit) => resolve(exit)));
      expect(code).toBe(1);
      expect(stderr).toMatch(/Another controller \(pid \d+\)/);
    } finally {
      await first.close();
    }
    // A lock whose owner is dead is taken over.
    writeFileSync(join(config.runRoot, ".controller.pid"), "999999\n");
    const third = launch(4195);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        try { ready = (await fetch("http://127.0.0.1:4195/api/health")).ok; } catch { await sleep(100); }
      }
      expect(ready).toBe(true);
    } finally {
      third.kill("SIGTERM");
      await new Promise((resolve) => third.once("exit", resolve));
    }
  }, 60_000);

  it("kills orphaned process groups and deletes stale run directories at startup", async () => {
    const config = testConfig();
    const runDir = join(config.runRoot, "01J00000000000000000000000");
    mkdirSync(runDir, { recursive: true });
    const child = spawn("sleep", ["4242"], { detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(join(runDir, "process-group.pid"), `${child.pid}\n`);
    writeFileSync(join(runDir, "leftover.txt"), "stale");
    expect(pgrep("sleep 4242")).not.toBe("");
    const started = await createServer(config);
    await started.ready();
    try {
      await sleep(300);
      expect(pgrep("sleep 4242")).toBe("");
      expect(existsSync(runDir)).toBe(false);
    } finally {
      await started.close();
    }
  });

  it("stops active runs and their process groups on SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "gcd-sigterm-"));
    const port = 4193;
    const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: serverRoot,
      env: { ...process.env, GCD_PORT: String(port), GCD_RUN_ROOT: root },
      stdio: "ignore"
    });
    const exited = new Promise<number | null>((resolve) => server.once("exit", (code) => resolve(code)));
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(100); }
    }
    expect(ready).toBe(true);
    const response = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(runRequest("jvm", java("public static void main(String[] a){ while(true){} }"), { jvm: { timeoutMs: 30000 } }))
    });
    expect(response.status).toBe(202);
    for (let attempt = 0; attempt < 100 && pgrep(`${root}.*gcd.launcher.Launcher`) === ""; attempt++) await sleep(100);
    expect(pgrep(`gcd.launcher.Launcher.*Main`)).not.toBe("");
    server.kill("SIGTERM");
    expect(await exited).toBe(0);
    await sleep(300);
    expect(pgrep(root)).toBe("");
  }, 60_000);
});

describe("hostile programs (G.3 resource-exhaustion re-run)", () => {
  const jvm = (source: string, timeoutMs = 4000, extra: Record<string, unknown> = {}) =>
    runToEnd(app, runRequest("jvm", source, { jvm: { timeoutMs, ...extra } }));
  const codes = (result: { errors: Array<{ code: string }> }) => result.errors.map((error) => error.code);

  it("scrubs the child environment: injected JVM options never reach the program", async () => {
    const injected = { JAVA_TOOL_OPTIONS: "-Xmx1m", _JAVA_OPTIONS: "-Xmx1m", JDK_JAVA_OPTIONS: "-Xmx1m", CLASSPATH: "/nonexistent", SECRET_TOKEN: "hunter2" };
    const saved = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
    Object.assign(process.env, injected);
    try {
      const result = await jvm(java(`public static void main(String[] a){
        for (String k : new String[]{"JAVA_TOOL_OPTIONS","_JAVA_OPTIONS","JDK_JAVA_OPTIONS","CLASSPATH","SECRET_TOKEN"}) System.out.println(k + "=" + System.getenv(k));
        System.out.println("tmp=" + System.getProperty("java.io.tmpdir").contains("gcd-")); }`));
      expect(result.status).toBe("succeeded");
      expect(result.output.stdout).toContain("JAVA_TOOL_OPTIONS=null");
      expect(result.output.stdout).toContain("_JAVA_OPTIONS=null");
      expect(result.output.stdout).toContain("JDK_JAVA_OPTIONS=null");
      expect(result.output.stdout).toContain("CLASSPATH=null");
      expect(result.output.stdout).toContain("SECRET_TOKEN=null");
      expect(result.output.stdout).toContain("tmp=true");  // user.home comes from the passwd entry, not $HOME (documented residual risk)
      expect(result.output.stderr).not.toContain("Picked up");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  it("reports a stack overflow as an uncaught exception", async () => {
    const result = await jvm(java(`static int f(int n){ return f(n+1)+1; } public static void main(String[] a){ f(0); }`));
    expect(result.status).toBe("program_error");
    expect(result.errors.find((e: { code: string }) => e.code === "UNCAUGHT_EXCEPTION").detail.exceptionClass).toBe("java.lang.StackOverflowError");
  }, 60_000);

  it("survives a thread bomb and stays healthy afterwards", async () => {
    const result = await jvm(java(`public static void main(String[] a) throws Exception {
      for (int i = 0; i < 20000; i++) { Thread t = new Thread(() -> { try { Thread.sleep(60000); } catch (InterruptedException e) {} }); t.setDaemon(true); t.start(); } Thread.sleep(60000); }`), 5000);
    expect(["timeout", "program_error", "resource_limit", "succeeded"]).toContain(result.status);
    const after = await jvm(java(`public static void main(String[] a){ System.out.println("alive"); }`));
    expect(after.output.stdout).toBe("alive\n");
    await sleep(500);
    expect(pgrep("gcd.launcher.Launcher")).toBe("");
  }, 90_000);

  it("contains off-heap exhaustion (direct buffers) as an out-of-memory error", async () => {
    const result = await jvm(java(`public static void main(String[] a){ java.nio.ByteBuffer.allocateDirect(512 * 1024 * 1024); }`));
    expect(result.status).toBe("program_error");
    expect(codes(result).some((code: string) => code === "OUT_OF_MEMORY" || code === "UNCAUGHT_EXCEPTION")).toBe(true);
  }, 60_000);

  it("kills on a stderr flood just like a stdout flood", async () => {
    const result = await jvm(java(`public static void main(String[] a){ String s = "e".repeat(1023) + "\\n"; for (int i = 0; i < 20000; i++) System.err.print(s); }`));
    expect(result.status).toBe("output_limit");
    expect(Buffer.byteLength(result.output.stderr)).toBeLessThanOrEqual(65_536);
  }, 60_000);

  it("does not let a program leave children behind after a normal exit", async () => {
    const result = await jvm(java(`public static void main(String[] a) throws Exception { new ProcessBuilder("sleep", "3141").start(); System.out.println("spawned"); }`));
    expect(result.status).toBe("succeeded");
    await sleep(500);
    expect(pgrep("sleep 3141")).toBe("");
  }, 60_000);

  it("kills busy child processes with the process group on timeout", async () => {
    const result = await jvm(java(`public static void main(String[] a) throws Exception { new ProcessBuilder("sh", "-c", "exec sleep 2718").start(); while (true) {} }`), 1500);
    expect(result.status).toBe("timeout");
    await sleep(800);
    expect(pgrep("sleep 2718")).toBe("");
  }, 60_000);

  it("handles maximum-depth source without hanging or crashing the controller", async () => {
    const nested = "public class Main { static int x = " + "(".repeat(14_000) + "1" + ")".repeat(14_000) + "; public static void main(String[] a){ System.out.println(x); } }";
    const chain = "public class Main { static int x = " + "1+".repeat(30_000) + "1; public static void main(String[] a){ System.out.println(x); } }";
    expect(Buffer.byteLength(nested)).toBeLessThanOrEqual(65_536);
    expect(Buffer.byteLength(chain)).toBeLessThanOrEqual(65_536);
    for (const source of [nested, chain]) {
      const started = Date.now();
      const analysis = await app.inject({ method: "POST", url: "/api/analyze", headers, payload: JSON.stringify({ engine: "jvm", source }) });
      expect([200, 500]).toContain(analysis.statusCode);
      const result = await runToEnd(app, runRequest("jvm", source));
      expect(["succeeded", "compile_error", "program_error", "timeout", "internal_error"]).toContain(result.status);
      expect(Date.now() - started).toBeLessThan(40_000);
    }
    expect((await get("/api/health")).statusCode).toBe(200);
    const after = await jvm(java(`public static void main(String[] a){ System.out.println("fine"); }`));
    expect(after.output.stdout).toBe("fine\n");
  }, 120_000);

  it("handles a 64 KiB toy program without hanging", async () => {
    const source = "a = new Object();\n".repeat(3500);
    expect(Buffer.byteLength(source)).toBeLessThanOrEqual(65_536);
    const result = await runToEnd(app, runRequest("custom", source));
    expect(["succeeded", "timeout", "resource_limit", "output_limit", "program_error"]).toContain(result.status);
  }, 60_000);

  it("runs ten JVM programs back to back without leftovers", async () => {
    for (let index = 0; index < 10; index++) {
      const result = await jvm(java(`public static void main(String[] a){ System.out.println(${index}); }`));
      expect(result.status).toBe("succeeded");
    }
    expect(pgrep("gcd.launcher.Launcher|gcd.analyzer.Analyzer")).toBe("");
  }, 120_000);

  it("rejects a second run with 409 and cancels cleanly mid-flight", async () => {
    const first = await submit(app, runRequest("jvm", java("public static void main(String[] a){ while(true){} }"), { jvm: { timeoutMs: 30000 } }));
    const id = first.json().runId as string;
    const second = await submit(app, runRequest("jvm", java("public static void main(String[] a){}")));
    expect(second.statusCode).toBe(409);
    await sleep(2500);
    await app.inject({ method: "POST", url: `/api/runs/${id}/cancel`, headers, payload: "{}" });
    expect((await waitForRun(app, id)).status).toBe("cancelled");
    await sleep(500);
    expect(pgrep("gcd.launcher.Launcher")).toBe("");
  }, 60_000);
});
