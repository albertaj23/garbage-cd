import type { BenchmarkListing, BenchmarkSummary, Engine, HeapSnapshot, RegionGraph, RunRequest, RunResult, Sample, TracePage } from "@gcd/shared";

export interface ApiError {
  code: string;
  message: string;
}

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly error: ApiError) {
    super(error.message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const raw = (body as { error?: unknown } | null)?.error;
    const error: ApiError =
      typeof raw === "object" && raw !== null && "message" in raw
        ? (raw as ApiError)
        : { code: "HTTP_ERROR", message: typeof raw === "string" ? raw : `HTTP ${response.status}` };
    throw new ApiFailure(response.status, error);
  }
  return body as T;
}

const json = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload)
});

export interface CustomOptions {
  regionSize: 0 | 16 | 32 | 64 | 128 | 256;
  slotReuse: boolean;
}

export interface Health {
  status: string;
  jdk: { found: boolean; version: string; supported?: boolean };
  customRunner: { found: boolean };
  javaAnalyzer: { found: boolean };
}

export const api = {
  health: () => request<Health>("/api/health"),
  samples: () => request<{ jvm: Sample[]; custom: Sample[] }>("/api/samples"),
  startRun: (engine: Engine, source: string, custom: CustomOptions = { regionSize: 0, slotReuse: false }) => {
    const body: RunRequest = {
      schema: "gcd.run-request/1",
      engine,
      source,
      // The custom runtime is always traced and snapshotted so the heap graph and timeline have data.
      ...(engine === "custom"
        ? {
            options: {
              custom: {
                traceLevel: "mutator" as const,
                snapshots: true,
                ...(custom.regionSize !== 0 ? { regionSize: custom.regionSize } : {}),
                ...(custom.slotReuse ? { slotReuse: true } : {})
              }
            }
          }
        : {})
    };
    return request<{ runId: string }>("/api/runs", json(body));
  },
  getRun: (runId: string) => request<RunResult>(`/api/runs/${runId}`),
  trace: (runId: string, afterSeq: number, maxEvents: number) =>
    request<TracePage>(`/api/runs/${runId}/trace?afterSeq=${afterSeq}&maxEvents=${maxEvents}`),
  snapshot: (runId: string, index: number) => request<HeapSnapshot>(`/api/runs/${runId}/snapshots/${index}`),
  regions: (runId: string, gc: number | "end") => request<RegionGraph>(`/api/runs/${runId}/regions?gc=${gc}`),
  benchmarks: () => request<BenchmarkListing[]>("/api/benchmarks"),
  benchmark: (id: string) => request<BenchmarkSummary>(`/api/benchmarks/${encodeURIComponent(id)}`),
  cancel: (runId: string) => request<unknown>(`/api/runs/${runId}/cancel`, json({}))
};
