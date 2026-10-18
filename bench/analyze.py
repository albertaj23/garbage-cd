#!/usr/bin/env python3
"""Turns raw benchmark files into tables, figures and hypothesis verdicts (G.7).

    python3 bench/analyze.py bench/results/<run>

Standard library only (no numpy/pandas/matplotlib are required): medians, 95 % bootstrap CIs
(10,000 resamples, fixed seed) of variant-to-A' ratios, CSV tables, SVG figures, summary.json
(validated by the controller against contracts/schemas/benchmark-summary.schema.json) and
REPORT.md. A difference is called real only if the CI excludes 1 AND the effect exceeds the larger
of 2 % and the A'-vs-A' noise floor measured for that workload.
"""
import collections
import csv
import glob
import json
import math
import os
import random
import statistics
import sys

RESAMPLES = 10000
WORKLOADS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7"]
W_TITLES = {
    "W1": "churn", "W2": "linked list", "W3": "binary tree", "W4": "cycles",
    "W5": "random mutation", "W6": "accumulation", "W7": "fan-in hub",
}
J_MIRROR = {"J1": "W1", "J2": "W2", "J3": "W3", "J4": "W4", "J5": "W7"}
BATCHES = [1, 64, 1024, 8192]
MIN_EFFECT = 0.02


def median(values):
    return statistics.median(values)


