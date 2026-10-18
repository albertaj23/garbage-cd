import { readFile, stat } from "node:fs/promises";

export const TRACE_MAX_EVENTS = 50_000;
const TRACE_MAX_FILE_BYTES = 80 * 1024 * 1024;

export interface TraceSummary {
  available: boolean;
  complete: boolean;
  eventCount: number;
  droppedCount: number;
  batchCount: number;
}

interface TraceBatchLine {
  schema: string;
  batch: number;
  firstSeq: number;
  lastSeq: number;
  droppedTotal: number;
  events: unknown[];
}

interface TraceTrailer {
  type: "end";
  lastSeq: number;
  complete: boolean;
  droppedByKind?: Record<string, number>;
}

export interface ParsedTrace {
  batches: TraceBatchLine[];
  trailer: TraceTrailer | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses NDJSON trace text; throws on a malformed batch line so callers can report corruption. */
export function parseTrace(text: string): ParsedTrace {
  const batches: TraceBatchLine[] = [];
  let trailer: TraceTrailer | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) throw new Error("Trace line is not an object");
    if (value.type === "end") {
      trailer = value as unknown as TraceTrailer;
    } else if (value.schema === "gcd.trace-batch/1" && Array.isArray(value.events)) {
      batches.push(value as unknown as TraceBatchLine);
    } else {
      throw new Error("Unrecognised trace line");
    }
  }
  return { batches, trailer };
}

export async function loadTrace(path: string): Promise<ParsedTrace | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  if (size > TRACE_MAX_FILE_BYTES) throw new Error("Trace file exceeds the controller's read limit");
  return parseTrace(await readFile(path, "utf8"));
}

export function summarizeTrace(trace: ParsedTrace | null): TraceSummary {
  if (!trace) return { available: false, complete: false, eventCount: 0, droppedCount: 0, batchCount: 0 };
  const eventCount = trace.batches.reduce((total, batch) => total + batch.events.length, 0);
  const dropped = trace.trailer?.droppedByKind
    ? Object.values(trace.trailer.droppedByKind).reduce((total, value) => total + value, 0)
    : (trace.batches.at(-1)?.droppedTotal ?? 0);
  return {
    available: true,
    // A missing trailer means the runner died before finishing.
    complete: trace.trailer?.complete === true && dropped === 0,
    eventCount,
    droppedCount: dropped,
    batchCount: trace.batches.length
  };
}

export interface TracePage {
  batches: TraceBatchLine[];
  /** Pass as `afterSeq` to continue; null when no batches remain. */
  next: number | null;
  trailer: TraceTrailer | null;
}

/**
 * Whole batches with firstSeq > afterSeq, until at least `maxEvents` events are collected
 * (the first batch is always returned). Paging by batch boundaries never splits, skips or
 * repeats a sequence number.
 */
export function pageTrace(trace: ParsedTrace, afterSeq: number, maxEvents: number): TracePage {
  const batches: TraceBatchLine[] = [];
  let events = 0;
  let index = trace.batches.findIndex((batch) => batch.firstSeq > afterSeq);
  if (index < 0) index = trace.batches.length;
  for (; index < trace.batches.length; index++) {
    const batch = trace.batches[index]!;
    if (batches.length > 0 && events + batch.events.length > maxEvents) break;
    batches.push(batch);
    events += batch.events.length;
  }
  const last = batches.at(-1);
  const more = index < trace.batches.length;
  return { batches, next: last && more ? last.lastSeq : null, trailer: more ? null : trace.trailer };
}
