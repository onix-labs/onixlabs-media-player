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

import {app, BrowserWindow, dialog, ipcMain, net, protocol} from "electron";
import * as path from "path";
import {fileURLToPath} from "url";
import {UnifiedMediaServer} from './unified-media-server.ts';

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
    // When running TS via tsx: electron/main.ts -> go up 1 level
    // When running compiled JS: electron/dist/main.js -> go up 2 levels
    const levels: number = filename.endsWith('.ts') ? 1 : 2;
    return path.resolve(dirname, ...Array(levels).fill('..'));
  }

  /** The main browser window instance, null when closed */
  private window: BrowserWindow | null = null;

  /** The unified HTTP media server instance */
  private mediaServer: UnifiedMediaServer | null = null;

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
   * 1. Register the media:// protocol handler
   * 2. Start the unified media server (HTTP API + SSE)
   * 3. Create the main browser window
   * 4. Set up IPC handlers for native functionality
   * 5. Set up window events for fullscreen notifications
   * 6. Load the Angular application (dev server or built files)
   * 7. Register lifecycle event handlers
   */
  private async initialize(): Promise<void> {
    this.registerMediaProtocol();

    // Start the unified media server (HTTP API + SSE)
    this.mediaServer = new UnifiedMediaServer();
    await this.mediaServer.start();

    this.window = this.createBrowserWindow();
    this.setupIpcHandlers();
    this.setupWindowEvents();

    if (Program.IS_DEVELOPMENT) void this.window.loadURL(Program.DEVELOPMENT_SERVER_URL);
    else void this.window.loadFile(path.join(Program.getProjectRoot(), "dist", "onixlabs-media-player", "browser", "index.html"));

    this.window.on("closed", this.onClosed.bind(this));
    app.on("activate", this.onActivate.bind(this));
    app.on("window-all-closed", this.onAllWindowsClosed.bind(this));
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
    const preloadPath: string = path.join(projectRoot, "electron", "dist", "preload.js");

    return new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {x: 12, y: 13},
      vibrancy: "fullscreen-ui",
      visualEffectState: "active",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: preloadPath
      }
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
    // File dialog - requires native dialog
    ipcMain.handle("dialog:openFile", async (_: Readonly<Electron.IpcMainInvokeEvent>, options: Readonly<{
      filters: readonly Electron.FileFilter[];
      multiSelections: boolean
    }>): Promise<string[]> => {
      if (!this.window) return [];

      const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(this.window, {
        properties: options.multiSelections
          ? ["openFile", "multiSelections"]
          : ["openFile"],
        filters: options.filters as Electron.FileFilter[]
      });

      return result.filePaths;
    });

    // Get server port - needed for renderer to connect to HTTP API
    ipcMain.handle("app:getServerPort", (): number => {
      return this.mediaServer?.getPort() || 0;
    });

    // Fullscreen control
    ipcMain.handle("window:enterFullscreen", (): void => {
      this.window?.setFullScreen(true);
    });

    ipcMain.handle("window:exitFullscreen", (): void => {
      this.window?.setFullScreen(false);
    });

    ipcMain.handle("window:isFullscreen", (): boolean => {
      return this.window?.isFullScreen() || false;
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

    // Notify renderer when fullscreen state changes (including via green button)
    this.window.on('enter-full-screen', (): void => {
      this.window?.webContents.send('window:fullscreenChanged', true);
    });

    this.window.on('leave-full-screen', (): void => {
      this.window?.webContents.send('window:fullscreenChanged', false);
    });
  }

  /**
   * Handles macOS dock activation (clicking app icon when running).
   * Creates a new window if none exist, standard macOS behavior.
   */
  private onActivate(): void {
    if (BrowserWindow.getAllWindows().length === 0)
      this.window = this.createBrowserWindow();
  }

  /**
   * Handles window closed event.
   * Clears the window reference to allow garbage collection.
   */
  private onClosed(): void {
    this.window = null;
  }

  /**
   * Handles all windows closed event.
   *
   * Behavior:
   * - Development mode: Always quit (faster iteration)
   * - macOS production: Stay running (standard macOS behavior)
   * - Other platforms: Quit the application
   */
  private onAllWindowsClosed(): void {
    if (Program.IS_DEVELOPMENT || process.platform !== "darwin")
      app.quit();
  }
}

Program.run();
