import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { realPath, resolvePath, isWithin } from '../../util/paths.ts';
import { OwnershipBusyError } from '../../util/ownership.ts';
import type { SavedRunResult } from './journal.ts';
import { defaultLimits, type BackgroundTask, type BackgroundRun, type ClaimedRun, type InboxEvent } from './types.ts';

type Row = Record<string, unknown>;
export class BackgroundBudgetError extends Error {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
export class BackgroundStore {
  readonly db: DatabaseSync;
  readonly home: string;
  readonly now: () => number;
  constructor(home: string, now: () => number = Date.now) {
    this.home = home;
    this.now = now;
    const directory = join(home, 'background');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'control.sqlite'));
    try {
      if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) > 3)
        throw new Error('Unsupported background store version.');
      this.db.exec(
        'PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
      );
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id), source TEXT NOT NULL, source_key TEXT NOT NULL,
          hash TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, available_at INTEGER NOT NULL,
          status TEXT NOT NULL, run_id TEXT REFERENCES runs(id), UNIQUE(source, source_key));
        CREATE INDEX IF NOT EXISTS inbox_ready ON inbox(status, available_at, seq);
        CREATE TABLE IF NOT EXISTS counters(scope TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0,
          runs INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0, reported INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
          scopes TEXT NOT NULL, reserved INTEGER NOT NULL, reported INTEGER, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS timers(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outcomes(run_id TEXT PRIMARY KEY REFERENCES runs(id), task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL REFERENCES tasks(id), dedupe_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries(outbox_id TEXT PRIMARY KEY REFERENCES outbox(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
        PRAGMA user_version=3;
      `);
      if (process.platform !== 'win32') chmodSync(join(directory, 'control.sqlite'), 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  task(id: string): BackgroundTask {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown background task: ${id}`);
    return decode<BackgroundTask>(row.data);
  }
  tasks(): BackgroundTask[] {
    return this.db
      .prepare('SELECT data FROM tasks ORDER BY rowid')
      .all()
      .map((r) => decode<BackgroundTask>(r.data));
  }
  saveTask(task: BackgroundTask) {
    this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(task), task.id);
  }
  createTask(
    input: Pick<BackgroundTask, 'cwd' | 'goal'> &
      Partial<Pick<BackgroundTask, 'id' | 'kind' | 'timezone' | 'limits' | 'expiresAt' | 'editablePaths'>>,
  ): BackgroundTask {
    if (
      input.editablePaths &&
      (!Array.isArray(input.editablePaths) ||
        input.editablePaths.length > 32 ||
        input.editablePaths.some((path) => typeof path !== 'string' || path.length > 500))
    )
      throw new Error('Invalid editable file scope.');
    const task: BackgroundTask = {
      id: input.id ?? randomUUID(),
      cwd: realPath(input.cwd),
      goal: input.goal,
      kind: input.kind ?? 'inspect',
      state: 'active',
      timezone: input.timezone ?? 'Asia/Shanghai',
      limits: { ...defaultLimits, ...input.limits },
      progress: '',
      revision: 0,
      expiresAt: input.expiresAt ?? this.now() + 7 * 86400000,
      createdAt: this.now(),
      editablePaths: [...new Set((input.editablePaths ?? []).map((path) => realPath(resolvePath(input.cwd, path))))],
    };
    if (
      !/^[\w-]{1,128}$/.test(task.id) ||
      !task.goal.trim() ||
      task.goal.length > 8000 ||
      !['inspect', 'dream', 'evolution'].includes(task.kind) ||
      !Number.isSafeInteger(task.expiresAt) ||
      task.expiresAt <= this.now() ||
      Object.values(task.limits).some((v) => !Number.isSafeInteger(v) || v < 1) ||
      task.editablePaths.length > 32 ||
      task.editablePaths.some((path) => !isWithin(task.cwd, path) || /[\x00-\x1f]/.test(path))
    )
      throw new Error('Invalid task scope or limits.');
    new Intl.DateTimeFormat('en', { timeZone: task.timezone }).format();
    this.db.prepare('INSERT INTO tasks(id,data) VALUES(?,?)').run(task.id, JSON.stringify(task));
    return task;
  }
  cancelTask(id: string) {
    this.transaction(() => {
      const task = this.task(id);
      task.state = 'cancelled';
      this.saveTask(task);
      this.db.prepare("UPDATE inbox SET status='dead_letter' WHERE task_id=? AND status='pending'").run(id);
      for (const row of this.db.prepare('SELECT id,data FROM timers WHERE task_id=?').all(id)) {
        const timer = decode<{ state: string; generation: number }>(row.data);
        timer.state = 'cancelled';
        timer.generation++;
        this.db.prepare('UPDATE timers SET data=? WHERE id=?').run(JSON.stringify(timer), String(row.id));
      }
      for (const row of this.db.prepare('SELECT id,data FROM approvals WHERE task_id=?').all(id)) {
        const approval = decode<{ state: string }>(row.data);
        if (approval.state === 'pending' || approval.state === 'answered') {
          approval.state = 'cancelled';
          this.db.prepare('UPDATE approvals SET data=? WHERE id=?').run(JSON.stringify(approval), String(row.id));
        }
      }
    });
  }
  enqueue(input: {
    taskId: string;
    source: string;
    sourceEventId: string;
    payload: unknown;
    kind?: string;
    availableAt?: number;
  }): { event: InboxEvent; duplicate: boolean } {
    const payload = JSON.stringify(input.payload),
      kind = input.kind ?? 'message',
      availableAt = input.availableAt ?? this.now();
    if (
      !payload ||
      Buffer.byteLength(payload) > 64000 ||
      !/^[\w.-]{1,64}$/.test(input.source) ||
      !input.sourceEventId ||
      input.sourceEventId.length > 200 ||
      !/^[\w.-]{1,40}$/.test(kind) ||
      !Number.isSafeInteger(availableAt)
    )
      throw new Error('Invalid inbox event or payload exceeds 64KB.');
    if (['timer', 'approval', 'control'].includes(input.source))
      throw new Error('This inbox source is reserved for the supervisor.');
    return this.transaction(() => this.insertEvent({ ...input, payload, kind, availableAt }));
  }
  insertEvent(input: {
    taskId: string;
    source: string;
    sourceEventId: string;
    payload: string;
    kind: string;
    availableAt: number;
  }) {
    const task = this.task(input.taskId);
    if (['cancelled', 'completed', 'expired'].includes(task.state) || task.expiresAt <= this.now())
      throw new Error('Task is inactive or expired.');
    const fingerprint = hash({ taskId: input.taskId, kind: input.kind, payload: input.payload });
    const existing = this.db
      .prepare('SELECT * FROM inbox WHERE source=? AND source_key=?')
      .get(input.source, input.sourceEventId);
    if (existing) {
      if (existing.hash !== fingerprint) throw new Error('Conflicting payload for the same source event ID.');
      return { event: this.eventRow(existing), duplicate: true };
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO inbox(id,task_id,source,source_key,hash,kind,payload,available_at,status) VALUES(?,?,?,?,?,?,?,?,'pending')",
      )
      .run(
        id,
        input.taskId,
        input.source,
        input.sourceEventId,
        fingerprint,
        input.kind,
        input.payload,
        input.availableAt,
      );
    return { event: this.eventRow(this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id)!), duplicate: false };
  }
  eventRow(row: Row): InboxEvent {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      source: String(row.source),
      sourceEventId: String(row.source_key),
      kind: String(row.kind),
      payload: decode<unknown>(row.payload),
      status: row.status as InboxEvent['status'],
      availableAt: Number(row.available_at),
      ...(row.run_id ? { runId: String(row.run_id) } : {}),
    };
  }
  events(taskId?: string): InboxEvent[] {
    return (
      taskId
        ? this.db.prepare('SELECT * FROM inbox WHERE task_id=? ORDER BY seq').all(taskId)
        : this.db.prepare('SELECT * FROM inbox ORDER BY seq').all()
    ).map((r) => this.eventRow(r));
  }
  run(id: string): BackgroundRun {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    if (!row) throw new Error('Unknown run: ' + id);
    return decode<BackgroundRun>(row.data);
  }
  runs(): BackgroundRun[] {
    return this.db
      .prepare('SELECT data FROM runs ORDER BY rowid')
      .all()
      .map((r) => decode<BackgroundRun>(r.data));
  }
  saveRun(run: BackgroundRun) {
    this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), run.id);
  }
  day(task: BackgroundTask): string {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: task.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(this.now());
    return ['year', 'month', 'day'].map((type) => parts.find((p) => p.type === type)!.value).join('-');
  }
  counter(scope: string): { calls: number; runs: number; reserved: number; reported: number } {
    this.db.prepare('INSERT OR IGNORE INTO counters(scope) VALUES(?)').run(scope);
    return this.db.prepare('SELECT calls,runs,reserved,reported FROM counters WHERE scope=?').get(scope) as unknown as {
      calls: number;
      runs: number;
      reserved: number;
      reported: number;
    };
  }
  claim(
    prepare: (task: BackgroundTask) => { sessionId: string; contractHash: string },
    taskIds?: readonly string[],
  ): ClaimedRun | undefined {
    return this.transaction(() => {
      const ready = this.db
        .prepare(
          "SELECT inbox.* FROM inbox JOIN tasks ON tasks.id=inbox.task_id WHERE inbox.status='pending' AND inbox.available_at<=? ORDER BY CASE json_extract(tasks.data,'$.kind') WHEN 'inspect' THEN 0 ELSE 1 END,inbox.seq",
        )
        .all(this.now())
        .filter((row) => {
          if (row.source === 'timer') {
            const payload = decode<{ timerId: string; generation: number }>(row.payload);
            const timer = this.db.prepare('SELECT data FROM timers WHERE id=?').get(payload.timerId);
            const data = timer ? decode<{ generation: number; state: string }>(timer.data) : undefined;
            if (!data || data.generation !== payload.generation || data.state === 'cancelled') {
              this.db.prepare("UPDATE inbox SET status='dead_letter' WHERE id=?").run(String(row.id));
              return false;
            }
          }
          return true;
        });
      const deferred = new Set<string>();
      for (const row of ready) {
        const task = this.task(String(row.task_id));
        if (taskIds && !taskIds.includes(task.id)) continue;
        if (deferred.has(task.id)) continue;
        if (task.expiresAt <= this.now()) {
          task.state = 'expired';
          this.saveTask(task);
          this.db.prepare("UPDATE inbox SET status='dead_letter' WHERE task_id=? AND status='pending'").run(task.id);
          continue;
        }
        if (task.state !== 'active') continue;
        if (
          this.runs().some(
            (r) =>
              r.taskId === task.id &&
              (['running', 'needs_reconciliation'].includes(r.state) ||
                (r.state === 'suspended' && row.source !== 'approval')),
          )
        )
          continue;
        const prior = row.run_id ? this.run(String(row.run_id)) : undefined;
        if (prior && prior.state !== 'recovering') continue;
        const batch: Row[] = [];
        let bytes = 0;
        for (const candidate of ready) {
          if (candidate.task_id !== row.task_id || candidate.kind !== row.kind || candidate.run_id !== row.run_id)
            continue;
          if (row.source === 'approval' && batch.length) break;
          bytes += Buffer.byteLength(String(candidate.payload));
          if (batch.length >= 16 || bytes > 64000) break;
          batch.push(candidate);
        }
        if (!prior) {
          const day = 'day:' + task.id + ':' + this.day(task);
          if (this.counter(day).runs >= task.limits.maxDayRuns) {
            task.state = 'blocked';
            task.progress = 'Daily run budget exhausted.';
            this.saveTask(task);
            continue;
          }
        }
        let prepared: ReturnType<typeof prepare>;
        try {
          prepared = prepare(task);
        } catch (error) {
          if (!(error instanceof OwnershipBusyError)) throw error;
          deferred.add(task.id);
          if (error.stale) {
            task.state = 'blocked';
            task.progress = error.message;
            this.saveTask(task);
          }
          continue;
        }
        if (!prior)
          this.db.prepare('UPDATE counters SET runs=runs+1 WHERE scope=?').run('day:' + task.id + ':' + this.day(task));
        const prompt = JSON.stringify({
          goal: task.goal,
          progress: task.progress,
          events: batch.map((r) => ({ id: r.id, source: r.source, kind: r.kind, payload: decode<unknown>(r.payload) })),
        });
        const run: BackgroundRun = prior ?? {
          id: randomUUID(),
          taskId: task.id,
          eventIds: batch.map((r) => String(r.id)),
          sessionId: prepared.sessionId,
          state: 'running',
          contractHash: prepared.contractHash,
          prompt,
          pid: process.pid,
          ...(row.source === 'approval' ? { approvalId: decode<{ requestId: string }>(row.payload).requestId } : {}),
        };
        run.state = 'running';
        run.pid = process.pid;
        if (prior) this.saveRun(run);
        else
          this.db.prepare('INSERT INTO runs(id,task_id,data) VALUES(?,?,?)').run(run.id, task.id, JSON.stringify(run));
        task.sessionId = run.sessionId;
        this.saveTask(task);
        for (const event of batch)
          this.db
            .prepare("UPDATE inbox SET status='claimed',run_id=? WHERE id=? AND status='pending'")
            .run(run.id, String(event.id));
        return { run, task, events: batch.map((r) => this.eventRow({ ...r, status: 'claimed', run_id: run.id })) };
      }
      return undefined;
    });
  }
  finish(
    runId: string,
    result: SavedRunResult,
    progress: string,
    onCommit?: (run: BackgroundRun, task: BackgroundTask) => void,
  ) {
    this.transaction(() => {
      const run = this.run(runId),
        task = this.task(run.taskId);
      run.state = result.reason === 'suspended' ? 'suspended' : result.reason === 'done' ? 'completed' : 'failed';
      run.result = result;
      this.saveRun(run);
      this.db.prepare("UPDATE inbox SET status='handled' WHERE run_id=? AND status='claimed'").run(runId);
      task.progress = progress.slice(0, 4000);
      task.revision++;
      if (!['cancelled', 'expired'].includes(task.state) && result.reason === 'suspended')
        task.state = 'waitingApproval';
      else if (!['cancelled', 'expired'].includes(task.state) && result.reason !== 'done') task.state = 'blocked';
      this.saveTask(task);
      onCommit?.(run, task);
    });
  }
  fail(runId: string, error: string) {
    this.transaction(() => {
      const run = this.run(runId),
        task = this.task(run.taskId);
      run.state = 'needs_reconciliation';
      run.error = error.slice(0, 2000);
      this.saveRun(run);
      if (!['cancelled', 'expired', 'completed'].includes(task.state)) task.state = 'blocked';
      task.progress = run.error;
      this.saveTask(task);
    });
  }
  requeue(runId: string) {
    this.transaction(() => {
      const run = this.run(runId),
        task = this.task(run.taskId);
      if (!['running', 'needs_reconciliation'].includes(run.state))
        throw new Error('Only interrupted runs can be recovered.');
      if (['cancelled', 'completed', 'expired'].includes(task.state) || task.expiresAt <= this.now()) {
        run.state = 'failed';
        run.error = 'The task was cancelled, completed or expired.';
        this.saveRun(run);
        this.db.prepare("UPDATE inbox SET status='dead_letter' WHERE run_id=? AND status='claimed'").run(runId);
        return;
      }
      run.state = 'recovering';
      this.saveRun(run);
      task.state = 'active';
      this.saveTask(task);
      this.db.prepare("UPDATE inbox SET status='pending' WHERE run_id=? AND status='claimed'").run(runId);
    });
  }
  reserveRequest(run: BackgroundRun, estimatedTokens: number): string {
    return this.transaction(() => {
      const task = this.task(run.taskId),
        scopes = ['run:' + run.id, 'task:' + task.id, 'day:' + task.id + ':' + this.day(task)];
      if (task.state !== 'active' || task.expiresAt <= this.now())
        throw new BackgroundBudgetError('Background task was cancelled, blocked or expired.');
      if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1)
        throw new Error('Invalid request reservation.');
      for (const [index, scope] of scopes.entries()) {
        const count = this.counter(scope),
          limit = [task.limits.maxRunCalls, task.limits.maxTaskCalls, task.limits.maxDayCalls][index]!;
        if (
          count.calls >= limit ||
          (index === 0 && count.reported + count.reserved + estimatedTokens > task.limits.maxRunTokens)
        )
          throw new BackgroundBudgetError('Background model budget exhausted.');
      }
      const id = randomUUID();
      for (const scope of scopes)
        this.db
          .prepare('UPDATE counters SET calls=calls+1,reserved=reserved+? WHERE scope=?')
          .run(estimatedTokens, scope);
      this.db
        .prepare("INSERT INTO requests(id,run_id,scopes,reserved,state) VALUES(?,?,?,?,'pending')")
        .run(id, run.id, JSON.stringify(scopes), estimatedTokens);
      return id;
    });
  }
  settleRequest(id: string, reported: number | undefined) {
    this.transaction(() => {
      const request = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
      if (!request || request.state !== 'pending') throw new Error('Unknown or settled budget reservation.');
      if (reported !== undefined && (!Number.isFinite(reported) || reported < 0))
        throw new Error('Invalid reported usage.');
      if (reported !== undefined)
        for (const scope of decode<string[]>(request.scopes))
          this.db
            .prepare('UPDATE counters SET reserved=reserved-?,reported=reported+? WHERE scope=?')
            .run(Number(request.reserved), reported, scope);
      this.db
        .prepare('UPDATE requests SET state=?,reported=? WHERE id=?')
        .run(reported === undefined ? 'unknown' : 'settled', reported ?? null, id);
    });
  }
}
