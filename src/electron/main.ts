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
import type {WindowBounds, MacOSVisualEffectState, AppearanceSettings} from './settings-manager.js';
import {initializeLogger, mainLogger, ipcLogger, windowLogger, getLogFilePath} from './logger.js';

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
   * Waits for Electron's app ready event before initializing.
   */
  private constructor() {
    app.whenReady().then(this.initialize.bind(this))
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

    // Register callback to update menu when shuffle/repeat mode changes
    this.mediaServer.onModeChange((shuffle: boolean, repeat: boolean): void => {
      mainLogger.debug(`Mode changed: shuffle=${shuffle}, repeat=${repeat}`);
      updateMenuState({shuffleEnabled: shuffle, repeatEnabled: repeat});
    });

    // Register callback to update menu when playlist count changes (enables/disables shuffle/repeat)
    this.mediaServer.onPlaylistCountChange((count: number): void => {
      mainLogger.debug(`Playlist count changed: ${count}`);
      updateMenuState({hasMedia: count > 0});
    });

    // Register callback to update menu when playback state changes (Play/Pause label)
    this.mediaServer.onPlaybackStateChange((isPlaying: boolean): void => {
      mainLogger.debug(`Playback state changed: ${isPlaying ? 'playing' : 'paused'}`);
      updateMenuState({isPlaying});
    });

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
    const preloadPath: string = path.join(projectRoot, "src", "electron", "dist", "preload.cjs");
    const iconPath: string = path.join(projectRoot, "public", "icon.png");

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
      platformOptions = {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: {x: 12, y: 13},
        // Apply vibrancy if glass enabled, otherwise use background color
        ...(glassEnabled
          ? { vibrancy: 'fullscreen-ui' as const, visualEffectState }
          : { backgroundColor }
        )
      };
    } else if (process.platform === 'win32') {
      // Windows 11: acrylic blur effect when glass enabled
      platformOptions = glassEnabled
        ? { transparent: true, backgroundMaterial: 'acrylic' as const }
        : { backgroundColor };
    } else {
      // Linux: no native blur support, always use background color
      platformOptions = { backgroundColor };
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

    // Get server port - needed for renderer to connect to HTTP API
    ipcMain.handle("app:getServerPort", (): number => {
      const port: number = this.mediaServer?.getPort() || 0;
      ipcLogger.debug(`app:getServerPort - returning ${port}`);
      return port;
    });

    // Get platform info - needed for renderer to show platform-specific settings
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

    // Get log file path - for debugging/support
    ipcMain.handle("app:getLogFilePath", (): string => {
      const logPath: string = getLogFilePath();
      ipcLogger.debug(`app:getLogFilePath - ${logPath}`);
      return logPath;
    });

    // Fullscreen control
    ipcMain.handle("window:enterFullscreen", (): void => {
      windowLogger.debug('Entering fullscreen');
      this.window?.setFullScreen(true);
    });

    ipcMain.handle("window:exitFullscreen", (): void => {
      windowLogger.debug('Exiting fullscreen');
      this.window?.setFullScreen(false);
    });

    ipcMain.handle("window:isFullscreen", (): boolean => {
      const isFullscreen: boolean = this.window?.isFullScreen() || false;
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
      if (this.window.isFullScreen()) {
        windowLogger.debug('Exiting fullscreen before entering miniplayer');
        await new Promise<void>((resolve: () => void): void => {
          this.window?.once('leave-full-screen', resolve);
          this.window?.setFullScreen(false);
        });
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
        this.window.setPosition(savedBounds.x, savedBounds.y);
        windowLogger.debug(`Restored miniplayer bounds: ${width}x${height} at (${savedBounds.x}, ${savedBounds.y})`);
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
        this.window?.destroy();
      });
    });

    // Notify renderer when fullscreen state changes (including via green button)
    this.window.on('enter-full-screen', (): void => {
      windowLogger.info('Entered fullscreen');
      this.window?.webContents.send('window:fullscreenChanged', true);
      this.window?.webContents.send('window:viewModeChanged', 'fullscreen');
    });

    this.window.on('leave-full-screen', (): void => {
      // Send the mode we're returning to (miniplayer or desktop)
      const mode: string = this.isInMiniPlayerMode ? 'miniplayer' : 'desktop';
      windowLogger.info(`Left fullscreen, returning to ${mode}`);
      this.window?.webContents.send('window:fullscreenChanged', false);
      this.window?.webContents.send('window:viewModeChanged', mode);
    });

    // Save mini-player bounds when window is resized (in mini-player mode)
    this.window.on('resized', (): void => {
      if (!this.isInMiniPlayerMode) return;
      const bounds: Electron.Rectangle = this.window!.getBounds();
      this.mediaServer?.getSettingsManager().setMiniplayerBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    });
  }

  /**
   * Sets up the application menu with callbacks for menu actions.
   * Menu actions are communicated to the renderer via webContents.send().
   */
  private setupApplicationMenu(): void {
    createApplicationMenu({
      onShowConfig: (): void => {
        this.window?.webContents.send('menu:showConfig');
      },
      onShowAbout: (): void => {
        this.window?.webContents.send('menu:showAbout');
      },
      onOpenFile: (): void => {
        this.window?.webContents.send('menu:openFile');
      },
      onCloseMedia: (): void => {
        this.window?.webContents.send('menu:closeMedia');
      },
      onToggleFullscreen: (): void => {
        if (this.window) {
          this.window.setFullScreen(!this.window.isFullScreen());
        }
      },
      onTogglePlayPause: (): void => {
        this.window?.webContents.send('menu:togglePlayPause');
      },
      onToggleShuffle: (): void => {
        this.window?.webContents.send('menu:toggleShuffle');
      },
      onToggleRepeat: (): void => {
        this.window?.webContents.send('menu:toggleRepeat');
      },
      onSelectVisualization: (id: string): void => {
        this.window?.webContents.send('menu:selectVisualization', id);
      }
    });
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
