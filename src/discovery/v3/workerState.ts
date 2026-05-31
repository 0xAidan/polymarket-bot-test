import fs from 'node:fs';
import path from 'node:path';

import { config } from '../../config.js';

export interface DiscoveryV3WorkerState {
  enabled: boolean;
  bootstrapOk: boolean;
  bootstrapError?: string;
  goldskyEnabled: boolean;
  rpcPollEnabled?: boolean;
  duckdbPath?: string;
  updatedAt: number;
}

const getStatePath = (dataDir = config.dataDir): string => (
  path.join(dataDir, 'discovery-v3-worker-state.json')
);

export const saveDiscoveryV3WorkerState = (
  state: DiscoveryV3WorkerState,
  dataDir = config.dataDir,
): void => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(getStatePath(dataDir), JSON.stringify(state, null, 2), 'utf-8');
};

export const loadDiscoveryV3WorkerState = (dataDir = config.dataDir): DiscoveryV3WorkerState | null => {
  try {
    const raw = fs.readFileSync(getStatePath(dataDir), 'utf-8');
    return JSON.parse(raw) as DiscoveryV3WorkerState;
  } catch {
    return null;
  }
};
