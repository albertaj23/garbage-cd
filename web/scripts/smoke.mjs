// Starts the built controller, runs one sample per engine over HTTP, and checks terminal statuses.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.GCD_SMOKE_PORT ?? 4188);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [join(root, "server/dist/index.js")], {
  env: { ...process.env, GCD_PORT: String(port) },
  stdio: ["ignore", "ignore", "inherit"]
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sample = (folder, name) => readFileSync(join(root, "server/samples", folder, name), "utf8");
let failed = false;
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failed = true;
};

async function waitReady() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error("controller did not start");
}

async function run(engine, source, options) {
  const response = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schema: "gcd.run-request/1", engine, source, ...(options ? { options } : {}) })
  });
  if (response.status !== 202) throw new Error(`submit ${engine}: ${response.status} ${await response.text()}`);
  const { runId } = await response.json();
  for (;;) {
    const result = await (await fetch(`${base}/api/runs/${runId}`)).json();
    if (result.status !== "running" && result.status !== "queued") return result;
    await sleep(250);
  }
}

try {
  await waitReady();
  const page = await fetch(`${base}/`);
  check(page.ok && (await page.text()).includes('id="root"'), "GET / serves the dashboard");
  const jvm = await run("jvm", sample("java", "Allocation.java"));
  check(jvm.status === "succeeded" && jvm.output.stdout.includes("allocated"), `jvm sample status=${jvm.status}`);
  check(jvm.staticAnalysis?.ast !== null, "jvm run includes an AST");
  const custom = readdirSync(join(root, "server/samples/custom")).includes("sample.gc");
  const toy = await run("custom", custom ? sample("custom", "sample.gc") : "", { custom: { traceLevel: "mutator", snapshots: true } });
  check(toy.status === "succeeded", `custom sample status=${toy.status}`);
  check(toy.engineResult?.collections?.length >= 1, "custom run reports per-GC records");
  check(toy.trace?.available === true && toy.trace?.complete === true, "custom run has a complete trace");
  const trace = await (await fetch(`${base}/api/runs/${toy.runId}/trace`)).json();
  check(trace.batches?.length >= 1 && trace.next === null, "trace endpoint returns batches");
  const snapshot = await (await fetch(`${base}/api/runs/${toy.runId}/snapshots/0`)).json();
  check(snapshot.schema === "gcd.heap-snapshot/1" && snapshot.objects.length === 2, "snapshot endpoint returns the GC #1 heap");
} catch (error) {
  console.error(String(error));
  failed = true;
} finally {
  server.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
