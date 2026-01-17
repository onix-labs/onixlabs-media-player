export interface VisualizationConfig {
  canvas: HTMLCanvasElement;
  analyser: AnalyserNode;
}

export type VisualizationCategory = 'frequency' | 'waveform' | 'ambience';

export abstract class Visualization {
  public abstract readonly name: string;
  public abstract readonly category: VisualizationCategory;

  protected canvas: HTMLCanvasElement;
  protected analyser: AnalyserNode;
  protected width: number = 0;
  protected height: number = 0;

  // Sensitivity controls visualization amplitude independent of master volume (0-1, default 0.5)
  protected sensitivity: number = 0.25;

  // Fade state for pause/stop transitions
  protected fadeAlpha: number = 1; // 0 = fully visible, 1 = fully black
  protected isPlaying: boolean = false;
  protected lastFrameTime: number = 0;
  protected readonly FADE_DURATION_MS: number = 5000; // 5 seconds to fade to black

  constructor(config: VisualizationConfig) {
    this.canvas = config.canvas;
    this.analyser = config.analyser;
    this.lastFrameTime = performance.now();
  }

  public setSensitivity(value: number): void {
    this.sensitivity = Math.max(0, Math.min(1, value));
  }

  public getSensitivity(): number {
    return this.sensitivity;
  }

  public setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    if (playing) {
      // Reset fade when playback starts
      this.fadeAlpha = 0;
    }
  }

  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.onResize();
  }

  protected onResize(): void {
    // Override in subclass if needed
  }

  protected updateFade(): void {
    const now: number = performance.now();
    const deltaMs: number = now - this.lastFrameTime;
    this.lastFrameTime = now;

    if (this.isPlaying) {
      // Fade in quickly when playing
      this.fadeAlpha = Math.max(0, this.fadeAlpha - deltaMs / 500);
    } else {
      // Fade out slowly when paused/stopped
      this.fadeAlpha = Math.min(1, this.fadeAlpha + deltaMs / this.FADE_DURATION_MS);
    }
  }

  public abstract draw(): void;

  public destroy(): void {
    // Override in subclass to clean up resources (WebGL contexts, etc.)
  }
}

export abstract class Canvas2DVisualization extends Visualization {
  protected ctx: CanvasRenderingContext2D;

  constructor(config: VisualizationConfig) {
    super(config);
    const ctx: CanvasRenderingContext2D | null = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;
  }

  protected applyFadeOverlay(): void {
    if (this.fadeAlpha <= 0) return;

    this.ctx.fillStyle = `rgba(0, 0, 0, ${this.fadeAlpha})`;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }
}

export abstract class WebGLVisualization extends Visualization {
  protected gl: WebGLRenderingContext;

  constructor(config: VisualizationConfig) {
    super(config);
    const gl: WebGLRenderingContext | null = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
    if (!gl) throw new Error('Failed to get WebGL context');
    this.gl = gl as WebGLRenderingContext;
  }

  public override destroy(): void {
    const ext: WEBGL_lose_context | null = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
