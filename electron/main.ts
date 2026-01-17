import {app, BrowserWindow, ipcMain, dialog, protocol, net} from "electron";
import * as path from "path";
import {fileURLToPath} from "url";
import {UnifiedMediaServer} from "./unified-media-server.ts";

// Allow audio autoplay without user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Register custom protocol for serving media files
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

class Program {
  private static readonly IS_DEVELOPMENT: boolean = process.env["NODE_ENV"] === "development";
  private static readonly DEVELOPMENT_SERVER_URL: string = process.env["DEV_SERVER_URL"] || "http://localhost:4200";

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

  private window: BrowserWindow | null = null;
  private mediaServer: UnifiedMediaServer | null = null;

  private constructor() {
    app.whenReady().then(this.initialize.bind(this))
  }

  public static run(): void {
    new Program();
  }

  private async initialize(): Promise<void> {
    this.registerMediaProtocol();

    // Start the unified media server (HTTP API + SSE)
    this.mediaServer = new UnifiedMediaServer();
    await this.mediaServer.start();

    this.window = this.createBrowserWindow();
    this.setupIpcHandlers();

    if (Program.IS_DEVELOPMENT) void this.window.loadURL(Program.DEVELOPMENT_SERVER_URL);
    else void this.window.loadFile(path.join(Program.getProjectRoot(), "dist", "onixlabs-media-player", "browser", "index.html"));

    this.window.on("closed", this.onClosed.bind(this));
    app.on("activate", this.onActivate.bind(this));
    app.on("window-all-closed", this.onAllWindowsClosed.bind(this));
  }

  private registerMediaProtocol(): void {
    protocol.handle('media', (request: Request) => {
      // Convert media://path to file path
      const filePath: string = decodeURIComponent(request.url.replace('media://', ''));
      return net.fetch('file://' + filePath);
    });
  }

  private createBrowserWindow(): BrowserWindow {
    const projectRoot: string = Program.getProjectRoot();
    // Preload must always be compiled JS - Electron can't run TS preload scripts
    const preloadPath: string = path.join(projectRoot, "electron", "dist", "preload.js");

    return new BrowserWindow({
      width: 1200,
      height: 800,
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

  private setupIpcHandlers(): void {
    // File dialog - requires native dialog
    ipcMain.handle("dialog:openFile", async (_: Electron.IpcMainInvokeEvent, options: { filters: Electron.FileFilter[]; multiSelections: boolean }) => {
      if (!this.window) return [];

      const result: Electron.OpenDialogReturnValue = await dialog.showOpenDialog(this.window, {
        properties: options.multiSelections
          ? ["openFile", "multiSelections"]
          : ["openFile"],
        filters: options.filters
      });

      return result.filePaths;
    });

    // Get server port - needed for renderer to connect to HTTP API
    ipcMain.handle("app:getServerPort", () => {
      return this.mediaServer?.getPort() || 0;
    });
  }

  private onActivate(): void {
    if (BrowserWindow.getAllWindows().length === 0)
      this.window = this.createBrowserWindow();
  }

  private onClosed(): void {
    this.window = null;
  }

  private onAllWindowsClosed(): void {
    if (Program.IS_DEVELOPMENT || process.platform !== "darwin")
      app.quit();
  }
}

Program.run();
