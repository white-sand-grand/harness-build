import { useState } from 'react';
import type { FormEvent } from 'react';
import type { BackgroundView, HostCommand, ThinkingLevel } from '../contracts.ts';

const labels: Record<string, string> = {
  active: '等待事件',
  blocked: '需要处理',
  waitingApproval: '等待确认',
  completed: '已结束',
  cancelled: '已取消',
  expired: '已到期',
  running: '正在执行',
};
export function BackgroundPanel({
  view,
  projectId,
  modelId,
  thinking,
  busy,
  disabled,
  onCommand,
}: {
  view?: BackgroundView;
  projectId: string;
  modelId?: string;
  thinking: ThinkingLevel;
  busy: boolean;
  disabled: boolean;
  onCommand: (command: HostCommand) => Promise<boolean>;
}) {
  const [goal, setGoal] = useState(''),
    [paths, setPaths] = useState('');
  async function create(event: FormEvent) {
    event.preventDefault();
    if (
      await onCommand({
        method: 'backgroundCreate',
        projectId,
        goal: goal.trim(),
        editablePaths: paths
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean),
      })
    ) {
      setGoal('');
      setPaths('');
    }
  }
  return (
    <section id="background-panel" className="background-panel" aria-labelledby="background-heading">
      <header className="section-heading">
        <h2 id="background-heading">持续任务</h2>
        <button
          className="button"
          disabled={disabled}
          onClick={() => void onCommand({ method: 'backgroundRefresh', projectId })}
        >
          刷新
        </button>
      </header>
      <p className="background-hint">事件到来后处理一次；需要确认时保存并等待。当前连接用于下一次处理。</p>
      {view?.running && <p role="status">正在处理待办…</p>}
      {view?.error && (
        <p className="notice error" role="alert">
          {view.error}
        </p>
      )}
      <form onSubmit={(event) => void create(event)} className="background-create">
        <label className="field">
          任务目标
          <textarea
            required
            maxLength={8000}
            value={goal}
            disabled={disabled}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如：跟进本次检查结果，有变化再通知我"
          />
        </label>
        <label className="field">
          允许提议修改的文件，每行一个（可留空）
          <textarea
            value={paths}
            disabled={disabled}
            onChange={(event) => setPaths(event.target.value)}
            placeholder="留空时只读；每次修改仍需确认"
          />
        </label>
        <button className="button primary" disabled={disabled || !goal.trim()}>
          创建任务
        </button>
      </form>
      {view?.tasks.map((task) => (
        <article className="background-task" key={task.id}>
          <h3>{task.goal}</h3>
          <p role="status">{labels[task.state] ?? task.state}</p>
          {task.progress && <p className="background-progress">{task.progress}</p>}
          {!!task.editablePaths.length && (
            <details>
              <summary>允许提议修改的范围</summary>
              <pre>{task.editablePaths.join('\n')}</pre>
            </details>
          )}
          <div className="approval-actions">
            <button
              className="button"
              disabled={disabled || busy || !modelId || task.state !== 'active' || task.kind !== 'inspect'}
              onClick={() =>
                modelId && void onCommand({ method: 'backgroundRun', projectId, taskId: task.id, modelId, thinking })
              }
            >
              {task.kind === 'inspect' ? '处理待办' : '由后台服务处理'}
            </button>
            <button
              className="button"
              disabled={disabled || ['cancelled', 'completed', 'expired'].includes(task.state)}
              onClick={() => void onCommand({ method: 'backgroundCancel', projectId, taskId: task.id })}
            >
              取消任务
            </button>
          </div>
          {view.approvals
            .filter((approval) => approval.taskId === task.id && approval.state === 'pending')
            .map((approval) => (
              <section
                className="approval-card"
                key={approval.id}
                aria-labelledby={`background-approval-${approval.id}`}
              >
                <h4 id={`background-approval-${approval.id}`}>确认这一次修改</h4>
                <pre>{approval.detail}</pre>
                <p>有效期至 {new Date(approval.expiresAt).toLocaleString()}</p>
                <div className="approval-actions">
                  <button
                    className="button"
                    disabled={disabled}
                    onClick={() =>
                      void onCommand({
                        method: 'backgroundApprove',
                        projectId,
                        approvalId: approval.id,
                        decision: 'deny',
                      })
                    }
                  >
                    拒绝
                  </button>
                  <button
                    className="button primary"
                    disabled={disabled}
                    onClick={() =>
                      void onCommand({
                        method: 'backgroundApprove',
                        projectId,
                        approvalId: approval.id,
                        decision: 'allow',
                      })
                    }
                  >
                    允许本次
                  </button>
                </div>
                <p className="background-hint">答复会保存，之后可点击“处理待办”继续。</p>
              </section>
            ))}
          {view.messages
            .filter((message) => message.taskId === task.id)
            .slice(-5)
            .map((message) => (
              <details key={message.id} className="background-result">
                <summary>{message.seen ? '已读结果' : '新结果'}</summary>
                <pre>{message.body}</pre>
                {!message.seen && (
                  <button
                    className="button"
                    disabled={disabled}
                    onClick={() => void onCommand({ method: 'backgroundSeen', projectId, messageId: message.id })}
                  >
                    标为已读
                  </button>
                )}
              </details>
            ))}
        </article>
      ))}
      {!view?.tasks.length && <p className="background-hint">当前项目还没有持续任务。</p>}
    </section>
  );
}
