import type { PhaseInfo, RunRequest, RunResult, StructuredError } from "@gcd/shared";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { commandWithLimits, runProcess, type ProcessResult } from "./process.js";
import { metric, parseGcLog } from "./gc-log.js";
import type { Config } from "./config.js";
import { processGroupTracking } from "./process-meta.js";

interface AnalyzerResult {
  status: "ok" | "compile_error" | "no_main";
  mainClass: string | null;
  compileMs: number;
  staticAnalysis: {
    schema: "gcd.static-analysis/1";
    language: "java";
    ast: null;
    nodeCount: 0;
    truncated: false;
    diagnostics: Array<{
      severity: "error" | "warning" | "note";
      code: string;
      message: string;
      location?: StructuredError["location"];
    }>;
    java: {
      mainClass: string | null;
      publicTypeName: string | null;
      packageName: string | null;
      compileMs: {
        value: number;
        unit: string;
        provenance: "measured";
        source: string;
      };
    };
  };
}

function emptyAnalysis(compileMs = 0): AnalyzerResult["staticAnalysis"] {
  return {
    schema: "gcd.static-analysis/1",
    language: "java",
    ast: null,
    nodeCount: 0,
    truncated: false,
    diagnostics: [],
    java: {
      mainClass: null,
      publicTypeName: null,
      packageName: null,
      compileMs: {
        value: compileMs,
        unit: "ms",
        provenance: "measured",
        source: "gcd-java-analyzer"
      }
    }
  };
}

export async function analyzeJavaSource(
  config: Config,
  source: string,
  runDir: string,
  signal?: AbortSignal,
  parseOnly = false
): Promise<AnalyzerResult["staticAnalysis"]> {
  const sourcePath = join(runDir, "Submission.java");
  const analysisPath = join(runDir, "analysis.json");
  const classesPath = join(runDir, "classes");
  await mkdir(join(runDir, "tmp"), { recursive: true });
  await writeFile(sourcePath, source, { encoding: "utf8", mode: 0o600 });
  const command = commandWithLimits(config.javaPath, [
    "-Xmx256m",
    "-XX:ActiveProcessorCount=1",
    "-XX:-UsePerfData",
    "-Dfile.encoding=UTF-8",
    "-cp",
    config.javaJarPath,
    "gcd.analyzer.Analyzer",
    "--source",
    sourcePath,
    "--analysis",
    analysisPath,
    ...(parseOnly ? ["--parse-only"] : ["--classes", classesPath])
  ], { cpuSeconds: 20, fileBytes: 64 * 1024 * 1024, openFiles: 256 });
  const result = await runProcess(command.command, command.args, {
    cwd: runDir,
    env: safeEnvironment(runDir, config.javaPath),
    timeoutMs: config.analysisTimeoutMs,
    keepOutputBytes: 65_536,
    killOutputBytes: 1_048_576,
    ...(signal ? { signal } : {}),
    ...processGroupTracking(runDir)
  });
  if (result.timedOut) throw new Error("Java analysis timed out");
  if (result.outputLimit) throw new Error("Java analyzer output limit exceeded");
  return parseJson<AnalyzerResult>(await readFile(analysisPath, "utf8"), "Analyzer result").staticAnalysis;
}

interface LauncherMetrics {
  jvmUptimeMs: number;
  allocatedBytesMainThread: number | null;
  heapPeakUsed: number;
  collectors: Array<{ name: string; count: number; timeMs: number }>;
  exception?: { className: string; message: string; stackTop: string[] };
}

