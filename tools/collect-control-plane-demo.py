"""Collect a fixed, manually reviewed source slice. Never builds/runs upstream."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT.parent / 'research/lingqu/ubs-engine'
COMMIT = '0f8a279278433914c9bd1d4f3a2c3a40572cc40a'
API = 'src/controllers/mem/mem_controller/api/ubse_mem_controller_numa_api.cpp'
LEDGER = 'src/controllers/mem/mem_controller/debt/ubse_mem_debt_ledger.h'
LOCK = 'src/controllers/mem/mem_controller/logging_lock_guard.cpp'
LOCK_H = 'src/controllers/mem/mem_controller/logging_lock_guard.h'
SDK = 'src/sdk/c/ubs_engine_mem.cpp'
DISPATCH = 'src/controllers/mem/mem_controller/ubse_mem_controller_dispatcher.cpp'


def main():
    if subprocess.check_output(['git', '-C', str(SAMPLE), 'rev-parse', 'HEAD'], text=True).strip() != COMMIT:
        raise SystemExit('source commit differs from reviewed case')
    if subprocess.check_output(['git', '-C', str(SAMPLE), 'status', '--porcelain'], text=True).strip():
        raise SystemExit('source case is dirty')
    evidence = {}

    def excerpt(key, path, first, last, needle):
        data = (SAMPLE / path).read_bytes()
        lines = data.decode('utf-8').splitlines()
        text = '\n'.join(lines[first - 1:last])
        if needle not in text:
            raise ValueError(f'anchor differs: {key}')
        evidence[key] = {'file': path, 'line': first, 'last': last, 'text': text,
                         'fileSha256': hashlib.sha256(data).hexdigest(), 'certainty': 'source_reviewed'}
        return key

    excerpt('borrow', API, 319, 396, 'LoggingLockGuard(exportKey)')
    excerpt('construct', API, 148, 158, 'UBSE_MEM_EXPORT_RUNNING')
    excerpt('publish', API, 160, 170, 'PutResource(exportNodeId, exportKey,')
    excerpt('update', API, 398, 410, 'exportObj.status.state = state')
    excerpt('erase', API, 412, 422, 'RemoveResource(exportNodeId, exportKey)')
    excerpt('callback', API, 451, 470, 'GetResource(exportNodeId, exportKey)')
    excerpt('put-resource', LEDGER, 449, 462, 'std::unique_lock<std::shared_mutex> lock(mutex_)')
    excerpt('node-put', LEDGER, 143, 151, 'map_[resId] = obj')
    excerpt('node-get', LEDGER, 159, 164, 'std::shared_lock<std::shared_mutex> lock(mutex_)')
    excerpt('get-resource', LEDGER, 380, 388, 'FindNodeMap(nodeId)')
    excerpt('remove-resource', LEDGER, 493, 510, 'RemoveExportIndexIfOwned')
    excerpt('node-remove', LEDGER, 172, 177, 'map_.erase(resId)')
    excerpt('singleton', LEDGER, 575, 591, 'static UbseMemDebtLedger instance')
    excerpt('lock', LOCK, 30, 74, 'lock_shared()')
    excerpt('lock-contract', LOCK_H, 23, 33, 'LockType::WRITE')
    excerpt('create', SDK, 343, 377, 'ubse_invoke_call(UBSE_MEM, UBSE_MEM_NUMA_CREATE')
    excerpt('route', DISPATCH, 1862, 1899, 'localNodeId != masterNodeId')
    excerpt('allocate', API, 70, 87, 'NumaAllocate')
    excerpt('send', API, 201, 247, 'RpcSend')
    license_text = (SAMPLE / 'LICENSE').read_text(encoding='utf-8')
    headers = {path: (SAMPLE / path).read_text(encoding='utf-8').split('*/', 1)[0] + '*/'
               for path in [API, LEDGER, LOCK, LOCK_H, SDK, DISPATCH]}
    resources = {
        'export': {'name': 'NUMA 借出账本', 'symbol': 'ledger<ExportObj>[exportNodeId][exportKey]',
                   'kind': '共享容器', 'intro': '按借出节点和复合资源键保存借出对象；发布对象副本并维护资源键到节点的索引。',
                   'keys': 'exportKey = GenerateExportObjKey(name, importNodeId)', 'color': '#8ce7c3',
                   'definition': 'singleton', 'fields': [['status.state', '当前借出状态；对象构造/状态更新后发布到共享账本。'], ['status.expectState', '期望完成状态；构造时设为 EXPORT_SUCCESS。'], ['req', '请求元数据，含 name 和 importNodeId；参与资源身份。'], ['algoResult', '调度结果，含借出节点；不等于硬件已完成。']]},
        'import': {'name': 'NUMA 借入账本', 'symbol': 'ledger<ImportObj>[importNodeId][name]',
                   'kind': '共享容器', 'intro': '按借入节点和请求名称保存借入对象；与借出账本是不同模板类型和实例范围。',
                   'keys': 'nodeId = req.importNodeId; resId = req.name', 'color': '#9dcaff',
                   'definition': 'singleton', 'fields': [['status.state', '借入对象状态；与借出对象状态分别维护。'], ['status.expectState', '借入侧期望状态。'], ['req.importNodeId', '借入节点身份。']]}}
    functions = {
        'borrow': {'label': 'UbseMemNumaBorrow', 'role': '业务起点 · 借用 NUMA 内存', 'source': 'borrow'},
        'publish': {'label': 'UpdateNumaMemDebtInfoMap', 'role': '公共业务函数 · 发布两类对象', 'source': 'publish'},
        'update': {'label': 'NumaExportUpdateState', 'role': '内部接口 · 更新并发布借出状态', 'source': 'update'},
        'erase': {'label': 'EraseNumaExport', 'role': '内部接口 · 移除借出登记', 'source': 'erase'},
        'callback': {'label': 'NumaExportRunningCallback', 'role': '回调片段 · 查询当前借出状态', 'source': 'callback'},
        'put-export': {'label': 'PutResource<ExportObj>(const T&)', 'role': '共用实现 · 借出对象引用重载', 'source': 'put-resource'},
        'put-import': {'label': 'PutResource<ImportObj>(const T&)', 'role': '同一模板的不同类型实例', 'source': 'put-resource'},
        'remove-export': {'label': 'RemoveResource<ExportObj>', 'role': '移除账本登记及索引，不等于释放物理内存', 'source': 'remove-resource'},
        'get-export': {'label': 'GetResource<ExportObj>', 'role': '读取对象快照；底层 Get 使用读锁', 'source': 'get-resource'},
        'create': {'label': 'ubs_mem_numa_create', 'role': '接收内存借用请求', 'source': 'create'},
        'route': {'label': 'MemNumaBorrowRpc', 'role': '本地处理或转发到主节点', 'source': 'route'},
        'allocate': {'label': 'NumaAllocate', 'role': '生成资源分配方案', 'source': 'allocate'},
        'send': {'label': 'SendNumaExportObj', 'role': '向资源节点下发操作', 'source': 'send'}}
    for fn in functions.values():
        fn['domain'] = 'user'
    known = {'status': 'source-scoped', 'label': '业务键锁：GenerateExportObjKey(req.name, req.importNodeId)',
             'detail': 'UbseMemNumaBorrow 创建 WRITE 模式 LoggingLockGuard；作用域析构解锁。锁身份由复合键决定；此处是人工源码核对，非自动锁分析。',
             'evidence': ['borrow', 'lock-contract', 'lock']}
    unknown = {'status': 'unknown', 'label': '外层业务保护未知',
               'detail': '该内部接口片段未见局部 LoggingLockGuard；其所有调用者及外层锁尚未核全，不能判定无锁或竞态。', 'evidence': []}
    internal = {'status': 'source-scoped', 'label': '容器内部锁：类型账本 mutex_ → 节点 map mutex_',
                'detail': 'Export 类型分支获取类型账本写锁，调用 nodePtr->Put；Put 内部获取另一节点账本写锁后替换 map_[resId]。这与业务键锁是不同对象和范围。',
                'evidence': ['put-resource', 'node-put']}
    contexts = [
        {'id': 'borrow-export', 'entry': 'borrow', 'function': 'put-export', 'resource': 'export',
         'path': ['borrow', 'publish', 'put-export'], 'callsite': 'publish', 'callLine': 165,
         'effect': '发布 exportObj 的副本；status.state ← EXPORT_RUNNING，expectState ← EXPORT_SUCCESS',
         'conditions': ['维护门禁、请求及资源检查通过', 'NumaAllocate 成功且 exportNumaInfos 非空', 'ConstructNumaObjs 成功；发布先于 SendNumaExportObj'],
         'protection': {'business': known, 'internal': internal}, 'evidence': ['borrow', 'construct', 'publish', 'put-resource', 'node-put']},
        {'id': 'update-export', 'entry': 'update', 'function': 'put-export', 'resource': 'export',
         'path': ['update', 'put-export'], 'callsite': 'update', 'callLine': 408,
         'effect': 'exportObj.status.state ← 入参 state；随后发布对象副本，旧共享状态未知',
         'conditions': ['exportNumaInfos 非空；为空则已改局部/传入对象状态但不发布到账本', '调用者提供的 state 值与外层保护需继续追踪'],
         'protection': {'business': unknown, 'internal': internal}, 'evidence': ['update', 'put-resource', 'node-put']},
        {'id': 'erase-export', 'entry': 'erase', 'function': 'remove-export', 'resource': 'export',
         'path': ['erase', 'remove-export'], 'callsite': 'erase', 'callLine': 421,
         'effect': '移除指定节点/资源键的账本登记，并清理相应索引；不证明物理内存释放',
         'conditions': ['exportNumaInfos 非空', '节点/登记存在才执行删除'],
         'protection': {'business': unknown, 'internal': {'status': 'source-scoped', 'label': '类型账本与节点 map 的内部写锁', 'detail': '两层容器分别持写锁移除登记。', 'evidence': ['remove-resource', 'node-remove']}},
         'evidence': ['erase', 'remove-resource', 'node-remove']},
        {'id': 'borrow-import', 'entry': 'borrow', 'function': 'put-import', 'resource': 'import',
         'path': ['borrow', 'publish', 'put-import'], 'callsite': 'publish', 'callLine': 167,
         'effect': '按 importNodeId / name 发布 importObj 副本；与借出账本分开',
         'conditions': ['借用前置检查、分配及对象构造成功'],
         'protection': {'business': known, 'internal': {'status': 'source-scoped', 'label': '节点 map 内部写锁；节点查建细节未展开', 'detail': 'Import 分支经 GetOrCreateNodeMap 后调用 Put；本切片确认 Put 的写锁，不把 Export 分支的类型锁套到 Import。', 'evidence': ['put-resource', 'node-put']}},
         'evidence': ['borrow', 'construct', 'publish', 'put-resource', 'node-put']},
        {'id': 'callback-read', 'entry': 'callback', 'function': 'get-export', 'resource': 'export',
         'path': ['callback', 'get-export'], 'callsite': 'callback', 'callLine': 458,
         'effect': '读取 existingObjPtr->status.state；已为 EXPORT_SUCCESS 时提前返回',
         'conditions': ['回调调用上下文尚未核全', '本关系只摘录查询；回调后续更新和执行器行为不在此关系覆盖内'],
         'protection': {'business': unknown, 'internal': {'status': 'source-scoped', 'label': '节点 Get 的内部 shared_lock', 'detail': '底层 Get 持读锁查表；对象快照读取不等于业务流程全程互斥。', 'evidence': ['node-get']}},
         'evidence': ['callback', 'get-resource', 'node-get']}
    ]
    relations = [
        {'id': 'borrow-write', 'function': 'borrow', 'resource': 'export', 'action': 'write', 'label': '发布 · state / expectState', 'summary': '分配和构造成功后，将借出对象发布到共享账本。', 'contextIds': ['borrow-export']},
        {'id': 'update-write', 'function': 'update', 'resource': 'export', 'action': 'write', 'label': '更新 · state ← 入参', 'summary': '更新传入对象状态；存在借出节点时发布到账本。', 'contextIds': ['update-export']},
        {'id': 'erase-remove', 'function': 'erase', 'resource': 'export', 'action': 'remove', 'label': '移除 · 登记 / 索引', 'summary': '移除账本登记，不能据此宣称设备资源已经释放。', 'contextIds': ['erase-export']},
        {'id': 'callback-read', 'function': 'callback', 'resource': 'export', 'action': 'read', 'label': '读取 · status.state', 'summary': '回调先查询账本状态，已成功时提前返回。', 'contextIds': ['callback-read']},
        {'id': 'borrow-import', 'function': 'borrow', 'resource': 'import', 'action': 'write', 'label': '发布 · 借入对象副本', 'summary': '同时发布到另一类型实例的借入账本。', 'contextIds': ['borrow-import']}
    ]
    outline = {'goal': '把一次内存借用请求，变成资源方案、账本记录和节点操作。',
               'objects': ['借用请求', '借入账本', '借出账本'],
               'steps': [
                   {'id': 'accept', 'title': '接收并分派请求', 'description': '把请求交给负责处理的节点。', 'role': 'business', 'functions': ['create', 'route'], 'resources': []},
                   {'id': 'allocate', 'title': '调度借出资源', 'description': '决定从哪里借，形成分配方案。', 'role': 'business', 'functions': ['borrow', 'allocate'], 'resources': []},
                   {'id': 'record', 'title': '登记借入 / 借出状态', 'description': '保存这次借用的两端记录。', 'role': 'business', 'functions': ['publish'], 'resources': ['export', 'import']},
                   {'id': 'execute', 'title': '下发资源方案', 'description': '将操作请求发送到资源节点。', 'role': 'business', 'functions': ['send'], 'resources': ['export']},
                   {'id': 'track', 'title': '执行并更新进度', 'description': '资源节点处理请求，推进状态。', 'role': 'business', 'functions': ['callback', 'update'], 'resources': ['export'], 'asyncEntry': True}
               ]}
    case = {'schemaVersion': 1, 'id': 'ubs-engine-numa-ledger', 'title': 'UBS Engine 管控面 · NUMA 内存借用',
            'intro': outline['goal'], 'outline': outline,
            'scope': '人工核对的 5 条资源关系 / 5 个访问上下文；不是完整仓库或自动 CodeGraph。',
            'commit': COMMIT, 'sourceUrl': 'https://atomgit.com/openeuler/ubs-engine',
            'provenance': 'source_reviewed', 'observed': False, 'defaultResources': ['export'],
            'limitations': ['未构建、未运行管控面；不证明真实线程顺序、设备结果或全路径锁覆盖', '所有键与参数保留符号表达；源码注解不升级为编译器 exact', '回调后续修改、通信和完整生命周期未在该切片展开'],
            'license': 'MulanPSL-2.0', 'licenseText': license_text, 'copyrightHeaders': headers,
            'resources': resources, 'functions': functions, 'relations': relations, 'contexts': contexts, 'evidence': evidence}
    output = ROOT / 'demo/code-view/control-plane-case.json'
    output.write_text(json.dumps(case, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'collected {len(evidence)} checked excerpts; source not executed')


if __name__ == '__main__':
    main()
