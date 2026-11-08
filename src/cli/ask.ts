import type { Interface } from 'node:readline';
import type { Asker } from '../hooks/permission.ts';
export const createAsker =
  (rl: Interface): Asker =>
  async (q) => {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${q.title}\n${q.detail}\nAllow [o]nce / [s]ession / [d]eny? `, resolve),
    );
    return answer.trim().toLowerCase() === 'o' ? 'once' : answer.trim().toLowerCase() === 's' ? 'session' : 'deny';
  };
