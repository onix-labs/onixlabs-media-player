/**
 * @fileoverview Tests for logger helper functions.
 *
 * Tests the utility functions that format log messages for HTTP requests,
 * process spawn, process output, and process exit events.
 *
 * @module electron/logger.spec
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import * as path from 'path';

// Mock electron module before any imports that use it. Only userData is a
// sensible place for the log, so any other request gets an obviously wrong path.
vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => name === 'userData' ? '/tmp/onixplayer-test' : `/not-user-data/${name}`,
  },
}));

// Mock electron-log via createRequire. Each load of the logger module gets its
// own instance, which hands out one logger per scope name, as electron-log does.
vi.mock('module', () => ({
  createRequire: (): (() => Record<string, unknown>) => (): Record<string, unknown> => {
    const scopes: Map<string, Record<string, unknown>> = new Map<string, Record<string, unknown>>();
    return {
      transports: {
        file: { resolvePathFn: null, maxSize: 0, format: '', level: '', sync: true },
        console: { format: '', level: '' },
      },
      scope: (name: string): Record<string, unknown> => {
        const existing: Record<string, unknown> | undefined = scopes.get(name);
        if (existing) return existing;
        const created: Record<string, unknown> = {
          error: vi.fn(),
          warn: vi.fn(),
          info: vi.fn(),
          debug: vi.fn(),
          _scope: name,
        };
        scopes.set(name, created);
        return created;
      },
      initialize: vi.fn(),
      errorHandler: { startCatching: vi.fn() },
      warn: vi.fn(),
      error: vi.fn(),
    };
  },
}));

import { logHttpRequest, logProcessSpawn, logProcessOutput, logProcessExit, serverLogger } from './logger.js';

// ============================================================================
// Helpers
// ============================================================================

/** A scoped logger as the electron-log mock hands it out. */
interface FakeScopedLogger {
  readonly error: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly info: ReturnType<typeof vi.fn>;
  readonly debug: ReturnType<typeof vi.fn>;
  readonly _scope: string;
}

/** The parts of the electron-log mock the tests inspect. */
interface FakeLog {
  readonly transports: {
    readonly file: { resolvePathFn: (() => string) | null; maxSize: number; format: string; level: string; sync: boolean };
    readonly console: { format: string; level: string };
  };
  readonly scope: (name: string) => FakeScopedLogger;
  readonly initialize: ReturnType<typeof vi.fn>;
  readonly errorHandler: { readonly startCatching: ReturnType<typeof vi.fn> };
  readonly warn: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
}

/** A freshly loaded logger module together with the electron-log mock behind it. */
interface FreshLogger {
  readonly logger: typeof import('./logger.js');
  readonly log: FakeLog;
}

/**
 * Loads a new copy of the logger module, so that "already initialized" from
 * one test cannot leak into the next.
 */
async function loadFreshLogger(): Promise<FreshLogger> {
  vi.resetModules();
  const logger: typeof import('./logger.js') = await import('./logger.js');
  return { logger, log: logger.log as unknown as FakeLog };
}

/** Where the log file belongs: in the mocked userData directory. */
const EXPECTED_LOG_FILE: string = path.join('/tmp/onixplayer-test', 'onixplayer.log');

// ============================================================================
// Tests
// ============================================================================

/** A log method that records its calls. */
type LogMethodMock = Mock<(...params: unknown[]) => void>;

/** A scoped logger whose every level records its calls. */
interface MockScopedLogger {
  debug: LogMethodMock;
  info: LogMethodMock;
  warn: LogMethodMock;
  error: LogMethodMock;
}

function createMockScopedLogger(): MockScopedLogger {
  return {
    debug: vi.fn<(...params: unknown[]) => void>(),
    info: vi.fn<(...params: unknown[]) => void>(),
    warn: vi.fn<(...params: unknown[]) => void>(),
    error: vi.fn<(...params: unknown[]) => void>(),
  };
}

