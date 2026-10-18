import {
  fuzzScenarios,
  LAB_VARIANTS,
  PRESET_SCENARIOS,
  type LabVariant,
  type Scenario
} from "@gcd/shared";
import { useRef, useState } from "react";
import { outcomePassed, runLabCase, type LabOutcome } from "../lib/lab-runner";

export function TestLab({ busy }: { busy: boolean }) {
  const [presets, setPresets] = useState<Set<string>>(new Set(PRESET_SCENARIOS.map((item) => item.id)));
  const [variants, setVariants] = useState<Set<string>>(new Set(LAB_VARIANTS.map((item) => item.id)));
  const [fuzz, setFuzz] = useState(10);
  const [fuzzSeed, setFuzzSeed] = useState(1);
  const [outcomes, setOutcomes] = useState<LabOutcome[]>([]);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const signal = useRef({ cancelled: false });

  const toggle = (set: Set<string>, id: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const start = async () => {
    const scenarios: Scenario[] = [
      ...PRESET_SCENARIOS.filter((item) => presets.has(item.id)),
      ...fuzzScenarios(Math.max(0, Math.min(200, fuzz)), fuzzSeed)
    ];
    const chosen: LabVariant[] = LAB_VARIANTS.filter((item) => variants.has(item.id));
    signal.current = { cancelled: false };
    setOutcomes([]);
    setTotal(scenarios.length * chosen.length);
    setRunning(true);
    for (const scenario of scenarios) {
      for (const variant of chosen) {
        if (signal.current.cancelled) break;
        const outcome = await runLabCase(scenario, variant, signal.current);
        setOutcomes((previous) => [...previous, outcome]);
        // A busy controller (someone started a run) invalidates the rest of the matrix.
        if (outcome.error?.includes("BUSY")) signal.current.cancelled = true;
      }
    }
    setRunning(false);
  };

  const passed = outcomes.filter(outcomePassed).length;
  const failed = outcomes.length - passed;
  return (
    <div className="lab">
      <p className="muted">
        Each scenario is generated from the builder, run on the custom runtime under each heap variant, and checked against the outcome the builder predicted by plain reachability: allocations, objects freed and live after every collection, the program-end snapshot and, with regions, the region counters. Any disagreement is a bug in the collector, the instrumentation or the builder.
      </p>
      <div className="lab-config">
        <fieldset>
          <legend>Scenarios</legend>
          {PRESET_SCENARIOS.map((item) => (
            <label key={item.id} className="check">
              <input type="checkbox" checked={presets.has(item.id)} disabled={running} onChange={() => toggle(presets, item.id, setPresets)} /> {item.title}
            </label>
          ))}
          <label className="check">
            Random scenarios{" "}
            <input type="number" aria-label="Fuzz count" min={0} max={200} value={fuzz} disabled={running} onChange={(event) => setFuzz(Number(event.target.value))} /> seed{" "}
            <input type="number" aria-label="Fuzz seed" min={0} value={fuzzSeed} disabled={running} onChange={(event) => setFuzzSeed(Number(event.target.value))} />
          </label>
        </fieldset>
        <fieldset>
          <legend>Heap variants</legend>
          {LAB_VARIANTS.map((item) => (
            <label key={item.id} className="check">
              <input type="checkbox" checked={variants.has(item.id)} disabled={running} onChange={() => toggle(variants, item.id, setVariants)} /> {item.title}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="builder-actions">
        <button className="primary" disabled={running || busy || variants.size === 0} onClick={() => void start()}>
          ▶ Run the lab
        </button>
        <button disabled={!running} onClick={() => (signal.current.cancelled = true)}>
          ■ Stop
        </button>
        {busy ? <span className="muted">A run is active; wait for it to finish.</span> : null}
        <span role="status">
          {outcomes.length} / {total} cases · <span className="pass">{passed} passed</span> · <span className={failed ? "fail" : "muted"}>{failed} failed</span>
          {running ? " · running…" : ""}
        </span>
      </div>
      {outcomes.length > 0 ? (
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Variant</th>
                <th>Objects</th>
                <th>Checks</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((outcome) => {
                const key = `${outcome.scenario.id}/${outcome.variant.id}`;
                const ok = outcomePassed(outcome);
                const bad = outcome.checks.filter((item) => !item.ok);
                return (
                  <tr key={key} className={ok ? "" : "failed-row"}>
                    <td className="left">{outcome.scenario.title}</td>
                    <td className="left">{outcome.variant.id}</td>
                    <td>{outcome.objects}</td>
                    <td>{outcome.checks.length}</td>
                    <td className="left">
                      {ok ? (
                        <span className="pass">✔ pass</span>
                      ) : (
                        <>
                          <button className="link" onClick={() => setOpen(open === key ? null : key)}>
                            ✖ fail ({outcome.error ? "error" : `${bad.length} checks`})
                          </button>
                          {open === key ? (
                            <ul>
                              {outcome.error ? <li>{outcome.error}</li> : null}
                              {bad.map((item) => (
                                <li key={item.name}>
                                  {item.name}: {item.detail}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
