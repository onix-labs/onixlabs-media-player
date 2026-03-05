/**
 * @fileoverview Electron main process entry point.
 *
 * This file initializes the Electron application, creates the main browser window,
 * starts the unified media server, and sets up IPC handlers for communication
 * between the main process and renderer process.
 *
 * Architecture overview:
 * - Main process (this file) handles native OS interactions (dialogs, fullscreen)
 * - UnifiedMediaServer provides HTTP API for all media operations
 * - Renderer communicates via IPC for native features, HTTP for media operations
 * - Custom 'media://' protocol enables secure local file access
 *
 * @module electron/main
 */

import {app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, screen} from "electron";
import * as path from "path";
import {fileURLToPath} from "url";
import {UnifiedMediaServer} from './unified-media-server.js';
import {createApplicationMenu, updateMenuState} from './application-menu.js';
import type {WindowBounds, MacOSVisualEffectState, AppearanceSettings, RecentItem, RecentItemsSettings} from './settings-manager.js';
import type {SettingsManager} from './settings-manager.js';
import type {DependencyState} from './dependency-manager.js';
import {initializeLogger, mainLogger, ipcLogger, windowLogger, getLogFilePath} from './logger.js';
import {existsSync} from 'fs';

/**
 * Supported audio file extensions for file association handling.
 * Used to determine if a file opened from the OS should be treated as a media file.
 */
const AUDIO_EXTENSIONS: readonly string[] = ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'mid', 'midi'];

/**
 * Supported video file extensions for file association handling.
 * Used to determine if a file opened from the OS should be treated as a media file.
 */
const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'm4v', 'mkv', 'avi', 'webm', 'mov'];

/**
 * Files passed to the app before it was ready.
 * These are queued and processed after the window is created.
 */
let pendingFilesToOpen: string[] = [];

// Set app name (shows in dock/menu bar during development)
app.setName('ONIXPlayer');

// Allow audio autoplay without user gesture
// Required for media player to start playback programmatically
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/**
 * Register the custom 'media://' protocol scheme before app is ready.
 * This must be called synchronously before app ready event.
 *
 * The media protocol enables:
 * - Secure access to local files from the renderer
 * - Streaming support for large media files
 * - Bypassing CSP restrictions for local file access
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
]);

/**
 * Main application class that orchestrates the Electron app lifecycle.
 *
 * Responsibilities:
 * - Creating and managing the main browser window
 * - Starting the unified media server for HTTP-based media operations
 * - Setting up IPC handlers for native functionality
 * - Managing fullscreen state and window events
 * - Handling macOS-specific behaviors (dock activation, window restoration)
 *
 * @example
 * // Application is started via static run method
 * Program.run();
 */
class Program {
  /**
   * Whether the application is running in development mode.
   * Determined by NODE_ENV environment variable.
   */
  private static readonly IS_DEVELOPMENT: boolean = process.env["NODE_ENV"] === "development";

  /**
   * URL of the Angular development server for hot reload support.
   * Only used when IS_DEVELOPMENT is true.
   */
  private static readonly DEVELOPMENT_SERVER_URL: string = process.env["DEV_SERVER_URL"] || "http://localhost:4200";

  /**
   * Calculates the project root directory path.
   *
   * Handles different scenarios:
   * - Packaged app: Uses app.getAppPath()
   * - Development (running .ts via tsx): Goes up 1 level from electron/main.ts
   * - Production testing (compiled .js): Goes up 2 levels from electron/dist/main.js
   *
   * @returns The absolute path to the project root directory
   */
  private static getProjectRoot(): string {
    // In packaged app, use app.getAppPath()
    // In development/prod testing, calculate from file location
    if (app.isPackaged) {
      return app.getAppPath();
    }
    const filename: string = fileURLToPath(import.meta.url);
    const dirname: string = path.dirname(filename);
    // When running TS via tsx: src/electron/main.ts -> go up 2 levels
    // When running compiled JS: src/electron/dist/main.js -> go up 3 levels
    const levels: number = filename.endsWith('.ts') ? 2 : 3;
    return path.resolve(dirname, ...Array(levels).fill('..'));
  }

  /** The main browser window instance, null when closed */
  private window: BrowserWindow | null = null;

  /** The configuration window instance, null when closed */
  private configWindow: BrowserWindow | null = null;

  /** The about window instance, null when closed */
  private aboutWindow: BrowserWindow | null = null;

  /** The setup wizard window instance, null when closed */
  private setupWizardWindow: BrowserWindow | null = null;

  /** Whether the setup wizard was closed legitimately (via complete/skip) */
  private setupWizardClosedLegitimately: boolean = false;

  /** The unified HTTP media server instance */
  private mediaServer: UnifiedMediaServer | null = null;

  /** The port the media server is running on */
  private serverPort: number = 0;

  /** Stored desktop window bounds for restoring when exiting mini-player */
  private desktopBounds: Electron.Rectangle | null = null;

  /** Whether the window is currently in mini-player mode */
  private isInMiniPlayerMode: boolean = false;

  /** Snap threshold in pixels for magnetic edge snapping */
  private readonly SNAP_THRESHOLD: number = 40;

  /** Gap in pixels between window and screen edge when snapped */
  private readonly SNAP_GAP: number = 10;

  /** Whether the window is currently closing (to prevent re-entry) */
  private isClosing: boolean = false;

  /** Duration for audio fade-out before window close (milliseconds) */
  private readonly CLOSE_FADE_DURATION: number = 150;

  /** Whether the application is currently in configuration mode (settings view) */
  private isInConfigurationMode: boolean = false;

  /** Stored main window bounds before opening config window (for restoration on close) */
  private mainWindowBoundsBeforeConfig: Electron.Rectangle | null = null;

  /**
   * Gets the default background color based on system theme.
   * Used when glass is disabled or on platforms without glass support.
   *
   * @returns Dark gray (#1e1e1e) for dark mode, light gray (#e0e0e0) for light mode
   */
  private getDefaultBackgroundColor(): string {
    try {
      return nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#e0e0e0';
    } catch {
      return '#1e1e1e'; // Fallback to dark
    }
  }

  /**
   * Private constructor - use Program.run() to start the application.
   * Sets up single-instance lock and waits for Electron's app ready event.
   */
  private constructor() {
    // Request single instance lock - ensures only one instance of the app runs
    const gotTheLock: boolean = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      // Another instance is already running - it will receive our files via second-instance event
      app.quit();
      return;
    }

    // Handle second instance launch (Windows/Linux - when user opens file while app is running)
    app.on('second-instance', (_event: Electron.Event, argv: string[]): void => {
      // Extract file paths from command line arguments (skip Electron flags)
      const files: string[] = argv.slice(1).filter((arg: string): boolean =>
        !arg.startsWith('-') && !arg.startsWith('--') && existsSync(arg)
      );
      files.forEach((f: string): void => this.handleFileFromOS(f));

      // Focus the existing window
      if (this.window) {
        if (this.window.isMinimized()) {
          this.window.restore();
        }
        this.window.focus();
      }
    });

    // Handle open-file event (macOS - when user double-clicks a file or drops on dock icon)
    app.on('open-file', (event: Electron.Event, filePath: string): void => {
      event.preventDefault();
      if (this.window) {
        this.handleFileFromOS(filePath);
      } else {
        // App not ready yet - queue for later
        pendingFilesToOpen.push(filePath);
      }
    });

