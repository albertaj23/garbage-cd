import { defineConfig } from "vitest/config";

// Test files share one machine-wide process-orphan check, so run them one at a time.
export default defineConfig({ test: { fileParallelism: false } });
