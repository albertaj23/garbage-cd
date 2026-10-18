import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function processGroupTracking(runDir: string): {
  onSpawn: (pid: number) => void;
  onClose: () => void;
} {
  const pidFile = join(runDir, "process-group.pid");
  return {
    onSpawn: (pid) => writeFileSync(pidFile, `${pid}\n`, { encoding: "utf8", mode: 0o600 }),
    onClose: () => {
      try {
        unlinkSync(pidFile);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  };
}
