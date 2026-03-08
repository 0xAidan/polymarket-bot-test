import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

export interface DiscoveryRuntimeHeartbeat {
  mode: 'discovery-worker';
  pid: number;
  running: boolean;
  startedAt: number;
  lastHeartbeatAt: number;
  chainListener?: {
    connected: boolean;
    lastEventAt?: number;
    reconnectCount: number;
  };
  apiPoller?: {
    running: boolean;
    lastPollAt?: number;
    marketsMonitored: number;
  };
}

const getHeartbeatPath = (dataDir = config.dataDir): string => (
  path.join(dataDir, 'discovery-runtime-heartbeat.json')
);

export const saveDiscoveryRuntimeHeartbeat = (
  dataDir = config.dataDir,
  heartbeat: DiscoveryRuntimeHeartbeat,
): void => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(getHeartbeatPath(dataDir), JSON.stringify(heartbeat, null, 2), 'utf-8');
};

export const loadDiscoveryRuntimeHeartbeat = (dataDir = config.dataDir): DiscoveryRuntimeHeartbeat | null => {
  try {
    const raw = fs.readFileSync(getHeartbeatPath(dataDir), 'utf-8');
    return JSON.parse(raw) as DiscoveryRuntimeHeartbeat;
  } catch {
    return null;
  }
};

export const clearDiscoveryRuntimeHeartbeat = (dataDir = config.dataDir): void => {
  try {
    fs.unlinkSync(getHeartbeatPath(dataDir));
  } catch {
    // Ignore missing heartbeat files.
  }
};

export const getCurrentDiscoveryRuntimeHeartbeat = (): DiscoveryRuntimeHeartbeat | null => (
  loadDiscoveryRuntimeHeartbeat(config.dataDir)
);
