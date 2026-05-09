import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let queryProc: ChildProcess | null = null;
let latestPos = { x: 0, y: 0 };
let active = false;
let restartTimer: NodeJS.Timeout | undefined;

/**
 * Path to the compiled cursor_query binary.
 * - Dev: next to main.js in dist/main/
 * - Packaged: in resources/ next to app.asar (extraResources)
 */
const BINARY_PATH = app.isPackaged
  ? join(process.resourcesPath, 'cursor_query')
  : join(dirname(fileURLToPath(import.meta.url)), 'cursor_query');

export function startCursorTracker(): void {
  if (active) return;
  active = true;

  try {
    queryProc = spawn(BINARY_PATH, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const rl = createInterface({ input: queryProc.stdout! });

    rl.on('line', (line: string) => {
      if (!active) return;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const x = parseInt(parts[0], 10);
        const y = parseInt(parts[1], 10);
        if (!isNaN(x) && !isNaN(y)) {
          latestPos = { x, y };
        }
      }
    });

    queryProc.stderr?.on('data', (data: Buffer) => {
      if (active) {
        console.warn('[clicky:cursor] query binary stderr:', data.toString().trim());
      }
    });

    queryProc.on('exit', (code, signal) => {
      console.log('[clicky:cursor] query binary exited', { code, signal });
      queryProc = null;
      if (active) {
        restartTimer = setTimeout(startCursorTracker, 300);
      }
    });

    console.log('[clicky:cursor] tracker started');
  } catch (err) {
    console.error('[clicky:cursor] failed to start tracker:', err);
    queryProc = null;
  }
}

export function stopCursorTracker(): void {
  active = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }
  if (queryProc) {
    queryProc.kill('SIGTERM');
    queryProc = null;
  }
  console.log('[clicky:cursor] tracker stopped');
}

export function getCursorPosition(): { x: number; y: number } {
  return latestPos;
}

/** True if the tracker has ever received a valid (non-zero) position. */
export function hasValidPosition(): boolean {
  return latestPos.x !== 0 || latestPos.y !== 0;
}
