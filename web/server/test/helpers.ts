import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { config as baseConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

export const TEST_PORT = 4177;
export const headers = { host: `127.0.0.1:${TEST_PORT}`, "content-type": "application/json" };

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...baseConfig,
    port: TEST_PORT,
    runRoot: mkdtempSync(join(tmpdir(), "gcd-test-")),
    ...overrides
  };
}

export async function start(overrides: Partial<Config> = {}): Promise<{ app: FastifyInstance; config: Config }> {
  const config = testConfig(overrides);
  const app = await createServer(config);
  return { app, config };
}

export const runRequest = (engine: "jvm" | "custom", source: string, options?: unknown) => ({
  schema: "gcd.run-request/1",
  engine,
  source,
  ...(options === undefined ? {} : { options })
});

export async function submit(app: FastifyInstance, body: unknown) {
  return app.inject({ method: "POST", url: "/api/runs", headers, payload: JSON.stringify(body) });
}

export async function waitForRun(app: FastifyInstance, runId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers });
    const body = response.json();
    if (body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error("run did not finish");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function runToEnd(app: FastifyInstance, body: unknown) {
  const response = await submit(app, body);
  if (response.statusCode !== 202) throw new Error(`submit failed ${response.statusCode}: ${response.body}`);
  return waitForRun(app, response.json().runId);
}
