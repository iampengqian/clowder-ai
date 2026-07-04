import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import crypto from 'node:crypto';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { resolveStartupProjectRoot } from '../../../../../utils/startup-root.js';

const log = createModuleLogger('invaluable-node-manager');

export interface InvaluableNode {
  name: string;
  dataDir: string;
  process: ChildProcess | null;
  startTime?: number;
  lastRestartTime?: number;
  restartCount?: number;
  status?: 'active' | 'dead' | 'cooldown';
}

export class InvaluableNodeManager {
  private static instance: InvaluableNodeManager | null = null;
  private readonly nodes: Map<string, InvaluableNode> = new Map();
  private readonly monorepoRoot: string;
  private readonly invaluableRoot: string;
  private readonly buildJsPath: string;
  private isShuttingDown = false;

  private constructor() {
    this.monorepoRoot = resolveStartupProjectRoot();
    this.invaluableRoot = resolve(this.monorepoRoot, '../invaluable/invaluable');
    this.buildJsPath = resolve(this.invaluableRoot, 'build/js');

    const nodeNames = ['ict-leo', 'ict-mia', 'ict-ravi', 'ict-niko', 'ict-observer'];
    for (const name of nodeNames) {
      this.nodes.set(name, {
        name,
        dataDir: resolve(this.monorepoRoot, '.loop', name),
        process: null,
        restartCount: 0,
        lastRestartTime: 0,
        status: 'dead',
      });
    }
  }

  public static getInstance(): InvaluableNodeManager {
    if (!InvaluableNodeManager.instance) {
      InvaluableNodeManager.instance = new InvaluableNodeManager();
    }
    return InvaluableNodeManager.instance;
  }

  /**
   * Pre-generates Ed25519 keys in Invaluable's expected serialization format.
   */
  public provisionNode(name: string): void {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`Unknown node: ${name}`);

    if (!existsSync(node.dataDir)) {
      mkdirSync(node.dataDir, { recursive: true });
    }

    const keyPath = join(node.dataDir, 'identity.key');
    if (existsSync(keyPath)) return;

    log.info(`Provisioning new Ed25519 identity.key for node: ${name}`);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    const publicKeyRaw = publicKey.subarray(12); // last 32 bytes of 44-byte SPKI
    const seed = privateKey.subarray(privateKey.length - 32); // last 32 bytes of PKCS#8
    const secretKey64 = Buffer.concat([seed, publicKeyRaw]); // 64 bytes

    const iniContent = `type=ed25519\npublic=${publicKey.toString('base64url')}\nprivate=${secretKey64.toString('base64url')}\n`;
    writeFileSync(keyPath, iniContent, 'utf8');
  }

  /**
   * Spawns a background node process if it is not already running.
   */
  public startNode(name: string): void {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`Unknown node: ${name}`);
    if (node.process && !node.process.killed) return;

    // Rate-limiting restart logic to prevent hotloops on continuous crash
    const now = Date.now();
    const lastRestart = node.lastRestartTime || 0;
    const currentCount = node.restartCount || 0;

    if (now - lastRestart < 10000 && currentCount >= 3) {
      log.error(`Node ${name} is crashing continuously. Entering restart cooldown...`);
      node.status = 'cooldown';
      return;
    }

    this.provisionNode(name);

    const relativeBundlePath = 'packages/invaluable-app-social-mcp/kotlin/invaluable-app-social-mcp.js';
    const bundlePath = resolve(this.buildJsPath, relativeBundlePath);

    if (!existsSync(bundlePath)) {
      throw new Error(`Invaluable Kotlin/JS bundle not found at ${bundlePath}. Please run gradle build first.`);
    }

    log.info(`Spawning background peer node process: ${name}`);
    node.startTime = Date.now();
    node.lastRestartTime = Date.now();
    node.restartCount = (now - lastRestart < 10000) ? currentCount + 1 : 1;
    node.status = 'active';

    const child = spawn(
      'node',
      [
        relativeBundlePath,
        '--data-dir', node.dataDir,
        '--name', name,
        '--signal-port', '51900',
        'mcp'
      ],
      {
        cwd: this.buildJsPath,
        env: {
          ...process.env,
          NODE_PATH: 'build/js/node_modules',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );

    let stderrLinesThisSecond = 0;
    let windowStart = Date.now();

    child.stderr?.on('data', (data) => {
      const currentTime = Date.now();
      if (currentTime - windowStart > 1000) {
        stderrLinesThisSecond = 0;
        windowStart = currentTime;
      }

      if (stderrLinesThisSecond > 50) {
        if (stderrLinesThisSecond === 51) {
          log.warn(`[${name}] Log flood detected. Muffling stderr for this second.`);
          stderrLinesThisSecond++;
        }
        return;
      }

      stderrLinesThisSecond++;
      log.debug(`[${name}] ${data.toString().trim()}`);
    });

    child.on('exit', (code, signal) => {
      log.warn(`Background peer node ${name} exited with code ${code} (signal ${signal})`);
      if (node.process === child) {
        node.process = null;
        node.status = 'dead';

        // Auto-restart if we are not shutting down the whole mesh
        if (!this.isShuttingDown) {
          log.info(`Scheduling auto-restart for dead peer node: ${name}`);
          setTimeout(() => {
            try {
              this.startNode(name);
            } catch (err: any) {
              log.error(`Auto-restart failed for node ${name}: ${err.message}`);
            }
          }, 2000);
        }
      }
    });

    node.process = child;
  }

  /**
   * Kills all background node processes on Clowder shutdown.
   */
  public stopAll(): void {
    this.isShuttingDown = true;
    for (const name of this.nodes.keys()) {
      const node = this.nodes.get(name);
      if (node && node.process) {
        log.info(`Stopping background peer node process: ${name}`);
        node.process.kill('SIGTERM');
        node.process = null;
        node.status = 'dead';
      }
    }
  }

  /**
   * Returns diagnostic stats for all provisioned peer nodes.
   */
  public getMeshHealth(): Array<{
    name: string;
    status: 'active' | 'dead' | 'cooldown';
    uptime: number;
    restarts: number;
  }> {
    const health: Array<{
      name: string;
      status: 'active' | 'dead' | 'cooldown';
      uptime: number;
      restarts: number;
    }> = [];

    const now = Date.now();
    for (const node of this.nodes.values()) {
      let currentStatus: 'active' | 'dead' | 'cooldown' = node.status || 'dead';
      if (node.process && !node.process.killed) {
        currentStatus = 'active';
      }

      health.push({
        name: node.name,
        status: currentStatus,
        uptime: currentStatus === 'active' && node.startTime ? now - node.startTime : 0,
        restarts: node.restartCount || 0,
      });
    }

    return health;
  }

  /**
   * Helper to retrieve node status (for tests)
   */
  public getNodeProcess(name: string): ChildProcess | null {
    const node = this.nodes.get(name);
    return node ? node.process : null;
  }

  /**
   * Helper to retrieve node's data directory (for tests)
   */
  public getDataDir(name: string): string {
    const node = this.nodes.get(name);
    return node ? node.dataDir : '';
  }
}
