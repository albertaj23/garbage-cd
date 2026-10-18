import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export interface Config {
  root: string;
  runRoot: string;
  host: "127.0.0.1";
  port: number;
  sourceBytes: number;
  outputBytes: number;
  runTimeoutMs: number;
  analysisTimeoutMs: number;
  clientDist: string;
  benchmarkRoot: string;
  runnerPath: string;
  javaPath: string;
  javaJarPath: string;
  gitCommit: string;
  jdkVersion: string;
  jdkVendor: string;
}

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const runnerCandidates = [
  resolve(root, "build/gcd_runner"),
  resolve(root, "build-rel/gcd_runner"),
  resolve(root, "build-asan/gcd_runner")
];
const javaCandidates = [
  process.env.JAVA,
  process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : undefined,
  join(homedir(), ".jdk", "temurin-21", "bin", "java"),
  "/usr/bin/java",
  "/opt/homebrew/bin/java",
  ...(process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "java"))
].filter((candidate): candidate is string => candidate !== undefined);
const javaPath = javaCandidates.find((candidate) => {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}) ?? "java";

export const config: Config = {
  root,
  // One run directory per controller port, so two controllers never sweep each other's runs.
  runRoot: process.env.GCD_RUN_ROOT ? resolve(process.env.GCD_RUN_ROOT) : resolve(tmpdir(), `gcd-runs-${Number(process.env.GCD_PORT ?? 4177)}`),
  host: "127.0.0.1",
  port: Number(process.env.GCD_PORT ?? 4177),
  sourceBytes: 65_536,
  outputBytes: 1_048_576,
  runTimeoutMs: 30_000,
  analysisTimeoutMs: 15_000,
  clientDist: resolve(root, "web/client/dist"),
  benchmarkRoot: resolve(root, "bench/results"),
  runnerPath: process.env.GCD_RUNNER ?? runnerCandidates.find(existsSync) ?? runnerCandidates[0]!,
  javaPath: isAbsolute(javaPath) ? javaPath : "java",
  javaJarPath: resolve(root, "build/java/gcd-java-tools.jar"),
  gitCommit: process.env.GCD_GIT_COMMIT ?? "unknown",
  jdkVersion: "unknown",
  jdkVendor: "unknown"
};
