import { generate, PRESET_SCENARIOS, type RunResult } from "@gcd/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { BuilderPanel, verification } from "../src/components/BuilderPanel";
import { TestLab } from "../src/components/TestLab";
import { initialState, reducer } from "../src/store";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const metric = (value: number) => ({ value, unit: "objects", provenance: "measured", source: "t" });
function successRun(generated: ReturnType<typeof generate>, over: Partial<RunResult> = {}): RunResult {
  let live = generated.expected.allocations;
  return {
    runId: "r1",
    engine: "custom",
    status: "succeeded",
    errors: [],
    engineResult: {
      totals: { allocations: metric(generated.expected.allocations), freed: metric(generated.expected.freedTotal), liveAfter: metric(generated.expected.liveFinal) },
      collections: generated.expected.collections.map((item) => {
        const row = { liveBefore: metric(live), freed: metric(item.freed), liveAfter: metric(item.liveAfter) };
        live = item.liveAfter;
        return row;
      })
    },
    ...over
  } as unknown as RunResult;
}

describe("store: builder state", () => {
  it("normalises spec patches, tracks what it wrote, and remembers the run's source", () => {
    let state = reducer(initialState, { type: "builder-spec", patch: { objects: 99999, rounds: 0 } });
    expect(state.builder.spec.objects).toBe(3000);
    expect(state.builder.spec.rounds).toBe(1);
    state = reducer(state, { type: "builder-apply", source: "o0 = new Object();\n" });
    expect(state.sources.custom).toBe("o0 = new Object();\n");
    expect(state.builder.appliedSource).toBe("o0 = new Object();\n");
    expect(state.sampleName).toBe("");
    state = reducer(state, { type: "started", runId: "r", source: "abc" });
    expect(state.runSource).toBe("abc");
    expect(reducer(state, { type: "builder", patch: { open: true } }).builder.open).toBe(true);
  });
});

describe("BuilderPanel", () => {
  const props = (spec = generate({ objects: 30 }).spec) => {
    const generated = generate(spec);
    return {
      spec: generated.spec,
      generated,
      liveSync: true,
      diverged: false,
      applied: false,
      run: null,
      runSource: null,
      onSpec: vi.fn(),
      onApply: vi.fn(),
      onLiveSync: vi.fn()
    };
  };

  it("exposes the object counter, the cycle/chain mix and the ranges, and reports changes", () => {
    const p = props();
    render(<BuilderPanel {...p} />);
    fireEvent.change(screen.getByLabelText("Objects"), { target: { value: "250" } });
    expect(p.onSpec).toHaveBeenCalledWith({ objects: 250 });
    fireEvent.click(screen.getByLabelText("More objects"));
    expect(p.onSpec).toHaveBeenCalledWith({ objects: p.spec.objects + 10 });
    fireEvent.change(screen.getByLabelText("Cycle share"), { target: { value: "80" } });
    expect(p.onSpec).toHaveBeenCalledWith({ cycleShare: 80 });
    fireEvent.change(screen.getByLabelText("Chain length"), { target: { value: "2-9" } });
    expect(p.onSpec).toHaveBeenCalledWith({ chainLength: [2, 9] });
    fireEvent.change(screen.getByLabelText("Extra links per object"), { target: { value: "1-3" } });
    expect(p.onSpec).toHaveBeenCalledWith({ extraLinks: [1, 3] });
    const before = p.onSpec.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Cycle length"), { target: { value: "nonsense" } });
    expect(p.onSpec.mock.calls.length).toBe(before);  // an unparsable range is not applied
    expect(screen.getByLabelText("Cycle length").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: PRESET_SCENARIOS[0]!.id } });
    expect(p.onSpec).toHaveBeenLastCalledWith(PRESET_SCENARIOS[0]!.spec);
  });

  it("shows statistics, the size meter, the CLI equivalent and the prediction", () => {
    const p = props();
    render(<BuilderPanel {...p} />);
    expect(screen.getByText(/objects in/).textContent).toContain(`${p.generated.stats.objects} objects`);
    expect(screen.getByLabelText("Source size")).toBeTruthy();
    expect(screen.getByText(/node web\/scripts\/gen-toy\.mjs --objects 30/)).toBeTruthy();
    expect(screen.getByText(/Predicted:/).textContent).toContain("gc 1 frees 0");
    fireEvent.click(screen.getByText("Generate into editor"));
    expect(p.onApply).toHaveBeenCalled();
  });

  it("blocks and explains a program over the 64 KiB limit, and flags hand edits", () => {
    const big = generate({ objects: 3000, extraLinks: [2, 2] });
    const { rerender } = render(<BuilderPanel {...props(big.spec)} />);
    expect(screen.getByRole("alert").textContent).toContain("64 KiB");
    rerender(<BuilderPanel {...props()} diverged applied />);
    expect(screen.getByRole("status").textContent).toContain("edited by hand");
    expect(screen.getByText("Regenerate into editor")).toBeTruthy();
  });

  it("verifies a finished run against the prediction, and says when the code differs", () => {
    const generated = generate({ objects: 40, seed: 3 });
    const pass = verification(generated, successRun(generated), generated.source);
    expect(pass?.state).toBe("pass");
    expect(verification(generated, successRun(generated), "something else")?.state).toBe("stale");
    expect(verification(generated, null, generated.source)).toBeNull();
    expect(verification(generated, successRun(generated, { status: "running" } as Partial<RunResult>), generated.source)).toBeNull();
    const wrong = successRun(generated);
    (wrong.engineResult as { totals: { freed: ReturnType<typeof metric> } }).totals.freed = metric(generated.expected.freedTotal + 1);
    const verdict = verification(generated, wrong, generated.source);
    expect(verdict?.state).toBe("fail");
    const p = props(generated.spec);
    render(<BuilderPanel {...p} run={wrong} runSource={generated.source} />);
    expect(screen.getByRole("alert").textContent).toContain("total freed");
  });
});

