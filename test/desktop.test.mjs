import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Desktop } from '../src/desktop.mjs';

test('Agent observation reports native running/idle/unloaded states without inferring from old tasks', () => {
  const registry = new Map([['one', { status: 'running' }], ['two', { status: 'idle' }]]);
  const desktop = new Desktop({ agents: { get: id => registry.get(id) } }, { providers: [] });
  assert.deepEqual(desktop.observe(['one', 'two', 'cold', 'one']), [
    { id: 'one', status: 'running' }, { id: 'two', status: 'idle' }, { id: 'cold', status: 'unloaded' },
  ]);
});

test('model routing uses the explicit provider list and validates exact model capabilities', async () => {
  const queried = [];
  const context = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'account', model: 'flash' }) },
    llm: {
      listProviders: () => [{ id: 'account' }, { id: 'other' }],
      async listModels(provider) { queried.push(provider);return [{ id: 'flash' }]; },
      async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }; },
      async resolveCallConfig(value) { return value; },
    },
  };
  const desktop = new Desktop(context, { providers: ['account'] });
  assert.deepEqual(await desktop.choose({}), { provider: 'account', model: 'flash', reasoningEffort: 'low' });
  assert.deepEqual(queried, ['account']);
  await assert.rejects(desktop.choose({ provider: 'other' }), /outside/);
  await assert.rejects(desktop.choose({ model: 'missing' }), /not available/);
  await assert.rejects(desktop.choose({ effort: 'invented' }), /Unsupported/);
});

test('prompt submission uses the public AbortSignal API, protects model routing, and rejects archived chats', async () => {
  let guard;
  let delivered;
  const agent = { ctx: { on(_name, handler) { guard = handler;return () => {}; } } };
  const context = {
    effect() {}, workspaceRegistry: { archivedSessionIds: [] },
    sessionController: {
      agents: { async resolveAgent() { return { agent }; } },
      async prompt(request, signal) { signal.throwIfAborted();delivered = request; },
    },
  };
  const desktop = new Desktop(context, { providers: ['account'] });
  await desktop.send({ id: 'order-1' }, { conversation_id: 'chat-1' }, 'hello', 'steer');
  assert.equal(delivered.requestId, 'order-1');assert.equal(delivered.mode, 'steer');
  await assert.rejects(guard({}, async () => ({ provider: 'other' })), /outside/);
  context.workspaceRegistry.archivedSessionIds.push('chat-1');
  await assert.rejects(desktop.send({ id: 'order-2' }, { conversation_id: 'chat-1' }, 'hello', 'queue'), /Restore/);
});

test('the provider boundary wraps native session model selection instead of rejecting the underlying desktop default', async () => {
  const handlers = [async (_payload, next) => ({ ...await next(), provider: 'account', model: 'flash' })];
  const agent = { ctx: { on(name, handler, options) {
    assert.equal(name, 'agent/request');assert.equal(options.prepend, true);handlers.unshift(handler);return () => {};
  } } };
  const desktop = new Desktop({ effect() {}, llm: { listProviders: () => [{ id: 'account' }] } }, { providers: ['account'] });desktop.protect(agent);
  const invoke = index => index === handlers.length ? Promise.resolve({ provider: 'desktop-default', model: 'other' })
    : handlers[index]({}, () => invoke(index + 1));
  assert.deepEqual(await invoke(0), { provider: 'account', model: 'flash' });
});

test('pre-admission failures correlate a claimed inbox message without taking the prior active turn as its result', async () => {
  const message = { id: 'message', source: { kind: 'user', rpcId: 'wanted' } };
  const events = [
    { seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } },
    { seq: 1, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'prior unrelated failure' } } } },
  ];
  const desktop = new Desktop({ sessionQuery: { async readSession() { return { events }; } } }, { providers: ['account'] });
  const state = { conversation_id: 'chat-1', status: 'executing' };
  assert.equal((await desktop.progress({ id: 'wanted' }, state)).status, 'executing');
  events.push({ seq: 2, type: 'turn/start', data: { turn: 2 } },
    { seq: 3, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { seq: 4, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'selected model rejected' } } } });
  const failed = await desktop.progress({ id: 'wanted' }, state);
  assert.equal(failed.status, 'failed');assert.equal(failed.progress, 'selected model rejected');
  events[4].data.reason = { kind: 'completed' };
  assert.equal((await desktop.progress({ id: 'wanted' }, state)).status, 'uncertain');
});

