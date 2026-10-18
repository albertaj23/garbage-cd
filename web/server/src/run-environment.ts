import { delimiter, join } from "node:path";

export function safeRunEnvironment(runDir: string): NodeJS.ProcessEnv {
  return {
    PATH: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    LANG: "C.UTF-8",
    HOME: runDir,
    TMPDIR: join(runDir, "tmp")
  };
}