describe("App: builder and code stay in step", () => {
  function stubApi(started: Array<{ source: string }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
        if (url === "/api/samples") return json({ jvm: [], custom: [{ engine: "custom", name: "sample", source: "a = new Object();" }] });
        if (url === "/api/health") return json({ status: "ok", jdk: { found: true, version: "21", supported: true }, javaAnalyzer: { found: true }, customRunner: { found: true } });
        if (url === "/api/runs" && init?.method === "POST") {
          started.push(JSON.parse(String(init.body)));
          return json({ runId: "01M55N1Y3H22E6825WH41B0ZGN" }, 202);
        }
        return json({ error: "unexpected " + url }, 404);
      })
    );
  }

  it("writes the generated program into the editor, live-syncs spec changes, and stops after a hand edit", async () => {
    stubApi([]);
    render(<App />);
    fireEvent.change(screen.getByLabelText("Engine"), { target: { value: "custom" } });
    fireEvent.click(await screen.findByText(/Object builder/));
    const editorText = () => document.querySelector(".cm-content")?.textContent ?? "";
    await waitFor(() => expect(editorText()).toContain("a = new Object();"));  // sample, untouched by opening the builder
    fireEvent.change(screen.getByLabelText("Objects"), { target: { value: "7" } });
    expect(editorText()).toContain("a = new Object();");  // nothing applied before an explicit generate
    fireEvent.click(screen.getByText("Generate into editor"));
    await waitFor(() => expect(editorText()).toContain("o6 = new Object();"));
    fireEvent.change(screen.getByLabelText("Objects"), { target: { value: "9" } });
    await waitFor(() => expect(editorText()).toContain("o8 = new Object();"));  // live sync
    fireEvent.click(screen.getByLabelText("Live sync"));
    fireEvent.change(screen.getByLabelText("Objects"), { target: { value: "11" } });
    expect(editorText()).not.toContain("o10 = new Object();");  // sync off
    expect(screen.queryByText(/edited by hand/)).toBeNull();
  });

  it("starts the builder-generated code as an ordinary run", async () => {
    const started: Array<{ source: string }> = [];
    stubApi(started);
    render(<App />);
    fireEvent.change(screen.getByLabelText("Engine"), { target: { value: "custom" } });
    fireEvent.click(await screen.findByText(/Object builder/));
    fireEvent.change(screen.getByLabelText("Objects"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Generate into editor"));
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("o4 = new Object();"));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.source).toBe(generate(initialState.builder.spec && { ...initialState.builder.spec, objects: 5 }).source);
  });

  it("shows the builder only for the custom engine", async () => {
    stubApi([]);
    render(<App />);
    expect(screen.queryByText(/Object builder/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Engine"), { target: { value: "custom" } });
    expect(await screen.findByText(/Object builder/)).toBeTruthy();
  });
});

describe("TestLab", () => {
  it("runs the selected scenarios under the selected variants and reports passes and failures", async () => {
    const calls: string[] = [];
    let failNext = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
        if (url === "/api/runs" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          calls.push(JSON.stringify(body.options.custom));
          return json({ runId: `run${calls.length}` }, 202);
        }
        const match = /^\/api\/runs\/(run\d+)$/.exec(url);
        if (match) {
          const source = "";
          void source;
          const index = Number(match[1]!.slice(3)) - 1;
          const scenario = PRESET_SCENARIOS[index % PRESET_SCENARIOS.length]!;
          const generated = generate(scenario.spec);
          const run = successRun(generated, { runId: match[1] } as Partial<RunResult>);
          if (failNext && index === 1) (run.engineResult as { totals: { freed: ReturnType<typeof metric> } }).totals.freed = metric(-1);
          (run.engineResult as Record<string, unknown>).snapshots = [];
          return json(run);
        }
        return json({ error: "unexpected " + url }, 404);
      })
    );
    render(<TestLab busy={false} />);
    // keep only two presets and one variant so the matrix is tiny
    for (const checkbox of screen.getAllByRole("checkbox")) {
      const label = checkbox.parentElement?.textContent ?? "";
      const keep = label.includes("One chain of 100") || label.includes("Everything stays rooted") || label.includes("no regions, no reuse");
      if ((checkbox as HTMLInputElement).checked !== keep) fireEvent.click(checkbox);
    }
    fireEvent.change(screen.getByLabelText("Fuzz count"), { target: { value: "0" } });
    failNext = true;
    fireEvent.click(screen.getByText("▶ Run the lab"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 / 2 cases"), { timeout: 5000 });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!)).toEqual({ traceLevel: "mutator", snapshots: true });
    expect(screen.getByRole("status").textContent).toContain("1 passed");
    expect(screen.getByRole("status").textContent).toContain("1 failed");
    fireEvent.click(screen.getByText(/✖ fail/));
    expect(screen.getByText(/total freed: expected/)).toBeTruthy();
  });

  it("disables the run button while a normal run is active", () => {
    render(<TestLab busy />);
    expect((screen.getByText("▶ Run the lab") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/A run is active/)).toBeTruthy();
  });
});
