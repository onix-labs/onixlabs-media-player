/**
 * @fileoverview Centralized logging module for the Electron application.
 *
 * This module provides comprehensive logging across all processes (main, renderer, utility)
 * using electron-log. All logs are written to a single file in the userData directory
 * with timestamps and source identification (scopes).
 *
 * Log Format: [YYYY-MM-DD HH:mm:ss.SSS] [LEVEL] [Scope] Message
 *
 * Features:
 * - Unified logging across main and renderer processes via IPC
 * - Automatic capture of renderer console.log/warn/error
 * - Scoped loggers for source identification (similar to Serilog)
 * - File rotation when log exceeds 10MB
 * - Persistent storage in userData directory
 *
 * @module electron/logger
 */

import {createRequire} from 'module';
import {app} from 'electron';
import * as path from 'path';

// Use createRequire to load CJS module electron-log from ESM context
// electron-log doesn't have proper ESM exports, so we can't use `import`
const esmRequire: NodeRequire = createRequire(import.meta.url);
const log: typeof import('electron-log/main') = esmRequire('electron-log/main');

/**
 * Simplified logger interface for helper functions.
 * Matches the LogFunctions interface from electron-log.
 */
interface ScopedLogger {
  error(...params: unknown[]): void;
  warn(...params: unknown[]): void;
  info(...params: unknown[]): void;
  debug(...params: unknown[]): void;
}

/**
 * Log file name.
 */
const LOG_FILE_NAME: string = 'onixplayer.log';

/**
 * Maximum log file size before rotation (10MB).
 */
const MAX_LOG_SIZE: number = 10 * 1024 * 1024;

/**
 * Whether the logger has been initialized.
 */
let isInitialized: boolean = false;

/**
 * Initializes the logging system.
 *
 * Must be called once in the main process before any windows are created.
 * This sets up:
 * - File transport with custom path and format
 * - Console transport for development
 * - IPC listener for renderer process logs
 * - Automatic capture of renderer console output
 *
 * @param options - Initialization options
 * @param options.spyRendererConsole - Whether to capture renderer console.log calls (default: true)
 */
export function initializeLogger(options: {spyRendererConsole?: boolean} = {}): void {
  if (isInitialized) {
    log.warn('[Logger] Logger already initialized, skipping');
    return;
  }

  const {spyRendererConsole = true}: {spyRendererConsole?: boolean} = options;

  // Configure file transport
  const userDataPath: string = app.getPath('userData');
  const logFilePath: string = path.join(userDataPath, LOG_FILE_NAME);

  log.transports.file.resolvePathFn = (): string => logFilePath;
  log.transports.file.maxSize = MAX_LOG_SIZE;
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}';

  // Configure console transport (for development)
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {scope} {text}';

  // Set minimum log level (debug in development, info in production)
  const isDevelopment: boolean = process.env['NODE_ENV'] === 'development';
  log.transports.file.level = isDevelopment ? 'debug' : 'info';
  log.transports.console.level = isDevelopment ? 'debug' : 'info';

  // Initialize with renderer console spying
  // This injects a preload script that captures console.log in renderer processes
  log.initialize({spyRendererConsole});

  // Catch unhandled errors and rejections
  log.errorHandler.startCatching({
    showDialog: false,
    onError: ({error}: {error: Error}): void => {
      log.error('[Uncaught]', error);
    },
  });

  isInitialized = true;

  // Log initialization
  const mainLog: ScopedLogger = log.scope('Main');
  mainLog.info('Logger initialized');
  mainLog.info(`Log file: ${logFilePath}`);
  mainLog.info(`Environment: ${isDevelopment ? 'development' : 'production'}`);
}

/**
 * Gets the path to the log file.
 *
 * @returns The absolute path to the log file
 */
export function getLogFilePath(): string {
  const userDataPath: string = app.getPath('userData');
  return path.join(userDataPath, LOG_FILE_NAME);
}

// ============================================================================
// Scoped Loggers
// ============================================================================

/**
 * Logger for main process application lifecycle events.
 */
export const mainLogger: ScopedLogger = log.scope('Main');

/**
 * Logger for IPC communication between main and renderer.
 */