test('native event projection correlates each order and excludes prior replies, later turns and reasoning', async () => {
  const events = [
    { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old' }] } } },
    { seq: 1, type: 'user/message', data: { source: { rpcId: 'wanted' } } },
    { seq: 2, type: 'assistant/thought', data: { text: 'hidden' } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'correct' }] } } },
    { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'later' }] } } },
  ];
  const desktop = new Desktop({ sessionQuery: { async readSession() { return { events }; } } }, { providers: [] });
  const projected = await desktop.progress({ id: 'wanted' }, { conversation_id: 'chat-1', status: 'executing' });
  assert.equal(projected.status, 'completed');assert.equal(projected.output.text, 'correct');
  assert.equal((await desktop.progress({ id: 'not-admitted' }, { conversation_id: 'chat-1', status: 'executing' })).status, 'executing');
});

test('a wildcard provider list follows the currently loaded DSH providers and isolates one failed catalog', async () => {
  const live = ['account', 'broken', 'other'];
  const queried = [];
  const llm = {
    listProviders: () => live.map(id => ({ id })),
    async listModels(provider) {
      queried.push(provider);
      if (provider === 'broken') throw new Error('provider catalog unavailable');
      return [{ id: 'flash', name: 'Flash' }];
    },
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }; },
    async resolveCallConfig(value) { return value; },
  };
  const desktop = new Desktop({ llm, agentDefaultModel: { currentSelection: () => ({ provider: 'account', model: 'flash' }) } },
    { providers: ['*'] });
  assert.deepEqual(await desktop.describe(), {
    models: [
      { provider: 'account', model: 'flash', name: 'Flash', efforts: ['low'], default_effort: 'low' },
      { provider: 'other', model: 'flash', name: 'Flash', efforts: ['low'], default_effort: 'low' },
    ],
    unavailable_providers: ['broken'],
    permission_control: { available: false, presets: [] },
  });
  assert.deepEqual(queried, ['account', 'broken', 'other']);
  assert.deepEqual(await desktop.choose({ provider: 'other' }), { provider: 'other', model: 'flash', reasoningEffort: 'low' });
  await assert.rejects(desktop.choose({ provider: 'broken' }), /not available/);
});

test('the heartbeat advertises native permission control so older consumers are distinguishable', async () => {
  const llm = {
    listProviders: () => [{ id: 'account' }],
    async listModels() { return [{ id: 'flash', name: 'Flash' }]; },
    async resolveModelInfo() { return {}; },
  };
  const native = {
    catalog: () => ({ options: [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'auto', name: 'auto' },
      { value: 'danger-full-access', name: 'danger-full-access' },
    ] }),
    async set() {}, current() { return 'read-only'; },
  };
  const available = new Desktop({ llm, get: name => name === 'permissionPresets' ? native : undefined }, { providers: ['account'] });
  assert.deepEqual((await available.describe()).permission_control,
    { available: true, presets: ['read-only', 'workspace-write', 'danger-full-access'] });
  // A partial service (catalog only) must not be advertised as usable: the
  // adapter also needs set() and current() to apply and verify a preset.
  const partial = new Desktop({ llm, get: name => name === 'permissionPresets' ? { catalog: native.catalog } : undefined }, { providers: ['account'] });
  assert.deepEqual((await partial.describe()).permission_control, { available: false, presets: [] });
  // A plugin whose native catalog fails still loads; the board sees "unavailable"
  // instead of assuming permission_control exists.
  const broken = new Desktop({ llm, get: name => name === 'permissionPresets' ? { catalog() { throw new Error('unavailable'); }, async set() {}, current() {} } : undefined }, { providers: ['account'] });
  assert.deepEqual((await broken.describe()).permission_control, { available: false, presets: [] });
  const missing = new Desktop({ llm, get: () => undefined }, { providers: ['account'] });
  assert.deepEqual((await missing.describe()).permission_control, { available: false, presets: [] });
});

