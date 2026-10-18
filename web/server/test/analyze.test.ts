import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AstNode, StaticAnalysisResult } from "@gcd/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as baseConfig } from "../src/config.js";
import { headers, runRequest, runToEnd, start } from "./helpers.js";

let app: FastifyInstance;
const samplesDir = join(baseConfig.root, "web", "server", "samples", "java");
const goldenDir = new URL("./golden/", import.meta.url).pathname;

beforeAll(async () => {
  ({ app } = await start());
}, 30_000);
afterAll(async () => {
  await app.close();
});

async function analyze(source: string): Promise<{ status: number; body: StaticAnalysisResult }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/analyze",
    headers,
    payload: JSON.stringify({ engine: "jvm", source })
  });
  return { status: response.statusCode, body: response.json() };
}

function* walk(node: AstNode): Generator<AstNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

const normalized = (analysis: StaticAnalysisResult) => {
  const copy = structuredClone(analysis);
  if (copy.java) copy.java.compileMs = { ...copy.java.compileMs, value: 0 };
  return copy;
};

describe("Java static analysis (POST /api/analyze)", () => {
  const names = readdirSync(samplesDir).filter((name) => name.endsWith(".java")).sort();

  it("has five Java samples", () => {
    expect(names).toHaveLength(5);
  });

  for (const name of names) {
    it(`matches the golden AST for ${name}`, async () => {
      const source = readFileSync(join(samplesDir, name), "utf8");
      const { status, body } = await analyze(source);
      expect(status).toBe(200);
      const goldenPath = join(goldenDir, `${name.replace(/\.java$/, "")}.ast.json`);
      if (process.env.UPDATE_GOLDEN === "1" || !existsSync(goldenPath)) {
        writeFileSync(goldenPath, `${JSON.stringify(normalized(body), null, 2)}\n`);
      }
      expect(normalized(body)).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
    }, 30_000);

    it(`round-trips spans for ${name}`, async () => {
      const source = readFileSync(join(samplesDir, name), "utf8");
      const { body } = await analyze(source);
      expect(body.ast).not.toBeNull();
      let spans = 0;
      const check = (node: AstNode, parent?: AstNode) => {
        if (node.span) {
          spans++;
          const text = source.slice(node.span.start, node.span.end);
          expect(text.length).toBeGreaterThan(0);
          if (node.kind === "IDENTIFIER" || node.kind === "VARIABLE") {
            expect(text.includes(node.label ?? "")).toBe(true);
          }
          if (node.kind === "STRING_LITERAL") expect(text.startsWith('"')).toBe(true);
          if (parent?.span) {
            expect(node.span.start).toBeGreaterThanOrEqual(parent.span.start);
            expect(node.span.end).toBeLessThanOrEqual(parent.span.end);
          }
        } else {
          expect(node.synthetic).toBe(true);
        }
        node.children.forEach((child) => check(child, node));
      };
      check(body.ast!);
      expect(spans).toBeGreaterThan(5);
    }, 30_000);
  }

  it("assigns contiguous pre-order ids", async () => {
    const { body } = await analyze(readFileSync(join(samplesDir, "Cycle.java"), "utf8"));
    const ids = [...walk(body.ast!)].map((node) => node.id);
    expect(ids).toEqual(ids.map((_, index) => index));
    expect(body.nodeCount).toBe(ids.length);
    expect(body.truncated).toBe(false);
  });

  it("flags the implicit default constructor as synthetic in a full run", async () => {
    const result = await runToEnd(
      app,
      runRequest("jvm", "public class Main { public static void main(String[] a) { System.out.println(1); } }")
    );
    const ctor = [...walk(result.staticAnalysis.ast as AstNode)].find((node) => node.kind === "METHOD" && node.label === "<init>");
    expect(ctor?.synthetic).toBe(true);
    expect(ctor?.span).toBeUndefined();
  }, 60_000);

  it("truncates a 5,001+ node program breadth-first at 5,000 nodes", async () => {
    const values = Array.from({ length: 6_000 }, (_, index) => String(index)).join(",");
    const source = `public class Big { static int[] data = {${values}}; public static void main(String[] a) {} }`;
    const { status, body } = await analyze(source);
    expect(status).toBe(200);
    expect(body.nodeCount).toBe(5_000);
    expect(body.truncated).toBe(true);
    expect([...walk(body.ast!)]).toHaveLength(5_000);
    expect(body.diagnostics.some((item) => item.code === "AST_TRUNCATED")).toBe(true);
  }, 30_000);

  it("reports syntax errors with a compiler location and no compile", async () => {
    const { status, body } = await analyze("public class Main { void f( { } }");
    expect(status).toBe(200);
    expect(body.diagnostics.some((item) => item.severity === "error" && item.location?.line === 1)).toBe(true);
  }, 30_000);

  it("analyzes a ~300-line program in under 2 seconds", async () => {
    const methods = Array.from({ length: 60 }, (_, index) =>
      `  static int f${index}(int x) {\n    int y = x * ${index} + 1;\n    if (y > 10) { y -= 3; }\n    return y;\n  }\n`
    ).join("");
    const source = `public class Large {\n${methods}  public static void main(String[] a) { System.out.println(f1(2)); }\n}\n`;
    expect(source.split("\n").length).toBeGreaterThanOrEqual(300);
    const started = performance.now();
    const { status, body } = await analyze(source);
    const elapsed = performance.now() - started;
    expect(status).toBe(200);
    expect(body.truncated).toBe(false);
    expect(elapsed).toBeLessThan(2_000);
  }, 30_000);
});