    app.whenReady().then(this.initialize.bind(this));
  }

  /**
   * Static entry point to start the application.
   * Creates a new Program instance which triggers initialization.
   */
  public static run(): void {
    new Program();
  }

  /**
   * Initializes the application after Electron is ready.
   *
   * Initialization sequence:
   * 1. Initialize logging system
   * 2. Register the media:// protocol handler
   * 3. Start the unified media server (HTTP API + SSE)
   * 4. Create the main browser window
   * 5. Set up IPC handlers for native functionality
   * 6. Set up window events for fullscreen notifications
   * 7. Load the Angular application (dev server or built files)
   * 8. Register lifecycle event handlers
   */
  private async initialize(): Promise<void> {
    // Initialize logging first (captures renderer console.log via preload)
    initializeLogger({spyRendererConsole: true});
    mainLogger.info('Application starting');
    mainLogger.debug(`Platform: ${process.platform}, Arch: ${process.arch}`);
    mainLogger.debug(`Electron: ${process.versions.electron}, Node: ${process.versions.node}`);
    mainLogger.debug(`Development mode: ${Program.IS_DEVELOPMENT}`);

    this.registerMediaProtocol();
    mainLogger.debug('Media protocol registered');

    // Start the unified media server (HTTP API + SSE)
    // In production, also serve the Angular app via HTTP to avoid file:// CORS issues
    const staticPath: string | undefined = Program.IS_DEVELOPMENT
      ? undefined
      : path.join(Program.getProjectRoot(), "dist", "onixlabs-media-player", "browser");
    mainLogger.debug('Starting unified media server');
    this.mediaServer = new UnifiedMediaServer(staticPath);
    this.serverPort = await this.mediaServer.start();
    mainLogger.info(`Media server started on port ${this.serverPort}`);

    // Nuke any stale MIDI cache from previous sessions
    this.mediaServer.nukeMidiCache();

    // Register callback to update menu when shuffle/repeat mode changes
    this.mediaServer.onModeChange((shuffle: boolean, repeat: boolean): void => {
      mainLogger.debug(`Mode changed: shuffle=${shuffle}, repeat=${repeat}`);
      updateMenuState({shuffleEnabled: shuffle, repeatEnabled: repeat});
    });

    // Register callback to update menu when playlist count changes (enables/disables shuffle/repeat)
    this.mediaServer.onPlaylistCountChange((count: number): void => {
      mainLogger.debug(`Playlist count changed: ${count}`);
      const hasMedia: boolean = count > 0;
      updateMenuState({hasMedia});
      // On macOS, disable the green traffic light button when no media is loaded
      if (process.platform === 'darwin' && this.window) {
        this.window.setFullScreenable(hasMedia);
      }
    });

    // Register callback to update menu when playback state changes (Play/Pause label)
    this.mediaServer.onPlaybackStateChange((isPlaying: boolean): void => {
      mainLogger.debug(`Playback state changed: ${isPlaying ? 'playing' : 'paused'}`);
      updateMenuState({isPlaying});
    });

    // Register callback to update menu when media type changes (enables/disables Aspect Ratio)
    this.mediaServer.onMediaTypeChange((isVideo: boolean): void => {
      mainLogger.debug(`Media type changed: isVideo=${isVideo}`);
      updateMenuState({isVideo});
    });

    // Register callback to update menu when dependency state changes (enables/disables Open)
    this.mediaServer.onDependencyStateChange((ffmpeg: boolean, fluidsynth: boolean): void => {
      mainLogger.debug(`Dependency state changed: ffmpeg=${ffmpeg}, fluidsynth=${fluidsynth}`);
      updateMenuState({openEnabled: ffmpeg || fluidsynth});
    });

    // Register callback to update menu when recent items change
    this.mediaServer.onRecentItemsChange((recentFiles: readonly RecentItem[], recentPlaylists: readonly RecentItem[]): void => {
      mainLogger.debug(`Recent items changed: ${recentFiles.length} files, ${recentPlaylists.length} playlists`);
      updateMenuState({recentFiles, recentPlaylists});
    });

    // Set initial openEnabled state based on current dependency detection
    const depState: DependencyState = this.mediaServer.getDependencyManager().getState();
    updateMenuState({openEnabled: depState.ffmpeg.installed || depState.fluidsynth.installed});

    // Setup core IPC handlers needed by any window (including setup wizard)
    this.setupCoreIpcHandlers();

    // Check if this is a first run or if --first-run flag was passed
    const isFirstRun: boolean = !this.mediaServer.getSettingsManager().isSetupComplete();
    const forceFirstRun: boolean = process.argv.includes('--first-run');

    if (isFirstRun || forceFirstRun) {
      mainLogger.info(`Showing setup wizard (firstRun=${isFirstRun}, forceFirstRun=${forceFirstRun})`);
      this.setupSetupWizardIpcHandlers();
      await this.showSetupWizard();
    }

    mainLogger.debug('Creating browser window');
    this.window = this.createBrowserWindow();
    this.setupIpcHandlers();
    this.setupWindowEvents();
    this.setupApplicationMenu();
    mainLogger.debug('Window setup complete');

    // Load Angular app - use HTTP in both dev and prod to avoid CORS issues
    if (Program.IS_DEVELOPMENT) {
      mainLogger.info(`Loading development server: ${Program.DEVELOPMENT_SERVER_URL}`);
      void this.window.loadURL(Program.DEVELOPMENT_SERVER_URL);
    } else {
      const prodUrl: string = `http://127.0.0.1:${this.serverPort}/`;
      mainLogger.info(`Loading production build: ${prodUrl}`);
      void this.window.loadURL(prodUrl);
    }

    // Process pending files after the renderer is ready
    this.window.webContents.once('did-finish-load', (): void => {
      mainLogger.debug('Renderer loaded - processing pending files');
      this.processPendingFiles();
    });

    this.window.on("closed", this.onClosed.bind(this));
    app.on("activate", this.onActivate.bind(this));
    app.on("window-all-closed", this.onAllWindowsClosed.bind(this));

    mainLogger.info('Application initialized successfully');
  }

  /**
   * Registers the media:// protocol handler.
   *
   * Converts media://path URLs to file:// URLs for local file access.
   * This allows the renderer to securely access local media files
   * without exposing the full file system.
   *
   * @example
   * // In renderer: fetch('media:///path/to/file.mp3')
   * // Handled as: file:///path/to/file.mp3
   */
  private registerMediaProtocol(): void {
    protocol.handle('media', (request: Readonly<Request>): Response | Promise<Response> => {
      // Convert media://path to file path
      const filePath: string = decodeURIComponent(request.url.replace('media://', ''));

      // Validate path to prevent directory traversal
      if (filePath.includes('..')) {
        return new Response('Forbidden', {status: 403});
      }

      return net.fetch('file://' + filePath);
    });
  }

  /**
   * Creates and configures the main browser window.
   *
   * Window configuration:
   * - macOS: Hidden title bar with inset traffic lights for native look
   * - Vibrancy effect for translucent background
   * - Context isolation enabled for security
   * - Node integration disabled (uses preload script)
   * - Sandbox disabled to allow preload script IPC
   *
   * @returns The configured BrowserWindow instance
   */
  private createBrowserWindow(): BrowserWindow {
    const projectRoot: string = Program.getProjectRoot();
    // Preload must always be compiled JS - Electron can't run TS preload scripts
    const preloadPath: string = path.join(projectRoot, "src", "electron", "dist", "preload.js");
    const iconPath: string = path.join(projectRoot, "public", "icon-windows-linux.png");

    // Set dock icon on macOS (for development - packaged apps use Info.plist)
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(iconPath);
    }

    // Build platform-specific window options
    const baseOptions: Electron.BrowserWindowConstructorOptions = {
      width: 960,
      height: 720,
      minWidth: 640,
      minHeight: 480,
      center: true,
      icon: iconPath,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: preloadPath,
        zoomFactor: 1.0,
        webSecurity: true
      }
    };

    // Platform-specific transparency and window chrome options
    let platformOptions: Electron.BrowserWindowConstructorOptions = {};

    // Get appearance settings
    const appearanceSettings: AppearanceSettings | undefined = this.mediaServer?.getSettingsManager().getSettings().appearance;
    const glassEnabled: boolean = appearanceSettings?.glassEnabled ?? true;
    const visualEffectState: MacOSVisualEffectState = appearanceSettings?.macOSVisualEffectState ?? 'active';
    const backgroundColor: string = appearanceSettings?.backgroundColor ?? this.getDefaultBackgroundColor();

    if (process.platform === 'darwin') {
      // macOS: native vibrancy with hidden title bar
      // fullscreenable starts false — enabled when media is loaded (via onPlaylistCountChange)
      platformOptions = {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: {x: 12, y: 13},
        fullscreenable: false,
        // Apply vibrancy if glass enabled, otherwise use background color
        ...(glassEnabled
          ? { vibrancy: 'fullscreen-ui' as const, visualEffectState }
          : { backgroundColor }
        )
      };
    } else if (process.platform === 'win32') {
      // Windows 11: acrylic blur effect when glass enabled
      // Note: Do NOT use transparent:true with backgroundMaterial - it removes the native frame
      // Auto-hide menu bar for cleaner look (press Alt to show)
      platformOptions = glassEnabled
        ? { backgroundMaterial: 'acrylic' as const, autoHideMenuBar: true }
        : { backgroundColor, autoHideMenuBar: true };
    } else {
      // Linux: no native blur support, always use background color
      // Auto-hide menu bar for cleaner look (press Alt to show)
      platformOptions = { backgroundColor, autoHideMenuBar: true };
    }

    const window: BrowserWindow = new BrowserWindow({
      ...baseOptions,
      ...platformOptions
    });

    // Prevent zoom via keyboard shortcuts
    window.webContents.on('before-input-event', (_event: Electron.Event, input: Electron.Input): void => {
      // Block Cmd/Ctrl + Plus, Minus, Zero, and Cmd/Ctrl + Scroll zoom
      if ((input.control || input.meta) && (input.key === '+' || input.key === '-' || input.key === '=' || input.key === '0')) {
        _event.preventDefault();
      }
    });

    // Prevent pinch-to-zoom
    window.webContents.setVisualZoomLevelLimits(1, 1);

    return window;
  }

  /**
   * Creates and shows the configuration window.
   *
   * The configuration window is a fixed-size frameless dialog (800x600) that displays
   * the settings view. It loads the Angular app with a query parameter to
   * indicate it should show only the configuration view.
   *
   * If the window already exists, it will be focused instead of creating a new one.
   *
   * @param initialCategory - Optional category ID to select on open (e.g., 'dependencies')
   */
  private showConfigurationWindow(initialCategory?: string): void {
    // If window already exists, focus it
    if (this.configWindow && !this.configWindow.isDestroyed()) {
      this.configWindow.focus();
      return;
    }

    const projectRoot: string = Program.getProjectRoot();
    const preloadPath: string = path.join(projectRoot, "src", "electron", "dist", "preload.js");

    // Fixed size, non-resizable dialog with hidden title bar
    const configWindowWidth: number = 800;
    const configWindowHeight: number = 600;

    // Platform-specific options for hidden title bar with traffic lights (macOS only)
    // Windows/Linux use the default window frame with title bar and controls
    // Also apply glass/vibrancy/acrylic effects to match main window
    const appearanceSettings: AppearanceSettings | undefined = this.mediaServer?.getSettingsManager().getSettings().appearance;
    const glassEnabled: boolean = appearanceSettings?.glassEnabled ?? true;
    const visualEffectState: MacOSVisualEffectState = appearanceSettings?.macOSVisualEffectState ?? 'active';
    const backgroundColor: string = appearanceSettings?.backgroundColor ?? this.getDefaultBackgroundColor();

    let configPlatformOptions: Electron.BrowserWindowConstructorOptions = {};
    if (process.platform === 'darwin') {
      configPlatformOptions = {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: {x: 12, y: 13},
        ...(glassEnabled
          ? { vibrancy: 'fullscreen-ui' as const, visualEffectState }
          : { backgroundColor }
        )
      };
    } else if (process.platform === 'win32') {
      configPlatformOptions = glassEnabled
        ? { backgroundMaterial: 'acrylic' as const }
        : { backgroundColor };
    } else {
      configPlatformOptions = { backgroundColor };
    }

    // Determine if we should do side-by-side positioning
    // Only in normal windowed mode (not fullscreen, not miniplayer)
    const shouldPositionSideBySide: boolean = this.window !== null &&
      !this.window.isFullScreen() &&
      !this.isInMiniPlayerMode;

    // Calculate positions for side-by-side layout
    let configWindowX: number | undefined;
    let configWindowY: number | undefined;

    if (shouldPositionSideBySide && this.window) {
      // Remember main window position for restoration on close
      this.mainWindowBoundsBeforeConfig = this.window.getBounds();

      // Get the display containing the main window
      const mainBounds: Electron.Rectangle = this.mainWindowBoundsBeforeConfig;
      const display: Electron.Display = screen.getDisplayNearestPoint({
        x: mainBounds.x + mainBounds.width / 2,
        y: mainBounds.y + mainBounds.height / 2
      });
      const workArea: Electron.Rectangle = display.workArea;

      const gutter: number = 32;
      const totalWidth: number = configWindowWidth + mainBounds.width + gutter * 2;

      // Calculate vertical center
      const configY: number = Math.round(workArea.y + (workArea.height - configWindowHeight) / 2);
      const mainY: number = Math.round(workArea.y + (workArea.height - mainBounds.height) / 2);

      if (totalWidth <= workArea.width) {
        // Enough space: position side by side with gutters
        configWindowX = workArea.x + gutter;
        configWindowY = configY;
        const mainX: number = workArea.x + workArea.width - mainBounds.width - gutter;
        this.window.setBounds({x: mainX, y: mainY, width: mainBounds.width, height: mainBounds.height});
      } else {
        // Not enough space: config on left with gutter, main on right with gutter (overlapping allowed)
        configWindowX = workArea.x + gutter;
        configWindowY = configY;
        const mainX: number = workArea.x + workArea.width - mainBounds.width - gutter;
        this.window.setBounds({x: mainX, y: mainY, width: mainBounds.width, height: mainBounds.height});
      }
    }

    this.configWindow = new BrowserWindow({
      width: configWindowWidth,
      height: configWindowHeight,
      x: configWindowX,
      y: configWindowY,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      center: configWindowX === undefined, // Only center if we didn't calculate position
      parent: this.window ?? undefined,
      modal: false,
      show: false,
      title: 'ONIXPlayer Configuration',
      ...configPlatformOptions,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: preloadPath,
        zoomFactor: 1.0,
        webSecurity: true
      }
    });

    // Hide menu bar on Windows/Linux
    this.configWindow.setMenuBarVisibility(false);

    // Load the Angular app with configuration window parameter
    const baseUrl: string = app.isPackaged
      ? `http://127.0.0.1:${this.serverPort}/`
      : Program.DEVELOPMENT_SERVER_URL;
    const categoryParam: string = initialCategory ? `&category=${initialCategory}` : '';
    const configUrl: string = `${baseUrl}?window=configuration${categoryParam}`;

    void this.configWindow.loadURL(configUrl);

    // Show when ready
    this.configWindow.once('ready-to-show', (): void => {
      this.configWindow?.show();
    });

    // Clean up reference and restore main window position when closed
    this.configWindow.on('closed', (): void => {
      // Restore main window to original position
      if (this.mainWindowBoundsBeforeConfig && this.window && !this.window.isDestroyed()) {
        this.window.setBounds(this.mainWindowBoundsBeforeConfig);
      }
      this.mainWindowBoundsBeforeConfig = null;
      this.configWindow = null;
    });

    // Prevent zoom
    this.configWindow.webContents.on('before-input-event', (_event: Electron.Event, input: Electron.Input): void => {
      if ((input.control || input.meta) && (input.key === '+' || input.key === '-' || input.key === '=' || input.key === '0')) {
        _event.preventDefault();
      }
    });
    this.configWindow.webContents.setVisualZoomLevelLimits(1, 1);
  }

  /**
   * Opens the About window.
   *
   * Creates a new BrowserWindow that displays application information
   * including version, dependencies, and links.
   *
   * If the window already exists, it will be focused instead of creating a new one.
   */
  private showAboutWindow(): void {
    // If window already exists, focus it
    if (this.aboutWindow && !this.aboutWindow.isDestroyed()) {
      this.aboutWindow.focus();
      return;
    }

    const projectRoot: string = Program.getProjectRoot();
    const preloadPath: string = path.join(projectRoot, "src", "electron", "dist", "preload.js");

    // Fixed size, non-resizable dialog
    const aboutWindowWidth: number = 480;
    const aboutWindowHeight: number = 640;

    // Platform-specific options for hidden title bar with traffic lights (macOS only)
    const appearanceSettings: AppearanceSettings | undefined = this.mediaServer?.getSettingsManager().getSettings().appearance;
    const glassEnabled: boolean = appearanceSettings?.glassEnabled ?? true;
    const visualEffectState: MacOSVisualEffectState = appearanceSettings?.macOSVisualEffectState ?? 'active';
    const backgroundColor: string = appearanceSettings?.backgroundColor ?? this.getDefaultBackgroundColor();

    let aboutPlatformOptions: Electron.BrowserWindowConstructorOptions = {};
    if (process.platform === 'darwin') {
      aboutPlatformOptions = {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: {x: 12, y: 13},
        ...(glassEnabled
          ? { vibrancy: 'fullscreen-ui' as const, visualEffectState }
          : { backgroundColor }
        )
      };
    } else if (process.platform === 'win32') {
      aboutPlatformOptions = glassEnabled
        ? { backgroundMaterial: 'acrylic' as const }
        : { backgroundColor };
    } else {
      aboutPlatformOptions = { backgroundColor };
    }

    this.aboutWindow = new BrowserWindow({
      width: aboutWindowWidth,
      height: aboutWindowHeight,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      center: true,
      parent: this.window ?? undefined,
      modal: false,
      show: false,
      title: 'About ONIXPlayer',
      ...aboutPlatformOptions,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: preloadPath,
        zoomFactor: 1.0,
        webSecurity: true
      }
    });

    // Hide menu bar on Windows/Linux
    this.aboutWindow.setMenuBarVisibility(false);

    // Load the Angular app with about window parameter
    const baseUrl: string = app.isPackaged
      ? `http://127.0.0.1:${this.serverPort}/`
      : Program.DEVELOPMENT_SERVER_URL;
    const aboutUrl: string = `${baseUrl}?window=about`;

    void this.aboutWindow.loadURL(aboutUrl);

    // Show when ready
    this.aboutWindow.once('ready-to-show', (): void => {
      this.aboutWindow?.show();
    });

    // Clean up reference when closed
    this.aboutWindow.on('closed', (): void => {
      this.aboutWindow = null;
    });

    // Prevent zoom
    this.aboutWindow.webContents.on('before-input-event', (_event: Electron.Event, input: Electron.Input): void => {
      if ((input.control || input.meta) && (input.key === '+' || input.key === '-' || input.key === '=' || input.key === '0')) {
        _event.preventDefault();
      }
    });
    this.aboutWindow.webContents.setVisualZoomLevelLimits(1, 1);
  }

  /**
   * Shows the setup wizard window.
   *
   * The setup wizard guides users through initial application configuration
   * on first run or when launched with the --first-run flag.
   *
   * Steps include:
   * 1. Welcome
   * 2. Server port configuration
   * 3. Dependencies (FFmpeg, FluidSynth)
   * 4. File type associations (Windows/Linux only)
   * 5. Complete
   *
   * @returns Promise that resolves when the wizard is closed
   */
  private async showSetupWizard(): Promise<void> {
    // If wizard already exists, wait for it to close
    if (this.setupWizardWindow && !this.setupWizardWindow.isDestroyed()) {
      return new Promise((resolve: () => void): void => {
        this.setupWizardWindow?.once('closed', resolve);
      });
    }

    // Reset the legitimate close flag
    this.setupWizardClosedLegitimately = false;

    const projectRoot: string = Program.getProjectRoot();
    const preloadPath: string = path.join(projectRoot, "src", "electron", "dist", "preload.js");
    const iconPath: string = path.join(projectRoot, "public", "icon-windows-linux.png");

    // Fixed size wizard dialog
    const wizardWidth: number = 700;
    const wizardHeight: number = 500;

    // Get appearance settings for consistent styling
    const appearanceSettings: AppearanceSettings | undefined = this.mediaServer?.getSettingsManager().getSettings().appearance;
    const glassEnabled: boolean = appearanceSettings?.glassEnabled ?? true;
    const visualEffectState: MacOSVisualEffectState = appearanceSettings?.macOSVisualEffectState ?? 'active';
    const backgroundColor: string = appearanceSettings?.backgroundColor ?? this.getDefaultBackgroundColor();

    let wizardPlatformOptions: Electron.BrowserWindowConstructorOptions = {};
    if (process.platform === 'darwin') {
      wizardPlatformOptions = {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: {x: 12, y: 13},
        ...(glassEnabled
          ? { vibrancy: 'fullscreen-ui' as const, visualEffectState }
          : { backgroundColor }
        )
      };
    } else if (process.platform === 'win32') {
      wizardPlatformOptions = glassEnabled
        ? { backgroundMaterial: 'acrylic' as const }
        : { backgroundColor };
    } else {
      wizardPlatformOptions = { backgroundColor };
    }

    this.setupWizardWindow = new BrowserWindow({
      width: wizardWidth,
      height: wizardHeight,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      center: true,
      icon: iconPath,
      modal: false,
      show: false,
      title: 'ONIXPlayer Setup',
      ...wizardPlatformOptions,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: preloadPath,
        zoomFactor: 1.0,
        webSecurity: true
      }
    });

    // Hide menu bar on Windows/Linux
    this.setupWizardWindow.setMenuBarVisibility(false);

    // Load the Angular app with setup wizard parameter
    const baseUrl: string = app.isPackaged
      ? `http://127.0.0.1:${this.serverPort}/`
      : Program.DEVELOPMENT_SERVER_URL;
    const wizardUrl: string = `${baseUrl}?window=setup-wizard`;

    mainLogger.info(`Loading setup wizard: ${wizardUrl}`);
    await this.setupWizardWindow.loadURL(wizardUrl);

    // Show when ready
    this.setupWizardWindow.show();

    // Wait for wizard completion or direct close
    return new Promise((resolve: () => void): void => {
      this.setupWizardWindow?.on('closed', (): void => {
        this.setupWizardWindow = null;

        // If the wizard was closed directly (clicking X) rather than via complete/skip,
        // quit the app entirely - don't proceed to the main window
        if (!this.setupWizardClosedLegitimately) {
          mainLogger.info('Setup wizard closed directly - quitting application');
          app.quit();
          return;
        }

        resolve();
      });
    });
  }

  /**
   * Sets up IPC handlers for communication with the renderer process.
   *
   * Handlers registered:
   * - dialog:openFile - Opens native file picker dialog
   * - app:getServerPort - Returns the media server's port number
   * - window:enterFullscreen - Enters fullscreen mode
   * - window:exitFullscreen - Exits fullscreen mode
   * - window:isFullscreen - Queries current fullscreen state
   *
   * Note: Most media operations use HTTP API instead of IPC for simplicity.
   * IPC is only used for operations that require native OS access.
   */
  private setupIpcHandlers(): void {
    ipcLogger.debug('Setting up IPC handlers');

    // File dialog - requires native dialog
    ipcMain.handle("dialog:openFile", async (_: Readonly<Electron.IpcMainInvokeEvent>, options: Readonly<{
      filters: readonly Electron.FileFilter[];
      multiSelections: boolean
    }>): Promise<string[]> => {
      ipcLogger.debug(`dialog:openFile - multiSelections=${options.multiSelections}`);
      if (!this.window) {
        ipcLogger.warn('dialog:openFile - no window available');
        return [];
      }

      const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(this.window, {
        properties: options.multiSelections
          ? ["openFile", "multiSelections"]
          : ["openFile"],
        filters: options.filters as Electron.FileFilter[]
      });

      ipcLogger.info(`dialog:openFile - selected ${result.filePaths.length} file(s)`);
      return result.filePaths;
    });

    // Open SoundFont file dialog - scoped to .sf2 files
    ipcMain.handle("dialog:openSoundFont", async (): Promise<string[]> => {
      ipcLogger.debug('dialog:openSoundFont');
      if (!this.window) {
        ipcLogger.warn('dialog:openSoundFont - no window available');
        return [];
      }

      const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(this.window, {
        title: 'Select SoundFont File',
        properties: ['openFile'],
        filters: [{name: 'SoundFont Files', extensions: ['sf2']}],
      });

      ipcLogger.info(`dialog:openSoundFont - selected ${result.filePaths.length} file(s)`);
      return result.canceled ? [] : result.filePaths;
    });

    // Open playlist file dialog - scoped to .opp files
    ipcMain.handle("dialog:openPlaylist", async (): Promise<string | null> => {
      ipcLogger.debug('dialog:openPlaylist');
      if (!this.window) {
        ipcLogger.warn('dialog:openPlaylist - no window available');
        return null;
      }

      const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(this.window, {
        title: 'Open Playlist',
        properties: ['openFile'],
        filters: [{name: 'ONIXPlayer Playlist', extensions: ['opp']}],
      });

      if (result.canceled || result.filePaths.length === 0) {
        ipcLogger.info('dialog:openPlaylist - cancelled');
        return null;
      }

      ipcLogger.info(`dialog:openPlaylist - selected: ${result.filePaths[0]}`);
      return result.filePaths[0];
    });

    // Save playlist file dialog - scoped to .opp files
    ipcMain.handle("dialog:savePlaylist", async (): Promise<string | null> => {
      ipcLogger.debug('dialog:savePlaylist');
      if (!this.window) {
        ipcLogger.warn('dialog:savePlaylist - no window available');
        return null;
      }

      const result: Electron.SaveDialogReturnValue = await dialog.showSaveDialog(this.window, {
        title: 'Save Playlist',
        defaultPath: 'playlist.opp',
        filters: [{name: 'ONIXPlayer Playlist', extensions: ['opp']}],
      });

      if (result.canceled || !result.filePath) {
        ipcLogger.info('dialog:savePlaylist - cancelled');
        return null;
      }

      ipcLogger.info(`dialog:savePlaylist - selected: ${result.filePath}`);
      return result.filePath;
    });

    // Open external subtitle file dialog - scoped to subtitle formats
    ipcMain.handle("dialog:openSubtitle", async (): Promise<string | null> => {
      ipcLogger.debug('dialog:openSubtitle');
      if (!this.window) {
        ipcLogger.warn('dialog:openSubtitle - no window available');
        return null;
      }

      const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(this.window, {
        title: 'Open Subtitle File',
        properties: ['openFile'],
        filters: [{name: 'Subtitle Files', extensions: ['srt', 'vtt', 'ass', 'ssa']}],
      });

      if (result.canceled || result.filePaths.length === 0) {
        ipcLogger.info('dialog:openSubtitle - cancelled');
        return null;
      }

      ipcLogger.info(`dialog:openSubtitle - selected: ${result.filePaths[0]}`);
      return result.filePaths[0];
    });

    // Get log file path - for debugging/support
    ipcMain.handle("app:getLogFilePath", (): string => {
      const logPath: string = getLogFilePath();
      ipcLogger.debug(`app:getLogFilePath - ${logPath}`);
      return logPath;
    });

    // Fullscreen control - uses simpleFullScreen on Windows to reduce GPU spike
    ipcMain.handle("window:enterFullscreen", (): void => {
      windowLogger.debug('Entering fullscreen');
      // Notify renderer to pause intensive rendering during transition
      this.window?.webContents.send('window:fullscreenTransitionStart');
      if (process.platform === 'win32') {
        // Windows: use simpleFullScreen to avoid swap chain recreation overhead
        this.window?.setSimpleFullScreen(true);
        // Notify renderer that transition is complete (simpleFullScreen is synchronous)
        this.window?.webContents.send('window:fullscreenTransitionEnd');
      } else {
        // macOS/Linux: use native fullscreen (transition end sent via event handler)
        this.window?.setFullScreen(true);
      }
    });

    ipcMain.handle("window:exitFullscreen", (): void => {
      windowLogger.debug('Exiting fullscreen');
      // Notify renderer to pause intensive rendering during transition
      this.window?.webContents.send('window:fullscreenTransitionStart');
      if (process.platform === 'win32') {
        // Windows: use simpleFullScreen
        this.window?.setSimpleFullScreen(false);
        // Notify renderer that transition is complete
        this.window?.webContents.send('window:fullscreenTransitionEnd');
      } else {
        // macOS/Linux: use native fullscreen
        this.window?.setFullScreen(false);
      }
    });

    ipcMain.handle("window:isFullscreen", (): boolean => {
      // On Windows, check simpleFullScreen state; on macOS/Linux, check native fullscreen
      const isFullscreen: boolean = process.platform === 'win32'
        ? (this.window?.isSimpleFullScreen() || false)
        : (this.window?.isFullScreen() || false);
      windowLogger.debug(`isFullscreen query: ${isFullscreen}`);
      return isFullscreen;
    });

    // Miniplayer control
    ipcMain.handle("window:enterMiniplayer", async (): Promise<void> => {
      windowLogger.info('Entering miniplayer mode');
      if (!this.window) {
        windowLogger.warn('enterMiniplayer - no window available');
        return;
      }

      // If in fullscreen, exit first and wait for transition to complete
      const isFullscreen: boolean = process.platform === 'win32'
        ? this.window.isSimpleFullScreen()
        : this.window.isFullScreen();

      if (isFullscreen) {
        windowLogger.debug('Exiting fullscreen before entering miniplayer');
        if (process.platform === 'win32') {
          // Windows: simpleFullScreen is synchronous
          this.window.setSimpleFullScreen(false);
        } else {
          // macOS/Linux: wait for async transition
          await new Promise<void>((resolve: () => void): void => {
            this.window?.once('leave-full-screen', resolve);
            this.window?.setFullScreen(false);
          });
        }
      }

      // Store current bounds for restoration (after exiting fullscreen)
      this.desktopBounds = this.window.getBounds();
      windowLogger.debug(`Stored desktop bounds: ${JSON.stringify(this.desktopBounds)}`);

      // Set mini-player constraints
      this.window.setMinimumSize(320, 200);
      this.window.setMaximumSize(640, 400);
      this.window.setAlwaysOnTop(true, 'floating');

      // Try to restore saved mini-player bounds, otherwise use default position
      const savedBounds: WindowBounds | null = this.mediaServer?.getSettingsManager().getMiniplayerBounds() ?? null;
      if (savedBounds) {
        // Restore saved position and size (clamped to min/max constraints)
        const width: number = Math.min(Math.max(savedBounds.width, 320), 640);
        const height: number = Math.min(Math.max(savedBounds.height, 200), 400);
        this.window.setSize(width, height);

        // Check if saved position is on-screen, snap to edges if not
        const display: Electron.Display = screen.getDisplayNearestPoint({x: savedBounds.x, y: savedBounds.y});
        const workArea: Electron.Rectangle = display.workArea;

        let x: number = savedBounds.x;
        let y: number = savedBounds.y;
        let positionCorrected: boolean = false;

        // Clamp to keep window on-screen with gap
        // Left edge: ensure window left edge is at least SNAP_GAP from work area left
        if (x < workArea.x + this.SNAP_GAP) {
          x = workArea.x + this.SNAP_GAP;
          positionCorrected = true;
        }
        // Right edge: ensure window right edge is at least SNAP_GAP from work area right
        if (x + width > workArea.x + workArea.width - this.SNAP_GAP) {
          x = workArea.x + workArea.width - width - this.SNAP_GAP;
          positionCorrected = true;
        }
        // Top edge: ensure window top edge is at least SNAP_GAP from work area top
        if (y < workArea.y + this.SNAP_GAP) {
          y = workArea.y + this.SNAP_GAP;
          positionCorrected = true;
        }
        // Bottom edge: ensure window bottom edge is at least SNAP_GAP from work area bottom
        if (y + height > workArea.y + workArea.height - this.SNAP_GAP) {
          y = workArea.y + workArea.height - height - this.SNAP_GAP;
          positionCorrected = true;
        }

        this.window.setPosition(x, y);

        // If position was corrected, save the new bounds
        if (positionCorrected) {
          this.mediaServer?.getSettingsManager().setMiniplayerBounds({x, y, width, height});
          windowLogger.debug(`Corrected miniplayer position to stay on-screen: ${width}x${height} at (${x}, ${y})`);
        } else {
          windowLogger.debug(`Restored miniplayer bounds: ${width}x${height} at (${savedBounds.x}, ${savedBounds.y})`);
        }
      } else {
        // Default: position in bottom-right corner of primary display
        this.window.setSize(320, 200);
        const display: Electron.Display = screen.getPrimaryDisplay();
        const workArea: Electron.Rectangle = display.workArea;
        this.window.setPosition(
          workArea.x + workArea.width - 320 - this.SNAP_GAP,
          workArea.y + workArea.height - 200 - this.SNAP_GAP
        );
        windowLogger.debug('Using default miniplayer position (bottom-right corner)');
      }

      this.isInMiniPlayerMode = true;
      this.window.webContents.send('window:viewModeChanged', 'miniplayer');
      windowLogger.info('Miniplayer mode active');
    });

    ipcMain.handle("window:exitMiniplayer", (): void => {
      windowLogger.info('Exiting miniplayer mode');
      if (!this.window) {
        windowLogger.warn('exitMiniplayer - no window available');
        return;
      }

      // Save current mini-player bounds before exiting
      const currentBounds: Electron.Rectangle = this.window.getBounds();
      this.mediaServer?.getSettingsManager().setMiniplayerBounds({
        x: currentBounds.x,
        y: currentBounds.y,
        width: currentBounds.width,
        height: currentBounds.height,
      });
      windowLogger.debug(`Saved miniplayer bounds: ${JSON.stringify(currentBounds)}`);

      // Restore desktop constraints
      // On macOS, must set minimum before maximum, and use large values instead of 0,0
      // to properly restore resize capability
      this.window.setMinimumSize(800, 600);
      this.window.setMaximumSize(10000, 10000); // Large value to effectively remove max constraint
      this.window.setAlwaysOnTop(false);
      this.window.setResizable(true); // Explicitly re-enable resize

      // Restore previous bounds
      if (this.desktopBounds) {
        this.window.setBounds(this.desktopBounds);
        windowLogger.debug(`Restored desktop bounds: ${JSON.stringify(this.desktopBounds)}`);
      }

      this.isInMiniPlayerMode = false;
      this.window.webContents.send('window:viewModeChanged', 'desktop');
      windowLogger.info('Desktop mode restored');
    });

    ipcMain.handle("window:getViewMode", (): string => {
      const mode: string = this.window?.isFullScreen() ? 'fullscreen' : this.isInMiniPlayerMode ? 'miniplayer' : 'desktop';
      windowLogger.debug(`getViewMode: ${mode}`);
      return mode;
    });

    ipcMain.handle("window:getWindowPosition", (): {x: number; y: number} => {
      if (!this.window) return {x: 0, y: 0};
      const [x, y]: number[] = this.window.getPosition();
      return {x, y};
    });

    ipcMain.handle("window:setWindowPosition", (_: Readonly<Electron.IpcMainInvokeEvent>, position: Readonly<{x: number; y: number}>): {x: number; y: number} => {
      if (!this.window) return position;

      const display: Electron.Display = screen.getDisplayNearestPoint(position);
      const workArea: Electron.Rectangle = display.workArea;
      const [width, height]: number[] = this.window.getSize();

      let x: number = position.x;
      let y: number = position.y;

      // Left edge magnetic snap (with gap)
      if (Math.abs(x - (workArea.x + this.SNAP_GAP)) < this.SNAP_THRESHOLD) {
        x = workArea.x + this.SNAP_GAP;
      }
      // Right edge magnetic snap (with gap)
      if (Math.abs((x + width) - (workArea.x + workArea.width - this.SNAP_GAP)) < this.SNAP_THRESHOLD) {
        x = workArea.x + workArea.width - width - this.SNAP_GAP;
      }
      // Top edge magnetic snap (with gap)
      if (Math.abs(y - (workArea.y + this.SNAP_GAP)) < this.SNAP_THRESHOLD) {
        y = workArea.y + this.SNAP_GAP;
      }
      // Bottom edge magnetic snap (with gap)
      if (Math.abs((y + height) - (workArea.y + workArea.height - this.SNAP_GAP)) < this.SNAP_THRESHOLD) {
        y = workArea.y + workArea.height - height - this.SNAP_GAP;
      }

      this.window.setPosition(x, y);
      return {x, y};
    });

    ipcMain.handle("window:setTrafficLightVisibility", (_: Readonly<Electron.IpcMainInvokeEvent>, visible: boolean): void => {
      if (!this.window || process.platform !== 'darwin') return;
      this.window.setWindowButtonVisibility(visible);
    });

    // Save mini-player bounds (called after drag ends or resize)
    ipcMain.handle("window:saveMiniplayerBounds", (): void => {
      if (!this.window || !this.isInMiniPlayerMode) return;
      const bounds: Electron.Rectangle = this.window.getBounds();
      this.mediaServer?.getSettingsManager().setMiniplayerBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    });

    // Configuration mode tracking (for close button behavior)
    ipcMain.handle("app:setConfigurationMode", (_: Readonly<Electron.IpcMainInvokeEvent>, enabled: boolean): void => {
      this.isInConfigurationMode = enabled;
    });

    // Show configuration window (can be called from renderer)
    ipcMain.handle("window:showConfigurationWindow", (_: Readonly<Electron.IpcMainInvokeEvent>, initialCategory?: string): void => {
      this.showConfigurationWindow(initialCategory);
    });

    // Minimize window
    ipcMain.handle("window:minimize", (): void => {
      windowLogger.debug('Minimizing window');
      this.window?.minimize();
    });

  }

  /**
   * Sets up core IPC handlers needed by any window.
   * Must be called early in initialization, before any windows are created.
   */
  private setupCoreIpcHandlers(): void {
    ipcLogger.debug('Setting up core IPC handlers');

    // Get server port - needed for renderer to connect to HTTP API
    ipcMain.handle("app:getServerPort", (): number => {
      const port: number = this.mediaServer?.getPort() || 0;
      ipcLogger.debug(`app:getServerPort - returning ${port}`);
      return port;
    });

    // Get platform info - needed for renderer to show platform-specific UI
    ipcMain.handle("app:getPlatformInfo", (): {platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'} => {
      const systemTheme: 'dark' | 'light' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      const info: {platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'} = {
        platform: process.platform as string,
        supportsGlass: process.platform === 'darwin' || process.platform === 'win32',
        systemTheme
      };
      ipcLogger.debug(`app:getPlatformInfo - ${JSON.stringify(info)}`);
      return info;
    });
  }

  /**
   * Sets up IPC handlers for the setup wizard.
   * Must be called before showing the setup wizard window.
   */
  private setupSetupWizardIpcHandlers(): void {
    ipcLogger.debug('Setting up setup wizard IPC handlers');

    // Get current server port setting
    ipcMain.handle("setup:getPort", (): number => {
      return this.mediaServer?.getSettingsManager().getSettings().application.serverPort ?? 0;
    });

    // Set server port setting
    ipcMain.handle("setup:setPort", (_: Readonly<Electron.IpcMainInvokeEvent>, port: number): void => {
      this.mediaServer?.getSettingsManager().updateApplicationSettings({serverPort: port});
    });

    // Validate if a port is available for use
    ipcMain.handle("setup:validatePort", async (_: Readonly<Electron.IpcMainInvokeEvent>, port: number): Promise<boolean> => {
      // 0 means auto-assign, which is always valid
      if (port === 0) return true;
      // Check port range
      if (port < 1024 || port > 65535) return false;
      // Check if port is available by trying to listen on it
      return new Promise((resolve: (available: boolean) => void): void => {
        const net: typeof import('net') = require('net');
        const server: import('net').Server = net.createServer();
        server.once('error', (): void => resolve(false));
        server.once('listening', (): void => {
          server.close();
          resolve(true);
        });
        server.listen(port, '127.0.0.1');
      });
    });

    // Get platform for conditional UI
    ipcMain.handle("setup:getPlatform", (): string => {
      return process.platform;
    });

    // Complete the setup wizard
    ipcMain.handle("setup:complete", (): void => {
      ipcLogger.info('Setup wizard completed');
      this.mediaServer?.getSettingsManager().markSetupComplete();
      this.setupWizardClosedLegitimately = true;
      this.setupWizardWindow?.close();
    });

    // Skip the setup wizard (will show again next launch)
    ipcMain.handle("setup:skip", (): void => {
      ipcLogger.info('Setup wizard skipped');
      this.setupWizardClosedLegitimately = true;
      this.setupWizardWindow?.close();
    });

    // Install the bundled OPL3 soundfont
    ipcMain.handle("setup:installBundledSoundFont", async (): Promise<boolean> => {
      ipcLogger.info('Installing bundled OPL3 soundfont');
      try {
        const depManager: import('./dependency-manager.js').DependencyManager | undefined = this.mediaServer?.getDependencyManager();
        if (!depManager) {
          ipcLogger.error('DependencyManager not available');
          return false;
        }

        // Get the path to the bundled soundfont
        const bundledPath: string = path.join(Program.getProjectRoot(), 'dist', 'onixlabs-media-player', 'browser', 'soundfonts', 'OPL3-FM-128M.sf2');

        // Check if the bundled soundfont exists
        if (!existsSync(bundledPath)) {
          ipcLogger.error(`Bundled soundfont not found at: ${bundledPath}`);
          return false;
        }

        // Install it using the dependency manager
        const soundFontInfo: import('./dependency-manager.js').SoundFontInfo = depManager.installSoundFont(bundledPath);
        ipcLogger.info(`Bundled OPL3 soundfont installed successfully: ${soundFontInfo.fileName}`);
        // Broadcast the updated state
        this.mediaServer?.broadcastDependencyState();
        return true;
      } catch (error) {
        ipcLogger.error(`Failed to install bundled soundfont: ${error}`);
        return false;
      }
    });
  }

  /**
   * Sets up window event listeners for fullscreen state changes.
   *
   * Notifies the renderer when fullscreen state changes, including
   * changes triggered by the macOS green traffic light button.
   * This allows the renderer to update its UI accordingly.
   */
  private setupWindowEvents(): void {
    if (!this.window) return;
    windowLogger.debug('Setting up window events');

    // Handle window close - intercept in configuration mode, otherwise fade out audio
    this.window.on('close', (event: Electron.Event): void => {
      // Prevent re-entry while closing
      if (this.isClosing) return;

      // In configuration mode, intercept close and return to media player instead
      if (this.isInConfigurationMode) {
        windowLogger.debug('Close intercepted in configuration mode');
        event.preventDefault();
        this.window?.webContents.send('app:exitConfigurationMode');
        return;
      }

      windowLogger.info('Window closing - initiating fade out');
      // Prevent immediate close to allow fade-out
      event.preventDefault();
      this.isClosing = true;

      // Request renderer to fade out audio, with timeout fallback
      const fadePromise: Promise<void> = new Promise((resolve: () => void): void => {
        // Listen for fade complete response
        const onFadeComplete: () => void = (): void => {
          ipcMain.removeHandler('app:fadeOutComplete');
          windowLogger.debug('Fade out complete');
          resolve();
        };

        ipcMain.handleOnce('app:fadeOutComplete', onFadeComplete);

        // Tell renderer to start fading out
        this.window?.webContents.send('app:prepareForClose', this.CLOSE_FADE_DURATION);
      });

      // Wait for fade to complete (with timeout)
      const timeout: Promise<void> = new Promise((resolve: () => void): void => {
        setTimeout(resolve, this.CLOSE_FADE_DURATION + 100);
      });

      Promise.race([fadePromise, timeout]).then((): void => {
        windowLogger.info('Destroying window');
        // Close all child windows before destroying main window
        this.closeAllChildWindows();
        // Nuke MIDI cache on close
        this.mediaServer?.nukeMidiCache();
        this.window?.destroy();
      });
    });

    // Notify renderer when fullscreen state changes (including via green button on macOS)
    // These events only fire on macOS/Linux with native fullscreen, not on Windows with simpleFullScreen
    this.window.on('enter-full-screen', (): void => {
      windowLogger.info('Entered fullscreen');
      // Notify renderer that transition is complete (for macOS/Linux native fullscreen)
      this.window?.webContents.send('window:fullscreenTransitionEnd');
      this.window?.webContents.send('window:fullscreenChanged', true);
      this.window?.webContents.send('window:viewModeChanged', 'fullscreen');
    });

    this.window.on('leave-full-screen', (): void => {
      // Send the mode we're returning to (miniplayer or desktop)
      const mode: string = this.isInMiniPlayerMode ? 'miniplayer' : 'desktop';
      windowLogger.info(`Left fullscreen, returning to ${mode}`);
      // Notify renderer that transition is complete (for macOS/Linux native fullscreen)
      this.window?.webContents.send('window:fullscreenTransitionEnd');
      this.window?.webContents.send('window:fullscreenChanged', false);
      this.window?.webContents.send('window:viewModeChanged', mode);
    });

    // Save mini-player bounds when window is resized (in mini-player mode)
    // Debounce to avoid excessive settings writes during drag-resize
    let miniplayerResizeTimeout: ReturnType<typeof setTimeout> | null = null;
    this.window.on('resized', (): void => {
      if (!this.isInMiniPlayerMode) return;
      if (miniplayerResizeTimeout) clearTimeout(miniplayerResizeTimeout);
      miniplayerResizeTimeout = setTimeout((): void => {
        miniplayerResizeTimeout = null;
        const bounds: Electron.Rectangle = this.window!.getBounds();
        this.mediaServer?.getSettingsManager().setMiniplayerBounds({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        });
      }, 300);
    });
  }

  /**
   * Sets up the application menu with callbacks for menu actions.
   * Menu actions are communicated to the renderer via webContents.send().
   */
  private setupApplicationMenu(): void {
    createApplicationMenu({
      onShowConfig: (): void => {
        this.showConfigurationWindow();
      },
      onShowAbout: (): void => {
        this.showAboutWindow();
      },
      onShowHelp: (): void => {
        this.window?.webContents.send('menu:showHelp');
      },
      onOpenFile: (): void => {
        this.window?.webContents.send('menu:openFile');
      },
      onOpenPlaylist: (): void => {
        this.window?.webContents.send('menu:openPlaylist');
      },
      onOpenRecentFile: (filePath: string): void => {
        this.window?.webContents.send('menu:openRecentFile', filePath);
      },
      onOpenRecentPlaylist: (playlistPath: string): void => {
        this.window?.webContents.send('menu:openRecentPlaylist', playlistPath);
      },
      onClearRecent: (): void => {
        const settingsManager: SettingsManager | undefined = this.mediaServer?.getSettingsManager();
        if (settingsManager) {
          settingsManager.clearRecentItems();
          const recentItems: RecentItemsSettings = settingsManager.getRecentItems();
          updateMenuState({
            recentFiles: recentItems.recentFiles,
            recentPlaylists: recentItems.recentPlaylists,
          });
        }
      },
      onSavePlaylist: (): void => {
        this.window?.webContents.send('menu:savePlaylist');
      },
      onSavePlaylistAs: (): void => {
        this.window?.webContents.send('menu:savePlaylistAs');
      },
      onCloseMedia: (): void => {
        this.window?.webContents.send('menu:closeMedia');
      },
      onClosePlaylist: (): void => {
        this.window?.webContents.send('menu:closeAll');
      },
      onToggleFullscreen: (): void => {
        if (this.window) {
          // Notify renderer to pause intensive rendering during transition
          this.window.webContents.send('window:fullscreenTransitionStart');
          if (process.platform === 'win32') {
            // Windows: use simpleFullScreen to reduce GPU spike
            const isCurrentlyFullscreen: boolean = this.window.isSimpleFullScreen();
            this.window.setSimpleFullScreen(!isCurrentlyFullscreen);
            // Notify renderer that transition is complete
            this.window.webContents.send('window:fullscreenTransitionEnd');
            this.window.webContents.send('window:fullscreenChanged', !isCurrentlyFullscreen);
          } else {
            // macOS/Linux: use native fullscreen (events handled by window event listeners)
            this.window.setFullScreen(!this.window.isFullScreen());
          }
        }
      },
      onTogglePlayPause: (): void => {
        this.window?.webContents.send('menu:togglePlayPause');
      },
      onStop: (): void => {
        this.window?.webContents.send('menu:stop');
      },
      onToggleShuffle: (): void => {
        this.window?.webContents.send('menu:toggleShuffle');
      },
      onToggleRepeat: (): void => {
        this.window?.webContents.send('menu:toggleRepeat');
      },
      onSelectVisualization: (id: string): void => {
        this.window?.webContents.send('menu:selectVisualization', id);
      },
      onSelectAspectMode: (mode: string): void => {
        this.window?.webContents.send('menu:selectAspectMode', mode);
      }
    }, this.getInitialMenuState());
  }

  /**
   * Gets the initial menu state including recent items from settings.
   *
   * @returns Partial menu state with recent items
   */
  private getInitialMenuState(): {recentFiles: readonly RecentItem[]; recentPlaylists: readonly RecentItem[]} {
    const settingsManager: SettingsManager | undefined = this.mediaServer?.getSettingsManager();
    if (settingsManager) {
      const recentItems: RecentItemsSettings = settingsManager.getRecentItems();
      return {
        recentFiles: recentItems.recentFiles,
        recentPlaylists: recentItems.recentPlaylists,
      };
    }
    return {recentFiles: [], recentPlaylists: []};
  }

  /**
   * Handles a file opened from the OS (via double-click, drag to dock, etc.).
   * Routes the file to the appropriate handler based on extension.
   *
   * @param filePath - The absolute path to the file to open
   */
  private handleFileFromOS(filePath: string): void {
    if (!existsSync(filePath)) {
      mainLogger.warn(`handleFileFromOS - file does not exist: ${filePath}`);
      return;
    }

    const ext: string = filePath.split('.').pop()?.toLowerCase() ?? '';
    mainLogger.info(`handleFileFromOS - opening ${ext} file: ${filePath}`);

    if (ext === 'opp') {
      // Playlist file
      this.window?.webContents.send('os:openPlaylist', filePath);
    } else if ([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].includes(ext)) {
      // Media file
      this.window?.webContents.send('os:openFile', filePath);
    } else {
      mainLogger.warn(`handleFileFromOS - unsupported extension: ${ext}`);
    }
  }

  /**
   * Processes any files that were passed to the app before it was ready.
   * Also processes files passed via command line arguments on launch.
   */
  private processPendingFiles(): void {
    // Get files from launch command line arguments (skip Electron flags)
    const launchArgs: string[] = process.argv.slice(1).filter((arg: string): boolean =>
      !arg.startsWith('-') && !arg.startsWith('--') && existsSync(arg)
    );

    // Combine pending files (from open-file events) with launch args
    const allFiles: string[] = [...pendingFilesToOpen, ...launchArgs];
    pendingFilesToOpen = [];

    if (allFiles.length > 0) {
      mainLogger.info(`processPendingFiles - processing ${allFiles.length} file(s)`);
      allFiles.forEach((f: string): void => this.handleFileFromOS(f));
    }
  }

  /**
   * Handles macOS dock activation (clicking app icon when running).
   * Creates a new window if none exist, standard macOS behavior.
   * Re-initializes window events and menu for the new window.
   */
  private onActivate(): void {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainLogger.info('Dock activation - creating new window');
      this.window = this.createBrowserWindow();
      this.setupWindowEvents();
      this.setupApplicationMenu();

      // Load the application - use HTTP in both dev and prod
      if (Program.IS_DEVELOPMENT) {
        void this.window.loadURL(Program.DEVELOPMENT_SERVER_URL);
      } else {
        void this.window.loadURL(`http://127.0.0.1:${this.serverPort}/`);
      }

      this.window.on("closed", this.onClosed.bind(this));
    }
  }

  /**
   * Closes all child windows (configuration, about, setup wizard).
   * Called when the main window is closing to ensure clean shutdown.
   */
  private closeAllChildWindows(): void {
    if (this.configWindow && !this.configWindow.isDestroyed()) {
      windowLogger.debug('Closing configuration window');
      this.configWindow.destroy();
      this.configWindow = null;
    }
    if (this.aboutWindow && !this.aboutWindow.isDestroyed()) {
      windowLogger.debug('Closing about window');
      this.aboutWindow.destroy();
      this.aboutWindow = null;
    }
    if (this.setupWizardWindow && !this.setupWizardWindow.isDestroyed()) {
      windowLogger.debug('Closing setup wizard window');
      this.setupWizardWindow.destroy();
      this.setupWizardWindow = null;
    }
  }

  /**
   * Handles window closed event.
   * Clears the window reference and resets closing state.
   */
  private onClosed(): void {
    windowLogger.debug('Window closed');
    this.window = null;
    this.isClosing = false;
  }

  /**
   * Handles all windows closed event.
   * Quits the application on all platforms.
   */
  private onAllWindowsClosed(): void {
    mainLogger.info('All windows closed - quitting application');
    app.quit();
  }
}

Program.run();
