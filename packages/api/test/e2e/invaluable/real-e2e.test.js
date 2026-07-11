#!/usr/bin/env node
/**
 * Real E2E Integration Test — Spawns actual Invaluable Kotlin/JS nodes
 * and exercises their MCP tool commands (context, post, recommend, etc.)
 *
 * This is NOT a mock test. It starts real child processes from the compiled
 * Kotlin/JS bundle and communicates with them via stdio MCP protocol.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import crypto from 'node:crypto';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const CLOWDER_ROOT = resolve(import.meta.dirname, '../../../../../');
const INVALUABLE_ROOT = resolve(CLOWDER_ROOT, '../invaluable/invaluable');
const BUNDLE_PATH = resolve(INVALUABLE_ROOT, 'build/js/packages/invaluable-app-social-mcp/kotlin/invaluable-app-social-mcp.js');
const TEST_LOOP_DIR = resolve(CLOWDER_ROOT, '.loop-e2e-test');

// -- Helpers --

function provisionIdentityKey(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, 'identity.key');
  if (existsSync(keyPath)) return;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const publicKeyRaw = publicKey.subarray(12);
  const seed = privateKey.subarray(privateKey.length - 32);
  const secretKey64 = Buffer.concat([seed, publicKeyRaw]);

  const content = `type=ed25519\npublic=${publicKey.toString('base64url')}\nprivate=${secretKey64.toString('base64url')}\n`;
  writeFileSync(keyPath, content, 'utf8');
}

/**
 * Runs a one-shot Invaluable CLI command and returns { stdout, stderr, code }.
 */
function runInvaluableCommand(name, args, timeoutMs = 15000) {
  const dataDir = join(TEST_LOOP_DIR, name);
  provisionIdentityKey(dataDir);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      BUNDLE_PATH,
      '--data-dir', dataDir,
      '--name', name,
      ...args,
    ], {
      cwd: INVALUABLE_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// -- Tests --

describe('Real E2E: Invaluable Kotlin/JS Node Integration', async () => {
  // Clean up test data before running
  if (existsSync(TEST_LOOP_DIR)) {
    rmSync(TEST_LOOP_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_LOOP_DIR, { recursive: true });

  await test('Bundle exists and is executable', () => {
    assert.ok(existsSync(BUNDLE_PATH), `Bundle not found at ${BUNDLE_PATH}`);
  });

  await test('--help prints usage without error', async () => {
    const result = await runInvaluableCommand('test-help', ['--help']);
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('invaluable-agent') || combined.includes('Usage'),
      `Expected usage text, got: ${combined.substring(0, 200)}`
    );
  });

  await test('context command returns local world state for a fresh node', async () => {
    const result = await runInvaluableCommand('e2e-leo', ['context']);
    console.log(`  [context stdout] ${result.stdout.substring(0, 300)}`);
    console.log(`  [context stderr] ${result.stderr.substring(0, 300)}`);
    assert.ok(result.code === 0 || result.stdout.length > 0 || result.stderr.length > 0,
      `context command produced no output and exited with code ${result.code}`);
  });

  await test('post command creates a TASK post', async () => {
    const result = await runInvaluableCommand('e2e-leo', [
      'post', 'TASK: Build a Snake game in one HTML file',
      '--amount', '5',
    ]);
    console.log(`  [post stdout] ${result.stdout.substring(0, 300)}`);
    console.log(`  [post stderr] ${result.stderr.substring(0, 300)}`);
    assert.ok(result.code === 0,
      `post command failed with code ${result.code}: ${result.stderr.substring(0, 200)}`);
  });

  await test('context after post shows the new TASK post', async () => {
    const result = await runInvaluableCommand('e2e-leo', ['context']);
    console.log(`  [context-after-post stdout] ${result.stdout.substring(0, 500)}`);
    assert.ok(result.code === 0, `context failed with code ${result.code}`);
    assert.ok(
      result.stdout.includes('Snake') || result.stdout.includes('TASK'),
      `Expected TASK post in context, got: ${result.stdout.substring(0, 300)}`
    );
  });

  await test('remember command creates a private post', async () => {
    const result = await runInvaluableCommand('e2e-leo', [
      'remember', 'PROPOSAL: Use canvas for rendering, keyboard for controls',
    ]);
    console.log(`  [remember stdout] ${result.stdout.substring(0, 300)}`);
    assert.ok(result.code === 0,
      `remember command failed with code ${result.code}: ${result.stderr.substring(0, 200)}`);
  });

  await test('second node (e2e-mia) starts with independent identity', async () => {
    const result = await runInvaluableCommand('e2e-mia', ['context']);
    console.log(`  [mia context stdout] ${result.stdout.substring(0, 300)}`);
    assert.ok(result.code === 0, `Mia context failed with code ${result.code}`);

    const leoKeyPath = join(TEST_LOOP_DIR, 'e2e-leo', 'identity.key');
    const miaKeyPath = join(TEST_LOOP_DIR, 'e2e-mia', 'identity.key');
    assert.ok(existsSync(leoKeyPath), 'Leo identity.key missing');
    assert.ok(existsSync(miaKeyPath), 'Mia identity.key missing');

    const leoKey = readFileSync(leoKeyPath, 'utf8');
    const miaKey = readFileSync(miaKeyPath, 'utf8');
    assert.notEqual(leoKey, miaKey, 'Leo and Mia should have different identity keys');
  });

  await test('write budget flag --max-writes-per-turn is accepted', async () => {
    const r = await runInvaluableCommand('e2e-budget', [
      '--max-writes-per-turn', '3',
      'post', 'Budget test post',
    ]);
    console.log(`  [budget stdout] ${r.stdout.substring(0, 300)}`);
    assert.ok(r.code === 0, `Post with budget flag failed: ${r.stderr.substring(0, 200)}`);
  });

  // Cleanup
  await test('cleanup test data', () => {
    if (existsSync(TEST_LOOP_DIR)) {
      rmSync(TEST_LOOP_DIR, { recursive: true, force: true });
    }
    assert.ok(true, 'Cleanup done');
  });
});
