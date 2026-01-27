/**
 * @fileoverview Tests for logger helper functions.
 *
 * Tests the utility functions that format log messages for HTTP requests,
 * process spawn, process output, and process exit events.
 *
 * @module electron/logger.spec
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock electron module before any imports that use it
vi.mock('electron', () => ({
  app: {
    getPath: (): string => '/tmp/onixplayer-test',
  },
}));

// Mock electron-log via createRequire
vi.mock('module', () => ({
  createRequire: (): (() => Record<string, unknown>) => (): Record<string, unknown> => ({
    transports: {
      file: { resolvePathFn: null, maxSize: 0, format: '', level: '' },
      console: { format: '', level: '' },
    },
    scope: (name: string): Record<string, (...args: unknown[]) => void> => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      _scope: name,
    }),
    initialize: vi.fn(),
    errorHandler: { startCatching: vi.fn() },
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { logHttpRequest, logProcessSpawn, logProcessOutput, logProcessExit, serverLogger } from './logger.js';

// ============================================================================
// Tests
// ============================================================================

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
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessSpawn(mockLogger, 'ffmpeg', ['-i', 'input.mp4', '-c:v', 'libx264', 'output.mp4']);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Spawning: ffmpeg -i input.mp4 -c:v libx264 output.mp4'
      );
    });

    it('truncates long argument lists (> 10 args)', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      const args: string[] = Array.from({length: 15}, (_: unknown, i: number): string => `arg${i}`);
      logProcessSpawn(mockLogger, 'ffmpeg', args);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('... (15 total args)')
      );
    });

    it('does not truncate exactly 10 args', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      const args: string[] = Array.from({length: 10}, (_: unknown, i: number): string => `arg${i}`);
      logProcessSpawn(mockLogger, 'cmd', args);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.not.stringContaining('total args')
      );
    });

    it('handles empty argument list', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessSpawn(mockLogger, 'ls', []);
      expect(mockLogger.debug).toHaveBeenCalledWith('Spawning: ls ');
    });
  });

  // ==========================================================================
  // logProcessOutput
  // ==========================================================================

  describe('logProcessOutput', (): void => {
    it('logs single line of stdout', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessOutput(mockLogger, 'stdout', 'Hello world');
      expect(mockLogger.debug).toHaveBeenCalledWith('[stdout] Hello world');
    });

    it('logs multi-line output as separate lines', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessOutput(mockLogger, 'stderr', 'Line 1\nLine 2\nLine 3');
      expect(mockLogger.debug).toHaveBeenCalledTimes(3);
      expect(mockLogger.debug).toHaveBeenCalledWith('[stderr] Line 1');
      expect(mockLogger.debug).toHaveBeenCalledWith('[stderr] Line 2');
      expect(mockLogger.debug).toHaveBeenCalledWith('[stderr] Line 3');
    });

    it('skips empty lines', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessOutput(mockLogger, 'stdout', 'Line 1\n\n\nLine 2');
      expect(mockLogger.debug).toHaveBeenCalledTimes(2);
    });

    it('trims whitespace from data', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessOutput(mockLogger, 'stdout', '  \n  ');
      expect(mockLogger.debug).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // logProcessExit
  // ==========================================================================

  describe('logProcessExit', (): void => {
    it('logs successful exit (code 0) at debug level', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessExit(mockLogger, 'ffmpeg', 0, null);
      expect(mockLogger.debug).toHaveBeenCalledWith('ffmpeg exited successfully');
    });

    it('logs non-zero exit at warn level', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessExit(mockLogger, 'ffmpeg', 1, null);
      expect(mockLogger.warn).toHaveBeenCalledWith('ffmpeg exited with code 1');
    });

    it('logs signal termination at warn level', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessExit(mockLogger, 'fluidsynth', null, 'SIGTERM');
      expect(mockLogger.warn).toHaveBeenCalledWith('fluidsynth killed by signal SIGTERM');
    });

    it('prefers signal over code when both present', (): void => {
      const mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      logProcessExit(mockLogger, 'cmd', 137, 'SIGKILL');
      expect(mockLogger.warn).toHaveBeenCalledWith('cmd killed by signal SIGKILL');
    });
  });
});
