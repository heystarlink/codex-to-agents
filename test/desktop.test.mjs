import test from 'node:test';
import assert from 'node:assert/strict';
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
  });
  assert.deepEqual(queried, ['account', 'broken', 'other']);
  assert.deepEqual(await desktop.choose({ provider: 'other' }), { provider: 'other', model: 'flash', reasoningEffort: 'low' });
  await assert.rejects(desktop.choose({ provider: 'broken' }), /not available/);
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
  });
  assert.deepEqual(await desktop.choose({}), { provider: 'account', model: 'flash' });
  await assert.rejects(desktop.choose({ provider: 'other' }), /outside/);
  await assert.rejects(desktop.choose({ provider: 'retired' }), /not loaded/);
  desktop.allow({ provider: 'account' });
  assert.throws(() => desktop.allow({ provider: 'retired' }), /not loaded/);
  assert.throws(() => desktop.allow({ provider: 'other' }), /outside/);
});
