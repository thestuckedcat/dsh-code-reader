# 04 受控场景模拟夹具（S3a，CL-VIEW-T3）

更新：2026-11-15。给「打桩模拟」切片提供**可信、可隔离、可重放**的 Wasm 模拟 profile 与其模块。
来源是 Demo 的已构建产物（不是插件内编译），只用于隔离模拟验收，不证明真实设备或内核行为。

## 来源与固定值

| 项 | 值 |
|---|---|
| 模块 `bus.wasm` | 从 Demo 构建产物 `demo/code-view/index.html` 的 `bundle.wasm`（base64）**原样解码**，1547 B，SHA256 `69c8622d3522f68f90450a2db36ee11a85c859c91bdf2b5df1688fd6acd1321c` |
| 来源 C | `demo/code-view/bus.c` + `platform.c`（与本目录无关，见 `demo/code-view/`）；编译是 Demo 构建步骤，插件不执行编译器 |
| 接口参数范围 | Demo `interfaceFields`（channel 0..3、lane 0..3、max_len 1..65535、length 0..65535、return_code -4095..0） |
| 事件表 | Demo `bundle.events` 的 19 个事件名/码（DEFAULT_ROUTE..DOORBELL） |
| 绑定 | workspace `code-view-bus-demo`、variant `semantic-x86_64`、repo `bus`、snapshot `ed326d554334432b907de21297207eb8` |
| 资源/入口 id | `evidence/code-view-slice` 快照中的 `objects`/`functions` id（routes、staged_lengths、transfer_lock、irq_count、simulated_doorbell、platform_status；bus_send 等入口） |

## 文件

| 文件 | 说明 |
|---|---|
| `bus.wasm`（=`inbox/bus.wasm`） | 隔离模拟模块；sha256 见上 |
| `inbox/sim-profile.json` | 可信 SimProfileV1：绑定、接口（entry/util/stub_control）、trace 事件表、事件→资源映射、局限、**rev2 增加 `async_events:["IRQ"]`**（异步/IRQ 边界，见 `docs/scenario-contract.md` §11；rev1 sha256 `268d312a…` 见 S3a/S3b 历史证据，rev2 当前 sha256 `1c9ae1553f06486353cb0044f11d96fc0f1fc58eca13e9fe8dfca99747c298d9`，4793 B） |
| `inbox/trace-bus-send.json` | S3b 轨迹导入夹具（rev1，无 async 声明）：外部采集的 reset/bus_register(1)/bus_send(1,48) 记录（3418 B，sha256 `8860df515c39ae26cf62edfc8da74f454bcc3e65677092a7559aaf6d05d47e06`），导入时插件不执行代码 |
| `README.md` | 本文件 |

## 用途与边界

- Host 通过引擎 `sim-profile-import --profile sim-profile.json` 把 profile 与模块登记到**隔离 state**；
  运行由用户在工作台「打桩模拟」点击触发，在 Host `worker_threads` 内实例化 Wasm（`env.trace` 回调收集事件），
  执行有序接口调用并落不可变台账。
- `trace-bus-send.json` 用于 S3b `trace-import`：外部轨迹只做校验与只读台账登记，**不执行** Wasm；观测时序显示
  imported 标记与来源 label，不提供 undo/重放。
- worker 不读文件系统、不联网、无其他 import；总超时 10–15 s、内存 ≤64 MB。
- **不是**真实设备/内核执行证据；真实下发需单独授权与运行验证（S3b/S4 外）。插件不在运行期编译任何 C。
- `event_resources` 只把**实际资源变更**映射到快照对象（STORE_ROUTE→routes、WRITE→simulated_doorbell 等 10 类）；
  `DOORBELL` 只是把编码值交给平台写之前的通知，不映射资源——因此平台失败（`set_platform_stub(-5)`）时
  bus_send 记录没有 WRITE、也不把 simulated_doorbell 计为受影响资源，LOCK 仍记录 1→0。

## 复现提取（人工，一次）

```bash
python - <<'PY'
import base64, json, re
page = open('demo/code-view/index.html', encoding='utf-8').read()
bundle = json.loads(re.search(r'<script type="application/json" id="bundle">(.*?)</script>', page, re.S).group(1))
open('evidence/scenario-sim/bus.wasm','wb').write(base64.b64decode(bundle['wasm']))
PY
```
