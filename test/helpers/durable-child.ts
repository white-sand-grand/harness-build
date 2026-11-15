import { startRun } from '../../src/app/run.ts';
import { openSession } from '../../src/session/index.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { scripted } from './fake-provider.ts';

const [directory, sessionId, stage] = process.argv.slice(2) as [string, string, string];
await startRun({
  cwd: directory,
  home: directory,
  session: openSession(directory, directory, sessionId),
  config: defaultConfig(),
  prompt: 'inspect',
  durable: { runId: 'crash-run', eventIds: ['crash:event'] },
  provider:
    stage === 'tool'
      ? scripted({ toolCalls: [{ name: 'write', args: { path: 'result.txt', content: 'one write' } }] })
      : scripted({ text: 'completed' }),
  onEvent(event) {
    if (
      (stage === 'input' && event.type === 'message' && event.message.role === 'user') ||
      (stage === 'tool' && event.type === 'toolEnd') ||
      (stage === 'completion' && event.type === 'agentEnd')
    )
      process.exit(97);
  },
});
throw new Error('The requested crash boundary was not reached.');
