# 真实 Atlas 0.8 产物对照证据（04 增强）

更新：2026-11-08。目的：把 04 适配器从“只对合成 fixture 自测”推进到“消费真实 SDK Code Atlas 0.8.0 产物”，验证 envelope/hash/字段语义与路径/关系查询在真实输出上成立。

**边界**：只分析**合成 C 仓库**（Atlas 自带 quickstart 示例 + 本目录 `mini-repo/` 三函数 C 仓库），**不是** Linux 内核/Kbuild，也**不是**用户真实驱动。使用 Atlas 自带 Windows runtime 与 H 盘源码（只读），**未**运行 H 盘 launcher、**未**联网、**未**使用用户仓库。因此本证据只关闭“真实 Atlas 产物适配”这一项，不声称 Linux/Kbuild/隔离/native CFG 门禁通过。

## 来源与基线

| 项 | 值 |
|---|---|
| Atlas | `H:\VSCODE_READER`，git commit `c33320a98face14c5f6e5e817beaccf52b9bbb93`，TOOL_VERSION `0.8.0`，SCHEMA_VERSION `0.1` |
| runtime | `H:\VSCODE_READER\runtime\windows-x86_64\venv\Scripts\python.exe`（Python 3.11.4，runtime.json sha256 `172b2f8b...`） |
| sdk CLI | `scripts/sdk_atlas.py` sha256 `1be4da8cdc728b0a630e09cb355a3c70190266c57881366d60226d4d13059a24` |
| 编译器 | `C:\mingw64\bin\clang.exe`，clang 16.0.4 (mingw build)，仅用于 compdb 预检；Atlas 用自带 libclang 18.1.1 解析 |
| 宿主 | Windows x64；输出目录在本仓库 `evidence/real-atlas/` 内 |

## 复现命令

```powershell
$py = "H:\VSCODE_READER\runtime\windows-x86_64\venv\Scripts\python.exe"
$env:PYTHONDONTWRITEBYTECODE = "1"
$env:PATH = (Split-Path -Parent $py) + ";" + $env:PATH

# 1) Atlas 自带 trusted quickstart 示例（不执行 CMake）
& $py "H:\VSCODE_READER\scripts\sdk_atlas.py" quickstart --out .\evidence\real-atlas\quickstart

# 2) 本仓库自建最小 C 仓库（真实 compdb，clang 编译数据库）
& $py "H:\VSCODE_READER\scripts\sdk_atlas.py" run `
  --repo .\evidence\real-atlas\mini-repo `
  --compdb .\evidence\real-atlas\mini-repo\compile_commands.json `
  --out .\evidence\real-atlas\mini-run `
  --interface submit --max-tu 8 --tu-timeout 60 --dataflow off `
  --html .\evidence\real-atlas\mini-run\overview.html
```

Atlas 输出保留快照对 `graph.json` + `analysis_manifest.json` 与离线 `overview.html`；运行内部 objects/runs/index.sqlite 已清理，可由上面的命令重建。

## 产物与哈希

| 文件 | SHA256 | 字节 |
|---|---|---|
| `quickstart/snapshots/00fb39c133fa4841a64ec014fc0b5c18/graph.json` | `a0067ed6951e1693bb451c198a82f6f78c2abcb880f1e72134ebd9abbafa125d` | 8958 |
| `quickstart/.../analysis_manifest.json` | `b6f1edda6ad34c9c89263ab504d904567ba9d86779c1108cbd1188dbfc93d299` | 2149 |
| `quickstart/overview.html` | `f433c255f6f83ef1fbda0de5513864b6f71e239a37361b2659e5397fb384efe3` | 24940 |
| `quickstart/quickstart-compile_commands.json` | `c09fe1e0a1e16971de342106f3611481f2d9efce4799d6ff77f032c5effa2514` | 208 |
| `mini-run/snapshots/22a7c4d18126447688ea05faf45a3e65/graph.json` | `259319e4c4100c6c76a190657ee94b385951e94456291857369fc0916d3b892c` | 13427 |
| `mini-run/.../analysis_manifest.json` | `d80f11abd9555c6c0a6f08a1d6157dd258c86e47e63ef08c5c3710433a544796` | 2146 |
| `mini-run/overview.html` | `09ad0e85cdab04b8bc1f77258987b111e138303665174c88084ea878d32ae355` | 29646 |
| `mini-repo/mini.c` | `eb531b4ce574504279d11f0e39e90057a0f52fe23ef5341abe97275d6884a721` | 212 |
| `mini-repo/mini.h` | `0dccf94ad65bbcedde315787b9bbf644bdb2ec53ffa012f42607500803c214f7` | 88 |
| `mini-repo/compile_commands.json` | `9ab52f8b4b798721c284b19de82768dde9a405aaffa7085d695b5a23d138e5e8` | 442 |

两份快照的 `analysis_manifest.payload.graph_hash` 都**逐字节等于**对 `graph.json` 原始字节的 SHA256（适配器按此校验），见 `verification.json`。

## 验证结果（summary，详见 verification.json）

| 检查 | quickstart | mini |
|---|---|---|
| 真实 envelope `schema_version=0.1` / `record_kind` | ✅ | ✅ |
| `graph_hash == sha256(graph.json bytes)` | ✅ | ✅ |
| 导入引擎（`snapshot-import`）并保留 coverage | ✅ `failed=0, pending=0, whole_program_complete=false` | ✅ 同 |
| 真实函数实体只有 `evidence_ids`、没有 `file/line` | ✅ 已由适配器从 evidence 解析 | ✅ 同 |
| `path` 位置（file/line）与调用边 | `sdk_entry(7)→normalize(3)`，`exact` | `submit(13)→clamp_value(8)→normalize(3)`，2 条 `exact` |
| `flow_legacy` 关系查询 | `status=ok`, 1 item, `certainty=may` | `status=ok`, 1 item |
| source-only 查找/读取真实源码 | — | ✅ `origin=source_text`, `semantic_status=blocked` |

## 由此发现并修复的真实产品差异

1. **真实 graph 的函数实体不带 `file`/`line`**：位置在 `payload.evidence[]`（`file/line/start/end/text`），函数通过 `evidence_ids` 引用。旧适配器把 `file/line` 读成 `null`；现在 `atlas.function_location()` 从 evidence（按 `start` 最小优先）解析，`paths` 节点与歧义 choices 都会带回真实文件/行号。
2. **真实 `coverage.selected_scope` 是对象、capabilities 使用 Atlas 专属字符串**：适配器原样保留，不改成数字/数组。
3. **真实 graph/manifest 含大量合成 fixture 未覆盖的可选字段**（`flow_edges`、`locks`、`alias_*`、`assumptions`、`parameters`、`source_manifest_hash` 等）：严格校验只读取必需字段并原样保留未知字段，真实产物可导入。
4. `flow_legacy` 在真实 `flow_edges` 上返回 `status=ok`（此前只在合成数据上验证）。

## 仍未验证

- Linux/Kbuild 内核源码与真实生成头/目标 ABI；真实驱动仓库；native CFG（Atlas `cfg=unsupported` 如实保留）。
- 真实跨仓 UMD/UAPI/KMD 快照（本证据只有单仓 quickstart 与三函数 C 仓库）。
- Windows 下 libclang 18 解析 Linux 内核扩展、`-D__KERNEL__` 等目标宏的覆盖；这些属于 Linux 门禁，仍需目标 Linux 环境。
