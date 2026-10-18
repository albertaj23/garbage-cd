import { defaultSpec, normalizeSpec, type BuilderSpec, type Engine, type RunResult, type Sample } from "@gcd/shared";
import type { CustomOptions } from "./api";

export interface State {
  engine: Engine;
  samples: { jvm: Sample[]; custom: Sample[] };
  sampleName: string;
  sources: Record<Engine, string>;
  runId: string | null;
  run: RunResult | null;
  requestError: string | null;
  customOptions: CustomOptions;
  /** Finished runs of this session, newest last, for the Compare tab. */
  history: RunResult[];
  /** Source of the run that is displayed, so a prediction is only compared with the code it was made for. */
  runSource: string | null;
  builder: {
    open: boolean;
    spec: BuilderSpec;
    liveSync: boolean;
    /** The text the builder last wrote into the editor; null until the first explicit generate. */
    appliedSource: string | null;
  };
}

export type Action =
  | { type: "samples"; samples: State["samples"] }
  | { type: "engine"; engine: Engine }
  | { type: "sample"; name: string }
  | { type: "edit"; source: string }
  | { type: "started"; runId: string; source: string }
  | { type: "builder"; patch: Partial<State["builder"]> }
  | { type: "builder-spec"; patch: Partial<BuilderSpec> }
  | { type: "builder-apply"; source: string }
  | { type: "progress"; run: RunResult }
  | { type: "failed"; message: string }
  | { type: "options"; options: Partial<CustomOptions> }
  | { type: "reset" };

export const initialState: State = {
  engine: "jvm",
  samples: { jvm: [], custom: [] },
  sampleName: "",
  sources: { jvm: "", custom: "" },
  runId: null,
  run: null,
  requestError: null,
  customOptions: { regionSize: 0, slotReuse: false },
  history: [],
  runSource: null,
  builder: { open: false, spec: defaultSpec(), liveSync: true, appliedSource: null }
};

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "samples": {
      const first = action.samples[state.engine][0];
      return {
        ...state,
        samples: action.samples,
        sampleName: first?.name ?? "",
        sources: {
          jvm: action.samples.jvm[0]?.source ?? "",
          custom: action.samples.custom[0]?.source ?? ""
        }
      };
    }
    case "engine": {
      const first = state.samples[action.engine][0];
      return {
        ...state,
        engine: action.engine,
        sampleName: first?.name ?? "",
        sources: { ...state.sources, [action.engine]: first?.source ?? state.sources[action.engine] },
        run: null,
        runId: null,
        requestError: null
      };
    }
    case "sample": {
      const sample = state.samples[state.engine].find((item) => item.name === action.name);
      if (!sample) return { ...state, sampleName: "" };
      return { ...state, sampleName: sample.name, sources: { ...state.sources, [state.engine]: sample.source } };
    }
    case "edit":
      if (action.source === state.sources[state.engine]) return state;
      return { ...state, sampleName: "", sources: { ...state.sources, [state.engine]: action.source } };
    case "started":
      return { ...state, runId: action.runId, run: null, requestError: null, runSource: action.source };
    case "builder":
      return { ...state, builder: { ...state.builder, ...action.patch } };
    case "builder-spec":
      return { ...state, builder: { ...state.builder, spec: normalizeSpec({ ...state.builder.spec, ...action.patch }) } };
    case "builder-apply":
      return {
        ...state,
        sampleName: "",
        sources: { ...state.sources, custom: action.source },
        builder: { ...state.builder, appliedSource: action.source }
      };
    case "progress": {
      if (action.run.runId !== state.runId) return state;
      const finished = action.run.status !== "running" && action.run.status !== "queued";
      const history =
        finished && !state.history.some((item) => item.runId === action.run.runId)
          ? [...state.history, action.run].slice(-10)
          : state.history;
      return { ...state, run: action.run, history };
    }
    case "failed":
      return { ...state, requestError: action.message };
    case "options":
      return { ...state, customOptions: { ...state.customOptions, ...action.options } };
    case "reset":
      return { ...state, run: null, runId: null, requestError: null };
  }
}

export const isActive = (run: RunResult | null, runId: string | null): boolean =>
  runId !== null && (run === null || run.status === "running" || run.status === "queued");
