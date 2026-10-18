import { REGION_SIZES, type Engine, type RunStatus, type Sample } from "@gcd/shared";
import type { CustomOptions } from "../api";

const banner: Record<Engine, string> = {
  jvm: "Standard JVM — Java 21 — runs on HotSpot's own heap",
  custom: "Custom runtime — toy language — runs on the course mark-sweep heap"
};

export function statusLabel(status: RunStatus | "idle"): string {
  return status.replace("_", " ");
}

export function TopBar({
  engine,
  samples,
  sampleName,
  status,
  runId,
  customOptions,
  onOptions,
  onEngine,
  onSample,
  onRun,
  onStop,
  onReset
}: {
  engine: Engine;
  samples: Sample[];
  sampleName: string;
  status: RunStatus | "idle";
  runId: string | null;
  customOptions: CustomOptions;
  onOptions: (options: Partial<CustomOptions>) => void;
  onEngine: (engine: Engine) => void;
  onSample: (name: string) => void;
  onRun: () => void;
  onStop: () => void;
  onReset: () => void;
}) {
  const active = status === "running" || status === "queued";
  return (
    <header className="topbar">
      <strong className="brand">garbage-cd</strong>
      <label>
        Engine{" "}
        <select aria-label="Engine" value={engine} disabled={active} onChange={(e) => onEngine(e.target.value as Engine)}>
          <option value="jvm">Standard JVM</option>
          <option value="custom">Custom runtime</option>
        </select>
      </label>
      <label>
        Sample{" "}
        <select aria-label="Sample" value={sampleName} disabled={active} onChange={(e) => onSample(e.target.value)}>
          <option value="">(custom)</option>
          {samples.map((sample) => (
            <option key={sample.name} value={sample.name}>
              {sample.name}
            </option>
          ))}
        </select>
      </label>
      {engine === "custom" ? (
        <>
          <label title="Observational region metadata: address blocks of this many slots. 0 disables.">
            Regions{" "}
            <select
              aria-label="Regions"
              value={customOptions.regionSize}
              disabled={active}
              onChange={(e) => onOptions({ regionSize: Number(e.target.value) as CustomOptions["regionSize"] })}
            >
              {REGION_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size === 0 ? "off" : `${size} slots`}
                </option>
              ))}
            </select>
          </label>
          <label title="Reuse freed slots with generation-checked handles">
            <input
              type="checkbox"
              aria-label="Slot reuse"
              checked={customOptions.slotReuse}
              disabled={active}
              onChange={(e) => onOptions({ slotReuse: e.target.checked })}
            />{" "}
            Slot reuse
          </label>
        </>
      ) : null}
      <button className="primary" disabled={active} onClick={onRun}>
        ▶ Run
      </button>
      <button disabled={!active} onClick={onStop}>
        ■ Stop
      </button>
      <button disabled={active} onClick={onReset}>
        ↺ Reset
      </button>
      <span className={`status status-${status}`} role="status">
        ● {statusLabel(status)}
        {runId ? <code> · {runId}</code> : null}
      </span>
      <div className="engine-banner" role="note">
        {banner[engine]}
      </div>
    </header>
  );
}