test('wildcard routing stops new work and follow-ups once DSH unloads a provider', async () => {
  const live = ['account'];
  const events = [{ seq: 0, type: 'model/selection', data: { provider: 'account', model: 'flash' } }];
  let guard;
  const context = {
    llm: {
      listProviders: () => live.map(id => ({ id })),
      async listModels() { return [{ id: 'flash', name: 'Flash' }]; },
      async resolveModelInfo() { return {}; }, async resolveCallConfig(value) { return value; },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'account', model: 'flash' }) },
    sessionQuery: { async readSession() { return { events, session: { cwd: '/tmp' } }; } },
    effect() {},
  };
  const desktop = new Desktop(context, { providers: ['*'] });
  const agent = { ctx: { on(_name, handler) { guard = handler;return () => {}; } } };
  desktop.protect(agent);
  assert.deepEqual(await guard({}, async () => ({ provider: 'account', model: 'flash' })), { provider: 'account', model: 'flash' });
  live.splice(0, 1, 'other');
  assert.deepEqual((await desktop.describe()).models.map(model => model.provider), ['other']);
  await assert.rejects(guard({}, async () => ({ provider: 'account', model: 'flash' })), /not loaded/);
  await assert.rejects(desktop.choose({}), /not loaded/);
  await assert.rejects(desktop.checkpoint('chat-1'), /not loaded/);
  events[0] = { seq: 0, type: 'model/selection', data: { provider: 'other', model: 'flash' } };
  assert.equal((await desktop.checkpoint('chat-1')).route.provider, 'other');
  assert.throws(() => desktop.allow({ provider: 'account' }), /not loaded/);
});

test('the explicit provider allowlist is preserved and mixing it with a wildcard is rejected', async () => {
  const llm = {
    listProviders: () => [{ id: 'account' }],
    async listModels() { return [{ id: 'flash', name: 'Flash' }]; },
    async resolveModelInfo() { return {}; }, async resolveCallConfig(value) { return value; },
  };
  assert.throws(() => new Desktop({ llm }, { providers: ['*', 'account'] }), /not both/);
  const desktop = new Desktop({ llm, agentDefaultModel: { currentSelection: () => ({ provider: 'account', model: 'flash' }) } },
    { providers: ['account', 'retired'] });
  assert.deepEqual(await desktop.describe(), {
    models: [{ provider: 'account', model: 'flash', name: 'Flash', efforts: [], default_effort: null }],
    unavailable_providers: ['retired'],
    permission_control: { available: false, presets: [] },
  });
  assert.deepEqual(await desktop.choose({}), { provider: 'account', model: 'flash' });
  await assert.rejects(desktop.choose({ provider: 'other' }), /outside/);
  await assert.rejects(desktop.choose({ provider: 'retired' }), /not loaded/);
  desktop.allow({ provider: 'account' });
  assert.throws(() => desktop.allow({ provider: 'retired' }), /not loaded/);
  assert.throws(() => desktop.allow({ provider: 'other' }), /outside/);
});

// A saved DSH permission is a preset name, not a sandbox/approval pair. These
// fixtures mirror the native service contract: set(session, name) records the
// preset and both knob events, current(session) folds them back.
const PRESET_BUNDLES = {
  'read-only': ['read-only', 'ask'],
  'workspace-write': ['workspace-write', 'ask'],
  'danger-full-access': ['danger-full-access', 'never'],
};

