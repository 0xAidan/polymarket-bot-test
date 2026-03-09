import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('setup.cjs starts under module mode without the old require crash', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'setup-script-'));
  const setupSource = join(repoRoot, 'setup.cjs');
  const envExampleSource = join(repoRoot, 'ENV_EXAMPLE.txt');
  const packageJsonSource = join(repoRoot, 'package.json');

  try {
    await copyFile(setupSource, join(tempDir, 'setup.cjs'));
    await copyFile(envExampleSource, join(tempDir, 'ENV_EXAMPLE.txt'));

    const packageJson = JSON.parse(readFileSync(packageJsonSource, 'utf8'));
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ type: packageJson.type }), 'utf8');

    const result = spawnSync(process.execPath, ['setup.cjs'], {
      cwd: tempDir,
      input: '\n',
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, combinedOutput);
    assert.match(combinedOutput, /Enter your private key:/);
    assert.doesNotMatch(combinedOutput, /require is not defined in ES module scope/);
    assert.equal(existsSync(join(tempDir, '.env')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('start.cjs bootstraps through setup.cjs when .env is missing', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'start-script-'));
  const startSource = join(repoRoot, 'start.cjs');

  try {
    await copyFile(startSource, join(tempDir, 'start.cjs'));
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(join(tempDir, 'ENV_EXAMPLE.txt'), 'PRIVATE_KEY=your_private_key_here\n', 'utf8');
    writeFileSync(join(tempDir, 'setup.cjs'), `require('node:fs').writeFileSync('.env', 'PRIVATE_KEY=test\\n', 'utf8');`);

    const binDir = join(tempDir, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'npx'), '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(join(binDir, 'npx'), 0o755);

    const result = spawnSync(process.execPath, ['start.cjs'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(tempDir, '.env')), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
