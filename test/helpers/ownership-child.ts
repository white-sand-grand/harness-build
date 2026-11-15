import { openSession } from '../../src/session/index.ts';
import { acquireWorkspace } from '../../src/app/background/ownership.ts';

const [home, cwd, sessionId] = process.argv.slice(2) as [string, string, string];
acquireWorkspace(home, cwd);
const session = openSession(home, cwd, sessionId);
session.acquireWriter();
session.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'durable child' }] } });
session.flush();
process.send?.({ ready: true });
setInterval(() => {}, 1000);
