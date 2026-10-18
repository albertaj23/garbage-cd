#!/usr/bin/env python3
"""J1-J5 on HotSpot (G.8): fresh process per run, -Xms = -Xmx = 64m, Serial and G1.

Usage: jvm_bench.py --out DIR [--runs 10] [--tools build/java/gcd-java-tools.jar]
Uses the same launcher as the controller, so GC counts and times are MXBean totals; pause totals,
heap after the last GC and the cause list come from the unified GC log (JDK 21).
"""
import argparse
import json
import os
import re
import subprocess
import tempfile
import time

PAUSE = re.compile(
    r"^\[(?P<up>[\d.]+)s\]\[[^\]]*\]\[gc\s*\]\s+GC\((?P<id>\d+)\)\s+Pause\s+(?P<kind>.+?)"
    r"(?:\s+\((?P<cause>[^()]*)\))?\s+(?P<before>[\d.]+)(?P<bu>[KMG]?)->(?P<after>[\d.]+)(?P<au>[KMG]?)"
    r"\((?P<cap>[\d.]+)(?P<cu>[KMG]?)\)\s+(?P<ms>[\d.]+)ms"
)
SCALE = {"": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}


def parse_log(text):
    pauses = []
    for line in text.splitlines():
        match = PAUSE.match(line)
        if match:
            pauses.append(
                {
                    "kind": match["kind"],
                    "cause": match["cause"] or "",
                    "beforeBytes": float(match["before"]) * SCALE[match["bu"]],
                    "afterBytes": float(match["after"]) * SCALE[match["au"]],
                    "pauseMs": float(match["ms"]),
                }
            )
    return pauses


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--tools", default="build/java/gcd-java-tools.jar")
    parser.add_argument("--programs", default="J1,J2,J3,J4,J5")
    args = parser.parse_args()
    java_home = os.environ.get("JAVA_HOME", "")
    java = os.path.join(java_home, "bin", "java") if java_home else "java"
    javac = os.path.join(java_home, "bin", "javac") if java_home else "javac"
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(args.out, exist_ok=True)
    version = subprocess.run([java, "-version"], capture_output=True, text=True).stderr.strip()
    with tempfile.TemporaryDirectory() as work:
        classes = os.path.join(work, "classes")
        os.makedirs(classes)
        sources = [os.path.join(here, "java", f"{name}.java") for name in args.programs.split(",")]
        subprocess.run([javac, "-Xlint:all", "-d", classes, *sources], check=True)
        for program in args.programs.split(","):
            for collector in ("Serial", "G1"):
                flags = ["-Xms64m", "-Xmx64m", f"-XX:+Use{collector}GC", "-XX:ActiveProcessorCount=1", "-XX:-UsePerfData"]
                runs = []
                for run in range(args.runs):
                    log = os.path.join(work, "gc.log")
                    metrics = os.path.join(work, "metrics.json")
                    for path in (log, metrics):
                        if os.path.exists(path):
                            os.remove(path)
                    command = [java, *flags, f"-Xlog:gc*:file={log}:uptime,level,tags", "-cp",
                               os.pathsep.join([classes, args.tools]), "gcd.launcher.Launcher", program, metrics]
                    started = time.perf_counter()
                    done = subprocess.run(command, capture_output=True, text=True, timeout=300)
                    wall = (time.perf_counter() - started) * 1000
                    if done.returncode != 0:
                        raise SystemExit(f"{program}/{collector} run {run} failed: {done.stderr[:400]}")
                    data = json.load(open(metrics))
                    with open(log) as handle:
                        pauses = parse_log(handle.read())
                    runs.append(
                        {
                            "wallMs": wall,
                            "jvmUptimeMs": data["jvmUptimeMs"],
                            "gcCount": sum(c["count"] for c in data["collectors"]),
                            "gcPauseMxBeanMs": sum(c["timeMs"] for c in data["collectors"]),
                            "gcCountLog": len(pauses),
                            "gcPauseTotalMs": sum(p["pauseMs"] for p in pauses),
                            "heapAfterLastGcBytes": pauses[-1]["afterBytes"] if pauses else None,
                            "heapBeforeFirstGcBytes": pauses[0]["beforeBytes"] if pauses else None,
                            "allocatedBytesMainThread": data["allocatedBytesMainThread"],
                            "heapPeakUsedBytes": data["heapPeakUsed"],
                            "pauseKinds": sorted({p["kind"] for p in pauses}),
                        }
                    )
                with open(os.path.join(args.out, f"{program}-{collector.lower()}.json"), "w") as handle:
                    json.dump({"kind": "jvm", "program": program, "collector": collector.lower(),
                               "flags": flags, "jdk": version, "runs": runs}, handle, indent=1)
                    handle.write("\n")
                print(f"{program} {collector}: {args.runs} runs", flush=True)


if __name__ == "__main__":
    main()
