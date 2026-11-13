import { DesktopController } from './controller.ts';
import type { HostMessage, HostRequest } from '../contracts.ts';
type Port = {
  postMessage(value: HostMessage): void;
  on(event: 'message', listener: (event: { data: HostRequest }) => void): void;
  start(): void;
};
type ParentPort = {
  on(
    event: 'message',
    listener: (event: {
      data: { home: string; promptsDir: string; credentialEnvironment?: Record<string, string> };
      ports: Port[];
    }) => void,
  ): void;
};
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error('Desktop Host must be started by Electron utilityProcess.');
parentPort.on('message', (event) => {
  const port = event.ports[0];
  if (!port) return;
  const controller = new DesktopController({
    home: event.data.home,
    promptsDir: event.data.promptsDir,
    credentialEnvironment: event.data.credentialEnvironment,
    onSnapshot: (snapshot) => port.postMessage({ type: 'snapshot', snapshot }),
  });
  port.on('message', (request) => {
    const { id, command } = request.data;
    void controller.handle(command).then(
      (snapshot) => port.postMessage({ type: 'response', id, snapshot }),
      (error: unknown) =>
        port.postMessage({
          type: 'response',
          id,
          error: error instanceof Error ? error.message : 'Host operation failed.',
        }),
    );
  });
  port.start();
  port.postMessage({ type: 'ready', nodeVersion: process.versions.node });
});
