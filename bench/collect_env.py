#!/usr/bin/env python3
"""Records the machine and toolchain metadata that every result directory must carry (G.7)."""
import json
import os
import platform
import re
import subprocess
import sys


def run(*command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:  # noqa: BLE001 - metadata is best effort
        return ""


def main(out_path, extra):
    system = platform.system()
    env = {
        "capturedAt": run("date", "-u", "+%Y-%m-%dT%H:%M:%SZ"),
        "os": f"{system} {platform.release()}",
        "machine": platform.machine(),
        "python": sys.version.split()[0],
        "cxx": run(os.environ.get("CXX", "c++"), "--version").splitlines()[0:1],
        "java": run(os.path.join(os.environ.get("JAVA_HOME", ""), "bin", "java") if os.environ.get("JAVA_HOME") else "java", "-version") or "",
        "gitCommit": run("git", "rev-parse", "HEAD"),
        "gitDirty": bool(run("git", "status", "--porcelain", "--untracked-files=no")),
        "baselineTag": run("git", "rev-parse", "v1-baseline"),
        "cpuPinning": "none: macOS has no CPU-affinity API (taskset is Linux only)" if system == "Darwin" else os.environ.get("GCD_PIN", "taskset -c 0 when available"),
    }
    if system == "Darwin":
        env["cpuModel"] = run("sysctl", "-n", "machdep.cpu.brand_string")
        env["cores"] = int(run("sysctl", "-n", "hw.ncpu") or 0)
        env["ramBytes"] = int(run("sysctl", "-n", "hw.memsize") or 0)
        battery = run("pmset", "-g", "batt")
        env["power"] = "AC" if "AC Power" in battery else ("battery" if battery else "unknown")
        env["powerRaw"] = battery.splitlines()[0:1]
    else:
        cpu = run("sh", "-c", "grep -m1 'model name' /proc/cpuinfo")
        env["cpuModel"] = re.sub(r"^.*: ", "", cpu)
        env["cores"] = os.cpu_count()
        env["ramBytes"] = int(run("sh", "-c", "awk '/MemTotal/ {print $2*1024}' /proc/meminfo") or 0)
        env["power"] = "unknown"
    env.update(extra)
    with open(out_path, "w") as handle:
        json.dump(env, handle, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    main(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})
