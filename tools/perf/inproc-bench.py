#!/usr/bin/env python3
"""In-process engine projection bench for the S4-prep performance slice.

Loads the real ``code_learning`` package once in this process and times repeated
projection dispatch (no subprocess spawn), so "hot" samples exclude Python
start-up while "cold" is the first invocation in the process.

Usage:
  python tools/perf/inproc-bench.py --bootstrap <path> --workspace <id>
      --snapshot <id> --entry <function id> [--times 20]

Prints one JSON object with per-command samples (milliseconds) and p50/p95.
This script is verifier tooling only: it never writes production code/state.
"""
import argparse
import contextlib
import io
import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE_DIR = REPO_ROOT / "engine"
sys.path.insert(0, str(ENGINE_DIR))

from code_learning import cli  # noqa: E402  (after sys.path setup)


def percentile(samples, fraction):
    if not samples:
        return None
    ordered = sorted(samples)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * fraction))))
    return round(ordered[index], 3)


def run_once(argv):
    buffer = io.StringIO()
    started = time.perf_counter()
    with contextlib.redirect_stdout(buffer):
        code = cli.main(argv)
    elapsed = (time.perf_counter() - started) * 1000.0
    return code, round(elapsed, 3), buffer.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--entry", required=True)
    parser.add_argument("--times", type=int, default=20)
    args = parser.parse_args()

    commands = {
        "view-entries": ["view-entries", "--workspace", args.workspace, "--snapshot", args.snapshot],
        "view-end-to-end": ["view-end-to-end", "--workspace", args.workspace, "--snapshot", args.snapshot, "--entry", args.entry],
        "view-coupling": ["view-coupling", "--workspace", args.workspace, "--snapshot", args.snapshot, "--entry", args.entry],
        "view-tree": ["view-tree", "--workspace", args.workspace, "--snapshot", args.snapshot, "--entry", args.entry],
    }
    result = {"schema_version": 1, "times": args.times, "commands": {}, "failures": 0}
    for name, argv in commands.items():
        base = ["--bootstrap", args.bootstrap] + argv
        samples = []
        first_exit = None
        for index in range(args.times):
            exit_code, elapsed_ms, text = run_once(base)
            if index == 0:
                first_exit = exit_code
                try:
                    parsed = json.loads(text)
                    ok = parsed.get("schema_version") is not None and "error" not in parsed
                except Exception:
                    ok = False
                if not ok:
                    result["failures"] += 1
            samples.append(elapsed_ms)
        cold = samples[0]
        hot = samples[1:]
        result["commands"][name] = {
            "cold_ms": cold,
            "cold_exit_code": first_exit,
            "samples_ms": samples,
            "hot_p50_ms": percentile(hot, 0.50),
            "hot_p95_ms": percentile(hot, 0.95),
            "first_call_ok": first_exit == 0,
        }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
