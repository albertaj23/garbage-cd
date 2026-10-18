import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const runId = "01M55N1Y3H22E6825WH41B0ZGN";

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  let polls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/health") {
        return respond({
          status: "ok",
          jdk: { found: true, version: "25.0.1", supported: false },
          javaAnalyzer: { found: true },
          customRunner: { found: false }
        });
      }
      if (url === "/api/samples") {
        return respond({
          jvm: [{ engine: "jvm", name: "Hello", source: "public class Hello {}" }],
          custom: [{ engine: "custom", name: "sample", source: "var a = 1;" }]
        });
      }
      if (url === "/api/runs" && init?.method === "POST") return respond({ runId }, 202);
      if (url === `/api/runs/${runId}`) {
        polls++;
        const base = {
          schema: "gcd.run-result/1",
          runId,
          engine: "jvm",
          language: "java",
          sourceSha256: "0",
          createdAt: "now",
          phases: {},
          errors: [],
          limits: {},
          toolVersions: {}
        };
        return respond(
          polls < 2
            ? { ...base, status: "running", output: { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false } }
            : { ...base, status: "succeeded", output: { stdout: "finished output", stderr: "", stdoutTruncated: false, stderrTruncated: false } }
        );
      }
      return respond({ error: "unexpected " + url }, 404);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("loads samples, runs a program, polls to a terminal status and shows output", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText("Sample") as HTMLSelectElement).value).toBe("Hello"));
    expect(screen.getByRole("note").textContent).toContain("Standard JVM");
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("running"));
    await waitFor(() => expect(screen.getByLabelText("stdout").textContent).toBe("finished output"), { timeout: 3_000 });
    expect(screen.getByRole("status").textContent).toContain("succeeded");
  });

  it("tells the user when the JDK is not 21 or a tool is not built", async () => {
    render(<App />);
    expect(await screen.findByText(/JDK 25\.0\.1 is in use; .* JDK 21 only/)).toBeTruthy();
    expect(screen.getByText(/gcd_runner\) is not built/)).toBeTruthy();
    expect(screen.queryByText(/analyzer is not built/)).toBeNull();
  });

  it("switches engine and shows the custom-runtime banner", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText("Sample") as HTMLSelectElement).value).toBe("Hello"));
    fireEvent.change(screen.getByLabelText("Engine"), { target: { value: "custom" } });
    expect(screen.getByRole("note").textContent).toContain("Custom runtime");
    await waitFor(() => expect((screen.getByLabelText("Sample") as HTMLSelectElement).value).toBe("sample"));
  });
});