async function permissionHome(t, delegation) {
  const home = await mkdtemp(join(tmpdir(), 'cta-dsh-permission-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (delegation !== undefined) await writeFile(join(home, 'delegation.json'), typeof delegation === 'string' ? delegation : JSON.stringify(delegation));
  return home;
}

function fakePermissionService({ presets = Object.keys(PRESET_BUNDLES), fail = {}, sequence = [] } = {}) {
  const calls = { set: [], current: 0 };
  return { calls, service: {
    catalog() {
      sequence.push('permission-catalog');
      if (fail.catalog) throw new Error(fail.catalog);
      return { options: presets.map(value => ({ value, name: value })) };
    },
    async set(session, name) {
      sequence.push('permission-set');
      calls.set.push(name);
      if (fail.set) throw new Error(fail.set);
      const [sandbox, approval] = PRESET_BUNDLES[name];
      // Native semantics: append only the facts whose effective value differs.
      if (session.permission?.preset !== name) session.events.push({ type: 'permission/preset', data: { preset: name } });
      if (sandbox !== session.permission?.sandbox) session.events.push({ type: 'sandbox/mode', data: { mode: sandbox } });
      if (approval !== session.permission?.approval) session.events.push({ type: 'approval/policy', data: { policy: approval } });
      session.permission = { preset: name, sandbox, approval };
    },
    current(session) {
      sequence.push('permission-current');
      calls.current++;
      if (fail.current) throw new Error(fail.current);
      if (fail.mismatch) return 'custom';
      return session.permission?.preset ?? 'workspace-write';
    },
  } };
}

function startFixture({ home, sequence = [], permission = fakePermissionService({ sequence }), failCreate } = {}) {
  // The native service pins the composition default (workspace-write) when the
  // session is created; the adapter must not add a permission event for it.
  const session = { events: [], permission: { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' } };
  const agent = { session, ctx: { on() { return () => {}; } } };
  const context = {
    effect() {},
    get(name) { if (name === 'permissionPresets') return permission?.service; },
    agentDefaultModel: { currentSelection: () => ({ provider: 'account', model: 'flash' }) },
    llm: {
      listProviders: () => [{ id: 'account' }],
      async listModels() { return [{ id: 'flash', name: 'Flash' }]; },
      async resolveModelInfo() { return {}; },
      async resolveCallConfig(value) { return value; },
    },
    agents: { get() { sequence.push('agent'); return agent; } },
    sessionController: {
      async create() { sequence.push('create'); if (failCreate) throw new Error(failCreate); return { sessionId: 'cw-order-1' }; },
      async rename() { sequence.push('rename'); },
      agents: { selectForNextRequest() { sequence.push('select'); }, async resolveAgent() { return { agent }; } },
      async prompt() { sequence.push('prompt'); },
    },
    sessionQuery: { async readSession() { sequence.push('read'); return { events: session.events, session: { cwd: home } }; } },
    workspaceRegistry: { archivedSessionIds: [] },
  };
  const desktop = new Desktop(context, { providers: ['account'], home, defaultDirectory: home });
  const order = { id: 'order-1', payload: { goal: 'Do the work.', directory: home } };
  return { desktop, order, session, sequence, permission };
}

test('each explicit DSH permission maps to its native preset before the first task message', async t => {
  for (const preset of Object.keys(PRESET_BUNDLES)) {
    const home = await permissionHome(t, { enabled: true, executor: 'dsh', dsh_permission: preset });
    const { desktop, order, session, sequence, permission } = startFixture({ home });
    const location = await desktop.start(order);
    assert.deepEqual(location.permission, { preset, effective: preset });
    assert.deepEqual(permission.calls.set, [preset], 'the adapter switches to the saved native preset');
    // The permission switch is part of session creation and strictly precedes
    // the first prompt; the returned checkpoint also precedes it.
    const permissionAt = sequence.indexOf('permission-set');
    assert.ok(permissionAt > sequence.indexOf('create'));
    assert.ok(permissionAt < sequence.indexOf('select'));
    assert.ok(permissionAt < sequence.indexOf('rename'));
    assert.ok(permissionAt < sequence.indexOf('read'));
    await desktop.send(order, location, order.payload.goal, 'queue');
    assert.ok(sequence.indexOf('permission-current') < sequence.indexOf('prompt'));
    assert.ok(sequence.lastIndexOf('permission-set') < sequence.indexOf('prompt'));
    // The applied preset writes the native identity and both knobs, not just a
    // UI value. Selecting the already-pinned default appends nothing.
    assert.deepEqual(session.permission, { preset, sandbox: PRESET_BUNDLES[preset][0], approval: PRESET_BUNDLES[preset][1] });
    if (preset === 'workspace-write') {
      assert.equal(session.events.length, 0, 'the already-pinned native default needs no extra events');
    } else {
      assert.deepEqual(session.events.find(event => event.type === 'permission/preset'),
        { type: 'permission/preset', data: { preset } });
      assert.deepEqual(session.events.find(event => event.type === 'sandbox/mode'),
        { type: 'sandbox/mode', data: { mode: PRESET_BUNDLES[preset][0] } });
    }
  }
});

test('omitting the DSH permission follows the session default and touches no native knob', async t => {
  for (const delegation of [undefined, { enabled: true, executor: 'dsh' }]) {
    const home = await permissionHome(t, delegation);
    const { desktop, order, session, permission } = startFixture({ home });
    const location = await desktop.start(order);
    assert.equal(location.permission, undefined);
    assert.deepEqual(permission.calls.set, []);
    assert.equal(session.events.length, 0, 'no permission event is appended when following the DSH default');
    assert.equal(session.permission.preset, 'workspace-write', 'the native session default is preserved');
  }
});

test('an explicit DSH permission fails closed before creating a session when DSH cannot honor it', async t => {
  const home = await permissionHome(t, { enabled: true, executor: 'dsh', dsh_permission: 'read-only' });
  // No native permission service in this DSH.
  const missing = startFixture({ home });
  missing.permission.service = undefined;
  let created = false;
  missing.desktop.context.sessionController.create = async () => { created = true; return { sessionId: 'cw-order-1' }; };
  await assert.rejects(missing.desktop.start(missing.order), /未提供新会话权限控制/);
  assert.equal(created, false, 'dispatch stops before a session is created');
  // The service exists but the saved preset is not configured in this DSH.
  const unavailable = startFixture({ home, permission: fakePermissionService({ presets: ['workspace-write', 'danger-full-access'] }) });
  await assert.rejects(unavailable.desktop.start(unavailable.order), /未提供权限预设“仅可查看”/);
  assert.equal(unavailable.sequence.includes('create'), false);
});

test('unknown, unparsable or non-string saved permissions also block dispatch', async t => {
  for (const dshPermission of ['everything', null, 7, { sandbox: 'danger-full-access' }]) {
    const unknown = await permissionHome(t, { enabled: true, executor: 'dsh', dsh_permission: dshPermission });
    const first = startFixture({ home: unknown });
    await assert.rejects(first.desktop.start(first.order), /不受支持/);
    assert.equal(first.sequence.includes('create'), false);
  }

  const corrupt = await permissionHome(t, '{not json');
  const second = startFixture({ home: corrupt });
  await assert.rejects(second.desktop.start(second.order), /无法解析/);
  assert.equal(second.sequence.includes('create'), false);
});

test('a native permission failure or verification mismatch blocks the first message', async t => {
  const home = await permissionHome(t, { enabled: true, executor: 'dsh', dsh_permission: 'danger-full-access' });
  const failed = startFixture({ home, permission: fakePermissionService({ fail: { set: 'approval service rejected the preset' } }) });
  await assert.rejects(failed.desktop.start(failed.order), /未应用新会话权限“完全权限”/);
  assert.ok(failed.sequence.includes('create'), 'the session exists, but work is not sent');
  assert.equal(failed.sequence.includes('select'), false, 'model selection and rename do not continue after a failed permission');
  assert.equal(failed.sequence.includes('prompt'), false);

  const mismatch = startFixture({ home, permission: fakePermissionService({ fail: { mismatch: true } }) });
  await assert.rejects(mismatch.desktop.start(mismatch.order), /未生效（请求“完全权限”，实际 custom）/);
  assert.equal(mismatch.sequence.includes('prompt'), false);
});

test('follow-ups and resumed conversations never reapply the DSH permission', async t => {
  const home = await permissionHome(t, { enabled: true, executor: 'dsh', dsh_permission: 'read-only' });
  const { desktop, order, session, permission } = startFixture({ home });
  session.events.push({ type: 'model/selection', data: { provider: 'account', model: 'flash' } });
  await desktop.send(order, { conversation_id: 'chat-existing' }, 'Continue the work.', 'queue');
  await desktop.checkpoint('chat-existing');
  assert.deepEqual(permission.calls.set, []);
  assert.equal(permission.calls.current, 0);
});
