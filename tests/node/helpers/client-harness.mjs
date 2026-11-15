// Minimal fake DeepSeek Harness 0.2.1-rc.5 client-module environment for the 04
// code-reader client tests.
//
// The REAL bundle (bundle/client.js) is read from disk and executed unmodified
// with vm.runInThisContext, so the tests exercise the same
// `window.__ModuleLoader__.load(...)` wrapper the pinned rc.5 loader consumes.
// Everything fake lives here: fake window/document (style host only), a tiny
// React-compatible renderer (createElement/Fragment/useState/useEffect/useRef),
// a programmable RPC connection and a fake Cordis ctx (slots/layout/effect).
// It is deliberately smaller than 08's harness: 04 needs no timers, polling,
// clipboard or navigation intents.
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(HERE, '..', '..', '..');
export const BUNDLE_FILE = resolve(PROJECT_ROOT, 'bundle', 'client.js');
export const PLUGIN_ID = '@local/dsh-code-reader';
export const PLUGIN_NAME = 'dsh-code-reader';
export const PANEL_KEY = 'dsh-code-reader';
export const PANEL_LABEL = '代码工作台';
export const CHANNEL = '/code-view';
export const SNAPSHOT_ID = 'a'.repeat(32);
export const BUS_SEND_ID = 'f_afa8298f2d197e5fd110e49a';
export const STORE_ROUTE_ID = 'f_dfb9aead445405de7aafbbfa';
export const LOOKUP_ROUTE_ID = 'f_144ee14b1f297d19f8bdab78';
export const CHECK_LENGTH_ID = 'f_b19a05b7a8457000a4562e91';
export const DISPATCH_TRANSFER_ID = 'f_ccdd7df856dd459e2934ea77';
export const ROUTES_ID = 's_0860e6738eaa8c95f37d0d03';
export const BUS_C_SHA256 = 'd'.repeat(64);

export function readBundleSource() {
  return readFileSync(BUNDLE_FILE, 'utf8');
}

// ---------------------------------------------------------------------------
// Fake DOM nodes / document (only what the scoped style injection needs)
// ---------------------------------------------------------------------------

