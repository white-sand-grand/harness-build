import { mkdirSync, readFileSync, appendFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sessionId, type DistributiveOmit } from '../util/ids.ts';
import { projectSlug } from '../util/paths.ts';
import type { SessionEntry, SessionStore } from './types.ts';
import { rebuild } from './rebuild.ts';
const sessionsDir = (home: string, cwd: string) => join(home, 'projects', projectSlug(cwd), 'sessions');
function readEntries(file: string) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const entries: SessionEntry[] = [];
  let repaired = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]!) as SessionEntry;
      if (!entry || typeof entry.type !== 'string' || typeof entry.id !== 'string')
        throw new Error('invalid entry shape');
      entries.push(entry);
    } catch (error) {
      if (i === lines.length - 1 && !raw.endsWith('\n')) {
        repaired = true;
        process.emitWarning(`Ignored truncated last line in ${file}; valid entries were retained.`);
      } else
        throw new Error(
          `Corrupt session ${file}, line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }
  if (entries[0]?.type !== 'header' || entries[0].v !== 1) throw new Error(`Invalid session header: ${file}`);
  return { entries, repaired, needsNewline: !raw.endsWith('\n') };
}
class Store implements SessionStore {
  readonly id: string;
  readonly dir: string;
  private file: string;
  private records: SessionEntry[];
  private next: number;
  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'session.jsonl');
    const { entries, repaired, needsNewline } = readEntries(this.file);
    this.records = entries;
    this.id = entries[0]!.id;
    this.next = Math.max(0, ...entries.map((e) => (/^e\d+$/.test(e.id) ? Number(e.id.slice(1)) : 0))) + 1;
    if (repaired) writeFileSync(this.file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    else if (needsNewline) appendFileSync(this.file, '\n');
  }
  append(entry: DistributiveOmit<SessionEntry, 'id' | 'ts'>): string {
    const id = `e${this.next++}`;
    const record = { ...entry, id, ts: new Date().toISOString() } as SessionEntry;
    appendFileSync(this.file, JSON.stringify(record) + '\n');
    this.records.push(record);
    return id;
  }
  entries() {
    return structuredClone(this.records);
  }
  context() {
    return rebuild(this.records, this.dir);
  }
}
export function createSession(home: string, cwd: string): SessionStore {
  const id = sessionId(),
    dir = join(sessionsDir(home, cwd), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.jsonl'),
    JSON.stringify({ type: 'header', v: 1, id, cwd, createdAt: new Date().toISOString(), harnessVersion: '0.1.0' }) +
      '\n',
    { flag: 'wx' },
  );
  return new Store(dir);
}
export function listSessions(home: string, cwd: string): Array<{ id: string; firstUserText: string; mtime: Date }> {
  const root = sessionsDir(home, cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'session.jsonl')))
    .map((e) => {
      const file = join(root, e.name, 'session.jsonl');
      const { entries } = readEntries(file);
      const first = entries.find((e) => e.type === 'message' && e.message.role === 'user');
      return {
        id: e.name,
        firstUserText:
          first?.type === 'message'
            ? first.message.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('')
                .slice(0, 120)
            : '',
        mtime: statSync(file).mtime,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime() || b.id.localeCompare(a.id));
}
export function openSession(home: string, cwd: string, id: string | 'latest'): SessionStore {
  const selected = id === 'latest' ? listSessions(home, cwd)[0]?.id : id;
  if (!selected) throw new Error('No sessions found for this project.');
  if (!/^[A-Za-z0-9_-]+$/.test(selected)) throw new Error('Invalid session id.');
  return new Store(join(sessionsDir(home, cwd), selected));
}
