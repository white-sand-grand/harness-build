import assert from 'node:assert/strict';
import test from 'node:test';
import { disconnectedSnapshot } from '../main/disconnected.ts';
import type { Snapshot } from '../contracts.ts';

const fixture = (): Snapshot => ({
  protocolVersion: 1,
  seq: 4,
  sessions: [],
  messages: [],
  models: [],
  streamingText: 'partial',
  approvals: [{ id: 'ask', runId: 'run', title: 'Approve', detail: 'command' }],
  activities: [{ id: 'tool', name: 'bash', status: 'running', input: 'command', output: 'partial output' }],
  run: {
    id: 'run',
    sessionId: 'session',
    status: 'thinking',
    modelId: 'model',
    modelName: 'Model',
    thinking: 'high',
    verification: 'notRun',
    inputTokens: 1,
    outputTokens: 2,
  },
});

test('Host crash removes pending execution UI and fails only its active run', () => {
  const original = fixture();
  const next = disconnectedSnapshot(original);
  assert.equal(next.run?.status, 'failed');
  assert.equal(next.run?.verification, 'incomplete');
  assert.equal(next.streamingText, '');
  assert.equal(next.approvals.length, 0);
  assert.equal(next.activities[0]?.status, 'failed');
  assert.equal(next.activities[0]?.output, 'partial output');
  assert.equal(next.seq, 5);
  assert.equal(original.run?.status, 'thinking');
});

test('Idle Host exit preserves a completed run and its verified result', () => {
  const original = fixture();
  original.run!.status = 'completed';
  original.run!.verification = 'passed';
  original.activities[0]!.status = 'completed';
  const next = disconnectedSnapshot(original);
  assert.deepEqual(next.run, original.run);
  assert.equal(next.activities[0]?.status, 'completed');
  assert.match(next.error!, /重新打开/);
});
