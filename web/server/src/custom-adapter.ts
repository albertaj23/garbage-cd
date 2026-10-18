import type { RunRequest, RunResult, StructuredError } from "@gcd/shared";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { commandWithLimits, runProcess } from "./process.js";
import { safeRunEnvironment } from "./run-environment.js";
import { processGroupTracking } from "./process-meta.js";
import { loadTrace, summarizeTrace } from "./trace-store.js";

export interface CustomOutcome {
  status: RunResult["status"];
  result: Partial<RunResult> & Pick<RunResult, "status" | "output" | "errors">;
}

function makeError(code: string, message: string, phase: StructuredError["phase"]): StructuredError {
  return { code, message: message.slice(0, 2_000), phase };
}

export async function executeCustom(
  config: Config,
  request: RunRequest,
  runId: string,
  runDir: string,
  signal: AbortSignal
): Promise<CustomOutcome> {
  const sourcePath = join(runDir, "source.gc");
  const resultPath = join(runDir, "runner-result.json");
  const tracePath = join(runDir, "trace.ndjson");
  const snapshotsPath = join(runDir, "snapshots");
  await mkdir(join(runDir, "tmp"), { recursive: true });
  await writeFile(sourcePath, request.source, { encoding: "utf8", mode: 0o600 });
  const options = request.options?.custom;
  const traceLevel = options?.traceLevel ?? "off";
  const args = [
    "--source", sourcePath,
    "--result", resultPath,
    "--run-id", runId,
    "--trace-level", traceLevel,
    "--batch-size", String(options?.batchSize ?? 1024)
  ];
  if (traceLevel !== "off") args.push("--trace", tracePath);
  if (options?.snapshots) args.push("--snapshots-dir", snapshotsPath, "--snapshot-max-objects", "2000");
  const regionSize = options?.regionSize ?? 0;
  if (regionSize !== 0) args.push("--region-size", String(regionSize), "--regions-dir", join(runDir, "regions"));
  if (options?.slotReuse) args.push("--slot-reuse");
  const limits = {
    cpuSeconds: 10,
    fileBytes: 128 * 1024 * 1024,
    openFiles: 64,
    addressSpaceBytes: 1024 * 1024 * 1024
  };
  let command: ReturnType<typeof commandWithLimits>;
  try {
    command = commandWithLimits(config.runnerPath, args, limits);
  } catch (error) {
    return {
      status: "internal_error",
      result: {
        status: "internal_error",
        output: { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false },
        errors: [makeError("ENGINE_UNAVAILABLE", String(error), "execute")]
      }
    };
  }
  const execution = await runProcess(command.command, command.args, {
    cwd: runDir,
    env: safeRunEnvironment(runDir),
    timeoutMs: 5_000,
    keepOutputBytes: 65_536,
    killOutputBytes: 1_048_576,
    signal,
    ...processGroupTracking(runDir)
  });
  if (execution.cancelled || execution.timedOut || execution.outputLimit || execution.signal) {
    const status: RunResult["status"] = execution.cancelled
      ? "cancelled"
      : execution.timedOut
        ? "timeout"
        : execution.outputLimit
          ? "output_limit"
          : execution.signal === "SIGXCPU"
            ? "resource_limit"
            : "internal_error";
    const code = status === "cancelled"
      ? "CANCELLED"
      : status === "timeout"
        ? "TIMEOUT"
        : status === "output_limit"
          ? "OUTPUT_LIMIT"
          : status === "resource_limit"
            ? "RESOURCE_LIMIT"
            : "PROCESS_CRASH";
    return {
      status,
      result: {
        status,
        output: {
          stdout: execution.stdout,
          stderr: execution.stderr,
          stdoutTruncated: execution.stdoutTruncated,
          stderrTruncated: execution.stderrTruncated
        },
        errors: [makeError(code, `Custom runner ended with ${status}`, "execute")]
      }
    };
  }

  let runnerResult: Partial<RunResult>;
  try {
    runnerResult = JSON.parse(await readFile(resultPath, "utf8")) as Partial<RunResult>;
  } catch (error) {
    return {
      status: "internal_error",
      result: {
        status: "internal_error",
        output: {
          stdout: execution.stdout,
          stderr: execution.stderr,
          stdoutTruncated: execution.stdoutTruncated,
          stderrTruncated: execution.stderrTruncated
        },
        errors: [makeError("SCHEMA_VIOLATION", `Runner result is unavailable or invalid: ${String(error)}`, "controller")]
      }
    };
  }
  if (runnerResult.status === undefined || runnerResult.output === undefined || runnerResult.errors === undefined) {
    return {
      status: "internal_error",
      result: {
        status: "internal_error",
        output: {
          stdout: execution.stdout,
          stderr: execution.stderr,
          stdoutTruncated: execution.stdoutTruncated,
          stderrTruncated: execution.stderrTruncated
        },
        errors: [makeError("SCHEMA_VIOLATION", "Runner result is missing required envelope fields", "controller")]
      }
    };
  }
  try {
    runnerResult.trace = summarizeTrace(await loadTrace(tracePath));
  } catch (error) {
    runnerResult.trace = { available: true, complete: false, eventCount: 0, droppedCount: 0, batchCount: 0 };
    runnerResult.errors = [...runnerResult.errors, makeError("INTERNAL", `Trace file is unreadable: ${String(error)}`, "controller")];
  }
  return { status: runnerResult.status, result: runnerResult as CustomOutcome["result"] };
}
