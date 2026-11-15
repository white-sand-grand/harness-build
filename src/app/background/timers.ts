import { randomUUID } from 'node:crypto';
import { BackgroundStore } from './store.ts';

export type BackgroundTimer = {
  id: string;
  taskId: string;
  generation: number;
  dueAtUtc: number;
  anchorUtc: number;
  everyMs?: number;
  timezone: string;
  state: 'active' | 'done' | 'cancelled';
};
export class BackgroundTimers {
  private store: BackgroundStore;
  constructor(store: BackgroundStore) {
    this.store = store;
  }
  list(taskId?: string): BackgroundTimer[] {
    const rows = taskId
      ? this.store.db.prepare('SELECT data FROM timers WHERE task_id=? ORDER BY rowid').all(taskId)
      : this.store.db.prepare('SELECT data FROM timers ORDER BY rowid').all();
    return rows.map((row) => JSON.parse(String(row.data)) as BackgroundTimer);
  }
  create(input: { taskId: string; atUtc: number; everyMs?: number; timezone?: string }): BackgroundTimer {
    return this.store.transaction(() => {
      const task = this.store.task(input.taskId);
      if (
        task.state !== 'active' ||
        !Number.isSafeInteger(input.atUtc) ||
        input.atUtc > task.expiresAt ||
        (input.everyMs !== undefined && (!Number.isSafeInteger(input.everyMs) || input.everyMs < 1000)) ||
        this.list(task.id).filter((timer) => timer.state === 'active').length >= 16
      )
        throw new Error('Invalid timer, inactive task or timer limit reached.');
      const timer: BackgroundTimer = {
        id: randomUUID(),
        taskId: task.id,
        generation: 1,
        dueAtUtc: input.atUtc,
        anchorUtc: input.atUtc,
        ...(input.everyMs ? { everyMs: input.everyMs } : {}),
        timezone: input.timezone ?? task.timezone,
        state: 'active',
      };
      new Intl.DateTimeFormat('en', { timeZone: timer.timezone }).format();
      this.store.db
        .prepare('INSERT INTO timers(id,task_id,data) VALUES(?,?,?)')
        .run(timer.id, task.id, JSON.stringify(timer));
      return timer;
    });
  }
  cancel(id: string) {
    this.store.transaction(() => {
      const timer = this.list().find((item) => item.id === id);
      if (!timer) throw new Error('Unknown timer.');
      timer.generation++;
      timer.state = 'cancelled';
      this.save(timer);
    });
  }
  private save(timer: BackgroundTimer) {
    this.store.db.prepare('UPDATE timers SET data=? WHERE id=?').run(JSON.stringify(timer), timer.id);
  }
  tick(): number {
    return this.store.transaction(() => {
      let fired = 0;
      for (const timer of this.list()) {
        if (timer.state !== 'active' || timer.dueAtUtc > this.store.now()) continue;
        const task = this.store.task(timer.taskId);
        if (task.expiresAt <= this.store.now() || ['cancelled', 'completed', 'expired'].includes(task.state)) {
          timer.state = 'cancelled';
          timer.generation++;
          this.save(timer);
          continue;
        }
        if (task.state !== 'active') continue;
        const missedCount = timer.everyMs ? Math.floor((this.store.now() - timer.dueAtUtc) / timer.everyMs) : 0;
        const scheduledAtUtc = timer.dueAtUtc + missedCount * (timer.everyMs ?? 0);
        this.store.insertEvent({
          taskId: timer.taskId,
          source: 'timer',
          sourceEventId: `${timer.id}:${timer.generation}:${scheduledAtUtc}`,
          kind: 'timer',
          payload: JSON.stringify({ timerId: timer.id, generation: timer.generation, scheduledAtUtc, missedCount }),
          availableAt: this.store.now(),
        });
        if (timer.everyMs) {
          timer.dueAtUtc = scheduledAtUtc + timer.everyMs;
          if (timer.dueAtUtc > task.expiresAt) timer.state = 'done';
        } else timer.state = 'done';
        this.save(timer);
        fired++;
      }
      return fired;
    });
  }
}
