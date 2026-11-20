"""Build the fixed C fixture and embed its source map and wasm in the demo."""

import base64
import json
from pathlib import Path
import re
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent
CLANG = ["clang", "--target=wasm32", "-std=c11", "-Wall", "-Wextra", "-Werror"]
EXPORTS = ("reset", "bus_register", "stub_route", "bus_send", "bus_unregister", "bus_irq", "set_platform_stub")


def clang(*args):
    return subprocess.run([*CLANG, *args], cwd=ROOT, check=True, stdout=subprocess.PIPE).stdout


def descendants(node):
    yield node
    for child in node.get("inner", []):
        yield from descendants(child)


def source_lines(source, node):
    start, end = (node["range"][key]["offset"] for key in ("begin", "end"))
    return {"first": source.count(b"\n", 0, start) + 1, "last": source.count(b"\n", 0, end) + 1}


def parse_source(source, filename, repo):
    ast = json.loads(clang("-fsyntax-only", "-Xclang", "-ast-dump=json", filename))
    declarations = ast["inner"]
    definitions = {
        node["name"]: node for node in declarations
        if node["kind"] == "FunctionDecl"
        and any(child["kind"] == "CompoundStmt" for child in node.get("inner", []))
    }
    functions = {}
    globals_ = {node["name"] for node in declarations if node["kind"] == "VarDecl"}
    record_types = {
        node["name"]: {
            **source_lines(source, node),
            "fields": [child["name"] for child in node.get("inner", [])
                       if child["kind"] == "FieldDecl" and child.get("name")],
        }
        for node in declarations
        if node["kind"] == "RecordDecl" and node.get("completeDefinition") and node.get("name")
    }
    variables = {}
    for node in declarations:
        if node["kind"] != "VarDecl":
            continue
        variable = {"file": filename, **source_lines(source, node)}
        record = re.match(r"(?:const )?struct (\w+)(?:\[|$)", node["type"]["qualType"])
        if record and record[1] in record_types:
            variable["record"] = record_types[record[1]]
        variables[node["name"]] = variable
    for name, node in definitions.items():
        calls = []
        accesses = set()
        for call in descendants(node):
            ref = call.get("referencedDecl", {})
            if ref.get("kind") == "VarDecl" and ref.get("name") in globals_:
                accesses.add(ref["name"])
            if call.get("kind") != "CallExpr":
                continue
            for ref in descendants(call["inner"][0]):
                callee = ref.get("referencedDecl", {}).get("name")
                if ref.get("referencedDecl", {}).get("kind") == "FunctionDecl" and callee != "trace" and callee not in calls:
                    calls.append(callee)
        functions[name] = {
            **source_lines(source, node),
            "calls": calls,
            "file": filename,
            "repo": repo,
            "globals": sorted(accesses),
            "signature": node["type"]["qualType"],
        }
    event_enum = next((node for node in declarations if node.get("name") == "Event"), {})
    events = {member["name"]: int(member["inner"][0]["value"]) for member in event_enum.get("inner", [])}
    return functions, events, variables


def main():
    source = (ROOT / "bus.c").read_bytes()
    platform = (ROOT / "platform.c").read_bytes()
    functions, events, variables = parse_source(source, "bus.c", "driver")
    platform_functions, _, platform_variables = parse_source(platform, "platform.c", "platform")
    functions.update(platform_functions)
    variables.update(platform_variables)
    with tempfile.TemporaryDirectory(dir=ROOT) as directory:
        wasm_file = Path(directory) / "bus.wasm"
        clang("-O2", "-nostdlib", "-Wl,--no-entry", "-Wl,--allow-undefined",
              *(f"-Wl,--export={symbol}" for symbol in EXPORTS), "bus.c", "platform.c", "-o", str(wasm_file))
        wasm = base64.b64encode(wasm_file.read_bytes()).decode("ascii")
    bundle = {"source": source.decode("utf-8").replace("\r\n", "\n"),
              "platform": platform.decode("utf-8").replace("\r\n", "\n"),
              "functions": functions, "events": events, "variables": variables, "wasm": wasm}
    template = (ROOT / "page.html").read_text(encoding="utf-8")
    graph_model = (ROOT / "graph-model.cjs").read_text(encoding="utf-8")
    reading_model = (ROOT / "reading-model.js").read_text(encoding="utf-8")
    sequence_view = (ROOT / "sequence-view.js").read_text(encoding="utf-8")
    resource_chain_model = (ROOT / "resource-chains-model.js").read_text(encoding="utf-8")
    resource_chains = (ROOT / "resource-chains.js").read_text(encoding="utf-8")
    data = json.dumps(bundle, ensure_ascii=False).replace("<", "\\u003c")
    page = (template.replace("%%GRAPH_MODEL%%", graph_model).replace("%%READING_MODEL%%", reading_model)
            .replace("%%SEQUENCE_VIEW%%", sequence_view).replace("%%BUNDLE%%", data)
            .replace("%%RESOURCE_CHAIN_MODEL%%", resource_chain_model).replace("%%RESOURCE_CHAINS%%", resource_chains))
    (ROOT / "index.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    main()
