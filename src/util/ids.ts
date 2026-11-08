import { randomBytes } from 'node:crypto';
export function sessionId(): string {
  return (
    new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + '-' + randomBytes(3).toString('hex')
  );
}
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
