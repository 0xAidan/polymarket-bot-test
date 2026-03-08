export type RuntimeMode = 'app' | 'discovery-worker';

export interface RuntimeServices {
  server: boolean;
  trader: boolean;
  discoveryWorker: boolean;
}

export const resolveRuntimeMode = (
  envMode?: string,
  argv: string[] = [],
): RuntimeMode => {
  if (argv.includes('--discovery-worker')) {
    return 'discovery-worker';
  }

  if ((envMode || '').trim().toLowerCase() === 'discovery-worker') {
    return 'discovery-worker';
  }

  return 'app';
};

export const getRuntimeServicesForMode = (mode: RuntimeMode): RuntimeServices => {
  if (mode === 'discovery-worker') {
    return {
      server: false,
      trader: false,
      discoveryWorker: true,
    };
  }

  return {
    server: true,
    trader: true,
    discoveryWorker: false,
  };
};
