/// <reference types="vite/client" />

import type { DesktopBridge } from '../contracts.ts';

declare global {
  interface Window {
    mh: DesktopBridge;
  }
}

export {};
