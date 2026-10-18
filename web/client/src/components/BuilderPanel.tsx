import {
  BUILDER_LIMITS,
  checkRun,
  parseRange,
  PRESET_SCENARIOS,
  toCliArgs,
  type BuilderSpec,
  type Generated,
  type RunResult
} from "@gcd/shared";
import { useState } from "react";

function RangeInput({ label, value, onChange, hint }: { label: string; value: [number, number]; onChange: (range: [number, number]) => void; hint?: string }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? `${value[0]}-${value[1]}`;
  const invalid = text !== null && parseRange(text) === null;
  return (
    <label className="field" title={hint}>
      {label}
      <input
        aria-label={label}
        value={shown}
        aria-invalid={invalid}
        className={invalid ? "invalid" : ""}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = parseRange(event.target.value);
          if (parsed) onChange(parsed);
        }}
        onBlur={() => setText(null)}
      />
    </label>
  );
}

function NumberField({ label, value, min, max, onChange, hint }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; hint?: string }) {
  return (
    <label className="field" title={hint}>
      {label}
      <input
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function verification(generated: Generated, run: RunResult | null, runSource: string | null) {
  if (!run || run.status === "running" || run.status === "queued") return null;
  if (runSource !== generated.source) return { state: "stale" as const, checks: [] };
  const checks = checkRun(generated, run);
  return { state: checks.every((item) => item.ok) ? ("pass" as const) : ("fail" as const), checks };
}

export function BuilderPanel({
  spec,
  generated,
  liveSync,
  diverged,
  applied,
  run,
  runSource,
  onSpec,
  onApply,
  onLiveSync
}: {
  spec: BuilderSpec;
  generated: Generated;
  liveSync: boolean;
  diverged: boolean;
  applied: boolean;
  run: RunResult | null;
  runSource: string | null;
  onSpec: (patch: Partial<BuilderSpec>) => void;
  onApply: () => void;
  onLiveSync: (value: boolean) => void;
}) {
  const { stats } = generated;
  const verdict = verification(generated, run, runSource);
  const cli = `node web/scripts/gen-toy.mjs ${toCliArgs(spec)}`;
  const percent = Math.min(100, Math.round((stats.bytes / BUILDER_LIMITS.maxSourceBytes) * 100));
  return (
    <section className="builder" aria-label="Object builder">
      <div className="builder-grid">
        <div className="field wide">
          <span>Objects</span>
          <div className="stepper">
            <button aria-label="Fewer objects" onClick={() => onSpec({ objects: Math.max(1, spec.objects - (spec.objects > 100 ? 50 : 10)) })}>−</button>
            <input
              type="number"
              aria-label="Objects"
              min={1}
              max={BUILDER_LIMITS.maxObjects}
              value={spec.objects}
              onChange={(event) => onSpec({ objects: Number(event.target.value) })}
            />
            <button aria-label="More objects" onClick={() => onSpec({ objects: spec.objects + (spec.objects >= 100 ? 50 : 10) })}>+</button>
            <input type="range" aria-label="Objects slider" min={1} max={1500} value={Math.min(spec.objects, 1500)} onChange={(event) => onSpec({ objects: Number(event.target.value) })} />
          </div>
        </div>
        <label className="field wide">
          <span>
            Cycles vs chains: {spec.cycleShare}% cycles / {100 - spec.cycleShare}% chains
          </span>
          <input type="range" aria-label="Cycle share" min={0} max={100} value={spec.cycleShare} onChange={(event) => onSpec({ cycleShare: Number(event.target.value) })} />
        </label>
        <RangeInput label="Chain length" value={spec.chainLength} onChange={(range) => onSpec({ chainLength: range })} hint="Objects per chain, e.g. 3-8" />
        <RangeInput label="Cycle length" value={spec.cycleLength} onChange={(range) => onSpec({ cycleLength: range })} hint="Objects per cycle (at least 2), e.g. 2-5" />
        <RangeInput label="Extra links per object" value={spec.extraLinks} onChange={(range) => onSpec({ extraLinks: range })} hint={`Additional references from each object, e.g. 0-2 (max ${BUILDER_LIMITS.maxExtraLinks})`} />
        <NumberField label="Locality window" value={spec.locality} min={0} max={BUILDER_LIMITS.maxLocality} onChange={(value) => onSpec({ locality: value })} hint="0 = extra links may point anywhere; otherwise at most this many objects away" />
        <label className="field wide">
          <span>Keep {spec.keepRoots}% of groups rooted</span>
          <input type="range" aria-label="Kept roots" min={0} max={100} value={spec.keepRoots} onChange={(event) => onSpec({ keepRoots: Number(event.target.value) })} />
        </label>
        <NumberField label="Unroot rounds" value={spec.rounds} min={1} max={BUILDER_LIMITS.maxRounds} onChange={(value) => onSpec({ rounds: value })} hint="Dropped groups are unrooted over this many rounds, each followed by gc()" />
        <NumberField label="Seed" value={spec.seed} min={0} max={2147483647} onChange={(value) => onSpec({ seed: value })} />
        <label className="check">
          <input type="checkbox" aria-label="Collect while rooted" checked={spec.collectFirst} onChange={(event) => onSpec({ collectFirst: event.target.checked })} /> gc() while everything is rooted
        </label>
        <button onClick={() => onSpec({ seed: Math.floor(Math.random() * 1_000_000) })}>Reshuffle</button>
        <label className="field">
          Preset
          <select
            aria-label="Preset"
            value=""
            onChange={(event) => {
              const preset = PRESET_SCENARIOS.find((item) => item.id === event.target.value);
              if (preset) onSpec(preset.spec);
            }}
          >
            <option value="">Load…</option>
            {PRESET_SCENARIOS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="builder-summary" aria-live="polite">
        <strong>{stats.objects}</strong> objects in <strong>{stats.groups}</strong> groups ({stats.chains} chains, {stats.cycles} cycles), <strong>{stats.edges}</strong> references, {stats.statements} statements.{" "}
        <meter min={0} max={BUILDER_LIMITS.maxSourceBytes} value={Math.min(stats.bytes, BUILDER_LIMITS.maxSourceBytes)} aria-label="Source size" />{" "}
        <span className={stats.fits ? "muted" : "over"}>
          {stats.bytes.toLocaleString()} / {BUILDER_LIMITS.maxSourceBytes.toLocaleString()} bytes ({percent}%)
        </span>
      </p>
      {!stats.fits ? (
        <p className="banner" role="alert">
          This program is larger than the 64 KiB source limit and cannot be run. Reduce the objects or extra links.
        </p>
      ) : null}
      <p className="muted">
        Predicted: {generated.expected.collections.map((item, index) => `gc ${index + 1} frees ${item.freed}, ${item.liveAfter} live`).join(" · ")}. Final: {generated.expected.liveFinal} live, {generated.expected.freedTotal} freed.
      </p>

      <div className="builder-actions">
        <button className="primary" onClick={onApply}>
          {applied ? "Regenerate into editor" : "Generate into editor"}
        </button>
        <label className="check">
          <input type="checkbox" aria-label="Live sync" checked={liveSync} onChange={(event) => onLiveSync(event.target.checked)} /> Live sync
        </label>
        {diverged ? (
          <span className="banner inline" role="status">
            The code was edited by hand, so the builder no longer overwrites it. Regenerate to discard those edits.
          </span>
        ) : null}
      </div>
      <p className="muted">
        The same program from the command line:{" "}
        <code className="cli" title="Prints the generated program to stdout; pipe it to a file and run it with gcd_runner or paste it into the editor">
          {cli}
        </code>
      </p>

      {verdict?.state === "pass" ? (
        <p className="verify pass" role="status">
          ✔ The run matches the prediction ({verdict.checks.length} checks).
        </p>
      ) : null}
      {verdict?.state === "fail" ? (
        <div className="verify fail" role="alert">
          ✖ The run differs from the prediction:
          <ul>
            {verdict.checks
              .filter((item) => !item.ok)
              .map((item) => (
                <li key={item.name}>
                  {item.name}: {item.detail}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {verdict?.state === "stale" ? <p className="muted">The last run used different code; run again to compare it with this prediction.</p> : null}
    </section>
  );
}
