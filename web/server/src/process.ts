import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  outputLimit: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  keepOutputBytes: number;
  killOutputBytes: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  onClose?: () => void;
}

export interface ResourceLimits {
  cpuSeconds: number;
  fileBytes: number;
  openFiles: number;
  addressSpaceBytes?: number;
}

export function commandWithLimits(
  command: string,
  args: string[],
  limits: ResourceLimits
): { command: string; args: string[]; applied: boolean } {
  if (process.platform !== "linux") {
    return { command, args, applied: false };
  }
  const prlimit = ["/usr/bin/prlimit", "/bin/prlimit"].find(existsSync);
  if (!prlimit) throw new Error("Linux execution requires util-linux prlimit");
  const options = [
    `--cpu=${limits.cpuSeconds}`,
    `--fsize=${limits.fileBytes}`,
    `--nofile=${limits.openFiles}`
  ];
  if (limits.addressSpaceBytes !== undefined) {
    options.push(`--as=${limits.addressSpaceBytes}`);
  }
  return { command: prlimit, args: [...options, "--", command, ...args], applied: true };
}

export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (child.pid !== undefined && options.onSpawn) {
      try {
        options.onSpawn(child.pid);
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
        return;
      }
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let outputLimit = false;
    let timedOut = false;
    let cancelled = false;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
          reject(error);
        }
      }
    };
    const stop = (): void => {
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 500);
      killTimer.unref();
    };
    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const room = Math.max(0, options.keepOutputBytes - current.length);
      return room === 0 ? current : Buffer.concat([current, chunk.subarray(0, room)]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout = append(stdout, chunk);
      stdoutTruncated ||= stdoutBytes > options.keepOutputBytes;
      if (stdoutBytes > options.killOutputBytes && !outputLimit) {
        outputLimit = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr = append(stderr, chunk);
      stderrTruncated ||= stderrBytes > options.keepOutputBytes;
      if (stderrBytes > options.killOutputBytes && !outputLimit) {
        outputLimit = true;
        stop();
      }
    });
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timeoutTimer.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        options.onClose?.();
      } catch (closeError) {
        reject(new AggregateError([error, closeError], "Process failed and cleanup failed"));
        return;
      }
      reject(error);
    });
    // Anything the program left running in its process group (for example a child it started and
    // did not wait for) must not outlive the run. This is a no-op when the group is empty.
    child.once("exit", () => signalGroup("SIGKILL"));
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        options.onClose?.();
      } catch (error) {
        reject(error);
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        outputLimit,
        cancelled,
        durationMs: performance.now() - started
      });
    });
  });
}