export const ipcLogger: ScopedLogger = log.scope('IPC');

/**
 * Logger for the unified media server (HTTP API, SSE).
 */
export const serverLogger: ScopedLogger = log.scope('Server');

/**
 * Logger for playlist management operations.
 */
export const playlistLogger: ScopedLogger = log.scope('Playlist');

/**
 * Logger for media playback state and control.
 */
export const playbackLogger: ScopedLogger = log.scope('Playback');

/**
 * Logger for settings management and persistence.
 */
export const settingsLogger: ScopedLogger = log.scope('Settings');

/**
 * Logger for FFmpeg child process operations.
 */
export const ffmpegLogger: ScopedLogger = log.scope('FFmpeg');

/**
 * Logger for FluidSynth/MIDI operations.
 */
export const midiLogger: ScopedLogger = log.scope('MIDI');

/**
 * Logger for file system operations.
 */
export const fsLogger: ScopedLogger = log.scope('FS');

/**
 * Logger for window management (fullscreen, miniplayer, etc.).
 */
export const windowLogger: ScopedLogger = log.scope('Window');

/**
 * Logger for application menu events.
 */
export const menuLogger: ScopedLogger = log.scope('Menu');

/**
 * Logger for renderer process events (via IPC).
 * Note: This is primarily used when manually logging from renderer via IPC.
 * Console.log captures are automatically scoped as 'renderer'.
 */
export const rendererLogger: ScopedLogger = log.scope('Renderer');

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a custom scoped logger.
 *
 * Use this when the predefined scopes don't fit your needs.
 *
 * @param scope - The scope name to identify the log source
 * @returns A scoped logger instance
 *
 * @example
 * const myLogger = createScopedLogger('MyComponent');
 * myLogger.info('Something happened');
 * // Output: [2025-01-25 08:30:45.123] [info] [MyComponent] Something happened
 */
export function createScopedLogger(scope: string): ScopedLogger {
  return log.scope(scope);
}

/**
 * Logs an HTTP request with timing information.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Request path
 * @param statusCode - Response status code
 * @param durationMs - Request duration in milliseconds
 */
export function logHttpRequest(method: string, path: string, statusCode: number, durationMs: number): void {
  const level: 'warn' | 'debug' = statusCode >= 400 ? 'warn' : 'debug';
  serverLogger[level](`${method} ${path} ${statusCode} ${durationMs}ms`);
}

/**
 * Logs a child process spawn with arguments.
 *
 * @param logger - The scoped logger to use (e.g., ffmpegLogger, midiLogger)
 * @param command - The command being executed
 * @param args - Command arguments
 */
export function logProcessSpawn(logger: ScopedLogger, command: string, args: readonly string[]): void {
  // Truncate long argument lists for readability
  const argsStr: string = args.length > 10
    ? `${args.slice(0, 10).join(' ')} ... (${args.length} total args)`
    : args.join(' ');
  logger.debug(`Spawning: ${command} ${argsStr}`);
}

/**
 * Logs child process output (stdout/stderr).
 *
 * @param logger - The scoped logger to use
 * @param stream - 'stdout' or 'stderr'
 * @param data - The output data
 */
export function logProcessOutput(logger: ScopedLogger, stream: 'stdout' | 'stderr', data: string): void {
  // Split multi-line output and log each line
  const lines: string[] = data.trim().split('\n').filter((line: string): boolean => Boolean(line.trim()));
  for (const line of lines) {
    // Use debug for stdout, warn for stderr (but FFmpeg uses stderr for info)
    logger.debug(`[${stream}] ${line}`);
  }
}

/**
 * Logs child process exit.
 *
 * @param logger - The scoped logger to use
 * @param command - The command that was executed
 * @param code - Exit code (null if killed by signal)
 * @param signal - Signal that killed the process (null if exited normally)
 */
export function logProcessExit(logger: ScopedLogger, command: string, code: number | null, signal: string | null): void {
  if (signal) {
    logger.warn(`${command} killed by signal ${signal}`);
  } else if (code === 0) {
    logger.debug(`${command} exited successfully`);
  } else {
    logger.warn(`${command} exited with code ${code}`);
  }
}

// Export the base log instance for advanced usage
export {log};
