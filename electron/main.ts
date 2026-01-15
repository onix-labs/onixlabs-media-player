import {app, BrowserWindow} from "electron";
import * as path from "path";
import {fileURLToPath} from "url";

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

  private constructor() {
    app.whenReady().then(this.initialize.bind(this))
  }

  public static run(): void {
    new Program();
  }

  private initialize(): void {
    this.window = this.createBrowserWindow();

    if (Program.IS_DEVELOPMENT) void this.window.loadURL(Program.DEVELOPMENT_SERVER_URL);
    else void this.window.loadFile(path.join(Program.getProjectRoot(), "dist", "onixlabs-media-player", "browser", "index.html"));

    this.window.on("closed", this.onClosed.bind(this));
    app.on("activate", this.onActivate.bind(this));
    app.on("window-all-closed", this.onAllWindowsClosed.bind(this));
  }

  private createBrowserWindow(): BrowserWindow {
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
        sandbox: false
      }
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
