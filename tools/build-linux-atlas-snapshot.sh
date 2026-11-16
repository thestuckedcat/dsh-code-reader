#!/bin/bash
# Build the Linux (WSL2 Ubuntu) Atlas 0.8 snapshot used by tools/verify-linux-snapshot.mjs.
#
# The snapshot is produced on Linux with Atlas's bundled Linux runtime; the
# Windows plugin then imports it with a bootstrap `path_aliases` mapping.
# This script only analyzes the checked-in Demo C sources (bus.c/platform.c)
# with gcc; it is a portability/cross-OS demo, not a Kbuild target analysis.
set -euo pipefail

ATLAS_REPO=${ATLAS_REPO:-/mnt/h/VSCODE_READER}
REPO_SRC=${REPO_SRC:-/mnt/e/dsh/plugin/04-code-learning/evidence/code-view-slice/repo}
EVIDENCE_OUT=${EVIDENCE_OUT:-/mnt/e/dsh/plugin/04-code-learning/evidence/linux-atlas/snapshot-linux}
WORK=${WORK:-$HOME/atlas-linux-build}

rm -rf "$WORK"
mkdir -p "$WORK/repo"
cp "$REPO_SRC/bus.c" "$WORK/repo/bus.c"
cp "$REPO_SRC/platform.c" "$WORK/repo/platform.c"

python3 - "$WORK" <<'PY'
import json, sys
work = sys.argv[1]
commands = [
    {"directory": work + "/repo", "file": work + "/repo/bus.c",
     "command": "gcc -std=gnu11 -O0 -g -c bus.c -o /tmp/bus.o"},
    {"directory": work + "/repo", "file": work + "/repo/platform.c",
     "command": "gcc -std=gnu11 -O0 -g -c platform.c -o /tmp/platform.o"},
]
with open(work + "/compile_commands.json", "w", encoding="utf-8") as handle:
    json.dump(commands, handle, indent=2)
PY

ATLAS="$ATLAS_REPO/runtime/linux-x86_64/venv/bin/python"
SCRIPTS="$ATLAS_REPO/scripts/sdk_atlas.py"
"$ATLAS" "$SCRIPTS" run --repo "$WORK/repo" --compdb "$WORK/compile_commands.json" \
  --out "$WORK/out" --max-tu 8 --tu-timeout 60 --dataflow off

SNAPSHOT_DIR=$(ls -d "$WORK"/out/snapshots/*/ | head -1)
mkdir -p "$EVIDENCE_OUT"
cp "$SNAPSHOT_DIR/graph.json" "$EVIDENCE_OUT/graph.json"
cp "$SNAPSHOT_DIR/analysis_manifest.json" "$EVIDENCE_OUT/analysis_manifest.json"
echo "snapshot written to $EVIDENCE_OUT"
python3 - "$EVIDENCE_OUT" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1] + "/analysis_manifest.json", encoding="utf-8"))["payload"]
print("snapshot_id:", payload["snapshot_id"])
print("graph_hash:", payload["graph_hash"])
print("workspace_roots:", payload["workspace_roots"])
print("coverage.parsed:", payload["coverage"]["parsed"])
print("coverage.failed:", payload["coverage"]["failed"])
PY
