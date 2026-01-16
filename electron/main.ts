import {app, BrowserWindow, ipcMain, dialog, protocol, net} from "electron";
import * as path from "path";
import {fileURLToPath} from "url";
import {FFmpegManager} from "./ffmpeg-manager.ts";

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
    const filename = fileURLToPath(import.meta.url);
    const dirname = path.dirname(filename);
    // When running TS via tsx: electron/main.ts -> go up 1 level
    // When running compiled JS: electron/dist/main.js -> go up 2 levels
    const levels = filename.endsWith('.ts') ? 1 : 2;
    return path.resolve(dirname, ...Array(levels).fill('..'));
  }

  private window: BrowserWindow | null = null;
  private ffmpegManager: FFmpegManager | null = null;

  private constructor() {
    app.whenReady().then(this.initialize.bind(this))
  }

  public static run(): void {
    new Program();
  }

  private initialize(): void {
    this.registerMediaProtocol();
    this.window = this.createBrowserWindow();
    this.ffmpegManager = new FFmpegManager(this.window);
    this.setupIpcHandlers();

    if (Program.IS_DEVELOPMENT) void this.window.loadURL(Program.DEVELOPMENT_SERVER_URL);
    else void this.window.loadFile(path.join(Program.getProjectRoot(), "dist", "onixlabs-media-player", "browser", "index.html"));

    this.window.on("closed", this.onClosed.bind(this));
    app.on("activate", this.onActivate.bind(this));
    app.on("window-all-closed", this.onAllWindowsClosed.bind(this));
  }

  private registerMediaProtocol(): void {
    protocol.handle('media', (request) => {
      // Convert media://path to file path
      const filePath = decodeURIComponent(request.url.replace('media://', ''));
      return net.fetch('file://' + filePath);
    });
  }

  private createBrowserWindow(): BrowserWindow {
    const projectRoot = Program.getProjectRoot();
    // Preload must always be compiled JS - Electron can't run TS preload scripts
    const preloadPath = path.join(projectRoot, "electron", "dist", "preload.js");

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
    ipcMain.handle("dialog:openFile", async (_, options: { filters: Electron.FileFilter[]; multiSelections: boolean }) => {
      if (!this.window) return [];

      const result = await dialog.showOpenDialog(this.window, {
        properties: options.multiSelections
          ? ["openFile", "multiSelections"]
          : ["openFile"],
        filters: options.filters
      });

      return result.filePaths;
    });

    ipcMain.handle("media:load", async (_, filePath: string) => {
      return this.ffmpegManager?.loadMedia(filePath);
    });

    ipcMain.handle("media:play", async () => {
      return this.ffmpegManager?.play();
    });

    ipcMain.handle("media:pause", async () => {
      return this.ffmpegManager?.pause();
    });

    ipcMain.handle("media:resume", async () => {
      return this.ffmpegManager?.resume();
    });

    ipcMain.handle("media:seek", async (_, time: number) => {
      return this.ffmpegManager?.seek(time);
    });

    ipcMain.handle("media:setVolume", async (_, volume: number) => {
      return this.ffmpegManager?.setVolume(volume);
    });

    ipcMain.handle("media:stop", async () => {
      return this.ffmpegManager?.stop();
    });

    ipcMain.handle("media:getUrl", async (_, filePath: string) => {
      // Return a media:// URL that the renderer can use with <video>/<audio>
      return `media://${encodeURIComponent(filePath)}`;
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