describe('logger helpers', (): void => {
  beforeEach((): void => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // logHttpRequest
  // ==========================================================================

  describe('logHttpRequest', (): void => {
    it('logs successful request at debug level', (): void => {
      logHttpRequest('GET', '/player/state', 200, 5);
      expect(serverLogger.debug).toHaveBeenCalledWith('GET /player/state 200 5ms');
    });

    it('logs client error at warn level', (): void => {
      logHttpRequest('POST', '/invalid', 404, 2);
      expect(serverLogger.warn).toHaveBeenCalledWith('POST /invalid 404 2ms');
    });

    it('logs server error at warn level', (): void => {
      logHttpRequest('GET', '/media/stream', 500, 100);
      expect(serverLogger.warn).toHaveBeenCalledWith('GET /media/stream 500 100ms');
    });

    it('logs 399 status at debug level (not an error)', (): void => {
      logHttpRequest('GET', '/test', 399, 10);
      expect(serverLogger.debug).toHaveBeenCalledWith('GET /test 399 10ms');
    });

    it('logs 400 status at warn level (boundary)', (): void => {
      logHttpRequest('GET', '/test', 400, 10);
      expect(serverLogger.warn).toHaveBeenCalledWith('GET /test 400 10ms');
    });
  });

  // ==========================================================================
  // logProcessSpawn
  // ==========================================================================

  describe('logProcessSpawn', (): void => {
    it('logs command with short argument list', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessSpawn(mockLogger, 'ffmpeg', ['-i', 'input.mp4', '-c:v', 'libx264', 'output.mp4']);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Spawning: ffmpeg -i input.mp4 -c:v libx264 output.mp4'
      );
    });

    it('truncates long argument lists (> 10 args)', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      const args: string[] = Array.from({length: 15}, (_: unknown, i: number): string => `arg${i}`);
      logProcessSpawn(mockLogger, 'ffmpeg', args);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('... (15 total args)')
      );
    });

    it('does not truncate exactly 10 args', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      const args: string[] = Array.from({length: 10}, (_: unknown, i: number): string => `arg${i}`);
      logProcessSpawn(mockLogger, 'cmd', args);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.not.stringContaining('total args')
      );
    });

    it('handles empty argument list', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessSpawn(mockLogger, 'ls', []);
      expect(mockLogger.debug).toHaveBeenCalledWith('Spawning: ls ');
    });
  });

  // ==========================================================================
  // logProcessOutput
  // ==========================================================================

  describe('logProcessOutput', (): void => {
    it('logs single line of stdout', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessOutput(mockLogger, 'stdout', 'Hello world');
      expect(mockLogger.debug).toHaveBeenCalledWith('[stdout] Hello world');
    });

    it('logs multi-line output as separate lines', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessOutput(mockLogger, 'stderr', 'Line 1\nLine 2\nLine 3');
      expect(mockLogger.debug).toHaveBeenCalledTimes(3);
      expect(mockLogger.debug).toHaveBeenCalledWith('[stderr] Line 1');
      expect(mockLogger.debug).toHaveBeenCalledWith('[stderr] Line 2');
      expect(mockLogger.debug).toHaveBeenCalledWith('[stderr] Line 3');
    });

    it('skips empty lines', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessOutput(mockLogger, 'stdout', 'Line 1\n\n\nLine 2');
      expect(mockLogger.debug).toHaveBeenCalledTimes(2);
    });

    it('trims whitespace from data', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessOutput(mockLogger, 'stdout', '  \n  ');
      expect(mockLogger.debug).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // logProcessExit
  // ==========================================================================

  describe('logProcessExit', (): void => {
    it('logs successful exit (code 0) at debug level', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessExit(mockLogger, 'ffmpeg', 0, null);
      expect(mockLogger.debug).toHaveBeenCalledWith('ffmpeg exited successfully');
    });

    it('logs non-zero exit at warn level', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessExit(mockLogger, 'ffmpeg', 1, null);
      expect(mockLogger.warn).toHaveBeenCalledWith('ffmpeg exited with code 1');
    });

    it('logs signal termination at warn level', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessExit(mockLogger, 'fluidsynth', null, 'SIGTERM');
      expect(mockLogger.warn).toHaveBeenCalledWith('fluidsynth killed by signal SIGTERM');
    });

    it('prefers signal over code when both present', (): void => {
      const mockLogger: MockScopedLogger = createMockScopedLogger();
      logProcessExit(mockLogger, 'cmd', 137, 'SIGKILL');
      expect(mockLogger.warn).toHaveBeenCalledWith('cmd killed by signal SIGKILL');
    });
  });
});

// ============================================================================
// Initialization
// ============================================================================

