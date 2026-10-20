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