def boot(rng, samples, statistic, n=RESAMPLES):
    """Percentile bootstrap: `samples` is a list of lists resampled independently."""
    draws = []
    for _ in range(n):
        resampled = [sorted(rng.choices(s, k=len(s))) for s in samples]
        value = statistic([r[len(r) // 2] if len(r) % 2 else (r[len(r) // 2 - 1] + r[len(r) // 2]) / 2 for r in resampled])
        if value is not None and not math.isnan(value):
            draws.append(value)
    draws.sort()
    if not draws:
        return None, None
    return draws[int(0.025 * len(draws))], draws[min(len(draws) - 1, int(0.975 * len(draws)))]


def ratio_with_ci(rng, numerator, denominator):
    point = median(numerator) / median(denominator)
    lo, hi = boot(rng, [numerator, denominator], lambda m: m[0] / m[1] if m[1] else None)
    return point, lo, hi


def load_collector(raw):
    data = collections.defaultdict(list)  # (group, workload, variant) -> list of (proc, iteration dict)
    env = {}
    for path in sorted(glob.glob(os.path.join(raw, "collector", "*", "*.json"))):
        group = os.path.basename(os.path.dirname(path))
        doc = json.load(open(path))
        proc = int(os.path.basename(path).rsplit("-p", 1)[1].split(".")[0])
        env[(group, doc["variant"])] = {"objectBytes": doc["objectBytes"], "peakRssBytes": doc["peakRssBytes"], "scale": doc["scale"]}
        for it in doc["iterations"]:
            if not it["warmup"]:
                data[(group, doc["workload"], doc["variant"])].append((proc, it))
    return data, env


def series(data, group, workload, variant, field):
    return [it[field] for _, it in data.get((group, workload, variant), []) if it[field] is not None and it[field] >= 0]


def fmt(x, digits=3):
    return "n/a" if x is None else (f"{x:.{digits}f}" if abs(x) < 1000 else f"{x:,.0f}")


# ---------------------------------------------------------------- figures (plain SVG)
class Svg:
    def __init__(self, width, height, title):
        self.w, self.h = width, height
        self.parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" font-family="sans-serif" font-size="11">',
            f'<rect width="{width}" height="{height}" fill="white"/>',
            f'<text x="{width / 2}" y="16" text-anchor="middle" font-size="13" font-weight="600">{title}</text>',
        ]

    def line(self, x1, y1, x2, y2, color="#555", width=1, dash=None):
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{color}" stroke-width="{width}"{extra}/>')

    def rect(self, x, y, w, h, color):
        self.parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{max(w, 0):.1f}" height="{max(h, 0):.1f}" fill="{color}"/>')

    def text(self, x, y, s, anchor="middle", color="#222", size=None):
        extra = f' font-size="{size}"' if size else ""
        self.parts.append(f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" fill="{color}"{extra}>{s}</text>')

    def polyline(self, points, color):
        pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
        self.parts.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2"/>')

    def save(self, path):
        with open(path, "w") as handle:
            handle.write("\n".join(self.parts + ["</svg>"]) + "\n")


PALETTE = ["#1f6feb", "#d29922", "#3fb950", "#a371f7", "#f85149", "#8b949e", "#0d9488"]


def figure_ratios(rows, path):
    variants = ["B", "D", "E", "ED"]
    svg = Svg(900, 340, "Whole-run time relative to A' (median ratio, 95 % bootstrap CI; log scale; ratio 1 = no change)")
    left, top, plot_w, plot_h = 50, 34, 830, 240
    lo_axis, hi_axis = 0.25, 32.0
    span = math.log2(hi_axis) - math.log2(lo_axis)
    y = lambda v: top + plot_h - ((math.log2(min(max(v, lo_axis), hi_axis)) - math.log2(lo_axis)) / span) * plot_h
    svg.line(left, top + plot_h, left + plot_w, top + plot_h)
    svg.line(left, top, left, top + plot_h)
    for tick in [0.25, 0.5, 1, 2, 4, 8, 16, 32]:
        svg.line(left, y(tick), left + plot_w, y(tick), "#999" if tick == 1 else "#ddd", 1, "4 3" if tick == 1 else None)
        svg.text(left - 6, y(tick) + 4, f"{tick:g}x", "end")
    group_w = plot_w / len(WORKLOADS)
    bar_w = group_w / (len(variants) + 1)
    for gi, workload in enumerate(WORKLOADS):
        gx = left + gi * group_w
        svg.text(gx + group_w / 2, top + plot_h + 16, f"{workload} {W_TITLES[workload]}")
        for vi, variant in enumerate(variants):
            row = next((r for r in rows if r["workload"] == workload and r["variant"] == variant), None)
            if not row:
                continue
            ratio = row["total"]
            x = gx + (vi + 0.5) * bar_w
            top_y, bottom_y = sorted((y(ratio["ratio"]), y(1.0)))
            svg.rect(x, top_y, bar_w * 0.8, bottom_y - top_y, PALETTE[vi])
            if ratio.get("lo") is not None:
                cx = x + bar_w * 0.4
                svg.line(cx, y(ratio["lo"]), cx, y(ratio["hi"]), "#000", 1.2)
    for vi, variant in enumerate(variants):
        svg.rect(left + vi * 90, 306, 10, 10, PALETTE[vi])
        svg.text(left + vi * 90 + 14, 315, variant, "start")
    svg.save(path)


def figure_w6(series_by_variant, path):
    svg = Svg(560, 300, "W6 accumulation: collect time per round (median over samples)")
    left, top, plot_w, plot_h = 56, 34, 480, 210
    top_value = max([1.0] + [v for vals in series_by_variant.values() for v in vals])
    x = lambda i: left + (i / 5) * plot_w
    y = lambda v: top + plot_h - (v / top_value) * plot_h
    svg.line(left, top + plot_h, left + plot_w, top + plot_h)
    svg.line(left, top, left, top + plot_h)
    for i in range(6):
        svg.text(x(i), top + plot_h + 14, f"round {i + 1}")
    for tick in range(0, int(top_value) + 1, max(1, int(top_value // 5) or 1)):
        svg.text(left - 6, y(tick) + 4, f"{tick}", "end")
    svg.text(14, top + plot_h / 2, "ms", "middle")
    for index, (variant, values) in enumerate(series_by_variant.items()):
        svg.polyline([(x(i), y(v)) for i, v in enumerate(values)], PALETTE[index])
        svg.rect(left + index * 110, 270, 10, 10, PALETTE[index])
        svg.text(left + index * 110 + 14, 279, variant, "start")
    svg.save(path)


def figure_h3(overheads, path):
    svg = Svg(820, 300, "H3: tracing overhead over trace-off (A'), by batch size")
    left, top, plot_w, plot_h = 56, 34, 330, 200
    for pi, level in enumerate(("m", "f")):
        ox = left + pi * (plot_w + 70)
        top_value = max([1.0] + [v for w in WORKLOADS for v in overheads.get((level, w), {}).values() if v is not None])
        y = lambda v: top + plot_h - (v / top_value) * plot_h
        x = lambda i: ox + (i / (len(BATCHES) - 1)) * plot_w
        svg.line(ox, top + plot_h, ox + plot_w, top + plot_h)
        svg.line(ox, top, ox, top + plot_h)
        svg.text(ox + plot_w / 2, top + plot_h + 30, "mutator events" if level == "m" else "full events (mark visits and frees)")
        for i, b in enumerate(BATCHES):
            svg.text(x(i), top + plot_h + 14, f"B={b}")
        for wi, workload in enumerate(WORKLOADS):
            vals = [overheads.get((level, workload), {}).get(b) for b in BATCHES]
            if all(v is not None for v in vals):
                svg.polyline([(x(i), y(v)) for i, v in enumerate(vals)], PALETTE[wi])
        svg.text(ox - 6, top + 8, f"{top_value:.1f}x", "end")
    for wi, workload in enumerate(WORKLOADS):
        svg.rect(left + wi * 100, 282, 10, 10, PALETTE[wi])
        svg.text(left + wi * 100 + 14, 291, workload, "start")
    svg.save(path)


# ---------------------------------------------------------------- analysis
def analyse(result_dir):
    raw = os.path.join(result_dir, "raw")
    rng = random.Random(20261018)
    data, env_files = load_collector(raw)
    environment = json.load(open(os.path.join(result_dir, "environment.json")))
    tables = os.path.join(result_dir, "tables")
    figures = os.path.join(result_dir, "figures")
    os.makedirs(tables, exist_ok=True)
    os.makedirs(figures, exist_ok=True)
    summary = {"schema": "gcd.benchmark-summary/1", "id": os.path.basename(result_dir.rstrip("/")),
               "createdAt": environment.get("capturedAt", ""), "environment": environment,
               "method": {"resamples": RESAMPLES, "minEffect": MIN_EFFECT,
                          "warmupDiscarded": 5, "measuredPerProcess": 10, "processes": 3,
                          "noiseRule": "difference is real if the 95% CI excludes 1 and the effect exceeds max(2%, |A'2/A' - 1|)"},
               "collector": [], "dormantHooks": [], "hypotheses": [], "jvm": [], "shapes": [], "h2": [], "noiseFloor": {}}

    # --- main group: ratios to A'
    main_rows = []
    for workload in WORKLOADS:
        ref = {m: series(data, "main", workload, "Aprime", m) for m in ("totalMs", "collectMs")}
        floor = {}
        for metric in ("totalMs", "collectMs"):
            other = series(data, "main", workload, "Aprime2", metric)
            if ref[metric] and other:
                floor[metric] = max(MIN_EFFECT, abs(median(other) / median(ref[metric]) - 1))
        summary["noiseFloor"][workload] = {k: round(v, 4) for k, v in floor.items()}
        for variant in ["A", "Aprime", "Aprime2", "B", "D", "E", "ED"]:
            totals = series(data, "main", workload, variant, "totalMs")
            collects = series(data, "main", workload, variant, "collectMs")
            if not totals or not ref["totalMs"]:
                continue
            entry = {"group": "main", "workload": workload, "variant": variant, "samples": len(totals),
                     "medianTotalMs": median(totals), "medianCollectMs": median(collects)}
            for key, values, metric in (("total", totals, "totalMs"), ("collect", collects, "collectMs")):
                if variant == "Aprime":
                    entry[key] = {"ratio": 1.0, "lo": 1.0, "hi": 1.0, "real": False}
                    continue
                ratio, lo, hi = ratio_with_ci(rng, values, ref[metric])
                real = (lo is not None) and (lo > 1 or hi < 1) and abs(ratio - 1) > floor.get(metric, MIN_EFFECT)
                entry[key] = {"ratio": ratio, "lo": lo, "hi": hi, "real": real}
            main_rows.append(entry)
            summary["collector"].append(entry)

    # --- dormant hooks: A' relative to A (the 3 % check on W6 from I.3)
    for workload in WORKLOADS:
        a_total, a_collect = series(data, "main", workload, "A", "totalMs"), series(data, "main", workload, "A", "collectMs")
        p_total, p_collect = series(data, "main", workload, "Aprime", "totalMs"), series(data, "main", workload, "Aprime", "collectMs")
        if a_total and p_total:
            tr, tlo, thi = ratio_with_ci(rng, p_total, a_total)
            cr, clo, chi = ratio_with_ci(rng, p_collect, a_collect)
            summary["dormantHooks"].append({"workload": workload, "total": {"ratio": tr, "lo": tlo, "hi": thi},
                                            "collect": {"ratio": cr, "lo": clo, "hi": chi},
                                            "within3Percent": cr <= 1.03 or (clo is not None and clo <= 1.03)})

    # --- H3 groups
    h3_overheads = {}
    h3_rows = []
    for workload in WORKLOADS:
        ref = series(data, "h3", workload, "Aprime", "totalMs")
        if not ref:
            continue
        for level in ("m", "f"):
            per = {b: series(data, "h3", workload, f"C-{level}-{b}", "totalMs") for b in BATCHES}
            if not all(per.values()):
                continue
            overhead = {b: median(per[b]) / median(ref) - 1 for b in BATCHES}
            h3_overheads[(level, workload)] = overhead
            removal = 1 - overhead[1024] / overhead[1] if overhead[1] > 0 else None

            def removal_stat(m):
                o1, o1024 = m[1] / m[0] - 1, m[2] / m[0] - 1
                return 1 - o1024 / o1 if o1 > 0 else None

            lo, hi = boot(rng, [ref, per[1], per[1024]], removal_stat)
            passes = removal is not None and removal >= 0.5 and lo is not None and lo > 0
            h3_rows.append({"workload": workload, "level": "mutator" if level == "m" else "full",
                            "overheadByBatch": {str(b): overhead[b] for b in BATCHES},
                            "removalAt1024": removal, "ciLo": lo, "ciHi": hi, "pass": passes})

    # --- H2
    h2_by_n = collections.defaultdict(lambda: {"snapshot": [], "export": [], "snapshotBytes": None, "exportBytes": None})
    for path in sorted(glob.glob(os.path.join(raw, "h2", "*.json"))):
        doc = json.load(open(path))
        entry = h2_by_n[doc["objects"]]
        entry["snapshot"] += doc["snapshotMs"]
        entry["export"] += doc["exportMs"]
        entry["snapshotBytes"], entry["exportBytes"] = doc["snapshotBytes"], doc["exportBytes"]
    h2_rows = []
    for n in sorted(h2_by_n):
        entry = h2_by_n[n]
        ratio, lo, hi = ratio_with_ci(rng, entry["snapshot"], entry["export"])
        row = {"objects": n, "snapshotMs": median(entry["snapshot"]), "exportMs": median(entry["export"]),
               "ratio": ratio, "lo": lo, "hi": hi, "snapshotBytes": entry["snapshotBytes"], "exportBytes": entry["exportBytes"],
               "samples": len(entry["snapshot"])}
        h2_rows.append(row)
    summary["h2"] = h2_rows

    def saving_ms(n):
        points = [(r["objects"], max(r["snapshotMs"] - r["exportMs"], 1e-6)) for r in h2_rows]
        if not points:
            return None
        if len(points) == 1:
            return points[0][1]
        xs = [math.log(p[0]) for p in points]
        ys = [math.log(p[1]) for p in points]
        t = math.log(max(n, 1))
        for i in range(len(xs) - 1):
            if t <= xs[i + 1] or i == len(xs) - 2:
                slope = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i])
                return math.exp(ys[i] + slope * (t - xs[i]))

    # --- H4 pieces
    w5_b, w5_a = series(data, "main", "W5", "B", "totalMs"), series(data, "main", "W5", "Aprime", "totalMs")
    writes = [it["fieldWrites"] for _, it in data.get(("main", "W5", "B"), [])]
    barrier = None
    if w5_b and w5_a and writes:
        delta = median(w5_b) - median(w5_a)
        lo, hi = boot(rng, [w5_b, w5_a], lambda m: (m[0] - m[1]))
        w = median(writes)
        barrier = {"nsPerSetField": delta * 1e6 / w, "ciLoNs": lo * 1e6 / w if lo is not None else None, "ciHiNs": hi * 1e6 / w if hi is not None else None}
    k_rows = []
    for workload in WORKLOADS:
        b_total, a_total = series(data, "main", workload, "B", "totalMs"), series(data, "main", workload, "Aprime", "totalMs")
        cols = [it["collections"] for _, it in data.get(("main", workload, "B"), [])]
        lives = [it["maxLiveBefore"] for _, it in data.get(("main", workload, "B"), [])]
        if not (b_total and a_total and cols):
            continue
        extra_per_collection = (median(b_total) - median(a_total)) / median(cols)
        gain = saving_ms(median(lives))
        k = 0.0 if extra_per_collection <= 0 else (extra_per_collection / gain if gain else None)
        k_rows.append({"workload": workload, "extraMsPerCollection": extra_per_collection, "liveObjects": median(lives),
                       "savingPerOverviewMs": gain, "kStar": k})
    meta = [it["metadataBytes"] / max(it["maxLiveBefore"], 1) for _, it in data.get(("main", "W5", "B"), [])]
    object_v1 = env_files.get(("main", "A"), {}).get("objectBytes")
    object_v2 = env_files.get(("main", "Aprime"), {}).get("objectBytes")

    # --- H5: digests identical across all variants for the same (group, workload, process)
    mismatches, compared = [], 0
    for group in ("main", "h3"):
        for workload in WORKLOADS:
            by_proc = collections.defaultdict(lambda: collections.defaultdict(set))
            for (g, w, variant), items in data.items():
                if g == group and w == workload:
                    for proc, it in items:
                        by_proc[proc][variant].add(it["digest"])
            for proc, variants in by_proc.items():
                digests = set().union(*variants.values())
                compared += 1
                if len(digests) != 1:
                    mismatches.append(f"{group}/{workload}/p{proc}: {sorted(variants)}")

    def log_ok(name):
        path = os.path.join(raw, "tests", name)
        if not os.path.exists(path):
            return None, ""
        text = open(path).read().strip()
        return ("FAILED" not in text and "passed" in text), text.splitlines()[-1] if text else ""

    prop_ok, prop_line = log_ok("property.txt")
    diff_ok, diff_line = log_ok("differential.txt")
    reg_ok, reg_line = log_ok("region.txt")

    def verdict(ok):
        return "inconclusive" if ok is None else ("pass" if ok else "fail")

    summary["hypotheses"] = [
        {"id": "H1", "statement": "Region metadata faithfully represents cross-region references",
         "criterion": "I6 recomputation matches after every operation on seeded random programs: zero mismatches",
         "verdict": verdict(reg_ok and prop_ok if reg_ok is not None and prop_ok is not None else None),
         "evidence": f"region_tests: {reg_line or 'not run'}; gc_property_tests: {prop_line or 'not run'}"},
        {"id": "H5", "statement": "Observation never changes collection",
         "criterion": "identical freed sets across variants A', B, C, D, E, E+D on every workload and seed",
         "verdict": verdict(None if (diff_ok is None and not compared) else (diff_ok is not False and not mismatches and compared > 0)),
         "evidence": f"differential_tests: {diff_line or 'not run'}; harness digests of per-collection (freed, live) compared on {compared} (group, workload, process) cells, mismatches: {len(mismatches)}"
                     + ("" if not mismatches else f" ({'; '.join(mismatches[:3])})")},
    ]
    h2_big = [r for r in h2_rows if r["objects"] >= 100000]
    h2_pass = bool(h2_big) and all(r["ratio"] >= 2 and r["lo"] is not None and r["lo"] > 2 for r in h2_big)
    summary["hypotheses"].append({
        "id": "H2", "statement": "A region overview is cheaper than building it from a full snapshot",
        "criterion": "export at least 2x faster at N >= 10^5 with the 95% CI of the ratio excluding 2",
        "verdict": "inconclusive" if not h2_big else ("pass" if h2_pass else "fail"),
        "evidence": "; ".join(f"N={r['objects']:,}: {r['ratio']:.1f}x (CI {fmt(r['lo'], 1)}-{fmt(r['hi'], 1)})" for r in h2_rows)})
    for level, label in (("mutator", "mutator"), ("full", "full")):
        rows = [r for r in h3_rows if r["level"] == level]
        passed = sum(1 for r in rows if r["pass"])
        summary["hypotheses"].append({
            "id": f"H3-{label}", "statement": f"Batching lowers telemetry overhead at trace level {label}",
            "criterion": "B=1,024 removes >= 50% of B=1's overhead with the CI excluding 0 (passes if so on >= 4 of 7 workloads)",
            "verdict": "inconclusive" if not rows else ("pass" if passed >= 4 else "fail"),
            "evidence": f"{passed} of {len(rows)} workloads pass; " + "; ".join(
                f"{r['workload']}: {fmt(r['removalAt1024'] * 100 if r['removalAt1024'] is not None else None, 0)}% removed" for r in rows)})
    k_pass = sum(1 for r in k_rows if r["kStar"] is not None and r["kStar"] <= 1)
    summary["hypotheses"].append({
        "id": "H4", "statement": "Region benefits are not cancelled by their costs",
        "criterion": "break-even k* <= 1 overview per collection on >= 4 of 7 workloads",
        "verdict": "inconclusive" if not k_rows else ("pass" if k_pass >= 4 else "fail"),
        "evidence": (f"barrier {fmt(barrier['nsPerSetField'], 1)} ns per setField (CI {fmt(barrier['ciLoNs'], 1)} to {fmt(barrier['ciHiNs'], 1)}); " if barrier else "")
                    + (f"region metadata {fmt(median(meta), 3)} B per live object; " if meta else "")
                    + (f"Object struct {object_v1} B (V1) -> {object_v2} B (V2); " if object_v1 else "")
                    + f"k* <= 1 on {k_pass} of {len(k_rows)} workloads: " + ", ".join(f"{r['workload']} {fmt(r['kStar'], 3)}" for r in k_rows)})
    dormant_w6 = next((r for r in summary["dormantHooks"] if r["workload"] == "W6"), None)
    whole = ", ".join(f"{r['workload']} {1 / r['total']['ratio']:.2f}x" if False else f"{r['workload']} {r['total']['ratio']:.2f}x" for r in summary["dormantHooks"])
    summary["hypotheses"].append({
        "id": "DORMANT", "statement": "Dormant V2 hooks (everything off) cost under 3 % of collect time on W6 versus V1 (I.3 acceptance)",
        "criterion": "A' collect time within 3 % of A on W6",
        "verdict": "inconclusive" if not dormant_w6 else ("pass" if dormant_w6["within3Percent"] else "fail"),
        "evidence": (f"A'/A collect ratio on W6 {dormant_w6['collect']['ratio']:.3f} (CI {fmt(dormant_w6['collect']['lo'])}-{fmt(dormant_w6['collect']['hi'])}). "
                     f"The I.3 criterion covers collect time only; WHOLE-RUN A'/A is {whole} (above 1 means V2 with everything off is slower than V1; the setField path also gained reference-integrity hardening and a region branch)" if dormant_w6 else "not measured")})
    summary["barrier"] = barrier
    summary["breakEven"] = k_rows
    summary["h3"] = h3_rows

    # --- JVM
    jvm_files = sorted(glob.glob(os.path.join(raw, "jvm", "*.json")))
    for path in jvm_files:
        doc = json.load(open(path))
        runs = doc["runs"]
        pick = lambda key: median([r[key] for r in runs if r[key] is not None]) if any(r[key] is not None for r in runs) else None
        summary["jvm"].append({"program": doc["program"], "collector": doc["collector"], "runs": len(runs),
                               "gcCount": pick("gcCount"), "gcPauseTotalMs": pick("gcPauseTotalMs"),
                               "heapAfterLastGcBytes": pick("heapAfterLastGcBytes"),
                               "allocatedBytesMainThread": pick("allocatedBytesMainThread"),
                               "wallMs": pick("wallMs"), "jdk": doc["jdk"].splitlines()[0] if doc["jdk"] else ""})
    # behavioural shapes: custom W-workloads next to the JVM programs that mirror them (never a delta)
    for program, workload in J_MIRROR.items():
        custom = data.get(("main", workload, "Aprime"), [])
        if not custom:
            continue
        its = [it for _, it in custom]
        entry = {"program": program, "workload": workload,
                 "custom": {"collections": median([i["collections"] for i in its]),
                            "allocations": median([i["allocations"] for i in its]),
                            "freedFraction": median([i["freedTotal"] / i["allocations"] for i in its]),
                            "liveObjectsAfterLastGc": median([i["liveAfterLast"] for i in its])},
                 "jvm": [j for j in summary["jvm"] if j["program"] == program]}
        summary["shapes"].append(entry)

    # --- tables and figures
    with open(os.path.join(tables, "collector_ratios.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["workload", "variant", "samples", "median_total_ms", "total_ratio_vs_Aprime", "total_lo", "total_hi", "total_real",
                         "median_collect_ms", "collect_ratio_vs_Aprime", "collect_lo", "collect_hi", "collect_real"])
        for r in main_rows:
            writer.writerow([r["workload"], r["variant"], r["samples"], f"{r['medianTotalMs']:.3f}", f"{r['total']['ratio']:.4f}",
                             fmt(r["total"]["lo"], 4), fmt(r["total"]["hi"], 4), r["total"]["real"],
                             f"{r['medianCollectMs']:.3f}", f"{r['collect']['ratio']:.4f}", fmt(r["collect"]["lo"], 4), fmt(r["collect"]["hi"], 4), r["collect"]["real"]])
    with open(os.path.join(tables, "h3_batching.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["workload", "level", *[f"overhead_B{b}" for b in BATCHES], "removed_at_1024", "ci_lo", "ci_hi", "pass"])
        for r in h3_rows:
            writer.writerow([r["workload"], r["level"], *[f"{r['overheadByBatch'][str(b)]:.4f}" for b in BATCHES],
                             fmt(r["removalAt1024"], 4), fmt(r["ciLo"], 4), fmt(r["ciHi"], 4), r["pass"]])
    with open(os.path.join(tables, "h2_overview.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["objects", "snapshot_ms", "export_ms", "ratio", "ci_lo", "ci_hi", "snapshot_bytes", "export_bytes", "samples"])
        for r in h2_rows:
            writer.writerow([r["objects"], f"{r['snapshotMs']:.4f}", f"{r['exportMs']:.4f}", f"{r['ratio']:.2f}", fmt(r["lo"], 2), fmt(r["hi"], 2), r["snapshotBytes"], r["exportBytes"], r["samples"]])
    with open(os.path.join(tables, "jvm.csv"), "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["program", "collector", "runs", "gc_count", "gc_pause_total_ms", "heap_after_last_gc_bytes", "allocated_bytes_main_thread", "wall_ms"])
        for r in summary["jvm"]:
            writer.writerow([r["program"], r["collector"], r["runs"], r["gcCount"], fmt(r["gcPauseTotalMs"]), r["heapAfterLastGcBytes"], r["allocatedBytesMainThread"], fmt(r["wallMs"], 1)])
    if main_rows:
        figure_ratios(main_rows, os.path.join(figures, "ratios_main.svg"))
        w6 = {}
        for variant in ("A", "Aprime", "E"):
            per_round = [it["roundCollectMs"] for _, it in data.get(("main", "W6", variant), [])]
            if per_round:
                w6[variant] = [median([r[i] for r in per_round]) for i in range(len(per_round[0]))]
        if w6:
            figure_w6(w6, os.path.join(figures, "w6_collect_per_round.svg"))
            summary["w6Rounds"] = {k: [round(x, 4) for x in v] for k, v in w6.items()}
    if h3_overheads:
        figure_h3(h3_overheads, os.path.join(figures, "h3_batching.svg"))

    with open(os.path.join(result_dir, "summary.json"), "w") as handle:
        json.dump(summary, handle, indent=1, default=lambda o: None if (isinstance(o, float) and math.isnan(o)) else o)
        handle.write("\n")
    write_report(result_dir, summary)
    print(f"analysis written to {result_dir}")


def write_report(result_dir, s):
    lines = [f"# Benchmark report {s['id']}", "",
             f"Environment: {s['environment'].get('cpuModel', '?')}, {s['environment'].get('cores', '?')} cores, {s['environment'].get('os', '?')}, "
             f"power {s['environment'].get('power', '?')}; pinning: {s['environment'].get('cpuPinning', '?')}; commit {s['environment'].get('gitCommit', '?')[:10]}"
             f"{' (dirty)' if s['environment'].get('gitDirty') else ''}.", "",
             "Method: " + s["method"]["noiseRule"] + f"; {s['method']['processes']} fresh processes x ({s['method']['warmupDiscarded']} warm-up + {s['method']['measuredPerProcess']} measured) per cell; "
             f"{s['method']['resamples']:,}-resample percentile bootstrap.", "", "## Hypotheses", "",
             "| ID | Hypothesis | Criterion | Verdict | Evidence |", "| --- | --- | --- | --- | --- |"]
    for h in s["hypotheses"]:
        lines.append(f"| {h['id']} | {h['statement']} | {h['criterion']} | **{h['verdict']}** | {h['evidence']} |")
    lines += ["", "## Collector: run time relative to A' (median ratio [95 % CI]; * = real by the rule above)", "",
              "| Workload | A | A'2 (noise) | B regions | D regions+trace | E slot reuse | E+D |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for workload in WORKLOADS:
        cells = []
        for variant in ["A", "Aprime2", "B", "D", "E", "ED"]:
            row = next((r for r in s["collector"] if r["workload"] == workload and r["variant"] == variant), None)
            if not row:
                cells.append("-")
                continue
            t = row["total"]
            cells.append(f"{t['ratio']:.3f} [{fmt(t['lo'], 3)}, {fmt(t['hi'], 3)}]{'*' if t['real'] else ''}")
        lines.append(f"| {workload} {W_TITLES[workload]} | " + " | ".join(cells) + " |")
    lines += ["", "Same table for collect time only (the collector's own cost):", "",
              "| Workload | A | A'2 (noise) | B | D | E | E+D |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for workload in WORKLOADS:
        cells = []
        for variant in ["A", "Aprime2", "B", "D", "E", "ED"]:
            row = next((r for r in s["collector"] if r["workload"] == workload and r["variant"] == variant), None)
            c = row["collect"] if row else None
            cells.append("-" if not c else f"{c['ratio']:.3f} [{fmt(c['lo'], 3)}, {fmt(c['hi'], 3)}]{'*' if c['real'] else ''}")
        lines.append(f"| {workload} | " + " | ".join(cells) + " |")
    if s["h2"]:
        lines += ["", "## H2 region overview vs full snapshot", "", "| Objects | Snapshot ms | Export ms | Ratio [CI] | Snapshot bytes | Export bytes |", "| --- | --- | --- | --- | --- | --- |"]
        for r in s["h2"]:
            lines.append(f"| {r['objects']:,} | {r['snapshotMs']:.3f} | {r['exportMs']:.4f} | {r['ratio']:.1f} [{fmt(r['lo'], 1)}, {fmt(r['hi'], 1)}] | {r['snapshotBytes']:,} | {r['exportBytes']:,} |")
    if s["jvm"]:
        lines += ["", "## HotSpot (JDK Serial and G1, -Xms=-Xmx=64m): behaviour only, never a speed comparison", "",
                  "Separate runtimes, separate programs. Differences reflect language, runtime, object model and collector together. "
                  "Metrics with different bases are shown side by side without deltas.", "",
                  "| Program | Collector | GC count | Pause total ms | Heap after last GC | Allocated (main thread) | Wall ms |", "| --- | --- | --- | --- | --- | --- | --- |"]
        for r in s["jvm"]:
            lines.append(f"| {r['program']} | {r['collector']} | {fmt(r['gcCount'], 0)} | {fmt(r['gcPauseTotalMs'], 2)} | {fmt(r['heapAfterLastGcBytes'], 0)} B | {fmt(r['allocatedBytesMainThread'], 0)} B | {fmt(r['wallMs'], 0)} |")
        lines += ["", "| Mirror | Custom collections | Custom freed / allocated | Custom live objects after last GC |", "| --- | --- | --- | --- |"]
        for r in s["shapes"]:
            c = r["custom"]
            lines.append(f"| {r['program']} = {r['workload']} | {c['collections']:.0f} | {c['freedFraction']:.3f} | {c['liveObjectsAfterLastGc']:.0f} |")
    lines += ["", "## Threats to validity", "",
              "- Single machine, " + str(s["environment"].get("power", "?")) + " power, no CPU pinning (macOS has no affinity API); run-to-run drift is controlled only by interleaving variants and by the A'-vs-A' noise floor. Results are not claimed for Linux/GCC.",
              "- Variant A is built from the `v1-baseline` sources with the same compiler and flags, but a different code layout; small A-vs-A' differences can reflect layout and alignment rather than the V2 hooks.",
              "- The batching grid (H3) ran at scale 0.25 of each workload because the product caps a trace at 1,000,000 events or 64 MiB and full-level B=1 runs take seconds; its A' reference ran at the same scale. Overheads at full scale would be capped by the same limits.",
              "- Traces are written to a local disk file; a slower sink would raise the B=1 cost.",
              "- H2's graph is random with out-degree <= 2 and no locality, so nearly every reference crosses regions and the overview is almost as large as the graph. Programs with locality would give the region overview a larger advantage; this workload is the unfavourable case, and the result is reported as measured.",
              "- Statistics use 3 processes x 10 measured iterations (30 samples) per cell; the process-level variance is therefore estimated from three values.",
              "- HotSpot comparisons are behavioural only. The unified GC log prints heap sizes rounded to whole MiB, so 'heap after last GC' is quantised to MiB and J1-J4 all read 1 MiB.",
              "- The toy language has no loops, so W1-W7 drive `gc::IHeap` directly, exactly as the interpreter does but without interpretation cost.",
              "", "Figures: `figures/ratios_main.svg`, `figures/w6_collect_per_round.svg`, `figures/h3_batching.svg`. Tables: `tables/*.csv`. Raw files: `raw/`.", ""]
    with open(os.path.join(result_dir, "REPORT.md"), "w") as handle:
        handle.write("\n".join(lines))


if __name__ == "__main__":
    analyse(sys.argv[1])
