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
    return {
      tag: typeof type === 'string' ? type : '#unknown',
      props,
      children: children === null ? [] : Array.isArray(children) ? children : [children],
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
      five_views: false,
      resource_graph: false,
      scenario_execution: false,
      run_observation: false,
    },
    gaps: [{code: 'scenario_execution', status: 'unavailable', reason: '本轮只读切片；场景执行/打桩/回退未实现'}],
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
    entry_id: 'f_bus_send',
    symbol_id: 's_bus_send',
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
      entry_id: 'f_store_route',
      symbol_id: 's_store_route',
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
        owner: {entry_id: 'f_bus_send', name: 'bus_send', file: 'bus.c', line: 152},
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
    entry_id: 'f_bus_send',
    symbol_id: 's_bus_send',
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
      entry_id: 'f_bus_send',
      symbol_id: 's_bus_send',
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
