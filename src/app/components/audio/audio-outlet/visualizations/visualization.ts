export interface VisualizationConfig {
  canvas: HTMLCanvasElement;
  analyser: AnalyserNode;
}

export type VisualizationCategory = 'frequency' | 'waveform' | 'ambience';

export abstract class Visualization {
  abstract readonly name: string;
  abstract readonly category: VisualizationCategory;

  protected canvas: HTMLCanvasElement;
  protected analyser: AnalyserNode;
  protected width: number = 0;
  protected height: number = 0;

  // Sensitivity controls visualization amplitude independent of master volume (0-1, default 0.5)
  protected sensitivity: number = 0.25;

  constructor(config: VisualizationConfig) {
    this.canvas = config.canvas;
    this.analyser = config.analyser;
  }

  setSensitivity(value: number): void {
    this.sensitivity = Math.max(0, Math.min(1, value));
  }

  getSensitivity(): number {
    return this.sensitivity;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.onResize();
  }

  protected onResize(): void {
    // Override in subclass if needed
  }

  abstract draw(): void;

  destroy(): void {
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
}

export abstract class WebGLVisualization extends Visualization {
  protected gl: WebGLRenderingContext;

  constructor(config: VisualizationConfig) {
    super(config);
    const gl: WebGLRenderingContext | null = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
    if (!gl) throw new Error('Failed to get WebGL context');
    this.gl = gl as WebGLRenderingContext;
  }

  override destroy(): void {
    const ext: WEBGL_lose_context | null = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
