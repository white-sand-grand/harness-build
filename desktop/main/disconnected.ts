import type { Snapshot } from '../contracts.ts';

export function disconnectedSnapshot(previous?: Snapshot): Snapshot {
  const snapshot: Snapshot = previous ?? {
    protocolVersion: 1,
    seq: 0,
    sessions: [],
    messages: [],
    activities: [],
    streamingText: '',
    approvals: [],
    models: [],
  };
  const active = snapshot.run && ['running', 'thinking', 'waitingApproval', 'cancelling'].includes(snapshot.run.status);
  return {
    ...snapshot,
    seq: snapshot.seq + 1,
    approvals: [],
    streamingText: '',
    activities: snapshot.activities.map((activity) =>
      activity.status === 'running' ? { ...activity, status: 'failed' } : activity,
    ),
    error: '执行服务已退出。请重新打开应用；未完成的工具不会自动重跑。',
    ...(active && { run: { ...snapshot.run!, status: 'failed', verification: 'incomplete', error: '执行服务中断' } }),
  };
}