describe('initializeLogger', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('writes the log to onixplayer.log in the user data directory', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    expect(log.transports.file.resolvePathFn?.()).toBe(EXPECTED_LOG_FILE);
  });

  it('rotates the log file at 10 MB', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    expect(log.transports.file.maxSize).toBe(10 * 1024 * 1024);
  });

  it('queues file writes instead of blocking on each line', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    expect(log.transports.file.sync).toBe(false);
  });

  it.each(['file', 'console'] as const)('puts the level, scope and message in every %s line', async (transport: 'file' | 'console'): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    expect(log.transports[transport].format).toMatch(/\[\{level\}\] \{scope\} \{text\}$/);
  });

  it('dates the lines of the file, which outlives the day it was written on', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    expect(log.transports.file.format).toMatch(/^\[\{y\}-\{m\}-\{d\} \{h\}:\{i\}:\{s\}\.\{ms\}\]/);
  });

  it.each([
    { environment: 'development', level: 'debug' },
    { environment: 'production', level: 'info' },
    { environment: '', level: 'info' },
  ])('logs at $level and above when NODE_ENV is "$environment"', async ({ environment, level }: { environment: string; level: string }): Promise<void> => {
    vi.stubEnv('NODE_ENV', environment);
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    expect([log.transports.file.level, log.transports.console.level]).toEqual([level, level]);
  });

  it('captures the renderer console by default', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    expect(log.initialize.mock.calls).toEqual([[{ spyRendererConsole: true }]]);
  });

  it('leaves the renderer console alone when asked to', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger({ spyRendererConsole: false });

    expect(log.initialize.mock.calls).toEqual([[{ spyRendererConsole: false }]]);
  });

  it('catches unhandled errors without showing a dialog', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    expect(log.errorHandler.startCatching).toHaveBeenCalledTimes(1);
    expect(log.errorHandler.startCatching.mock.calls[0][0]).toMatchObject({ showDialog: false });
  });

  it('logs an unhandled error it catches, marked as uncaught', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();
    logger.initializeLogger();
    const options: { onError: (details: { error: Error }) => void } = log.errorHandler.startCatching.mock.calls[0][0] as { onError: (details: { error: Error }) => void };
    const failure: Error = new Error('boom');

    options.onError({ error: failure });

    expect(log.error.mock.calls).toEqual([['[Uncaught]', failure]]);
  });

  it('records where the log file is and which environment it started in', async (): Promise<void> => {
    vi.stubEnv('NODE_ENV', 'development');
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    const messages: unknown[] = log.scope('Main').info.mock.calls.map((call: unknown[]): unknown => call[0]);
    expect(messages).toContain(`Log file: ${EXPECTED_LOG_FILE}`);
    expect(messages).toContain('Environment: development');
  });

  it('warns and changes nothing when initialized a second time', async (): Promise<void> => {
    vi.stubEnv('NODE_ENV', 'production');
    const { logger, log }: FreshLogger = await loadFreshLogger();
    logger.initializeLogger({ spyRendererConsole: false });
    vi.stubEnv('NODE_ENV', 'development');

    logger.initializeLogger({ spyRendererConsole: true });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('already initialized'));
    expect(log.initialize).toHaveBeenCalledTimes(1);
    expect(log.errorHandler.startCatching).toHaveBeenCalledTimes(1);
    expect(log.transports.file.level).toBe('info');
  });

  it('does not warn on the first initialization', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    logger.initializeLogger();

    expect(log.warn).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Log file path and custom scopes
// ============================================================================

describe('getLogFilePath', (): void => {
  it('returns onixplayer.log in the user data directory', async (): Promise<void> => {
    const { logger }: FreshLogger = await loadFreshLogger();

    expect(logger.getLogFilePath()).toBe(EXPECTED_LOG_FILE);
  });

  it('is available before the logger is initialized and names the file the logger then writes', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();
    const before: string = logger.getLogFilePath();

    logger.initializeLogger();

    expect(log.transports.file.resolvePathFn?.()).toBe(before);
  });
});

describe('createScopedLogger', (): void => {
  it('returns the logger for the named scope', async (): Promise<void> => {
    const { logger, log }: FreshLogger = await loadFreshLogger();

    const scoped: unknown = logger.createScopedLogger('Download');

    expect(scoped).toBe(log.scope('Download'));
    expect(log.scope('Download')._scope).toBe('Download');
  });
});
