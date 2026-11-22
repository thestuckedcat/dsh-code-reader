"""Collect reproducible source-only study evidence. Never imports upstream code."""
import hashlib
import json
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
out = Path(__file__).resolve().parent

def git(*args):
    return subprocess.check_output(["git", "-C", str(repo), *args]).decode("utf-8").strip()

commit = git("rev-parse", "HEAD")
assert commit == "0f8a279278433914c9bd1d4f3a2c3a40572cc40a", "study version changed"
assert git("status", "--porcelain") == "", "upstream checkout has local changes"
paths = [p for p in git("ls-files", "-z").split("\0") if p]
code_ext = {".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".go", ".py"}
areas = defaultdict(lambda: {"files": 0, "physical_lines": 0})
src_ext = Counter()
largest = []
for name in paths:
    path = Path(name)
    if path.suffix.lower() not in code_ext:
        continue
    lines = len((repo / path).read_text(encoding="utf-8", errors="replace").splitlines())
    area = "/".join(path.parts[:2])
    areas[area]["files"] += 1
    areas[area]["physical_lines"] += lines
    largest.append({"path": name, "physical_lines": lines})
    if name.startswith("src/"):
        src_ext[path.suffix.lower()] += 1
metrics = {"tracked_files": len(paths), "code_extensions_counted": sorted(code_ext),
           "code_by_area": dict(areas), "src_by_extension": dict(src_ext),
           "src_files": sum(v["files"] for k, v in areas.items() if k.startswith("src/")),
           "src_physical_lines": sum(v["physical_lines"] for k, v in areas.items() if k.startswith("src/")),
           "largest_code_files": sorted(largest, key=lambda x: x["physical_lines"], reverse=True)[:10],
           "measurement": "tracked files; physical lines include comments and blanks; not AST/function counts"}
anchors = [
    ("sdk_positive_error", "src/sdk/c/include/ubs_error.h", "UBS_ERR_OPERATION_FAILED = 42"),
    ("user_service", "scripts/rpm/ubse.service", "User=ubse"),
    ("sdk_numa", "src/sdk/c/ubs_engine_mem.cpp", "int32_t ubs_mem_numa_create("),
    ("ipc_opcode", "src/framework/ipc/include/ubse_ipc_common.h", "UBSE_MEM_NUMA_CREATE = 0x0010"),
    ("server_opcode", "src/include/ubse_com_op_code.h", "UBSE_MEM_NUMA_CREATE = 0x0010"),
    ("register_numa", "src/controllers/mem/mem_controller/ubse_mem_controller_dispatcher.cpp", "UbseResult UbseMemControllerDispatcher::RegisterNumaSdkDispatcherCreate()"),
    ("dispatch", "src/framework/ipc/server/ubse_ipc_server.cpp", "void UbseIpcServer::HandleRequest("),
    ("numa_handler", "src/controllers/mem/mem_controller/ubse_mem_controller_dispatcher.cpp", "UbseResult UbseMemControllerDispatcher::UbseMemNumaCreateHandler("),
    ("master_branch", "src/controllers/mem/mem_controller/ubse_mem_controller_dispatcher.cpp", "uint32_t MemNumaBorrowRpc("),
    ("async_local", "src/controllers/mem/mem_controller/ubse_mem_async_processor.cpp", "UbseResult DoNumaBorrowAsync("),
    ("rpc_receiver", "src/controllers/mem/mem_controller/ubse_mem_rpc_processor.cpp", "UbseResult UbseMemNumaBorrowMessageHandler::Handle("),
    ("borrow", "src/controllers/mem/mem_controller/api/ubse_mem_controller_numa_api.cpp", "uint32_t UbseMemNumaBorrow("),
    ("share_borrow", "src/controllers/mem/mem_controller/api/ubse_mem_controller_share_api.cpp", "uint32_t UbseMemShareBorrow("),
    ("ledger", "src/controllers/mem/mem_controller/debt/ubse_mem_debt_ledger.h", "class UbseMemNodeDebtMap"),
    ("ledger_update", "src/controllers/mem/mem_controller/debt/ubse_mem_debt_ledger.h", "bool Update(const std::string& resId"),
    ("raii_lock", "src/controllers/mem/mem_controller/logging_lock_guard.cpp", "LoggingLockGuard::LoggingLockGuard("),
    ("raii_unlock", "src/controllers/mem/mem_controller/logging_lock_guard.cpp", "LoggingLockGuard::~LoggingLockGuard()"),
    ("module_registration", "src/framework/context/ubse_context.h", "#define DYNAMIC_CREATE("),
    ("conditional_module", "src/controllers/mem/mem_controller/ubse_mem_controller_module.cpp", "CONDITION_DYNAMIC_CREATE("),
    ("external_obmm", "src/adapter_plugins/mmi/ubse_obmm_executor.cpp", 'DlOpenFunName(obmmExportFunc, "obmm_export")'),
    ("numa_tests", "test/UT/mem_controller/api/test_ubse_mem_controller_numa_api.cpp", "TEST_F(TestUbseMemControllerNumaApi, ConstructNumaObjs)"),
]
facts = []
for fact_id, name, needle in anchors:
    data = (repo / name).read_bytes()
    lines = data.decode("utf-8").splitlines()
    matches = [i + 1 for i, line in enumerate(lines) if needle in line]
    assert matches, (fact_id, name, needle)
    facts.append({"id": fact_id, "path": name, "line": matches[0], "needle": needle,
                  "file_sha256": hashlib.sha256(data).hexdigest(), "evidence": "source_text_reviewed"})
manifest = {"study_date": "2026-11-22", "repo_path": str(repo),
            "official_origin": git("remote", "get-url", "origin"), "branch": git("branch", "--show-current"),
            "commit": commit, "commit_time": git("show", "-s", "--format=%cI"),
            "shallow": git("rev-parse", "--is-shallow-repository") == "true", "dirty": False,
            "license": "MulanPSL-2.0", "license_sha256": hashlib.sha256((repo / "LICENSE").read_bytes()).hexdigest(),
            "official_project": "https://www.openeuler.org/en/projects/ub-service-core/",
            "operations": ["git clone --depth 1 --no-tags", "local static reads", "file metrics", "anchor/hash validation"],
            "not_performed": ["upstream builds/tests/scripts", "dependency installation", "service startup", "Atlas indexing", "hardware execution"]}
for name, value in [("source-lock.json", manifest), ("metrics.json", metrics), ("source-facts.json", facts)]:
    (out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"commit": commit, "tracked_files": len(paths), "src_files": metrics["src_files"],
                  "src_lines": metrics["src_physical_lines"], "verified_anchors": len(facts)}, ensure_ascii=False))