export interface AdapterOutcome {
  status: "succeeded" | "compile_error" | "program_error" | "timeout" | "output_limit" |
    "resource_limit" | "cancelled" | "internal_error";
  phases: RunResult["phases"];
  output: {
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  errors: StructuredError[];
  staticAnalysis: AnalyzerResult["staticAnalysis"];
  engineResult: Record<string, unknown>;
  limits: Record<string, number | string | null>;
  toolVersions: Record<string, string>;
}

const unavailable = (unit: string, note: string) =>
  metric(null, unit, "HotSpot supported management APIs", note);

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function safeEnvironment(runDir: string, javaPath: string): NodeJS.ProcessEnv {
  const javaHome = process.env.JAVA_HOME ?? (javaPath === "java" ? undefined : dirname(dirname(javaPath)));
  const pathEntries = [
    ...(javaHome ? [join(javaHome, "bin")] : []),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
  return {
    PATH: pathEntries.join(delimiter),
    LANG: "C.UTF-8",
    HOME: runDir,
    TMPDIR: join(runDir, "tmp"),
    ...(javaHome ? { JAVA_HOME: javaHome } : {})
  };
}

function resultLimits(config: Config, request: RunRequest, prlimit: boolean) {
  return {
    sourceBytes: Buffer.byteLength(request.source, "utf8"),
    stdoutBytes: 65_536,
    prlimit: prlimit ? "applied" : "unsupported-platform",
    analysisTimeoutMs: config.analysisTimeoutMs,
    executionTimeoutMs: request.options?.jvm?.timeoutMs ?? 10_000,
    cpuSeconds: 20,
    heapMiB: request.options?.jvm?.heapMiB ?? 64,
    fileBytes: 64 * 1024 * 1024,
    openFiles: 256,
    addressSpaceBytes: null
  };
}

function makeEngineResult(
  collector: "serial" | "g1",
  heapMiB: number,
  metrics: LauncherMetrics | undefined,
  compileMs: number,
  wallTimeMs: number,
  collections: ReturnType<typeof parseGcLog>
): Record<string, unknown> {
  const source = "GarbageCollectorMXBean";
  const collectorData = metrics?.collectors ?? [];
  const count = collectorData.every((item) => item.count >= 0)
    ? collectorData.reduce((sum, item) => sum + item.count, 0)
    : null;
  const gcTime = collectorData.every((item) => item.timeMs >= 0)
    ? collectorData.reduce((sum, item) => sum + item.timeMs, 0)
    : null;
  const heapPeak = metrics?.heapPeakUsed ?? null;
  const allocated = metrics?.allocatedBytesMainThread ?? null;
  const jvmUptime = metrics?.jvmUptimeMs ?? null;
  return {
    kind: "jvm",
    jvm: {
      version: process.env.GCD_JDK_VERSION ?? "unknown",
      vendor: process.env.GCD_JDK_VENDOR ?? "unknown",
      collector,
      flags: [
        `-XX:+Use${collector === "serial" ? "Serial" : "G1"}GC`,
        `-Xms${heapMiB}m`,
        `-Xmx${heapMiB}m`
      ]
    },
    totals: {
      compileMs: metric(compileMs, "ms", "gcd-java-analyzer"),
      wallTimeMs: metric(wallTimeMs, "ms", "controller monotonic clock"),
      jvmUptimeMs: metric(jvmUptime, "ms", "RuntimeMXBean"),
      gcCount: metric(count, "collections", source, "Aggregated GarbageCollectorMXBean counts"),
      gcPauseTotalMs: metric(gcTime, "ms", source, "Aggregated GarbageCollectorMXBean times"),
      allocatedBytesMainThread: metric(
        allocated,
        "bytes",
        "com.sun.management.ThreadMXBean",
        "Allocation accounting is for the invoked main thread only"
      ),
      heapPeakUsed: metric(
        heapPeak,
        "bytes",
        "sum of per-pool MemoryMXBean high-water marks",
        "Pool peaks may have occurred at different times"
      ),
      objectsReclaimed: unavailable("objects", "HotSpot does not expose per-collection object counts"),
      objectsMarked: unavailable("objects", "HotSpot does not expose mark counts"),
      rootSet: unavailable("objects", "HotSpot roots are not exposed through supported APIs"),
      objectGraph: unavailable("objects", "HotSpot object graph is not exposed through supported APIs"),
      edgesExamined: unavailable("edges", "HotSpot traversal work is not exposed")
    },
    perCollector: collectorData.map((item) => ({
      name: item.name,
      count: metric(item.count < 0 ? null : item.count, "collections", source),
      timeMs: metric(item.timeMs < 0 ? null : item.timeMs, "ms", source)
    })),
    collections,
    ...(metrics?.exception
      ? {
          exception: {
            className: metrics.exception.className,
            message: metrics.exception.message,
            stackTop: metrics.exception.stackTop.slice(0, 20)
          }
        }
      : {})
  };
}

function emptyMetrics(): LauncherMetrics {
  return {
    jvmUptimeMs: 0,
    allocatedBytesMainThread: null,
    heapPeakUsed: 0,
    collectors: []
  };
}

function phase(status: PhaseInfo["status"], duration: number, source: string): PhaseInfo {
  return {
    status,
    durationMs: {
      value: duration,
      unit: "ms",
      provenance: "measured",
      source
    }
  };
}

function structured(
  code: string,
  phaseName: StructuredError["phase"],
  message: string,
  extra?: Pick<StructuredError, "detail" | "location">
): StructuredError {
  return { code, phase: phaseName, message: message.slice(0, 2_000), ...extra };
}

export async function executeJava(
  config: Config,
  request: RunRequest,
  runDir: string,
  signal: AbortSignal
): Promise<AdapterOutcome> {
  const env = safeEnvironment(runDir, config.javaPath);
  const sourcePath = join(runDir, "Submission.java");
  const analysisPath = join(runDir, "analysis.json");
  const classesPath = join(runDir, "classes");
  const metricsPath = join(runDir, "jvm-metrics.json");
  const gcLogPath = join(runDir, "gc.log");
  const heapMiB = request.options?.jvm?.heapMiB ?? 64;
  const collector = request.options?.jvm?.collector ?? "serial";
  const limits = resultLimits(config, request, process.platform === "linux");
  let analyzerProcess: ProcessResult;
  try {
    await writeFile(sourcePath, request.source, { encoding: "utf8", mode: 0o600 });
    const command = commandWithLimits(config.javaPath, [
      "-Xmx256m",
      "-XX:ActiveProcessorCount=1",
      "-XX:-UsePerfData",
      "-Dfile.encoding=UTF-8",
      "-cp",
      config.javaJarPath,
      "gcd.analyzer.Analyzer",
      "--source",
      sourcePath,
      "--analysis",
      analysisPath,
      "--classes",
      classesPath
    ], { cpuSeconds: 20, fileBytes: 64 * 1024 * 1024, openFiles: 256 });
    analyzerProcess = await runProcess(command.command, command.args, {
      cwd: runDir,
      env,
      timeoutMs: config.analysisTimeoutMs,
      keepOutputBytes: 65_536,
      killOutputBytes: 1_048_576,
      signal,
      ...processGroupTracking(runDir)
    });
  } catch (error) {
    return {
      status: "internal_error",
      phases: { analysis: phase("failed", 0, "controller monotonic clock"), execute: phase("skipped", 0, "controller") },
      output: { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false },
      errors: [structured("ENGINE_UNAVAILABLE", "analysis", `Unable to start Java analyzer: ${String(error)}`)],
      staticAnalysis: emptyAnalysis(),
      engineResult: makeEngineResult(collector, heapMiB, undefined, 0, 0, []),
      limits,
      toolVersions: { controller: "2.0.0", analyzer: "unavailable", gitCommit: config.gitCommit }
    };
  }

  if (analyzerProcess.timedOut || analyzerProcess.outputLimit) {
    const status = analyzerProcess.outputLimit ? "output_limit" : "timeout";
    return {
      status,
      phases: {
        analysis: phase("killed", analyzerProcess.durationMs, "controller monotonic clock"),
        execute: phase("skipped", 0, "controller")
      },
      output: {
        stdout: "",
        stderr: analyzerProcess.stderr,
        stdoutTruncated: false,
        stderrTruncated: analyzerProcess.stderrTruncated
      },
      errors: [structured(
        analyzerProcess.outputLimit ? "OUTPUT_LIMIT" : "TIMEOUT",
        "analysis",
        analyzerProcess.outputLimit ? "Analyzer output limit exceeded" : "Java analysis timed out"
      )],
      staticAnalysis: emptyAnalysis(),
      engineResult: makeEngineResult(collector, heapMiB, undefined, 0, 0, []),
      limits,
      toolVersions: { controller: "2.0.0", analyzer: "2.0.0", gitCommit: config.gitCommit }
    };
  }

  let analyzer: AnalyzerResult;
  try {
    analyzer = parseJson<AnalyzerResult>(await readFile(analysisPath, "utf8"), "Analyzer result");
  } catch (error) {
    return {
      status: "internal_error",
      phases: { analysis: phase("failed", analyzerProcess.durationMs, "controller monotonic clock"), execute: phase("skipped", 0, "controller") },
      output: { stdout: "", stderr: analyzerProcess.stderr, stdoutTruncated: false, stderrTruncated: analyzerProcess.stderrTruncated },
      errors: [structured("SCHEMA_VIOLATION", "analysis", String(error))],
      staticAnalysis: emptyAnalysis(),
      engineResult: makeEngineResult(collector, heapMiB, undefined, 0, 0, []),
      limits,
      toolVersions: { controller: "2.0.0", analyzer: "2.0.0", gitCommit: config.gitCommit }
    };
  }

  const analysisErrors = analyzer.staticAnalysis.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => structured(
      diagnostic.code === "NO_MAIN_METHOD" ? "NO_MAIN_METHOD" : "COMPILE_ERROR",
      "compile",
      diagnostic.message,
      diagnostic.location ? { location: diagnostic.location } : undefined
    ));
  if (analyzer.status !== "ok" || !analyzer.mainClass) {
    const compileFailure = analyzer.status === "compile_error";
    return {
      status: "compile_error",
      phases: {
        analysis: phase("ok", analyzerProcess.durationMs, "controller monotonic clock"),
        compile: phase("failed", analyzer.compileMs, "gcd-java-analyzer"),
        execute: phase("skipped", 0, "controller")
      },
      output: {
        stdout: "",
        stderr: analyzerProcess.stderr,
        stdoutTruncated: false,
        stderrTruncated: analyzerProcess.stderrTruncated
      },
      errors: analysisErrors.length > 0
        ? analysisErrors
        : [structured(compileFailure ? "COMPILE_ERROR" : "NO_MAIN_METHOD", "compile", "Java source did not compile to a runnable main class")],
      staticAnalysis: analyzer.staticAnalysis,
      engineResult: makeEngineResult(collector, heapMiB, undefined, analyzer.compileMs, 0, []),
      limits,
      toolVersions: { controller: "2.0.0", analyzer: "2.0.0", gitCommit: config.gitCommit }
    };
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(analyzer.mainClass)) {
    return {
      status: "internal_error",
      phases: { analysis: phase("ok", analyzerProcess.durationMs, "controller monotonic clock"), compile: phase("ok", analyzer.compileMs, "gcd-java-analyzer"), execute: phase("skipped", 0, "controller") },
      output: { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false },
      errors: [structured("SCHEMA_VIOLATION", "analysis", "Analyzer returned an invalid fully-qualified main class")],
      staticAnalysis: analyzer.staticAnalysis,
      engineResult: makeEngineResult(collector, heapMiB, undefined, analyzer.compileMs, 0, []),
      limits,
      toolVersions: { controller: "2.0.0", analyzer: "2.0.0", gitCommit: config.gitCommit }
    };
  }

  const launchArgs = [
    `-Xms${heapMiB}m`,
    `-Xmx${heapMiB}m`,
    "-Xss1m",
    "-XX:MaxMetaspaceSize=64m",
    "-XX:ReservedCodeCacheSize=32m",
    "-XX:ActiveProcessorCount=1",
    "-XX:-UsePerfData",
    "-XX:+ExitOnOutOfMemoryError",
    collector === "serial" ? "-XX:+UseSerialGC" : "-XX:+UseG1GC",
    `-Djava.io.tmpdir=${join(runDir, "tmp")}`,
    "-Dfile.encoding=UTF-8",
    `-Xlog:gc*:file=${gcLogPath}:uptime,level,tags`,
    "-cp",
    [classesPath, config.javaJarPath].join(delimiter),
    "gcd.launcher.Launcher",
    analyzer.mainClass,
    metricsPath
  ];
  let execution: ProcessResult;
  try {
    await mkdir(join(runDir, "tmp"), { recursive: true });
    const command = commandWithLimits(config.javaPath, launchArgs, {
      cpuSeconds: 20,
      fileBytes: 64 * 1024 * 1024,
      openFiles: 256
    });
    execution = await runProcess(command.command, command.args, {
      cwd: runDir,
      env,
      timeoutMs: request.options?.jvm?.timeoutMs ?? 10_000,
      keepOutputBytes: 65_536,
      killOutputBytes: 1_048_576,
      signal,
      ...processGroupTracking(runDir)
    });
  } catch (error) {
    return {
      status: "internal_error",
      phases: {
        analysis: phase("ok", analyzerProcess.durationMs, "controller monotonic clock"),
        compile: phase("ok", analyzer.compileMs, "gcd-java-analyzer"),
        execute: phase("failed", 0, "controller monotonic clock")
      },
      output: { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false },
      errors: [structured("ENGINE_UNAVAILABLE", "execute", `Unable to start Java launcher: ${String(error)}`)],
      staticAnalysis: analyzer.staticAnalysis,
      engineResult: makeEngineResult(collector, heapMiB, undefined, analyzer.compileMs, 0, []),
      limits,
      toolVersions: { controller: "2.0.0", analyzer: "2.0.0", gitCommit: config.gitCommit }
    };
  }

  let launcherMetrics: LauncherMetrics | undefined;
  let metricsError: string | undefined;
  try {
    launcherMetrics = parseJson<LauncherMetrics>(await readFile(metricsPath, "utf8"), "JVM metrics");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      metricsError = "JVM launcher did not write metrics JSON";
    } else {
      metricsError = `JVM metrics JSON is invalid: ${String(error)}`;
    }
  }
  let gcLog = "";
  try {
    gcLog = await readFile(gcLogPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const collections = parseGcLog(gcLog);
  const errors = [...analysisErrors];
  let status: AdapterOutcome["status"] = "succeeded";
  if (execution.cancelled) {
    status = "cancelled";
    errors.push(structured("CANCELLED", "execute", "Run cancelled by the client"));
  } else if (execution.timedOut) {
    status = "timeout";
    errors.push(structured("TIMEOUT", "execute", "Java execution exceeded its time limit"));
  } else if (execution.outputLimit) {
    status = "output_limit";
    errors.push(structured("OUTPUT_LIMIT", "execute", "Java output exceeded the 1 MiB termination limit"));
  } else if (execution.signal === "SIGXCPU") {
    status = "resource_limit";
    errors.push(structured("RESOURCE_LIMIT", "execute", "Java process exceeded its CPU time limit"));
  } else if (execution.signal) {
    status = "internal_error";
    errors.push(structured("PROCESS_CRASH", "execute", `Java process terminated by ${execution.signal}`));
  } else if (launcherMetrics?.exception) {
    status = "program_error";
    const oom = launcherMetrics.exception.className.endsWith("OutOfMemoryError");
    errors.push(structured(
      oom ? "OUT_OF_MEMORY" : "UNCAUGHT_EXCEPTION",
      "execute",
      `${launcherMetrics.exception.className}: ${launcherMetrics.exception.message}`,
      { detail: { exceptionClass: launcherMetrics.exception.className, stackTop: launcherMetrics.exception.stackTop } }
    ));
  } else if (execution.exitCode !== 0) {
    status = "program_error";
    const outOfMemory = execution.exitCode === 3 &&
      (execution.stderr.includes("OutOfMemoryError") || execution.stdout.includes("OutOfMemoryError"));
    errors.push(structured(
      outOfMemory ? "OUT_OF_MEMORY" : "PROGRAM_EXIT",
      "execute",
      `Java program exited with status ${String(execution.exitCode)}`
    ));
  }
  if (!launcherMetrics && status === "succeeded") {
    status = "internal_error";
    errors.push(structured("SCHEMA_VIOLATION", "execute", metricsError ?? "JVM metrics are unavailable"));
  }

  const outcomeMetrics = launcherMetrics ?? emptyMetrics();
  return {
    status,
    phases: {
      analysis: phase("ok", analyzerProcess.durationMs, "controller monotonic clock"),
      compile: phase("ok", analyzer.compileMs, "gcd-java-analyzer"),
      execute: phase(
        execution.timedOut || execution.outputLimit || execution.cancelled ? "killed" : execution.exitCode === 0 ? "ok" : "failed",
        execution.durationMs,
        "controller monotonic clock"
      )
    },
    output: {
      stdout: execution.stdout,
      stderr: execution.stderr,
      stdoutTruncated: execution.stdoutTruncated,
      stderrTruncated: execution.stderrTruncated
    },
    errors,
    staticAnalysis: analyzer.staticAnalysis,
    engineResult: makeEngineResult(collector, heapMiB, outcomeMetrics, analyzer.compileMs, execution.durationMs, collections),
    limits,
    toolVersions: {
      controller: "2.0.0",
      analyzer: "2.0.0",
      jdk: process.env.GCD_JDK_VERSION ?? "unknown",
      gitCommit: config.gitCommit
    }
  };
}