export class FakeNode {
  constructor(tagName, ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = ownerDocument;
    this.attributes = Object.create(null);
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.textContent = '';
    this.className = '';
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  appendChild(child) {
    if (child === null || child === undefined) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (selectorMatches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

function selectorMatches(node, selector) {
  const match = /^([a-zA-Z][\w-]*)?(?:\[([a-zA-Z][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\])?$/.exec(String(selector).trim());
  if (!match) return false;
  const tag = match[1];
  const attribute = match[2];
  const value = match[3] ?? match[4] ?? match[5];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (attribute && !node.hasAttribute(attribute)) return false;
  if (attribute && value !== undefined && node.getAttribute(attribute) !== value) return false;
  return true;
}

export function createDocument() {
  const documentElement = new FakeNode('html');
  const head = new FakeNode('head');
  const body = new FakeNode('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  const doc = {
    documentElement,
    head,
    body,
    activeElement: null,
    createElement(tagName) {
      return new FakeNode(tagName, doc);
    },
    querySelector(selector) {
      return documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return documentElement.querySelectorAll(selector);
    },
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Minimal React-compatible runtime (createElement + hooks, no DOM diffing)
// ---------------------------------------------------------------------------

const ELEMENT = Symbol('dcr.element');
const FRAGMENT = Symbol('dcr.fragment');
const NEVER = Symbol('dcr.never');

export function createReactRuntime() {
  const instances = new Map();
  let current = null;
  let dirty = false;
  let mounted = false;
  let disposed = false;
  let rootType = null;
  let rootProps = {};
  let lastTree = null;
  const errors = [];
  let scheduled = false;

  function createElement(type, props, ...children) {
    const nextProps = Object.assign({}, props ?? {});
    if (children.length === 1) nextProps.children = children[0];
    else if (children.length > 1) nextProps.children = children;
    const key = nextProps.key ?? null;
    delete nextProps.key;
    return {[ELEMENT]: true, type, props: nextProps, key};
  }

  function isElement(value) {
    return typeof value === 'object' && value !== null && value[ELEMENT] === true;
  }

  function sameDeps(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
  }

  function useHookSlot(kind, init) {
    if (!current) throw new Error('react stub: hook called outside render');
    const instance = current.instance;
    const index = current.index;
    current.index += 1;
    let slot = instance.hooks[index];
    if (!slot || slot.kind !== kind) {
      slot = init();
      instance.hooks[index] = slot;
    }
    return {slot, instance};
  }

  function useState(initial) {
    const captured = useHookSlot('state', () => ({kind: 'state', value: typeof initial === 'function' ? initial() : initial}));
    const slot = captured.slot;
    const instance = captured.instance;
    function setState(next) {
      if (disposed || !instance.mounted) return;
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      dirty = true;
      schedule();
    }
    return [slot.value, setState];
  }

  function useRef(initial) {
    return useHookSlot('ref', () => ({kind: 'ref', value: {current: initial}})).slot.value;
  }

  function useEffect(effect, deps) {
    const captured = useHookSlot('effect', () => ({kind: 'effect', deps: NEVER, cleanup: null, pending: false, pendingFn: null, pendingDeps: undefined}));
    const slot = captured.slot;
    slot.pending = true;
    slot.pendingFn = effect;
    slot.pendingDeps = deps === undefined ? undefined : Array.isArray(deps) ? deps.slice() : [deps];
  }

  const react = {createElement, Fragment: FRAGMENT, useState, useEffect, useRef};

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed || !mounted) return;
      renderNow();
    });
  }

  function renderNode(element, path) {
    if (element === null || element === undefined || typeof element === 'boolean') return null;
    if (typeof element === 'string') return element;
    if (typeof element === 'number') return String(element);
    if (Array.isArray(element)) {
      return element.map((child, index) => renderNode(child, `${path}[${index}]`)).filter((child) => child !== null);
    }
    if (!isElement(element)) return null;
    const {type, props} = element;
    if (type === FRAGMENT) return renderNode(props.children, `${path}<>`);
    if (typeof type === 'function') {
      let instance = instances.get(path);
      if (instance && instance.type !== type) {
        unmountInstance(instance);
        instance = undefined;
      }
      if (!instance) {
        instance = {type, path, hooks: [], mounted: true, visited: false};
        instances.set(path, instance);
      }
      instance.visited = true;
      const previous = current;
      current = {instance, index: 0};
      let output;
      try {
        output = type(props);
      } finally {
        current = previous;
      }
      const children = renderNode(output, `${path}>`);
      return {
        tag: '#component',
        component: type.name || 'Anonymous',
        props,
        children: children === null ? [] : Array.isArray(children) ? children : [children],
      };
    }
    const children = renderNode(props.children, `${path}$`);
    let refNode = null;
    if (props.ref && typeof props.ref === 'object') {
      refNode = {
        tagName: typeof type === 'string' ? String(type).toUpperCase() : 'DIV',
        clientWidth: 960,
        clientHeight: 560,
        scrollWidth: 960,
        scrollHeight: 560,
        style: {},
        isConnected: true,
        getBoundingClientRect() {
          return {left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight};
        },
        setPointerCapture() {},
        releasePointerCapture() {},
        addEventListener() {},
        removeEventListener() {},
        focus() {},
      };
      try {
        props.ref.current = refNode;
      } catch {
        refNode = null;
      }
    }
    return {
      tag: typeof type === 'string' ? type : '#unknown',
      props,
      children: children === null ? [] : Array.isArray(children) ? children : [children],
      refNode,
    };
  }

  function runCleanup(instance) {
    for (const slot of instance.hooks) {
      if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') {
        try {
          slot.cleanup();
        } catch (error) {
          errors.push(error);
        }
        slot.cleanup = null;
      }
    }
  }

  function unmountInstance(instance) {
    runCleanup(instance);
    instance.mounted = false;
    instances.delete(instance.path);
  }

  function flushEffects() {
    let ran = false;
    for (const instance of instances.values()) {
      for (const slot of instance.hooks) {
        if (!slot || slot.kind !== 'effect' || !slot.pending) continue;
        slot.pending = false;
        const deps = slot.pendingDeps;
        const shouldRun = slot.deps === NEVER || deps === undefined || !sameDeps(slot.deps, deps);
        if (!shouldRun) continue;
        if (typeof slot.cleanup === 'function') {
          try {
            slot.cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        slot.cleanup = null;
        slot.deps = deps === undefined ? undefined : deps;
        try {
          const cleanup = slot.pendingFn();
          if (typeof cleanup === 'function') slot.cleanup = cleanup;
        } catch (error) {
          errors.push(error);
        }
        ran = true;
      }
    }
    return ran;
  }

  function renderNow() {
    if (disposed || !mounted || typeof rootType !== 'function') return false;
    let rendered = false;
    for (let turn = 0; turn < 50; turn += 1) {
      if (rendered && !dirty) break;
      dirty = false;
      for (const instance of instances.values()) instance.visited = false;
      lastTree = renderNode(createElement(rootType, rootProps), 'root');
      rendered = true;
      const stale = [];
      for (const instance of instances.values()) {
        if (!instance.visited) stale.push(instance);
      }
      for (const instance of stale) unmountInstance(instance);
      const ran = flushEffects();
      if (!dirty && !ran) break;
    }
    return rendered;
  }

  const runtime = {
    react,
    createElement,
    mount(type, props = {}) {
      if (disposed) throw new Error('react stub: runtime already disposed');
      mounted = true;
      rootType = type;
      rootProps = props;
      dirty = true;
      renderNow();
      return runtime.tree();
    },
    unmount() {
      for (const instance of [...instances.values()]) unmountInstance(instance);
      instances.clear();
      mounted = false;
      dirty = false;
      lastTree = null;
    },
    renderNow,
    async settle(maxTurns = 30) {
      let idle = 0;
      for (let turn = 0; turn < maxTurns && idle < 4; turn += 1) {
        await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
        const rendered = renderNow();
        if (rendered || dirty) idle = 0;
        else idle += 1;
      }
      if (errors.length > 0) {
        const error = errors.shift();
        throw error;
      }
      return lastTree;
    },
    tree() {
      return lastTree;
    },
    dispose() {
      if (disposed) return;
      runtime.unmount();
      disposed = true;
    },
    get disposed() {
      return disposed;
    },
    renderErrors: errors,
  };
  return runtime;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

export function walkTree(node, visitor) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') return;
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visitor);
    return;
  }
  visitor(node);
  for (const child of node.children ?? []) walkTree(child, visitor);
}

export function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children ?? []).map(textOf).join('');
}

export function findNodes(tree, predicate) {
  const found = [];
  walkTree(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

// ---------------------------------------------------------------------------
// Programmable RPC
// ---------------------------------------------------------------------------

export function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function deferred() {
  let resolveValue;
  let rejectValue;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolveValue = resolvePromise;
    rejectValue = rejectPromise;
  });
  return {promise, resolve: resolveValue, reject: rejectValue};
}

export function okResult(value) {
  return {__envelope: true, result: {ok: true, value}};
}

export function failResult(code, message) {
  return {__envelope: true, result: {ok: false, error: {code, message}}};
}

export function createRpc() {
  const calls = [];
  const handlers = new Map();

  function normalize(raw) {
    if (raw && typeof raw === 'object' && raw.__envelope === true) return raw.result;
    return {ok: true, value: raw};
  }

  const rpc = {
    calls,
    handlers,
    setResponse(endpoint, handler) {
      handlers.set(endpoint, handler);
      return rpc;
    },
    fail(endpoint, code, message) {
      return rpc.setResponse(endpoint, () => failResult(code, message));
    },
    reject(endpoint, message) {
      return rpc.setResponse(endpoint, () => {
        throw new Error(message ?? `rpc transport failure for ${endpoint}`);
      });
    },
    reset() {
      handlers.clear();
      calls.length = 0;
      return rpc;
    },
    async call(channel, endpoint, payload, signal) {
      const record = {channel, endpoint, payload, signal: signal ?? null};
      calls.push(record);
      if (signal?.aborted) throw abortError();
      const handler = handlers.get(endpoint);
      if (!handler) throw new Error(`rpc: unexpected endpoint in test: ${endpoint}`);
      const raw = await handler(payload, signal, record);
      if (signal?.aborted) throw abortError();
      return normalize(raw);
    },
    callsFor(endpoint) {
      return calls.filter((call) => call.endpoint === endpoint);
    },
    payloadsFor(endpoint) {
      return calls.filter((call) => call.endpoint === endpoint).map((call) => call.payload);
    },
    lastPayload(endpoint) {
      const matching = calls.filter((call) => call.endpoint === endpoint);
      return matching.length === 0 ? null : matching[matching.length - 1].payload;
    },
    endpoints() {
      return calls.map((call) => call.endpoint);
    },
  };
  return rpc;
}

// ---------------------------------------------------------------------------
// Fake slots / layout / Cordis ctx
// ---------------------------------------------------------------------------

export function createSlots() {
  const entries = [];
  const injections = [];
  const slots = {
    entries,
    injections,
    entriesOfSlot(name) {
      return entries.filter((entry) => entry.options?.name === name);
    },
    inject(name, callback) {
      injections.push(name);
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    register(options, component) {
      const entry = {options, component};
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
  };
  return slots;
}

export function createLayout() {
  return {
    selection: [],
    activePanelId: undefined,
    selectPanel(panelId) {
      this.selection.push(panelId);
      this.activePanelId = panelId;
    },
  };
}

export function createCtx({slots, layout, connection}) {
  const effects = [];
  effects.errors = [];
  const ctx = {
    slots,
    layout,
    connection,
    effects,
    effect(effectFactory, label) {
      const dispose = effectFactory();
      const record = {label, dispose: typeof dispose === 'function' ? dispose : null, disposed: false};
      effects.push(record);
      return () => {
        if (record.disposed) return;
        record.disposed = true;
        if (typeof record.dispose === 'function') record.dispose();
      };
    },
    dispose() {
      for (let index = effects.length - 1; index >= 0; index -= 1) {
        const record = effects[index];
        if (record.disposed) continue;
        record.disposed = true;
        try {
          if (typeof record.dispose === 'function') record.dispose();
        } catch (error) {
          effects.errors.push(error);
        }
      }
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Contract-shaped fixtures (§4.3 / §5.1 / §5.2 / §5.3)
// ---------------------------------------------------------------------------

export function makeSelection(overrides = {}) {
  return {
    workspace_id: 'code-view-bus-demo',
    variant_id: 'semantic-x86_64',
    snapshot_id: SNAPSHOT_ID,
    repo_id: 'bus',
    entry_id: null,
    symbol_id: null,
    callsite_ids: [],
    callsite_path: [],
    resource_ids: [],
    resource_status: 'unavailable',
    evidence_ids: [],
    run_id: null,
    event_id: null,
    ...overrides,
  };
}

export function makeStatusPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    host: {
      plugin: PLUGIN_NAME,
      package: PLUGIN_ID,
      version: '0.1.0',
      panel_key: PANEL_KEY,
      rpc_channel: CHANNEL,
      node: '24.21.0',
      platform: 'win32',
    },
    engine: {python: 'available', bootstrap: {configured: true, exists: true}},
    capabilities: {
      readonly_workbench: true,
      five_views: true,
      resource_graph: true,
      group_collapse: true,
      interface_library: true,
      subflow_breadcrumb: true,
      scenario_execution: true,
      run_observation: true,
      scenario_undo: false,
      trace_import: false,
      real_device_dispatch: false,
      ai_summary: false,
    },
    gaps: [
      {code: 'ai_summary', status: 'unavailable', reason: '无模型出口，仅占位；AI 归纳正文未实现'},
      {code: 'scenario_undo', status: 'unavailable', reason: '回退末尾 N 次/前缀重放 S3b 提供'},
      {code: 'trace_import', status: 'unavailable', reason: '轨迹导入 S3b 提供'},
      {code: 'real_device_dispatch', status: 'unavailable', reason: '真实设备/内核下发需单独授权与运行验证'},
    ],
  };
  return {...base, ...overrides};
}

export function makeSnapshotRow(overrides = {}) {
  return {
    snapshot_id: SNAPSHOT_ID,
    variant_id: 'semantic-x86_64',
    repo_id: 'bus',
    status: 'verified',
    freshness: 'fresh',
    graph_sha256: 'b'.repeat(64),
    manifest_sha256: 'c'.repeat(64),
    tool_version: '0.8.0',
    atlas_schema: '0.1',
    imported_at: '2026-11-15T08:00:00.000Z',
    entry_count: 14,
    coverage: {failed_count: 0, pending_count: 0, whole_program_complete: false},
    capabilities: {direct_calls: 'ready', cfg: 'unsupported', data_flow: 'partial_path_insensitive'},
    limitations: ['whole_program_incomplete'],
    error: null,
    ...overrides,
  };
}

export function makeWorkspace(overrides = {}) {
  return {
    workspace_id: 'code-view-bus-demo',
    revision: 1,
    semantic_status: 'semantic',
    repositories: [{repo_id: 'bus', role: 'other', root_ref: 'slice-root', relative_path: 'repo'}],
    variants: [{variant_id: 'semantic-x86_64', analysis_mode: 'semantic'}],
    snapshots: [makeSnapshotRow(overrides.snapshot)],
    ...overrides,
  };
}

export function makeSnapshotsPayload(options = {}) {
  const workspaces = options.workspaces ?? [makeWorkspace(options.workspace)];
  return {
    schema_version: 1,
    host: {engine: 'code-learning', scope_ref: 'local', scope_generation: 1, profile_ref: 'desktop'},
    workspaces,
    gaps: options.gaps ?? [],
  };
}

export function makeEntryRow(overrides = {}) {
  return {
    entry_id: BUS_SEND_ID,
    symbol_id: 's_9a99bb2c95e28f92052a6d4b',
    name: 'bus_send',
    display_name: 'bus_send(unsigned, unsigned)',
    kind: 'function',
    storage: 'GLOBAL',
    signature: 'int (unsigned, unsigned)',
    file: 'bus.c',
    line: 152,
    is_entry: true,
    callers: 0,
    callees: 3,
    file_status: 'ok',
    ...overrides,
  };
}

export function makeSourceLines(start, end) {
  const lines = [];
  for (let number = start; number <= end; number += 1) {
    let text = `    /* bus.c line ${number} */`;
    if (number === 152) text = 'int bus_send(unsigned channel, unsigned length)';
    if (number === 160) text = '    struct Route *route = lookup_route(channel);';
    if (number === 161) text = '    if (route->max_len < length) return -90;';
    if (number === 174) text = '}';
    lines.push({n: number, text});
  }
  return lines;
}

export function makeEntriesPayload(overrides = {}) {
  const entries = overrides.entries ?? [
    makeEntryRow({
      entry_id: STORE_ROUTE_ID,
      symbol_id: 's_dfb9aead445405de7aafbbfa',
      name: 'store_route',
      display_name: 'store_route(unsigned, unsigned, unsigned)',
      file: 'bus.c',
      line: 190,
      is_entry: false,
      callers: 1,
      callees: 2,
    }),
    makeEntryRow(),
  ];
  return {
    schema_version: 1,
    snapshot: {
      workspace_id: 'code-view-bus-demo',
      snapshot_id: SNAPSHOT_ID,
      variant_id: 'semantic-x86_64',
      repo_id: 'bus',
      freshness: 'fresh',
      coverage: {failed_count: 0, pending_count: 0, whole_program_complete: false},
      capabilities: {direct_calls: 'ready'},
      limitations: ['whole_program_incomplete'],
    },
    selection: makeSelection(),
    entries,
    external_nodes: [],
    gaps: [{code: 'resource_graph', status: 'unavailable', reason: 'resource_graph_view_not_in_readonly_slice'}],
    truncated: false,
    ...overrides,
  };
}

function makeDefaultSource(overrides = {}) {
  return {
    status: 'ok',
    path: 'bus.c',
    sha256: 'd'.repeat(64),
    path_ref: 'path:bus.c:152',
    evidence_ref: 'evidence:bus.c:152',
    byte_start: 4311,
    byte_end: 4735,
    line_start: 152,
    line_end: 174,
    lines: makeSourceLines(152, 174),
    highlight: {line_start: 152, line_end: 174},
    truncated: false,
    reason: null,
    ...overrides,
  };
}

function makeDefaultResources(overrides = {}) {
  return {
    status: 'partial',
    reason: null,
    objects: [
      {
        resource_id: 's_routes',
        name: 'routes',
        type: 'struct Route[4]',
        storage: 'STATIC',
        lifetime: 'static',
        file: 'bus.c',
        line: 26,
        evidence_ids: ['e_obj_routes'],
      },
    ],
    field_accesses: [
      {
        access_id: 'field_routes_max_len_write',
        object_ids: ['s_routes'],
        object_names: ['routes'],
        field_name: 'max_len',
        field_path: ['max_len'],
        expression: 'routes[channel].max_len',
        access: 'write',
        certainty: 'exact',
        owner: {entry_id: 'f_store_route', name: 'store_route', file: 'bus.c', line: 43},
        location: {file: 'bus.c', line: 46},
        evidence_ids: ['e_write_max_len'],
        limitations: [],
      },
      {
        access_id: 'field_routes_max_len_read',
        object_ids: ['s_routes'],
        object_names: ['routes'],
        field_name: 'max_len',
        field_path: ['max_len'],
        expression: 'routes[channel].max_len',
        access: 'read',
        certainty: 'may',
        owner: {entry_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152},
        location: {file: 'bus.c', line: 161},
        evidence_ids: ['e_read_max_len'],
        limitations: ['unresolved_or_multiple_base_objects'],
      },
    ],
    gaps: [],
    truncated: false,
    ...overrides,
  };
}

export function makeEntryPayload(overrides = {}) {
  const defaultSource = makeDefaultSource(overrides.source);
  const defaultResources = makeDefaultResources(overrides.resources);
  const defaultSelection = makeSelection({
    entry_id: BUS_SEND_ID,
    symbol_id: 's_9a99bb2c95e28f92052a6d4b',
    callsite_ids: [],
    resource_ids: ['s_routes'],
    resource_status: 'partial',
    evidence_ids: ['e_call_lookup', 'e_read_max_len'],
    ...overrides.selection,
  });
  const base = {
    schema_version: 1,
    snapshot: {
      workspace_id: 'code-view-bus-demo',
      snapshot_id: SNAPSHOT_ID,
      variant_id: 'semantic-x86_64',
      repo_id: 'bus',
      freshness: 'fresh',
      coverage: {failed_count: 0, pending_count: 0, whole_program_complete: false},
      capabilities: {direct_calls: 'ready'},
      limitations: ['whole_program_incomplete'],
    },
    selection: defaultSelection,
    entry: {
      entry_id: BUS_SEND_ID,
      symbol_id: 's_9a99bb2c95e28f92052a6d4b',
      name: 'bus_send',
      display_name: 'bus_send(unsigned, unsigned)',
      kind: 'function',
      storage: 'GLOBAL',
      signature: 'int bus_send(unsigned channel, unsigned length)',
      return_type: 'int',
      parameters: [
        {name: 'channel', type: 'unsigned'},
        {name: 'length', type: 'unsigned'},
      ],
      file: 'bus.c',
      line: 152,
      is_entry: true,
      summary: null,
      summary_origin: 'missing',
    },
    source: defaultSource,
    calls: [
      {
        edge_id: 'edge_lookup',
        callsite_id: 'c_lookup',
        callsite: {file: 'bus.c', line: 160, expression: 'lookup_route(channel)'},
        target: {entry_id: 'f_lookup_route', name: 'lookup_route', file: 'bus.c', line: 90},
        certainty: 'exact',
        origin: 'deterministic_analysis',
        evidence_ids: ['e_call_lookup'],
        limitations: [],
      },
      {
        edge_id: 'edge_maybe',
        callsite_id: 'c_maybe',
        callsite: {file: 'bus.c', line: 166, expression: 'maybe_lock(channel)'},
        target: {entry_id: null, name: 'maybe_lock', file: null, line: null},
        certainty: 'may',
        origin: 'indirect_candidate',
        evidence_ids: ['e_call_may'],
        limitations: ['indirect_call_unresolved'],
      },
      {
        edge_id: 'edge_unknown',
        callsite_id: 'c_unknown',
        callsite: {file: 'bus.c', line: 170, expression: 'external_hook(channel)'},
        target: {entry_id: null, name: 'external_hook', file: null, line: null},
        certainty: 'unknown',
        origin: 'external_boundary',
        evidence_ids: [],
        limitations: ['target_outside_analysis_scope'],
      },
    ],
    callers: [
      {
        edge_id: 'edge_caller',
        callsite_id: 'c_caller',
        callsite: {file: 'bus.c', line: 210, expression: 'bus_send(channel, length)'},
        source: {entry_id: 'f_user_io', name: 'user_io_write', file: 'bus.c', line: 200},
        certainty: 'may',
        origin: 'indirect_candidate',
        evidence_ids: ['e_caller'],
        limitations: [],
      },
    ],
    evidence: [
      {evidence_id: 'e_call_lookup', kind: 'call', file: 'bus.c', line: 160, text: 'lookup_route(channel)', truncated: false},
      {evidence_id: 'e_read_max_len', kind: 'field_access', file: 'bus.c', line: 161, text: 'routes[channel].max_len', truncated: false},
    ],
    resources: defaultResources,
    coverage: {failed_count: 0, pending_count: 0, whole_program_complete: false},
    capabilities: {direct_calls: 'ready', cfg: 'unsupported', data_flow: 'partial_path_insensitive'},
    limitations: ['whole_program_incomplete'],
    gaps: [],
    truncated: false,
  };
  return {
    ...base,
    ...overrides,
    source: defaultSource,
    resources: defaultResources,
    selection: defaultSelection,
  };
}

// ---------------------------------------------------------------------------
// S2a five-view fixtures (docs/five-view-contract.md §3)
// ---------------------------------------------------------------------------

export function makeSnapshotBlock(overrides = {}) {
  return {
    workspace_id: 'code-view-bus-demo',
    snapshot_id: SNAPSHOT_ID,
    variant_id: 'semantic-x86_64',
    repo_id: 'bus',
    freshness: 'fresh',
    coverage: {failed_count: 0, pending_count: 0, whole_program_complete: false},
    capabilities: {direct_calls: 'ready', cfg: 'unsupported'},
    limitations: ['whole_program_incomplete'],
    ...overrides,
  };
}

export function makeCouplingPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    snapshot: makeSnapshotBlock(),
    selection: makeSelection({
      entry_id: BUS_SEND_ID,
      symbol_id: 's_9a99bb2c95e28f92052a6d4b',
      resource_ids: [ROUTES_ID],
      resource_status: 'partial',
      evidence_ids: ['e_write_max_len', 'e_read_max_len'],
    }),
    scope: {mode: 'entry_neighborhood', entry_id: BUS_SEND_ID},
    resources: [
      {
        resource_id: ROUTES_ID,
        name: 'routes',
        type: 'struct Route[4]',
        storage: 'STATIC',
        lifetime: 'static',
        file: 'bus.c',
        line: 26,
        evidence_ids: ['e_obj_routes'],
        fields: [
          {field_id: ROUTES_ID, field_name: 'lane', field_path: ['lane']},
          {field_id: ROUTES_ID, field_name: 'max_len', field_path: ['max_len']},
        ],
        write_count: 2,
        read_count: 5,
        related_function_ids: [STORE_ROUTE_ID, BUS_SEND_ID, LOOKUP_ROUTE_ID, CHECK_LENGTH_ID],
        accesses: [
          {
            access_id: 'field_routes_max_len_write',
            access: 'write',
            certainty: 'exact',
            function_id: STORE_ROUTE_ID,
            function_name: 'store_route',
            function_file: 'bus.c',
            function_line: 43,
            location: {file: 'bus.c', line: 46},
            field_name: 'max_len',
            expression: 'routes[channel].max_len',
            evidence_ids: ['e_write_max_len'],
            limitations: [],
          },
          {
            access_id: 'field_routes_max_len_read',
            access: 'read',
            certainty: 'may',
            function_id: BUS_SEND_ID,
            function_name: 'bus_send',
            function_file: 'bus.c',
            function_line: 152,
            location: {file: 'bus.c', line: 92},
            field_name: 'max_len',
            expression: 'route->max_len',
            evidence_ids: ['e_read_max_len'],
            limitations: ['unresolved_or_multiple_base_objects'],
          },
        ],
      },
    ],
    functions: [
      {function_id: STORE_ROUTE_ID, name: 'store_route', file: 'bus.c', line: 43, role: 'writer', is_entry: false, access_summary: {exact: 2, may: 0}},
      {function_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152, role: 'reader', is_entry: true, access_summary: {exact: 0, may: 5}},
      {function_id: LOOKUP_ROUTE_ID, name: 'lookup_route', file: 'bus.c', line: 89, role: 'reader', is_entry: false, access_summary: {exact: 0, may: 2}},
      {function_id: CHECK_LENGTH_ID, name: 'check_length', file: 'bus.c', line: 96, role: 'reader', is_entry: false, access_summary: {exact: 0, may: 2}},
    ],
    edges: [
      {
        edge_id: 'access:field_routes_max_len_write',
        from_function: STORE_ROUTE_ID,
        to_resource: ROUTES_ID,
        access: 'write',
        certainty: 'exact',
        field_name: 'max_len',
        location: {file: 'bus.c', line: 46},
        evidence_ids: ['e_write_max_len'],
        limitations: [],
      },
      {
        edge_id: 'access:field_routes_max_len_read_92',
        from_function: BUS_SEND_ID,
        to_resource: ROUTES_ID,
        access: 'read',
        certainty: 'may',
        field_name: 'max_len',
        location: {file: 'bus.c', line: 92},
        evidence_ids: ['e_read_max_len'],
        limitations: ['unresolved_or_multiple_base_objects'],
      },
      {
        edge_id: 'access:field_routes_max_len_read_98',
        from_function: CHECK_LENGTH_ID,
        to_resource: ROUTES_ID,
        access: 'read',
        certainty: 'may',
        field_name: 'max_len',
        location: {file: 'bus.c', line: 98},
        evidence_ids: ['e_read_check'],
        limitations: ['unresolved_or_multiple_base_objects'],
      },
    ],
    external_nodes: [
      {
        function_id: null,
        name: 'platform_write',
        kind: 'external',
        callsite_id: 'c_platform',
        file: 'bus.c',
        line: 113,
        certainty: 'may',
        reason: 'implementation_not_found',
      },
    ],
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeTreePayload(overrides = {}) {
  const base = {
    schema_version: 1,
    snapshot: makeSnapshotBlock(),
    selection: makeSelection({entry_id: BUS_SEND_ID, symbol_id: 's_9a99bb2c95e28f92052a6d4b'}),
    entry: {entry_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152, signature: 'int bus_send(unsigned channel, unsigned length)'},
    nodes: [
      {
        node_id: 'n_1',
        parent_node_id: null,
        depth: 0,
        kind: 'entry',
        symbol: {function_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152, signature: 'int bus_send(unsigned channel, unsigned length)', storage: 'NONE'},
        callsite: null,
        guards: [],
        returns: [],
        children_count: 3,
        expandable: true,
        cycle: false,
        limitations: [],
      },
      {
        node_id: 'n_2',
        parent_node_id: 'n_1',
        depth: 1,
        kind: 'call',
        symbol: {function_id: LOOKUP_ROUTE_ID, name: 'lookup_route', file: 'bus.c', line: 89, signature: 'struct Route *lookup_route(unsigned)'},
        callsite: {callsite_id: 'c_lookup', file: 'bus.c', line: 160, expression: 'lookup_route(channel)'},
        guards: [],
        returns: [],
        children_count: 0,
        expandable: false,
        cycle: false,
        limitations: [],
      },
      {
        node_id: 'n_3',
        parent_node_id: 'n_1',
        depth: 1,
        kind: 'call',
        symbol: {function_id: CHECK_LENGTH_ID, name: 'check_length', file: 'bus.c', line: 96, signature: 'int check_length(const struct Route *, unsigned)'},
        callsite: {callsite_id: 'c_check', file: 'bus.c', line: 164, expression: 'check_length(route, length)'},
        guards: [{kind: 'IF_STMT', expression: 'if (!check_length(route, length))'}],
        returns: [{expression: '-90', certainty: 'may', limitations: ['path_insensitive', 'alias_not_solved']}],
        children_count: 0,
        expandable: false,
        cycle: false,
        limitations: [],
      },
      {
        node_id: 'n_4',
        parent_node_id: 'n_1',
        depth: 1,
        kind: 'call',
        symbol: {function_id: DISPATCH_TRANSFER_ID, name: 'dispatch_transfer', file: 'bus.c', line: 143, signature: 'int dispatch_transfer(unsigned, unsigned)'},
        callsite: {callsite_id: 'c_dispatch', file: 'bus.c', line: 170, expression: 'dispatch_transfer(route, channel, length)'},
        guards: [],
        returns: [],
        children_count: 1,
        expandable: true,
        cycle: false,
        limitations: [],
      },
      {
        node_id: 'n_5',
        parent_node_id: 'n_4',
        depth: 2,
        kind: 'external',
        symbol: {function_id: null, name: 'platform_write', file: 'bus.c', line: 113, signature: 'int platform_write(unsigned, unsigned)'},
        callsite: {callsite_id: 'c_platform', file: 'bus.c', line: 113, expression: 'platform_write(TX_DOORBELL, encoded)'},
        guards: [],
        returns: [],
        children_count: 0,
        expandable: false,
        cycle: false,
        limitations: ['implementation_not_found'],
      },
    ],
    max_depth: 2,
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeEndToEndPayload(overrides = {}) {
  const errorExitId = 'exit:' + BUS_SEND_ID + ':return:-90';
  const normalExitId = 'exit:' + BUS_SEND_ID + ':return:0';
  const base = {
    schema_version: 1,
    snapshot: makeSnapshotBlock(),
    selection: makeSelection({entry_id: BUS_SEND_ID, symbol_id: 's_9a99bb2c95e28f92052a6d4b'}),
    entry: {entry_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152, signature: 'int bus_send(unsigned channel, unsigned length)'},
    nodes: [
      {node_id: 'entry:' + BUS_SEND_ID, kind: 'entry', label: 'bus_send', sublabel: 'bus.c:152', file: 'bus.c', line: 152, function_id: BUS_SEND_ID, callsite_id: null, shape: 'ellipse', role: 'normal', certainty: 'exact', evidence_ids: ['e_entry']},
      {node_id: 'fn:' + LOOKUP_ROUTE_ID, kind: 'process', label: 'lookup_route', sublabel: 'bus.c:89', file: 'bus.c', line: 89, function_id: LOOKUP_ROUTE_ID, callsite_id: null, shape: 'rect', role: 'normal', certainty: 'exact', evidence_ids: ['e_lookup']},
      {node_id: 'decision:c_check', kind: 'decision', label: 'if (!check_length(route, length))', sublabel: 'bus.c:164', file: 'bus.c', line: 164, function_id: null, callsite_id: 'c_check', shape: 'diamond', role: 'normal', certainty: 'exact', evidence_ids: ['e_check']},
      {node_id: 'fn:' + CHECK_LENGTH_ID, kind: 'process', label: 'check_length', sublabel: 'bus.c:96', file: 'bus.c', line: 96, function_id: CHECK_LENGTH_ID, callsite_id: null, shape: 'rect', role: 'normal', certainty: 'exact', evidence_ids: ['e_check2']},
      {node_id: 'external:callee:platform_write', kind: 'external', label: 'platform_write', sublabel: 'bus.c:113', file: 'bus.c', line: 113, function_id: null, callsite_id: 'c_platform', shape: 'rectangle', role: 'boundary', certainty: 'may', evidence_ids: [], callsite_count: 1, caller_function_ids: [CHECK_LENGTH_ID]},
      {node_id: errorExitId, kind: 'exit', label: '返回 -90', sublabel: '异常返回', file: 'bus.c', line: 92, function_id: null, callsite_id: null, shape: 'rect', role: 'error', certainty: 'may', evidence_ids: ['e_ret']},
      {node_id: normalExitId, kind: 'exit', label: '返回 0', sublabel: '正常返回', file: 'bus.c', line: 174, function_id: null, callsite_id: null, shape: 'rect', role: 'normal', certainty: 'may', evidence_ids: ['e_ret2']},
      {node_id: 'fn:' + DISPATCH_TRANSFER_ID, kind: 'process', label: 'dispatch_transfer', sublabel: 'bus.c:143', file: 'bus.c', line: 143, function_id: DISPATCH_TRANSFER_ID, callsite_id: null, shape: 'rect', role: 'normal', certainty: 'exact', evidence_ids: ['e_dispatch']},
      {node_id: 'fn:submit_buffered', kind: 'process', label: 'submit_buffered', sublabel: 'bus.c:136', file: 'bus.c', line: 136, function_id: 'f_submit_buffered', callsite_id: null, shape: 'rect', role: 'normal', certainty: 'exact', evidence_ids: ['e_buffered']},
      {node_id: 'fn:submit_direct', kind: 'process', label: 'submit_direct', sublabel: 'bus.c:130', file: 'bus.c', line: 130, function_id: 'f_submit_direct', callsite_id: null, shape: 'rect', role: 'normal', certainty: 'exact', evidence_ids: ['e_direct']},
      {node_id: 'fn:commit_transfer', kind: 'process', label: 'commit_transfer', sublabel: 'bus.c:116', file: 'bus.c', line: 116, function_id: 'f_commit_transfer', callsite_id: null, shape: 'rect', role: 'normal', certainty: 'exact', evidence_ids: ['e_commit']},
      {node_id: 'fn:encode_doorbell', kind: 'process', label: 'encode_doorbell', sublabel: 'bus.c:103', file: 'bus.c', line: 103, function_id: 'f_encode_doorbell', callsite_id: null, shape: 'rect', role: 'normal', certainty: 'exact', evidence_ids: ['e_encode']},
      {node_id: 'fn:write_doorbell', kind: 'process', label: 'write_doorbell', sublabel: 'bus.c:110', file: 'bus.c', line: 110, function_id: 'f_write_doorbell', callsite_id: null, shape: 'rect', role: 'normal', certainty: 'exact', evidence_ids: ['e_write_doorbell']},
    ],
    edges: [
      {edge_id: 'call:lookup', from: 'entry:' + BUS_SEND_ID, to: 'fn:' + LOOKUP_ROUTE_ID, kind: 'call', label: 'lookup_route(channel)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_lookup', evidence_ids: ['e_lookup'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'call:check', from: 'fn:' + LOOKUP_ROUTE_ID, to: 'decision:c_check', kind: 'guard', label: 'lookup_route(channel)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_check', evidence_ids: ['e_check'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'call:check2', from: 'decision:c_check', to: 'fn:' + CHECK_LENGTH_ID, kind: 'call', label: 'check_length(route, length)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_check', evidence_ids: ['e_check'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'external:callee:platform_write', from: 'fn:' + CHECK_LENGTH_ID, to: 'external:callee:platform_write', kind: 'external', label: 'platform_write(TX_DOORBELL, encoded)', certainty: 'may', origin: 'callsite_boundary', callsite_id: 'c_platform', evidence_ids: [], limitations: ['implementation_not_found'], style: {line: 'dashed', color: 'normal'}},
      {edge_id: 'return:-90', from: 'fn:' + CHECK_LENGTH_ID, to: errorExitId, kind: 'return', label: '返回 -90', certainty: 'may', origin: 'flow_edge', callsite_id: null, evidence_ids: ['e_ret'], limitations: ['path_insensitive', 'alias_not_solved'], style: {line: 'solid', color: 'exception'}},
      {edge_id: 'return:0', from: 'entry:' + BUS_SEND_ID, to: normalExitId, kind: 'return', label: '返回 0', certainty: 'may', origin: 'flow_edge', callsite_id: null, evidence_ids: ['e_ret2'], limitations: ['path_insensitive'], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'call:check_dispatch', from: 'decision:c_check', to: 'fn:' + DISPATCH_TRANSFER_ID, kind: 'call', label: 'dispatch_transfer(route, channel, length)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_dispatch', evidence_ids: ['e_dispatch'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'call:dispatch_buffered', from: 'fn:' + DISPATCH_TRANSFER_ID, to: 'fn:submit_buffered', kind: 'call', label: 'submit_buffered(route, length)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_submit_buffered', evidence_ids: ['e_buffered'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'call:dispatch_direct', from: 'fn:' + DISPATCH_TRANSFER_ID, to: 'fn:submit_direct', kind: 'call', label: 'submit_direct(route, length)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_submit_direct', evidence_ids: ['e_direct'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'call:buffered_commit', from: 'fn:submit_buffered', to: 'fn:commit_transfer', kind: 'call', label: 'commit_transfer(lane, length)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_commit_buffered', evidence_ids: ['e_commit'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'call:direct_commit', from: 'fn:submit_direct', to: 'fn:commit_transfer', kind: 'call', label: 'commit_transfer(lane, length)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_commit_direct', evidence_ids: ['e_commit'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'call:commit_encode', from: 'fn:commit_transfer', to: 'fn:encode_doorbell', kind: 'call', label: 'encode_doorbell(lane, length)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_encode', evidence_ids: ['e_encode'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'call:encode_write', from: 'fn:encode_doorbell', to: 'fn:write_doorbell', kind: 'call', label: 'write_doorbell(value)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_write_doorbell', evidence_ids: ['e_write_doorbell'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'external:write_platform', from: 'fn:write_doorbell', to: 'external:callee:platform_write', kind: 'external', label: 'platform_write(TX_DOORBELL, encoded)', certainty: 'may', origin: 'callsite_boundary', callsite_id: 'c_platform', evidence_ids: [], limitations: ['implementation_not_found'], style: {line: 'dashed', color: 'normal'}},
    ],
    exits: [
      {node_id: errorExitId, label: '返回 -90', expression: '-90', role: 'error', certainty: 'may'},
      {node_id: normalExitId, label: '返回 0', expression: '0', role: 'normal', certainty: 'may'},
    ],
    groups: [
      {
        group_id: 'group:' + DISPATCH_TRANSFER_ID + ':g1',
        parent_group_id: null,
        label: 'dispatch_transfer 下游子流程',
        description: '由 submit_buffered、submit_direct、commit_transfer 组成（仅被 dispatch_transfer 调用）',
        member_node_ids: ['fn:submit_buffered', 'fn:submit_direct', 'fn:commit_transfer'],
        member_function_ids: ['f_submit_buffered', 'f_submit_direct', 'f_commit_transfer'],
        entry_node_ids: ['fn:submit_buffered', 'fn:submit_direct'],
        exit_node_ids: ['fn:commit_transfer'],
        collapsed_default: true,
        origin: 'structural_heuristic',
        evidence_ids: ['e_group_g1'],
        limitations: ['group_structural_heuristic', 'group_name_not_semantic'],
      },
      {
        group_id: 'group:f_commit_transfer:g2',
        parent_group_id: 'group:' + DISPATCH_TRANSFER_ID + ':g1',
        label: 'commit_transfer 下游子流程',
        description: '由 encode_doorbell、write_doorbell 组成（仅被 commit_transfer 调用）',
        member_node_ids: ['fn:encode_doorbell', 'fn:write_doorbell'],
        member_function_ids: ['f_encode_doorbell', 'f_write_doorbell'],
        entry_node_ids: ['fn:encode_doorbell'],
        exit_node_ids: ['fn:write_doorbell'],
        collapsed_default: true,
        origin: 'structural_heuristic',
        evidence_ids: ['e_group_g2'],
        limitations: ['group_structural_heuristic', 'group_name_not_semantic'],
      },
    ],
    grouping: {
      algorithm: 'private_callee_subflow',
      groups: 2,
      members: 5,
      gaps: [{code: 'group_semantics', status: 'degraded', reason: '组由单入口私有子图结构产生，名称/描述为结构归纳而非语义理解，可由用户修订'}],
    },
    breadcrumb: [],
    legend: [
      {key: 'exact', label: '静态确定'},
      {key: 'may', label: '候选'},
      {key: 'unknown', label: '未知'},
      {key: 'error', label: '异常返回'},
      {key: 'boundary', label: '分析域边界'},
    ],
    layout: {direction: 'DOWN', edge_routing: 'ORTHOGONAL'},
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeInterfacesPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    snapshot: makeSnapshotBlock(),
    selection: makeSelection(),
    candidates: [
      {
        interface_id: 'iface:platform_write',
        function_id: 'f_platform_write',
        name: 'platform_write',
        file: 'platform.c',
        line: 19,
        signature: 'int (unsigned int, unsigned int)',
        parameters: [
          {name: 'address', type: 'unsigned int'},
          {name: 'value', type: 'unsigned int'},
        ],
        return_type: 'int',
        call_count: 2,
        callers: [
          {function_id: 'f_write_doorbell', name: 'write_doorbell', file: 'bus.c', line: 110, callsite_id: 'c_platform', location: {file: 'bus.c', line: 113}},
        ],
        leaf: true,
        cross_file: true,
        field_accesses: [
          {access: 'write', field_name: 'simulated_doorbell', certainty: 'exact', location: {file: 'platform.c', line: 31}, limitations: []},
          {access: 'read', field_name: 'platform_status', certainty: 'may', location: {file: 'platform.c', line: 24}, limitations: ['alias_not_solved']},
        ],
        input_guards: [
          {callsite_id: 'c_guard_write', file: 'bus.c', line: 110, expression: 'if (address != TX_DOORBELL)'},
        ],
        decoupling: 'mixed',
        reasons: [
          {code: 'cross_file_boundary', label: '跨文件边界'},
          {code: 'leaf_function', label: '叶子函数'},
        ],
        score: 88,
        certainty: 'may',
        evidence_ids: ['e_platform_write'],
        limitations: ['candidate_not_semantically_reviewed'],
      },
      {
        interface_id: 'iface:' + LOOKUP_ROUTE_ID,
        function_id: LOOKUP_ROUTE_ID,
        name: 'lookup_route',
        file: 'bus.c',
        line: 89,
        signature: 'struct Route *(unsigned int)',
        parameters: [{name: 'channel', type: 'unsigned int'}],
        return_type: 'struct Route *',
        call_count: 1,
        callers: [
          {function_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152, callsite_id: 'c_lookup', location: {file: 'bus.c', line: 160}},
        ],
        leaf: false,
        cross_file: false,
        field_accesses: [
          {access: 'read', field_name: 'max_len', certainty: 'may', location: {file: 'bus.c', line: 92}, limitations: ['unresolved_or_multiple_base_objects']},
        ],
        input_guards: [{callsite_id: 'c_guard_lookup', file: 'bus.c', line: 152, expression: 'if (channel >= 4)'}],
        decoupling: 'independent',
        reasons: [
          {code: 'single_caller', label: '单调用者'},
          {code: 'stable_signature', label: '签名稳定'},
        ],
        score: 76,
        certainty: 'may',
        evidence_ids: ['e_lookup'],
        limitations: ['private_callee_not_proven'],
      },
      {
        interface_id: 'iface:' + CHECK_LENGTH_ID,
        function_id: CHECK_LENGTH_ID,
        name: 'check_length',
        file: 'bus.c',
        line: 96,
        signature: 'int (const struct Route *, unsigned int)',
        parameters: [
          {name: 'route', type: 'const struct Route *'},
          {name: 'length', type: 'unsigned int'},
        ],
        return_type: 'int',
        call_count: 1,
        callers: [
          {function_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152, callsite_id: 'c_check', location: {file: 'bus.c', line: 164}},
        ],
        leaf: false,
        cross_file: false,
        field_accesses: [],
        input_guards: [],
        decoupling: 'independent',
        reasons: [{code: 'pure_computation', label: '纯计算'}],
        score: 71,
        certainty: 'may',
        evidence_ids: ['e_check'],
        limitations: [],
      },
      {
        interface_id: 'iface:' + DISPATCH_TRANSFER_ID,
        function_id: DISPATCH_TRANSFER_ID,
        name: 'dispatch_transfer',
        file: 'bus.c',
        line: 143,
        signature: 'int (const struct Route *, unsigned int, unsigned int)',
        parameters: [
          {name: 'route', type: 'const struct Route *'},
          {name: 'channel', type: 'unsigned int'},
          {name: 'length', type: 'unsigned int'},
        ],
        return_type: 'int',
        call_count: 1,
        callers: [
          {function_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152, callsite_id: 'c_dispatch', location: {file: 'bus.c', line: 170}},
        ],
        leaf: false,
        cross_file: false,
        field_accesses: [],
        input_guards: [],
        decoupling: 'independent',
        reasons: [{code: 'single_caller', label: '单调用者'}],
        score: 69,
        certainty: 'may',
        evidence_ids: ['e_dispatch'],
        limitations: [],
      },
    ],
    external_boundaries: [
      {callee: 'trace', call_count: 1, callsite_ids: ['c_trace']},
      {callee: 'platform_write', call_count: 2, callsite_ids: ['c_platform']},
    ],
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeSubflowPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    snapshot: makeSnapshotBlock(),
    selection: makeSelection({entry_id: CHECK_LENGTH_ID, symbol_id: 's_check_length', resource_ids: ['s_routes'], resource_status: 'partial'}),
    entry: {entry_id: CHECK_LENGTH_ID, name: 'check_length', file: 'bus.c', line: 96, signature: 'int check_length(const struct Route *route, unsigned length)'},
    root: BUS_SEND_ID,
    nodes: [
      {node_id: 'entry:' + CHECK_LENGTH_ID, kind: 'entry', label: 'check_length', sublabel: 'bus.c:96', file: 'bus.c', line: 96, function_id: CHECK_LENGTH_ID, callsite_id: null, shape: 'ellipse', role: 'normal', certainty: 'exact', evidence_ids: ['e_check']},
      {node_id: 'fn:' + LOOKUP_ROUTE_ID, kind: 'process', label: 'lookup_route', sublabel: 'bus.c:89', file: 'bus.c', line: 89, function_id: LOOKUP_ROUTE_ID, callsite_id: null, shape: 'rect', role: 'normal', certainty: 'exact', evidence_ids: ['e_lookup']},
      {node_id: 'exit:' + CHECK_LENGTH_ID + ':return:-90', kind: 'exit', label: '返回 -90', sublabel: '异常返回', file: 'bus.c', line: 98, function_id: null, callsite_id: null, shape: 'rect', role: 'error', certainty: 'may', evidence_ids: ['e_ret']},
    ],
    edges: [
      {edge_id: 'call:subflow_lookup', from: 'entry:' + CHECK_LENGTH_ID, to: 'fn:' + LOOKUP_ROUTE_ID, kind: 'call', label: 'lookup_route(channel)', certainty: 'exact', origin: 'deterministic_analysis', callsite_id: 'c_lookup', evidence_ids: ['e_lookup'], limitations: [], style: {line: 'solid', color: 'normal'}},
      {edge_id: 'return:subflow:-90', from: 'fn:' + LOOKUP_ROUTE_ID, to: 'exit:' + CHECK_LENGTH_ID + ':return:-90', kind: 'return', label: '返回 -90', certainty: 'may', origin: 'flow_edge', callsite_id: null, evidence_ids: ['e_ret'], limitations: ['path_insensitive'], style: {line: 'solid', color: 'exception'}},
    ],
    exits: [{node_id: 'exit:' + CHECK_LENGTH_ID + ':return:-90', label: '返回 -90', expression: '-90', role: 'error', certainty: 'may'}],
    groups: [],
    grouping: {algorithm: 'private_callee_subflow', groups: 0, members: 0, gaps: []},
    breadcrumb: [
      {function_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152, callsite_id: null},
      {function_id: CHECK_LENGTH_ID, name: 'check_length', file: 'bus.c', line: 96, callsite_id: 'c_check'},
    ],
    legend: [],
    layout: {direction: 'DOWN', edge_routing: 'ORTHOGONAL'},
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeStubProfilesPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    workspace_id: 'code-view-bus-demo',
    profiles: [
      {
        profile_id: 'bus-demo-wasm',
        label: 'Demo bus/platform Wasm 隔离模拟',
        kind: 'wasm32',
        binding: {
          workspace_id: 'code-view-bus-demo',
          variant_id: 'semantic-x86_64',
          repo_id: 'bus',
          snapshot_id: SNAPSHOT_ID,
        },
        module: {file: 'bus.wasm', sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: 8741},
        interfaces: [
          {name: 'reset', params: [], returns: 'void', role: 'util'},
          {name: 'bus_register', params: [{name: 'channel', type: 'u32', min: 0, max: 3}], returns: 'i32', role: 'entry', entry_id: BUS_SEND_ID},
          {name: 'bus_send', params: [{name: 'channel', type: 'u32', min: 0, max: 3}, {name: 'length', type: 'u32', min: 1, max: 65535}], returns: 'i32', role: 'entry', entry_id: BUS_SEND_ID},
          {name: 'set_platform_stub', params: [{name: 'return_code', type: 'i32', min: -4095, max: 0}], returns: 'void', role: 'stub_control'},
          {name: 'lookup_route', params: [{name: 'channel', type: 'u32', min: 0, max: 3}], returns: 'i32', role: 'util'},
        ],
        limits: {timeout_ms: 10000, steps: 20, events_per_step: 256},
        limitations: ['wasm_simulation_not_real_device', 'not_a_real_device_or_kernel'],
      },
    ],
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeScenarioSummary(overrides = {}) {
  return {
    scenario_id: 'scn_0123456789ab',
    profile_id: 'bus-demo-wasm',
    generation: 1,
    step_count: 3,
    created_at: '2026-11-15T07:30:00Z',
    updated_at: '2026-11-15T07:30:00Z',
    records_digest: 'b'.repeat(64),
    workspace_id: 'code-view-bus-demo',
    snapshot_id: SNAPSHOT_ID,
    observed: true,
    limitations: ['wasm_simulation_not_real_device'],
    ...overrides,
  };
}

export function makeScenarioLedgerPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    workspace_id: 'code-view-bus-demo',
    scenarios: [],
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeScenarioPlanPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    plan_id: 'plan_0123456789abcdef0123456789abcdef',
    profile_id: 'bus-demo-wasm',
    module_sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    scenario_id: 'scn_0123456789ab',
    scenario_digest: 'c'.repeat(64),
    generation: 1,
    steps: [
      {index: 0, interface: 'reset', role: 'util', args: []},
      {index: 1, interface: 'bus_register', role: 'entry', args: [1]},
      {index: 2, interface: 'bus_send', role: 'entry', args: [1, 48]},
    ],
    trace: {import: {module: 'env', field: 'trace'}, signature: ['i32', 'i32', 'i32', 'i32', 'i32']},
    limits: {timeout_ms: 10000, steps: 20, events_per_step: 256},
    expires_at: '2026-11-15T07:40:00Z',
    limitations: ['wasm_simulation_not_real_device'],
  };
  return {...base, ...overrides};
}

export function makeStubRecord(overrides = {}) {
  const base = {
    call_id: 'call_1_1',
    step_index: 0,
    interface: 'reset',
    args: [],
    status: 'ok',
    result: 0,
    memory_digest: 'd'.repeat(64),
    affected_resources: [],
    stubbed: false,
    execution_events: [],
  };
  return {...base, ...overrides};
}

export function makeScenarioRunPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    scenario: {
      scenario_id: 'scn_0123456789ab',
      generation: 1,
      profile_id: 'bus-demo-wasm',
      workspace_id: 'code-view-bus-demo',
      snapshot_id: SNAPSHOT_ID,
      records_digest: 'b'.repeat(64),
      created_at: '2026-11-15T07:30:00Z',
    },
    records: [
      makeStubRecord({call_id: 'call_1_1', step_index: 0, interface: 'reset', args: [], status: 'ok', result: 0}),
      makeStubRecord({call_id: 'call_1_2', step_index: 1, interface: 'bus_register', args: [1], status: 'ok', result: 0, execution_events: [{event_id: 'ev_1_1_0', event: 'DEFAULT_ROUTE', code: 1, a: 1, b: 0, c: 0, line: 60}]}),
      makeStubRecord({
        call_id: 'call_1_3',
        step_index: 2,
        interface: 'bus_send',
        args: [1, 48],
        status: 'ok',
        result: 0,
        execution_events: [
          {event_id: 'ev_1_2_0', event: 'REQUEST', code: 3, a: 1, b: 48, c: 0, line: 158},
          {event_id: 'ev_1_2_1', event: 'WRITE', code: 19, a: 4160, b: 131120, c: 0, line: 113},
        ],
        affected_resources: [{resource_id: 's_0860e6738eaa8c95f37d0d03', name: 'simulated_doorbell', access: 'write'}],
      }),
    ],
    limitations: ['wasm_simulation_not_real_device'],
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeObservedSequencePayload(overrides = {}) {
  const base = {
    schema_version: 1,
    mode: 'observed',
    observed: true,
    scenario: {
      scenario_id: 'scn_0123456789ab',
      generation: 1,
      profile_id: 'bus-demo-wasm',
      workspace_id: 'code-view-bus-demo',
      snapshot_id: SNAPSHOT_ID,
      records_digest: 'b'.repeat(64),
      created_at: '2026-11-15T07:30:00Z',
    },
    participants: [
      {participant_id: 'caller', label: '调用方'},
      {participant_id: 'driver', label: '驱动'},
      {participant_id: 'resource', label: '驱动资源'},
      {participant_id: 'platform', label: '平台/设备边界'},
    ],
    messages: [
      {message_id: 'm_1', index: 1, kind: 'call', from: 'caller', to: 'driver', label: 'bus_send(1, 48)', call_id: 'call_1_3', step_index: 2, status: 'ok', result: 0, observed: true, source_ref: {function_id: BUS_SEND_ID, file: 'bus.c', line: 152}, limitations: []},
      {message_id: 'm_2', index: 2, kind: 'event', from: 'driver', to: 'resource', label: 'WRITE simulated_doorbell', call_id: 'call_1_3', step_index: 2, status: 'ok', result: 0, observed: true, event: 'WRITE', code: 19, affected_resources: [{resource_id: 's_0860e6738eaa8c95f37d0d03', name: 'simulated_doorbell', access: 'write'}], source_ref: {function_id: BUS_SEND_ID, file: 'bus.c', line: 113}, limitations: []},
      {message_id: 'm_3', index: 3, kind: 'event', from: 'driver', to: 'platform', label: 'DOORBELL', call_id: 'call_1_3', step_index: 2, status: 'ok', result: 0, observed: true, event: 'DOORBELL', code: 21, source_ref: {function_id: BUS_SEND_ID, file: 'bus.c', line: 113}, limitations: []},
      {message_id: 'm_4', index: 4, kind: 'return', from: 'driver', to: 'caller', label: '返回 0', call_id: 'call_1_3', step_index: 2, status: 'ok', result: 0, observed: true, source_ref: null, limitations: []},
      {message_id: 'm_5', index: 5, kind: 'error', from: 'driver', to: 'caller', label: '返回 -2（未登记 channel）', call_id: 'call_1_4', step_index: 3, status: 'error', result: -2, observed: true, source_ref: {function_id: BUS_SEND_ID, file: 'bus.c', line: 152}, limitations: []},
      {message_id: 'm_6', index: 6, kind: 'call', from: 'caller', to: 'driver', label: 'set_platform_stub(-5)', call_id: 'call_1_5', step_index: 4, status: 'ok', result: null, observed: true, stubbed: true, source_ref: null, limitations: []},
      {message_id: 'm_7', index: 7, kind: 'event', from: 'platform', to: 'driver', label: 'IRQ', call_id: 'call_1_3', step_index: 2, status: 'ok', result: 0, observed: true, event: 'IRQ', code: null, async: true, source_ref: {function_id: BUS_SEND_ID, file: 'bus.c', line: 113}, limitations: []},
    ],
    warning: null,
    gaps: [],
    async_events: ['IRQ'],
    truncated: false,
    limitations: ['observed_wasm_simulation_not_real_device'],
  };
  return {...base, ...overrides};
}


export function makeFileTreePayload(overrides = {}) {
  const base = {
    schema_version: 1,
    snapshot: makeSnapshotBlock(),
    selection: makeSelection(),
    repos: [
      {
        repo_id: 'bus',
        role: 'other',
        files: [
          {path: 'bus.c', bytes: 4744, sha256: BUS_C_SHA256, has_evidence: true},
          {path: 'platform.c', bytes: 751, sha256: 'e'.repeat(64), has_evidence: true},
        ],
        truncated: false,
      },
    ],
    gaps: [],
  };
  return {...base, ...overrides};
}

export function makeImportedScenarioSummary(overrides = {}) {
  return makeScenarioSummary({
    scenario_id: 'scn_1a2b3c4d5e6f',
    generation: 1,
    step_count: 2,
    imported: true,
    source: 'imported_trace',
    label: '外部采集 bus_send 轨迹（示例）',
    limitations: ['imported_trace_not_executed_by_host', 'resource_effects_unknown_for_imported_trace'],
    ...overrides,
  });
}

export function makeUndoTailPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    scenario_id: 'scn_prefix000001',
    generation: 2,
    profile_id: 'bus-demo-wasm',
    workspace_id: 'code-view-bus-demo',
    snapshot_id: SNAPSHOT_ID,
    variant_id: 'semantic-x86_64',
    repo_id: 'bus',
    records_digest: 'e'.repeat(64),
    observed: true,
    created_at: '2026-11-15T09:00:00Z',
    undo: {of_scenario_id: 'scn_0123456789ab', of_generation: 3, count: 1, state_digest_verified: true},
    records: [
      makeStubRecord({call_id: 'call_2_1', step_index: 0, interface: 'reset', args: [], status: 'ok', result: null}),
      makeStubRecord({call_id: 'call_2_2', step_index: 1, interface: 'bus_register', args: [1], status: 'ok', result: 0, execution_events: [{event_id: 'ev_2_1_0', event: 'DEFAULT_ROUTE', code: 1, a: 1, b: 0, c: 0, line: 60}]}),
    ],
    limitations: ['replay_verified_by_memory_digest', 'wasm_simulation_not_real_device'],
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeTraceImportPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    scenario_id: 'scn_1a2b3c4d5e6f',
    generation: 1,
    imported: true,
    source: 'imported_trace',
    label: '外部采集 bus_send 轨迹（示例）',
    profile_id: 'bus-demo-wasm',
    workspace_id: 'code-view-bus-demo',
    snapshot_id: SNAPSHOT_ID,
    variant_id: 'semantic-x86_64',
    repo_id: 'bus',
    records_digest: 'f'.repeat(64),
    observed: true,
    created_at: '2026-11-15T09:10:00Z',
    records: [
      makeStubRecord({call_id: 'call_1_1', step_index: 0, interface: 'reset', args: [], status: 'ok', result: null}),
      makeStubRecord({
        call_id: 'call_1_2',
        step_index: 1,
        interface: 'bus_send',
        args: [1, 48],
        status: 'ok',
        result: 0,
        execution_events: [
          {event_id: 'ev_1_1_0', event: 'REQUEST', code: 4, a: 1, b: 48, c: 0, line: 158},
          {event_id: 'ev_1_1_1', event: 'DOORBELL', code: 19, a: 4160, b: 131120, c: 0, line: 113},
          {event_id: 'ev_1_1_2', event: 'WRITE', code: 7, a: 4160, b: 131120, c: 0, line: 113},
        ],
        affected_resources: [],
      }),
    ],
    limitations: ['imported_trace_not_executed_by_host', 'resource_effects_unknown_for_imported_trace'],
    gaps: [],
    truncated: false,
  };
  return {...base, ...overrides};
}

export function makeImportedObservedSequencePayload(overrides = {}) {
  const base = {
    schema_version: 1,
    mode: 'observed',
    observed: true,
    scenario: {
      scenario_id: 'scn_1a2b3c4d5e6f',
      generation: 1,
      profile_id: 'bus-demo-wasm',
      workspace_id: 'code-view-bus-demo',
      snapshot_id: SNAPSHOT_ID,
      records_digest: 'f'.repeat(64),
      created_at: '2026-11-15T09:10:00Z',
      imported: true,
      label: '外部采集 bus_send 轨迹（示例）',
    },
    participants: [
      {participant_id: 'caller', label: '调用方'},
      {participant_id: 'driver', label: '驱动'},
      {participant_id: 'resource', label: '驱动资源'},
      {participant_id: 'platform', label: '平台/设备边界'},
    ],
    messages: [
      {message_id: 'mi_1', index: 1, kind: 'call', from: 'caller', to: 'driver', label: 'bus_send(1, 48)', call_id: 'call_1_2', step_index: 1, status: 'ok', result: 0, observed: true, imported: true, source_ref: {function_id: BUS_SEND_ID, file: 'bus.c', line: 152}, limitations: []},
      {message_id: 'mi_2', index: 2, kind: 'event', from: 'driver', to: 'platform', label: 'WRITE', call_id: 'call_1_2', step_index: 1, status: 'ok', result: 0, observed: true, imported: true, event: 'WRITE', code: 7, affected_resources: [], source_ref: {function_id: BUS_SEND_ID, file: 'bus.c', line: 113}, limitations: []},
      {message_id: 'mi_3', index: 3, kind: 'event', from: 'driver', to: 'platform', label: 'DOORBELL', call_id: 'call_1_2', step_index: 1, status: 'ok', result: 0, observed: true, imported: true, event: 'DOORBELL', code: 19, source_ref: {function_id: BUS_SEND_ID, file: 'bus.c', line: 113}, limitations: []},
      {message_id: 'mi_4', index: 4, kind: 'return', from: 'driver', to: 'caller', label: '返回 0', call_id: 'call_1_2', step_index: 1, status: 'ok', result: 0, observed: true, imported: true, source_ref: null, limitations: []},
    ],
    warning: null,
    gaps: [],
    truncated: false,
    limitations: ['imported_trace_not_executed_by_host', 'resource_effects_unknown_for_imported_trace'],
  };
  return {...base, ...overrides};
}

export function makeSummaryRecord(overrides = {}) {
  const base = {
    schema_version: 1,
    workspace_id: 'code-view-bus-demo',
    snapshot_id: SNAPSHOT_ID,
    subject: {type: 'function', id: BUS_SEND_ID},
    text: 'bus_send 先校验 channel 与 length，再查询路由并检查长度；通过后写入平台模拟门铃。该归纳基于静态结构与源码证据。',
    facts: [
      {kind: 'evidence', ref: 'e_231505a73a485bc1d8c9249d'},
      {kind: 'node', ref: 'fn:' + BUS_SEND_ID},
      {kind: 'selection', ref: 'entry:' + BUS_SEND_ID},
    ],
    generator: {kind: 'agent', ref: 'skill:code-view', model_ref: null},
    inference_labels: ['from_static_structure', 'from_source_text'],
    generated_at: '2026-11-15T10:00:00Z',
    snapshot_graph_sha256: 'a'.repeat(64),
    stale: false,
    limitations: [],
  };
  return {...base, ...overrides};
}

export function makeSummaryPayload(overrides = {}) {
  const base = {
    schema_version: 1,
    workspace_id: 'code-view-bus-demo',
    snapshot_id: SNAPSHOT_ID,
    summaries: [],
    gaps: [],
    stale_count: 0,
  };
  return {...base, ...overrides};
}

export function makeSummaryGapPayload(overrides = {}) {
  return makeSummaryPayload({
    summaries: [],
    gaps: [{code: 'ai_summary_not_generated', status: 'unavailable', reason: '该 subject 还没有 AI 归纳记录'}],
    ...overrides,
  });
}

export function makeSummaryStalePayload(overrides = {}) {
  return makeSummaryPayload({
    summaries: [makeSummaryRecord({
      stale: true,
      limitations: ['summary_stale_against_current_snapshot'],
      text: '这是基于旧快照的归纳：bus_send 会写入门铃。',
    })],
    stale_count: 1,
    ...overrides,
  });
}

export function makeFirstScreenPayload(overrides = {}) {
  return {
    schema_version: 1,
    workspace_id: 'code-view-bus-demo',
    snapshot_id: SNAPSHOT_ID,
    entry_id: BUS_SEND_ID,
    view: 'coupling',
    entry: makeEntryPayload(),
    interfaces: makeInterfacesPayload(),
    view_payload: makeCouplingPayload(),
    sizes: {entry: 128, interfaces: 256, view: 512},
    truncated: false,
    limitations: [],
    ...overrides,
  };
}

export function makeBusFileLines(start, end) {
  const lines = [];
  for (let number = start; number <= end; number += 1) {
    let text = `    /* bus.c line ${number} */`;
    if (number === 46) text = '    routes[channel].max_len = max_len;';
    if (number === 92) text = '    unsigned max_len = route->max_len;';
    if (number === 152) text = 'int bus_send(unsigned channel, unsigned length)';
    if (number === 160) text = '    struct Route *route = lookup_route(channel);';
    if (number === 164) text = '    if (!check_length(route, length)) return -90;';
    lines.push({n: number, text});
  }
  return lines;
}

export function makeFileReadPayload(overrides = {}) {
  const lines = overrides.lines ?? makeBusFileLines(1, 174);
  const base = {
    schema_version: 1,
    snapshot: makeSnapshotBlock(),
    selection: makeSelection(),
    repo_id: 'bus',
    path: 'bus.c',
    sha256: BUS_C_SHA256,
    bytes: 4744,
    total_lines: 174,
    line_start: 1,
    line_end: 174,
    truncated: false,
    lines,
    evidence_ref: 'evidence:bus.c:1-174',
    gaps: [],
  };
  return {...base, ...overrides, lines};
}

export function makeSequencePayload(overrides = {}) {
  const base = {
    schema_version: 1,
    snapshot: makeSnapshotBlock(),
    selection: makeSelection({entry_id: BUS_SEND_ID, symbol_id: 's_9a99bb2c95e28f92052a6d4b'}),
    mode: 'static',
    observed: false,
    warning: '静态预测：无运行观测，不表示实际执行顺序或取值',
    participants: [
      {participant_id: 'caller', label: '调用方'},
      {participant_id: 'driver', label: '驱动'},
      {participant_id: 'resource', label: '资源'},
      {participant_id: 'external', label: '设备 / 库边界'},
    ],
    messages: [
      {message_id: 'm_1', index: 1, kind: 'call', from: 'caller', to: 'driver', label: 'bus_send(channel, length)', function_id: BUS_SEND_ID, callsite_id: null, entry_id: BUS_SEND_ID, depth: 0, certainty: 'exact', evidence_ids: ['e_entry'], limitations: []},
      {message_id: 'm_2', index: 2, kind: 'call', from: 'driver', to: 'resource', label: 'lookup_route(channel)', function_id: LOOKUP_ROUTE_ID, callsite_id: 'c_lookup', entry_id: BUS_SEND_ID, depth: 1, certainty: 'exact', evidence_ids: ['e_lookup'], limitations: []},
      {message_id: 'm_3', index: 3, kind: 'call', from: 'driver', to: 'driver', label: 'check_length(route, length)', function_id: CHECK_LENGTH_ID, callsite_id: 'c_check', entry_id: BUS_SEND_ID, depth: 1, certainty: 'exact', evidence_ids: ['e_check'], limitations: []},
      {message_id: 'm_4', index: 4, kind: 'access', from: 'driver', to: 'resource', label: 'routes[channel].max_len ← max_len', function_id: BUS_SEND_ID, callsite_id: null, entry_id: BUS_SEND_ID, depth: 2, certainty: 'may', evidence_ids: ['e_read'], limitations: ['alias_not_solved']},
      {message_id: 'm_5', index: 5, kind: 'external', from: 'driver', to: 'external', label: 'platform_write(TX_DOORBELL, encoded)', function_id: null, callsite_id: 'c_platform', entry_id: BUS_SEND_ID, depth: 2, certainty: 'may', evidence_ids: [], limitations: ['implementation_not_found']},
      {message_id: 'm_6', index: 6, kind: 'return', from: 'external', to: 'driver', label: '平台返回 0', function_id: null, callsite_id: null, entry_id: BUS_SEND_ID, depth: 2, certainty: 'may', evidence_ids: [], limitations: []},
      {message_id: 'm_7', index: 7, kind: 'error', from: 'driver', to: 'caller', label: '返回 -90', function_id: BUS_SEND_ID, callsite_id: null, entry_id: BUS_SEND_ID, depth: 0, certainty: 'may', evidence_ids: ['e_ret'], limitations: ['path_insensitive']},
    ],
    gaps: [{code: 'run_observation', status: 'unavailable', reason: 'S2a 无运行观测；场景 / 轨迹导入在 CW-T3'}],
    truncated: false,
  };
  return {...base, ...overrides};
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ENV_KEYS = ['window', 'document'];

function captureGlobals() {
  return ENV_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key) ?? null]);
}

function installGlobals(windowRef, documentRef) {
  Object.defineProperty(globalThis, 'window', {configurable: true, writable: true, value: windowRef});
  Object.defineProperty(globalThis, 'document', {configurable: true, writable: true, value: documentRef});
}

function restoreGlobals(saved) {
  for (const [key, descriptor] of saved) {
    try {
      if (descriptor === null) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    } catch {
      // best effort; the next harness re-installs the globals anyway
    }
  }
}

export function createHarness() {
  const documentRef = createDocument();
  const rpc = createRpc();
  const connection = {rpc};
  const slots = createSlots();
  const layout = createLayout();
  const ctx = createCtx({slots, layout, connection});
  const react = createReactRuntime();
  const registrations = [];
  const windowRef = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
      },
    },
    document: documentRef,
  };

  const savedGlobals = captureGlobals();
  installGlobals(windowRef, documentRef);

  let source = '';
  let loadError = null;
  try {
    source = readBundleSource();
    vm.runInThisContext(source, {filename: BUNDLE_FILE});
  } catch (error) {
    loadError = error;
  }

  const registration = registrations[0] ?? null;
  const requires = [];
  let plugin = null;
  let factoryError = null;
  if (registration) {
    const requireStub = (id) => {
      requires.push(id);
      if (id === 'react') return react.react;
      throw new Error(`bundle required a non-static module: ${id}`);
    };
    try {
      plugin = registration.factory(requireStub);
    } catch (error) {
      factoryError = error;
    }
  }

  const harness = {
    projectRoot: PROJECT_ROOT,
    bundleFile: BUNDLE_FILE,
    source,
    loadError,
    registrations,
    registration,
    requires,
    plugin,
    factoryError,
    window: windowRef,
    document: documentRef,
    rpc,
    api: rpc,
    connection,
    slots,
    layout,
    ctx,
    react,
    errors: react.renderErrors,
    apply() {
      if (plugin === null) throw factoryError ?? new Error('client module factory did not run');
      plugin.apply(ctx);
      return harness;
    },
    async boot() {
      harness.apply();
      harness.mountMain();
      await harness.settle();
      return harness;
    },
    mountMain() {
      const entry = harness.mainEntry();
      if (!entry) throw new Error(`main slot "${PANEL_KEY}" is not registered`);
      react.mount(entry.component, {});
      return harness;
    },
    unmountMain() {
      react.unmount();
      return harness;
    },
    remountMain() {
      harness.mountMain();
      return harness;
    },
    mainEntry() {
      return slots.entriesOfSlot('main').find((entry) => entry.options?.key === PANEL_KEY) ?? null;
    },
    panellistEntry() {
      return slots.entriesOfSlot('sidebar.panellist').find((entry) => entry.options?.id === PANEL_KEY) ?? null;
    },
    tree() {
      return react.tree();
    },
    text() {
      return textOf(react.tree());
    },
    findAll(predicate) {
      return findNodes(react.tree(), predicate);
    },
    find(predicate) {
      return findNodes(react.tree(), predicate)[0] ?? null;
    },
    findByData(attribute, value) {
      return findNodes(react.tree(), (node) => {
        const attributeValue = node.props?.[attribute];
        return attributeValue !== undefined && String(attributeValue) === String(value);
      });
    },
    nodeByData(attribute, value) {
      return harness.findByData(attribute, value)[0] ?? null;
    },
    textOf(node) {
      return textOf(node);
    },
    clickNode(node) {
      if (!node) throw new Error('clickNode: node is missing');
      if (typeof node.props?.onClick !== 'function') throw new Error(`clickNode: <${node.tag}> has no onClick`);
      node.props.onClick({preventDefault() {}, stopPropagation() {}, currentTarget: node});
      return node;
    },
    clickData(attribute, value) {
      return harness.clickNode(harness.nodeByData(attribute, value));
    },
    button(label) {
      return findNodes(react.tree(), (node) => node.tag === 'button' && textOf(node).includes(label))[0] ?? null;
    },
    clickButton(label) {
      const button = harness.button(label);
      if (!button) throw new Error(`button containing ${JSON.stringify(label)} not found in: ${harness.text()}`);
      return harness.clickNode(button);
    },
    styleNode() {
      return documentRef.querySelector('style[data-code-view-style]');
    },
    styleCount() {
      return documentRef.querySelectorAll('style[data-code-view-style]').length;
    },
    async settle() {
      await react.settle();
      return harness;
    },
    dispose() {
      react.dispose();
      ctx.dispose();
      restoreGlobals(savedGlobals);
      return harness;
    },
  };
  return harness;
}
