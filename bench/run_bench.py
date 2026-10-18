#!/usr/bin/env python3
"""Runs the collector benchmark matrix (G.6/G.7) with interleaved ordering.

Groups
  main : scale 1.0  - variants A, Aprime, Aprime2, B, D, E, ED   (dormant hooks, regions, reuse)
  h3   : scale 0.25 - Aprime plus every batching configuration    (trace levels x batch sizes)
Each (workload, variant) gets 3 fresh processes x (5 warm-up + 10 measured) iterations. Within a
process index the same seed is used for every variant, and the variant order is shuffled per
(process, workload) from a fixed seed so thermal drift is spread across variants.
H2 : region overview vs full snapshot at N = 10^3 .. 10^6.
"""
import argparse
import os
import random
import subprocess
import sys
import time

WORKLOADS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7"]
GROUPS = {
    "main": {"scale": 1.0, "variants": ["A", "Aprime", "Aprime2", "B", "D", "E", "ED"]},
    "h3": {
        "scale": 0.25,
        "variants": ["Aprime"] + [f"C-{lvl}-{b}" for lvl in ("m", "f") for b in (1, 64, 1024, 8192)],
    },
}
H2_SIZES = [1000, 10000, 100000, 1000000]


def run(command):
    done = subprocess.run(command, capture_output=True, text=True)
    if done.returncode != 0:
        sys.exit(f"command failed: {' '.join(command)}\n{done.stderr[:500]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--quick", action="store_true")
    args = parser.parse_args()
    processes, warmup, measure = (1, 1, 2) if args.quick else (3, 5, 10)
    started = time.time()
    for group, spec in GROUPS.items():
        scale = spec["scale"] * (0.05 if args.quick else 1.0)
        directory = os.path.join(args.out, "collector", group)
        os.makedirs(directory, exist_ok=True)
        for proc in range(1, processes + 1):
            for workload in WORKLOADS:
                order = list(spec["variants"])
                random.Random(f"{group}/{workload}/{proc}").shuffle(order)
                for variant in order:
                    binary = os.path.join(args.work, "heap_bench_v1" if variant == "A" else "heap_bench_v2")
                    scratch = os.path.join(args.work, "scratch")
                    run([binary, "--workload", workload, "--variant", variant, "--warmup", str(warmup),
                         "--measure", str(measure), "--seed", str(proc), "--scale", str(scale),
                         "--scratch", scratch, "--out", os.path.join(directory, f"{variant}-{workload}-p{proc}.json")])
            print(f"{group}: process {proc}/{processes} done after {time.time() - started:.0f}s", flush=True)
    directory = os.path.join(args.out, "h2")
    os.makedirs(directory, exist_ok=True)
    binary = os.path.join(args.work, "heap_bench_v2")
    for proc in range(1, processes + 1):
        for size in ([1000, 10000] if args.quick else H2_SIZES):
            reps = 30 if size <= 100000 else 10
            run([binary, "--h2", str(size), "--reps", str(2 if args.quick else reps),
                 "--out", os.path.join(directory, f"N{size}-p{proc}.json")])
        print(f"h2: process {proc}/{processes} done after {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    main()
