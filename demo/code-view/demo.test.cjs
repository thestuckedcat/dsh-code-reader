const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { projectEdges, groupSummary, observedInPath } = require('./graph-model.cjs');

const page = readFileSync(`${__dirname}/index.html`, 'utf8');
const bundle = JSON.parse(page.match(/<script type="application\/json" id="bundle">(.*?)<\/script>/s)[1]);
const source = readFileSync(`${__dirname}/bus.c`, 'utf8').split(/\r?\n/);

async function fixture() {
  const events = [];
  const { instance } = await WebAssembly.instantiate(Buffer.from(bundle.wasm, 'base64'), {
    env: { trace: (...event) => events.push(event) },
  });
  return { c: instance.exports, events };
}

test('interface registration selects the default route and observes the C write', async () => {
  const { c, events } = await fixture();
  assert.equal(c.bus_register(1), 0);
  assert.equal(c.bus_send(1, 48), 0);
  const [write] = events.filter(([kind]) => kind === bundle.events.WRITE);
  assert.deepEqual(write.slice(1, 4), [0x1040, 0x20030, 0]);
  assert.match(bundle.platform.split('\n')[write[4] - 1], /trace\(WRITE/);
});

test('a stub route changes the write and resetting discards the previous state', async () => {
  const { c, events } = await fixture();
  assert.equal(c.stub_route(1, 3, 96), 0);
  assert.equal(c.bus_send(1, 48), 0);
  assert.deepEqual(events.find(([kind]) => kind === bundle.events.WRITE).slice(1, 4), [0x1040, 0x30030, 0]);
  c.reset();
  events.length = 0;
  assert.equal(c.bus_send(1, 48), -2);
  assert.equal(events.some(([kind]) => kind === bundle.events.WRITE), false);
});

test('unregistered keys, invalid input and long payloads return without a write', async () => {
  const { c, events } = await fixture();
  assert.equal(c.bus_register(1), 0);
  assert.equal(c.bus_send(0, 48), -2);
  assert.equal(c.bus_send(1, 65), -90);
  assert.equal(c.bus_send(1, 0), -22);
  assert.equal(c.stub_route(1, 4, 32), -22);
  assert.equal(events.some(([kind]) => kind === bundle.events.WRITE), false);
});

test('call graph and embedded code map to fixture source', () => {
  assert.deepEqual(bundle.functions.bus_send.calls, ['lookup_route', 'check_length', 'dispatch_transfer']);
  assert.deepEqual(bundle.functions.dispatch_transfer.calls, ['submit_buffered', 'submit_direct']);
  assert.deepEqual(bundle.functions.submit_buffered.calls, ['stage_payload', 'commit_transfer']);
  assert.deepEqual(bundle.functions.commit_transfer.calls, ['encode_doorbell', 'write_doorbell']);
  assert.deepEqual(bundle.functions.bus_register.calls, ['store_route']);
  assert.match(source[bundle.functions.bus_send.first - 1], /^int bus_send\(/);
  assert.equal(bundle.source, source.join('\n'));
});

test('48 bytes take the direct branch and 49 bytes stage before encoding', async () => {
  const { c, events } = await fixture();
  c.bus_register(1);
  events.length = 0;
  assert.equal(c.bus_send(1, 48), 0);
  assert.equal(events.find(([kind]) => kind === bundle.events.TRANSFER)[2], 0);
  assert.equal(events.some(([kind]) => kind === bundle.events.STAGE), false);
  events.length = 0;
  assert.equal(c.bus_send(1, 49), 0);
  assert.equal(events.find(([kind]) => kind === bundle.events.TRANSFER)[2], 1);
  const stage = events.findIndex(([kind]) => kind === bundle.events.STAGE);
  const encode = events.findIndex(([kind]) => kind === bundle.events.ENCODE);
  assert.ok(stage >= 0 && stage < encode);
  assert.equal(events.find(([kind]) => kind === bundle.events.WRITE)[2], 0x20031);
});

test('nested folding reconnects edges and merges duplicate boundary links', () => {
  const groups = { outer: ['start', 'inner'], inner: ['left', 'right'] };
  const links = [
    { from: 'entry', to: 'start', active: true },
    { from: 'start', to: 'left', active: true },
    { from: 'left', to: 'exit', active: true },
    { from: 'right', to: 'exit', active: false },
  ];
  const describe = (open) => projectEdges(groups, open, links).map(({from, to, active}) => [from, to, active]);
  assert.deepEqual(describe(new Set(['inner'])), [['entry', 'outer', true], ['outer', 'exit', true]]);
  assert.deepEqual(describe(new Set(['outer'])), [['entry', 'start', true], ['start', 'inner', true], ['inner', 'exit', true]]);
  assert.deepEqual(describe(new Set(['outer', 'inner'])).slice(-2), [['left', 'exit', true], ['right', 'exit', false]]);
  assert.equal(groupSummary('outer', groups, { start: '选择路由', left: '直发', right: '暂存' }).description, '选择路由、直发、暂存');
});

test('a shared implementation does not borrow observations from the other caller', () => {
  const names = new Set(['dispatch_transfer', 'submit_buffered', 'commit_transfer', 'encode_doorbell']);
  assert.equal(observedInPath(['dispatch_transfer', 'submit_direct', 'commit_transfer'], names), false);
  assert.equal(observedInPath(['dispatch_transfer', 'submit_buffered', 'commit_transfer'], names), true);
});

test('platform return stubs propagate to the entry and release the transfer lock', async () => {
  const { c, events } = await fixture();
  assert.equal(c.bus_register(1), 0);
  c.set_platform_stub(-5);
  assert.equal(c.bus_send(1, 48), -5);
  assert.equal(events.some(([kind]) => kind === bundle.events.WRITE), false);
  assert.deepEqual(events.filter(([kind]) => kind === bundle.events.LOCK).map(([, held]) => held), [1, 0]);
  c.set_platform_stub(0);
  assert.equal(c.bus_send(1, 48), 0);
  assert.equal(c.bus_irq(), 0);
  assert.equal(events.find(([kind]) => kind === bundle.events.IRQ)[1], 1);
  assert.equal(bundle.functions.platform_write.repo, 'platform');
  assert.ok(bundle.functions.write_doorbell.calls.includes('platform_write'));
});
