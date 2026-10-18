import type { RunResult, RunStatus } from "@gcd/shared";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api, ApiFailure } from "./api";
import { AstPanel } from "./components/AstPanel";
import { HeapGraphPanel } from "./components/HeapGraphPanel";
import { generate } from "@gcd/shared";
import { BuilderPanel } from "./components/BuilderPanel";
import { TestLab } from "./components/TestLab";
import { BenchmarkPanel } from "./components/BenchmarkPanel";
import { ComparePanel } from "./components/ComparePanel";
import { RegionPanel } from "./components/RegionPanel";
import { TimelinePanel } from "./components/TimelinePanel";
import { useTrace } from "./useTrace";
import { EditorPanel, type EditorCommand, type EditorDiagnostic } from "./components/EditorPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { OutputPanel, type Jump } from "./components/OutputPanel";
import { StatsPanel } from "./components/StatsPanel";
import { TopBar } from "./components/TopBar";
import { initialState, isActive, reducer } from "./store";
import { useRunPolling } from "./usePolling";

function offsetOf(source: string, line: number, column: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let index = 0; index < Math.min(line - 1, lines.length); index++) offset += lines[index]!.length + 1;
  return Math.min(offset + Math.max(column - 1, 0), source.length);
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [bottomTab, setBottomTab] = useState<"output" | "compare" | "benchmarks" | "lab">("output");
  const [leftTab, setLeftTab] = useState<"ast" | "stats">("ast");
  const [heapTab, setHeapTab] = useState<"graph" | "regions" | "timeline">("graph");
  const [regionFilter, setRegionFilter] = useState<number | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<number | null>(null);
  const [snapshotIndex, setSnapshotIndex] = useState(0);
  const [command, setCommand] = useState<EditorCommand | null>(null);
  const trace = useTrace(state.run);
  const source = state.sources[state.engine];
  const active = isActive(state.run, state.runId);
  const builderShown = state.builder.open && state.engine === "custom";
  const generated = useMemo(() => generate(state.builder.spec), [state.builder.spec]);
  const customSource = state.sources.custom;
  const diverged = state.builder.appliedSource !== null && customSource !== state.builder.appliedSource;
  // Live sync: after the first explicit generate, spec changes rewrite the editor until the user edits the code.
  useEffect(() => {
    const { appliedSource, liveSync } = state.builder;
    if (builderShown && liveSync && appliedSource !== null && customSource === appliedSource && generated.source !== appliedSource) {
      dispatch({ type: "builder-apply", source: generated.source });
    }
  }, [builderShown, generated.source]);
  const status: RunStatus | "idle" = state.run?.status ?? (state.runId ? "running" : "idle");

  const [setupProblems, setSetupProblems] = useState<string[]>([]);
  useEffect(() => {
    api
      .health()
      .then((health) => {
        const problems: string[] = [];
        if (!health.jdk.found) problems.push("No JDK was found: Java runs are unavailable. JDK 21 is required.");
        else if (health.jdk.supported === false) {
          problems.push(`JDK ${health.jdk.version} is in use; the GC-log parser and results are verified on JDK 21 only.`);
        }
        if (!health.javaAnalyzer.found) problems.push("The Java analyzer is not built (run java/build.sh).");
        if (!health.customRunner.found) problems.push("The custom runtime runner (gcd_runner) is not built.");
        setSetupProblems(problems);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .samples()
      .then((samples) => dispatch({ type: "samples", samples }))
      .catch((error: unknown) => dispatch({ type: "failed", message: String(error) }));
  }, []);

  const onProgress = useCallback((run: RunResult) => dispatch({ type: "progress", run }), []);
  const onPollError = useCallback((message: string) => dispatch({ type: "failed", message }), []);
  useRunPolling(state.runId, onProgress, onPollError);
  useEffect(() => {
    setSnapshotIndex(0);
    setRegionFilter(null);
    setSelectedRegion(null);
  }, [state.runId]);

  const jump = useCallback(
    (target: Jump) => {
      const start = offsetOf(source, target.line, target.column);
      const end =
        target.endLine && target.endColumn ? offsetOf(source, target.endLine, target.endColumn) : start;
      setCommand((previous) => ({ seq: (previous?.seq ?? 0) + 1, kind: "jump", start, end }));
    },
    [source]
  );

  // A finished run with a located error moves the cursor to it.
  const finishedId = state.run && state.run.status !== "running" && state.run.status !== "queued" ? state.run.runId : null;
  useEffect(() => {
    if (!state.run || !finishedId) return;
    const located =
      state.run.errors.find((error) => error.location)?.location ??
      state.run.staticAnalysis?.diagnostics.find((diagnostic) => diagnostic.severity === "error" && diagnostic.location)
        ?.location;
    if (located) jump(located);
  }, [finishedId]);

  const diagnostics = useMemo<EditorDiagnostic[]>(() => {
    const items: EditorDiagnostic[] = [];
    for (const diagnostic of state.run?.staticAnalysis?.diagnostics ?? []) {
      if (diagnostic.location && diagnostic.severity !== "note") {
        items.push({ line: diagnostic.location.line, severity: diagnostic.severity });
      }
    }
    for (const error of state.run?.errors ?? []) {
      if (error.location) items.push({ line: error.location.line, severity: "error" });
    }
    return items;
  }, [state.run]);

  const run = async () => {
    try {
      const { runId } = await api.startRun(state.engine, source, state.customOptions);
      dispatch({ type: "started", runId, source });
    } catch (error) {
      dispatch({ type: "failed", message: error instanceof ApiFailure ? `${error.error.code}: ${error.message}` : String(error) });
    }
  };
  const stop = async () => {
    if (!state.runId) return;
    try {
      await api.cancel(state.runId);
    } catch (error) {
      dispatch({ type: "failed", message: String(error) });
    }
  };

  return (
    <div className="app">
      <TopBar
        engine={state.engine}
        samples={state.samples[state.engine]}
        sampleName={state.sampleName}
        status={status}
        runId={state.runId}
        customOptions={state.customOptions}
        onOptions={(options) => dispatch({ type: "options", options })}
        onEngine={(engine) => dispatch({ type: "engine", engine })}
        onSample={(name) => dispatch({ type: "sample", name })}
        onRun={run}
        onStop={stop}
        onReset={() => dispatch({ type: "reset" })}
      />
      {setupProblems.map((problem) => (
        <div key={problem} className="banner" role="alert">
          {problem}
        </div>
      ))}
      {state.requestError ? (
        <div className="banner" role="alert">
          {state.requestError}
        </div>
      ) : null}
      <PanelGroup direction="vertical" autoSaveId="gcd-main-v2">
        <Panel defaultSize={76} minSize={25}>
          <PanelGroup direction="horizontal" autoSaveId="gcd-top-v2">
            <Panel defaultSize={50} minSize={20}>
              <div className="left-column">
                {state.engine === "custom" ? (
                  <button
                    className="builder-toggle"
                    aria-expanded={state.builder.open}
                    onClick={() => dispatch({ type: "builder", patch: { open: !state.builder.open } })}
                  >
                    {state.builder.open ? "▾" : "▸"} Object builder <span className="muted">(set object counts, cycles and chains; or just write code below)</span>
                  </button>
                ) : null}
                {builderShown ? (
                  <div className="builder-scroll">
                    <ErrorBoundary label="object builder">
                      <BuilderPanel
                        spec={state.builder.spec}
                        generated={generated}
                        liveSync={state.builder.liveSync}
                        diverged={diverged}
                        applied={state.builder.appliedSource !== null}
                        run={state.run}
                        runSource={state.runSource}
                        onSpec={(patch) => dispatch({ type: "builder-spec", patch })}
                        onApply={() => dispatch({ type: "builder-apply", source: generated.source })}
                        onLiveSync={(value) => dispatch({ type: "builder", patch: { liveSync: value } })}
                      />
                    </ErrorBoundary>
                  </div>
                ) : null}
                <div className="editor-slot">
                  <ErrorBoundary label="editor">
                    <EditorPanel
                      source={source}
                      language={state.engine === "jvm" ? "java" : "gcd-toy"}
                      diagnostics={diagnostics}
                      command={command}
                      readOnly={active}
                      onChange={(value) => dispatch({ type: "edit", source: value })}
                    />
                  </ErrorBoundary>
                </div>
              </div>
            </Panel>
            <PanelResizeHandle className="handle" />
            <Panel defaultSize={50} minSize={20}>
              <PanelGroup direction="vertical" autoSaveId="gcd-right-v2">
                <Panel defaultSize={32} minSize={10}>
                  <div className="tabs" role="tablist">
                    <button role="tab" aria-selected={leftTab === "ast"} onClick={() => setLeftTab("ast")}>
                      AST
                    </button>
                    <button role="tab" aria-selected={leftTab === "stats"} onClick={() => setLeftTab("stats")}>
                      Statistics
                    </button>
                  </div>
                  <div className="tab-body">
                    <ErrorBoundary label={leftTab === "ast" ? "AST" : "statistics"}>
                      {leftTab === "ast" ? (
                        <AstPanel
                          analysis={state.run?.staticAnalysis}
                          onSelectSpan={(span) =>
                            setCommand((previous) => ({ seq: (previous?.seq ?? 0) + 1, kind: "highlight", ...span }))
                          }
                        />
                      ) : (
                        <StatsPanel run={state.run} />
                      )}
                    </ErrorBoundary>
                  </div>
                </Panel>
                <PanelResizeHandle className="handle horizontal" />
                <Panel defaultSize={68} minSize={15}>
                  <div className="tabs" role="tablist">
                    <button role="tab" aria-selected={heapTab === "graph"} onClick={() => setHeapTab("graph")}>
                      Heap graph
                    </button>
                    <button role="tab" aria-selected={heapTab === "regions"} onClick={() => setHeapTab("regions")}>
                      Regions
                    </button>
                    <button role="tab" aria-selected={heapTab === "timeline"} onClick={() => setHeapTab("timeline")}>
                      Timeline
                    </button>
                  </div>
                  <div className="tab-body">
                    <ErrorBoundary label={heapTab === "graph" ? "heap graph" : heapTab === "regions" ? "regions" : "timeline"}>
                      {heapTab === "graph" ? (
                        <HeapGraphPanel
                          run={state.run}
                          selectedIndex={snapshotIndex}
                          onSelectIndex={setSnapshotIndex}
                          tracePartial={trace.partial}
                          regionFilter={regionFilter}
                          onClearRegionFilter={() => setRegionFilter(null)}
                        />
                      ) : heapTab === "regions" ? (
                        <RegionPanel
                          run={state.run}
                          snapshotIndex={snapshotIndex}
                          selectedRegion={selectedRegion}
                          onSelectRegion={setSelectedRegion}
                          onShowObjects={() => {
                            setRegionFilter(selectedRegion);
                            setHeapTab("graph");
                          }}
                        />
                      ) : (
                        <TimelinePanel
                          run={state.run}
                          trace={trace}
                          onSelectGc={(index) => {
                            setSnapshotIndex(index);
                            setHeapTab("graph");
                          }}
                        />
                      )}
                    </ErrorBoundary>
                  </div>
                </Panel>
              </PanelGroup>
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="handle horizontal" />
        <Panel defaultSize={24} minSize={8}>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={bottomTab === "output"} onClick={() => setBottomTab("output")}>
              Output
            </button>
            <button role="tab" aria-selected={bottomTab === "compare"} onClick={() => setBottomTab("compare")}>
              Compare
            </button>
            <button role="tab" aria-selected={bottomTab === "lab"} onClick={() => setBottomTab("lab")}>
              Test lab
            </button>
            <button role="tab" aria-selected={bottomTab === "benchmarks"} onClick={() => setBottomTab("benchmarks")}>
              Benchmarks
            </button>
          </div>
          <div className="tab-body">
            <ErrorBoundary label={bottomTab}>
              {bottomTab === "output" ? (
                <OutputPanel run={state.run} onJump={jump} />
              ) : bottomTab === "compare" ? (
                <ComparePanel history={state.history} />
              ) : bottomTab === "lab" ? (
                <TestLab busy={active} />
              ) : (
                <BenchmarkPanel />
              )}
            </ErrorBoundary>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
