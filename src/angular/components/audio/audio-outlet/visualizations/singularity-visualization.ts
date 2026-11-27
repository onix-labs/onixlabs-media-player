/**
 * @fileoverview Singularity visualization (Signature / Singularity).
 *
 * A split waveform bleeding away, bent by waves rolling out from the centre:
 *
 *   1. Scene - Reactor's horizontal waveform, laid flat and split in the middle.
 *      Only the left half is ever drawn: it runs from the left edge to the centre
 *      on a half-width trail surface that, every frame, is pushed away from the
 *      centre, spread evenly up and down, blurred and rippled, so it bleeds and
 *      distorts away out toward its edge. The right half is the same surface
 *      turned through the centre (flipped horizontally and vertically). Near the
 *      centre line each side is blended with its mirror image, so the two halves
 *      meet without a seam.
 *
 *   2. Light - the scene's brightness picks each pixel's colour from a ramp:
 *      near-white at full strength, through the main colour, into a deeper and
 *      shifted shade, and out to black, so the trail cools through it like
 *      phosphor afterglow. A faint glow over the whole screen follows the bass,
 *      so quiet passages sit dark and heavy ones make the screen breathe.
 *
 *   3. Waves - broad waves flow out from the centre, like stones dropped in
 *      water, close enough that neighbouring waves always overlap, so the
 *      picture never sits still. A kick starts a wave at once, so the waves
 *      bunch up with the drums; between kicks a quieter one follows at an
 *      uneven gap, so they never tick along like a metronome. Each wave takes
 *      its strength from the kick drum as it leaves the centre, and travels at
 *      a speed of its own, so a fast one can catch a slow one, double up as
 *      they cross, and pass it. The waves act as lenses: under a wave each
 *      pixel takes its light from a spot pulled toward the wave's crest, so the
 *      crest magnifies the picture and the waveform bends as the rings pass
 *      through it. The bending is strongest down the middle of the screen and
 *      tapers away toward the left and right edges. The waves are measured in
 *      cells of CELL_SIZE canvas pixels.
 *
 * The screen is drawn by the graphics card in a single pass over every pixel,
 * reading the half-width scene directly, onto a WebGL surface that is then laid
 * onto the canvas.
 *
 * The colour drifts slowly round the hue wheel, as Reactor's does. Every so
 * often (gated by a cooldown) a bass hit also jumps the hue: sometimes the whole
 * screen recolours at once, and sometimes the new colour sweeps in over a
 * fraction of a second.
 *
 * @module app/components/audio/audio-outlet/visualizations/singularity-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';

/** A single mutable 2D point. */
interface Point {
  x: number;
  y: number;
}

/** An RGB colour triplet (0-255 per channel). */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Waves that can be spreading at once; a new one replaces the furthest out. */
const MAX_RINGS: number = 8;

/**
 * Covers the screen with one square (aCorner, -1 to 1), handing each pixel its
 * position in canvas pixels, top-down.
 */
const SCREEN_VERTEX_SHADER: string = `
attribute vec2 aCorner;
uniform vec2 uCanvas;
varying vec2 vPixel;
void main() {
  gl_Position = vec4(aCorner, 0.0, 1.0);
  vPixel = vec2(aCorner.x + 1.0, 1.0 - aCorner.y) * 0.5 * uCanvas;
}
`;

/**
 * Lights one pixel.
 *
 * The waves bend it like a lens: it reads its light from a spot pulled along
 * the swell's slope, toward the nearest crest, by more down the middle of the
 * screen than at the edges. Each wave's swell is a bell curve around its crest
 * (radius and strength in uRings, in cells), so the slope is summed exactly
 * from the waves themselves; a free slot has no strength and adds nothing.
 *
 * The light is read from the half-width scene: as it is on the left, and
 * turned through the centre on the right. The scene is white drawn over
 * transparency, so its light is its opacity; the browser hands the colour
 * over un-premultiplied, which makes any visible pixel fully white, so the
 * colour channels cannot be used. Close to the centre line it is
 * blended with the light mirrored across it, half and half on the line itself,
 * so both sides read the same there and no seam shows. The bass glow is added
 * and the pixel is coloured from the afterglow ramp.
 */
const SCREEN_FRAGMENT_SHADER: string = `
precision highp float;
varying vec2 vPixel;
uniform vec2 uCanvas;
uniform sampler2D uLight;
uniform sampler2D uRamp;
uniform vec2 uRings[${MAX_RINGS}];
uniform float uCell;
uniform float uRingWidth;
uniform float uLens;
uniform float uCentreMagnify;
uniform float uEdgeMagnify;
uniform float uGain;
uniform float uGlow;
uniform float uSeam;
float lightAt(vec2 pixel) {
  vec2 halfSize = vec2(uCanvas.x * 0.5, uCanvas.y);
  vec2 left = pixel.x < halfSize.x ? pixel : uCanvas - pixel;
  return texture2D(uLight, left / halfSize).a;
}
void main() {
  vec2 centre = uCanvas * 0.5;
  vec2 offset = (vPixel - centre) / uCell;
  float distance = length(offset);
  float slope = 0.0;
  for (int r = 0; r < ${MAX_RINGS}; r++) {
    float along = (distance - uRings[r].x) / uRingWidth;
    slope -= uRings[r].y * along * exp(-along * along);
  }
  slope *= 2.0 / uRingWidth;
  vec2 outward = distance > 0.0 ? offset / distance : vec2(0.0);
  float across = max(0.0, 1.0 - abs(vPixel.x - centre.x) / centre.x);
  float magnify = uEdgeMagnify + (uCentreMagnify - uEdgeMagnify) * across * across;
  vec2 source = vPixel + outward * slope * uLens * magnify * uCell;
  float seam = 0.5 * (1.0 - smoothstep(0.0, uSeam, abs(source.x - centre.x)));
  float light = mix(lightAt(source), lightAt(vec2(uCanvas.x - source.x, source.y)), seam);
  light = min(1.0, light * uGain + uGlow);
  float rampStep = floor(light * 255.0);
  gl_FragColor = vec4(texture2D(uRamp, vec2((rampStep + 0.5) / 256.0, 0.5)).rgb, 1.0);
}
`;

/** The uniforms the screen program reads. */
const SCREEN_UNIFORMS: readonly string[] = [
  'uCanvas', 'uLight', 'uRamp', 'uRings', 'uCell', 'uRingWidth', 'uLens',
  'uCentreMagnify', 'uEdgeMagnify', 'uGain', 'uGlow', 'uSeam',
];

/**
 * Singularity visualization: a mirrored waveform bleeding away, bent like a lens
 * by waves rolling out from the centre.
 */
export class SingularityVisualization extends Canvas2DVisualization {
  // --- Cells and lenses ----------------------------------------------------

  /** Size of the cell the waves are measured in, in canvas pixels. */
  private static readonly CELL_SIZE: number = 8;

  /**
   * How far either side of the centre line each half is blended with its
   * mirror image, as a fraction of the screen width. Half and half on the line
   * itself, easing to none at this distance.
   */
  private static readonly SEAM_BLEND_FRACTION: number = 0.05;

  /** How brightly the scene lights the screen, as a multiple of its own light. */
  private static readonly LIGHT_GAIN: number = 0.8;

  /**
   * How strongly the waves bend the picture like lenses: a pixel takes its
   * light from this many cells toward the nearest crest per unit of the swell's
   * slope (scaled by how far across the screen the pixel is). A full kick's wave
   * moves the light about seven cells down the middle of the screen.
   */
  private static readonly LENS_STRENGTH: number = 60;

  // --- Afterglow colour ramp ------------------------------------------------

  /** Light (0-1) at which a pixel shows the deep shade. */
  private static readonly DEEP_STOP: number = 0.5;

  /** Light (0-1) at which a pixel shows the main colour. */
  private static readonly MAIN_STOP: number = 0.8;

  /** How far round the hue wheel the deep shade sits from the main colour (degrees). */
  private static readonly DEEP_HUE_SHIFT: number = 80;

  /** Saturation and lightness of the deep shade (percent). */
  private static readonly DEEP_SATURATION: number = 85;
  private static readonly DEEP_LIGHTNESS: number = 20;

  /** Saturation and lightness of the main colour (percent). */
  private static readonly MAIN_SATURATION: number = 85;
  private static readonly MAIN_LIGHTNESS: number = 55;

  /** Saturation and lightness of a fully lit, near-white pixel (percent). */
  private static readonly HOT_SATURATION: number = 100;
  private static readonly HOT_LIGHTNESS: number = 92;

  /** Colour of an unlit pixel. */
  private static readonly UNLIT: Rgb = {r: 0, g: 0, b: 0};

  /** Steps in the colour ramp, one per byte of light. */
  private static readonly RAMP_STEPS: number = 256;

  // --- Bass glow ------------------------------------------------------------

  /** Light the glow adds to every pixel at full bass (0-1). */
  private static readonly GLOW_AMOUNT: number = 0.5;

  /** How fast the glow follows the bass up and lets it go (fraction per frame). */
  private static readonly GLOW_ATTACK: number = 0.3;
  private static readonly GLOW_RELEASE: number = 0.03;

  // --- Bass ripples --------------------------------------------------------

  /**
   * Closest a kick may start a ripple behind the last one, in cells. Kicks
   * closer together than this would merge into one swelling.
   */
  private static readonly RING_MIN_SPACING: number = 8;

  /**
   * Range of gaps, in cells, after which a quieter ripple follows when no kick
   * has started one; a fresh gap is picked at random each time. With RING_WIDTH
   * at over a third of the longest, neighbours always overlap, so no part
   * of the screen is left out of a wave.
   */
  private static readonly RING_FILL_SPACING_MIN: number = 10;
  private static readonly RING_FILL_SPACING_MAX: number = 16;

  /**
   * How far above its own recent average the kick level (0-1) must climb, while
   * rising, to count as a kick, and how loud it must then be, so small bumps in
   * quiet passages do not count.
   *
   * Against an average rather than as a jump in a single frame: the analyser
   * smooths the spectrum and reports it in decibels, so even a hard kick climbs
   * only a couple of hundredths a frame, over several frames.
   */
  private static readonly ONSET_MARGIN: number = 0.05;
  private static readonly ONSET_FLOOR: number = 0.3;

  /** How fast the kick's recent average follows it (fraction per frame); about a second. */
  private static readonly KICK_AVERAGE_RATE: number = 0.05;

  /**
   * The kick band the ripples listen to (Hz): a kick drum's thump, below the
   * snare, vocals and guitars. Picked by frequency rather than as a share of
   * the bins, so it is the same band whatever the FFT size.
   */
  private static readonly KICK_LOW_HZ: number = 40;
  private static readonly KICK_HIGH_HZ: number = 150;

  /** Sample rate assumed when the analyser does not report its own (Hz). */
  private static readonly FALLBACK_SAMPLE_RATE: number = 44_100;

  /**
   * How fast the kick envelope lets the kick go (fraction per frame). It rises
   * with the kick at once and fades over about a second, so a kick landing
   * between two ripples still swells the next one.
   */
  private static readonly KICK_RELEASE: number = 0.03;

  /** Strength (0-1) of a ripple that leaves the centre in silence, so the waves never stop. */
  private static readonly RING_MIN_STRENGTH: number = 0.25;

  /** Frames a ripple at the usual speed takes to reach the corners (about four seconds). */
  private static readonly RING_FRAMES: number = 256;

  /**
   * Range of speeds a ripple may travel at, as multiples of the usual speed;
   * each picks one at random as it starts, so a fast one can catch and pass a
   * slow one.
   */
  private static readonly RING_SPEED_MIN: number = 0.5;
  private static readonly RING_SPEED_MAX: number = 1.5;

  /** Half-width of a ripple, in cells. */
  private static readonly RING_WIDTH: number = 6;

  /**
   * How strongly a wave bends the picture, by how far across the screen it is:
   * CENTRE_MAGNIFY down the middle, easing to EDGE_MAGNIFY at the left and
   * right edges. The ease is squared, so the bending falls away quickly from
   * the middle and tapers off toward the sides.
   */
  private static readonly CENTRE_MAGNIFY: number = 0.8;
  private static readonly EDGE_MAGNIFY: number = 0.2;

  /** Widths a ripple travels beyond the corners before it is dropped, its tail long gone. */
  private static readonly RING_TAIL: number = 4;

  // --- Waveform -------------------------------------------------------------

  /** Samples per half waveform (edge to centre). */
  private static readonly HALF_SAMPLES: number = 40;

  /** Waveform amplitude as a fraction of screen height. */
  private static readonly AMP_FRACTION: number = 0.3;

  /** Width of the glow stroke as a fraction of screen height. */
  private static readonly GLOW_WIDTH_FRACTION: number = 0.035;

  /** Width of the main stroke as a fraction of screen height. */
  private static readonly MAIN_WIDTH_FRACTION: number = 0.02;

  /** Width of the highlight stroke as a fraction of screen height. */
  private static readonly HIGHLIGHT_WIDTH_FRACTION: number = 0.004;

  /**
   * Stroke colours of the waveform. The scene only carries light, so it is
   * drawn in white; the afterglow ramp gives it its colour.
   */
  private static readonly COLOR_GLOW: string = 'rgba(255, 255, 255, 0.35)';
  private static readonly COLOR_MAIN: string = 'rgba(255, 255, 255, 0.75)';
  private static readonly COLOR_HIGHLIGHT: string = 'rgb(255, 255, 255)';

  // --- Trail (bleed / distort) ----------------------------------------------

  /**
   * Most pixels the half-width trail may hold. 320x360, half of 640x360.
   *
   * The trail is soft by design, so it renders small and is sampled up; that
   * keeps the per-frame stretch and blur cheap whatever the display size.
   */
  private static readonly HALF_PIXEL_BUDGET: number = 115_200;

  /** Vertical strips the trail is redrawn in, each distorted on its own. */
  private static readonly BLEED_COLUMNS: number = 32;

  /** Per-frame horizontal stretch away from the centre (1 = none). */
  private static readonly BLEED_STRETCH: number = 1.012;

  /** Per-frame vertical spread at the edges, as a fraction of height. */
  private static readonly BLEED_SPREAD: number = 0.012;

  /** Per-frame vertical ripple at the edges, as a fraction of height. */
  private static readonly BLEED_RIPPLE: number = 0.004;

  /** Ripple phase step between neighbouring strips (radians). */
  private static readonly RIPPLE_STEP: number = 0.55;

  /** Per-frame advance of the ripple phase (radians). */
  private static readonly RIPPLE_SPEED: number = 0.06;

  /** Blur applied to the trail each frame, in trail pixels. */
  private static readonly TRAIL_BLUR: number = 0.95;

  // --- Colour cycling -------------------------------------------------------

  /** Per-frame hue drift (degrees). */
  private static readonly HUE_CYCLE_SPEED: number = 0.5;

  /** Starting hue (degrees) - blue, matching Reactor. */
  private static readonly START_HUE: number = 220;

  // --- Bass trigger ---------------------------------------------------------

  /** Fraction of the lowest FFT bins treated as the "bass" band. */
  private static readonly BASS_BIN_FRACTION: number = 0.03;

  /** Average bass magnitude (0-1) at/above which the trigger fires. */
  private static readonly BASS_THRESHOLD: number = 0.5;

  /** Minimum time between hue jumps (milliseconds); also the start grace period. */
  private static readonly BASS_COOLDOWN_MS: number = 8000;

  /** Hue jump applied on each bass trigger (degrees; golden angle for variety). */
  private static readonly HUE_JUMP_DEGREES: number = 137.5;

  /** Chance (0-1) that a hue jump recolours everything at once rather than sweeping in. */
  private static readonly SNAP_PROBABILITY: number = 0.5;

  /** Half the hue wheel; a sweep takes the shorter way round (degrees). */
  private static readonly HALF_TURN_DEGREES: number = 180;

  /** Per-frame progress of a sweeping hue change (0.15 = about seven frames). */
  private static readonly HUE_SWEEP_RATE: number = 0.15;

  public readonly name: string = 'Singularity';
  public readonly category: string = 'Signature';

  /** Bent at the display's own resolution, so the lenses stay smooth; the scene is soft by design. */
  public override readonly rendersAtNativeResolution: boolean = true;

  // --- State ----------------------------------------------------------------

  /** Time-domain audio buffer (for the waveform). */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Frequency-domain audio buffer (for the bass trigger). */
  private freqArray: Uint8Array<ArrayBuffer>;

  /** Hue the scene is heading for (degrees). */
  private hue: number = SingularityVisualization.START_HUE;

  /** Hue a sweeping change started from (degrees). */
  private sweepFromHue: number = 0;

  /** Progress of a sweeping hue change: 0 (just started) to 1 (done). */
  private sweep: number = 1;

  /** Integer hue the colour ramp was built for (-1 = unbuilt). */
  private cachedHue: number = -1;

  /** The afterglow colour ramp: RGB for each byte of light, unlit to near-white. */
  private readonly ramp: Uint8Array = new Uint8Array(SingularityVisualization.RAMP_STEPS * 3);

  /** Whether the ramp has changed since it was last handed to the graphics card. */
  private rampDirty: boolean = true;

  /** performance.now() of the last hue jump, gating its cooldown. */
  private lastBassTriggerTime: number = Number.NEGATIVE_INFINITY;

  /** The kick envelope (0-1): rises with the kick at once, fades over about a second. */
  private kickEnvelope: number = 0;

  /** The kick level last frame (0-1), to tell a rising kick from a falling one. */
  private previousKick: number = 0;

  /** The kick level's recent average (0-1), to spot a kick as a climb above it. */
  private kickAverage: number = 0;

  /** How far the last ripple must travel before a quieter one follows it, in cells. */
  private fillSpacing: number = SingularityVisualization.RING_FILL_SPACING_MIN;

  /** The bass glow, following the bass level (0-1). */
  private glowLevel: number = 0;

  /** Radius of each ripple's crest, in cells; negative when the slot is free. */
  private readonly rings: Float32Array = new Float32Array(MAX_RINGS).fill(-1);

  /** Strength of each ripple (0-1), fixed from the kick as it left the centre. */
  private readonly ringStrengths: Float32Array = new Float32Array(MAX_RINGS);

  /** Speed of each ripple, as a multiple of the usual speed. */
  private readonly ringSpeeds: Float32Array = new Float32Array(MAX_RINGS);

  /** Each ripple's radius and eased strength, as handed to the graphics card. */
  private readonly ringUniform: Float32Array = new Float32Array(MAX_RINGS * 2);

  /** Phase of the trail ripple (radians). */
  private ripplePhase: number = 0;

  /** Pre-allocated points of the left half of the waveform (avoids per-frame allocation). */
  private readonly points: Point[];

  /** Distance from the centre to the furthest corner, in cells. */
  private maxDistance: number = 0;

  // --- Graphics card --------------------------------------------------------

  /** The WebGL surface the screen is drawn on, laid onto the canvas each frame. */
  private readonly glCanvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;

  /** Where each of the screen program's uniforms lives. */
  private readonly uniforms: Record<string, WebGLUniformLocation | null> = {};

  /** The scene's light (texture unit 0) and the afterglow ramp (unit 1). */
  private readonly lightTexture: WebGLTexture;
  private readonly rampTexture: WebGLTexture;

  /** Set once destroy() runs so a trailing frame cannot resurrect the surfaces. */
  private destroyed: boolean = false;

  /** Half-width trail surface the left half of the waveform is drawn onto and bled away on. */
  private sceneCanvas: HTMLCanvasElement | null = null;
  private sceneCtx: CanvasRenderingContext2D | null = null;

  /** Scratch surface the trail is copied onto before being redrawn. */
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.points = SingularityVisualization.allocatePoints(SingularityVisualization.HALF_SAMPLES);

    this.glCanvas = document.createElement('canvas');
    const gl: WebGLRenderingContext | null = this.glCanvas.getContext('webgl', {alpha: false, antialias: false});
    if (!gl) throw new Error('Failed to get WebGL context');
    this.gl = gl;

    // There is only one program, square and pair of textures, so they are
    // bound once here and stay bound; each frame only refreshes what changed.
    const program: WebGLProgram = this.createProgram(SCREEN_VERTEX_SHADER, SCREEN_FRAGMENT_SHADER);
    gl.useProgram(program);
    for (const name of SCREEN_UNIFORMS) this.uniforms[name] = gl.getUniformLocation(program, name);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.createBuffer());
    // The screen's corners, in triangle-strip order.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const corner: number = gl.getAttribLocation(program, 'aCorner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE1);
    this.rampTexture = this.createTexture(gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    // The light is read smoothly, so a lens can pull it from between two pixels.
    this.lightTexture = this.createTexture(gl.LINEAR);

    const u: Record<string, WebGLUniformLocation | null> = this.uniforms;
    gl.uniform1i(u['uLight'], 0);
    gl.uniform1i(u['uRamp'], 1);
    gl.uniform1f(u['uCell'], SingularityVisualization.CELL_SIZE);
    gl.uniform1f(u['uRingWidth'], SingularityVisualization.RING_WIDTH);
    gl.uniform1f(u['uLens'], SingularityVisualization.LENS_STRENGTH);
    gl.uniform1f(u['uCentreMagnify'], SingularityVisualization.CENTRE_MAGNIFY);
    gl.uniform1f(u['uEdgeMagnify'], SingularityVisualization.EDGE_MAGNIFY);
    gl.uniform1f(u['uGain'], SingularityVisualization.LIGHT_GAIN);
  }

  public override draw(): void {
    if (this.destroyed) return;
    this.updateFade();

    if (this.width <= 0 || this.height <= 0) return;
    if (!this.sceneCanvas || !this.scratchCanvas) this.onResize();
    const scene: HTMLCanvasElement | null = this.sceneCanvas;
    const sceneCtx: CanvasRenderingContext2D | null = this.sceneCtx;
    const scratch: HTMLCanvasElement | null = this.scratchCanvas;
    const scratchCtx: CanvasRenderingContext2D | null = this.scratchCtx;
    if (!scene || !sceneCtx || !scratch || !scratchCtx) return;

    // Advance time-based state. A bass hit may start a ring and jump the hue.
    this.updateAudio();
    this.hue = (this.hue + SingularityVisualization.HUE_CYCLE_SPEED) % 360;
    this.sweepFromHue = (this.sweepFromHue + SingularityVisualization.HUE_CYCLE_SPEED) % 360;
    if (this.sweep < 1) this.sweep = Math.min(1, this.sweep + SingularityVisualization.HUE_SWEEP_RATE);
    this.updateColors();
    this.ripplePhase += SingularityVisualization.RIPPLE_SPEED;
    this.advanceRings();

    this.analyser.getByteTimeDomainData(this.dataArray);

    // Age the scene, then lay the fresh waveform over it.
    this.bleedTrail(scene, sceneCtx, scratch, scratchCtx);
    this.drawWaveform(sceneCtx);

    // Have the graphics card turn, bend and colour the scene through the
    // waves, and lay that down.
    this.renderScreen(scene);
    this.ctx.drawImage(this.glCanvas, 0, 0);

    this.applyFadeOverlay();
  }

  /** Allocates a fresh array of zeroed points. */
  private static allocatePoints(count: number): Point[] {
    const points: Point[] = new Array<Point>(count);
    for (let i: number = 0; i < count; i++) {
      points[i] = {x: 0, y: 0};
    }
    return points;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    const width: number = this.width;
    const height: number = this.height;

    if (!this.sceneCanvas || !this.sceneCtx) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.sceneCanvas = offscreen.canvas;
      this.sceneCtx = offscreen.ctx;
    }
    if (!this.scratchCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.scratchCanvas = offscreen.canvas;
      this.scratchCtx = offscreen.ctx;
    }
    if (this.glCanvas.width !== width || this.glCanvas.height !== height) {
      this.glCanvas.width = width;
      this.glCanvas.height = height;
    }

    // The scene holds only the left half, at no more than its pixel budget,
    // and is drawn into in canvas coordinates through a transform.
    const halfWidth: number = width / 2;
    const scene: {width: number; height: number} =
      this.getSurfaceSize(Math.ceil(halfWidth), height, SingularityVisualization.HALF_PIXEL_BUDGET);
    if (this.sceneCanvas.width !== scene.width || this.sceneCanvas.height !== scene.height) {
      this.sceneCanvas.width = scene.width;
      this.sceneCanvas.height = scene.height;
      this.scratchCanvas.width = scene.width;
      this.scratchCanvas.height = scene.height;
    }
    this.applySurfaceTransform(this.sceneCtx, halfWidth, height);

    const gl: WebGLRenderingContext = this.gl;
    gl.viewport(0, 0, width, height);
    gl.uniform2f(this.uniforms['uCanvas'], width, height);
    gl.uniform1f(this.uniforms['uSeam'], width * SingularityVisualization.SEAM_BLEND_FRACTION);

    this.maxDistance = Math.hypot(width / 2, height / 2) / SingularityVisualization.CELL_SIZE;
    this.seedRings();
    this.ctx.clearRect(0, 0, width, height);
  }

  // === Screen ===============================================================

  /**
   * Draws the whole screen in a single pass: the scene, the ramp when it has
   * changed, the waves and the glow are handed over, and the graphics card
   * turns, bends, glows and colours every pixel.
   */
  private renderScreen(scene: HTMLCanvasElement): void {
    const gl: WebGLRenderingContext = this.gl;

    if (this.rampDirty) {
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, SingularityVisualization.RAMP_STEPS, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, this.ramp);
      gl.activeTexture(gl.TEXTURE0);
      this.rampDirty = false;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);

    this.fillRingUniform();
    gl.uniform2fv(this.uniforms['uRings'], this.ringUniform);
    gl.uniform1f(this.uniforms['uGlow'], SingularityVisualization.GLOW_AMOUNT * this.glowLevel * this.glowLevel);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Hands each wave's crest radius and strength over in pairs. A wave eases in
   * over its first width, so a new one does not pop at the centre; a free slot
   * has no strength.
   */
  private fillRingUniform(): void {
    const width: number = SingularityVisualization.RING_WIDTH;
    for (let r: number = 0; r < MAX_RINGS; r++) {
      const radius: number = this.rings[r];
      const easeIn: number = radius < width ? Math.max(0, radius) / width : 1;
      this.ringUniform[r * 2] = radius;
      this.ringUniform[r * 2 + 1] = radius < 0 ? 0 : this.ringStrengths[r] * easeIn;
    }
  }

  /** How far out a ripple travels before it is dropped, in cells. */
  private ringLimit(): number {
    return this.maxDistance + SingularityVisualization.RING_TAIL * SingularityVisualization.RING_WIDTH;
  }

  /**
   * Fills the screen with quiet waves at uneven gaps, so it starts out rolling
   * rather than waiting for the first waves to spread.
   */
  private seedRings(): void {
    this.rings.fill(-1);
    const limit: number = this.ringLimit();
    let radius: number = 0;
    for (let r: number = 0; r < MAX_RINGS && radius <= limit; r++) {
      this.rings[r] = radius;
      this.ringStrengths[r] = SingularityVisualization.RING_MIN_STRENGTH;
      this.ringSpeeds[r] = this.pickRingSpeed();
      const gap: number = this.pickFillSpacing();
      // The gap behind the innermost is the one the next quiet ripple waits for.
      if (r === 0) this.fillSpacing = gap;
      radius += gap;
    }
  }

  /** A random speed, as a multiple of the usual one, between RING_SPEED_MIN and RING_SPEED_MAX. */
  private pickRingSpeed(): number {
    const range: number = SingularityVisualization.RING_SPEED_MAX - SingularityVisualization.RING_SPEED_MIN;
    return SingularityVisualization.RING_SPEED_MIN + Math.random() * range;
  }

  /** A random gap, in cells, between RING_FILL_SPACING_MIN and RING_FILL_SPACING_MAX. */
  private pickFillSpacing(): number {
    const range: number = SingularityVisualization.RING_FILL_SPACING_MAX - SingularityVisualization.RING_FILL_SPACING_MIN;
    return SingularityVisualization.RING_FILL_SPACING_MIN + Math.random() * range;
  }

  /** Moves every ripple outward, freeing the slots of those past the corners. */
  private advanceRings(): void {
    const speed: number = this.maxDistance / SingularityVisualization.RING_FRAMES;
    const limit: number = this.ringLimit();
    for (let r: number = 0; r < MAX_RINGS; r++) {
      if (this.rings[r] < 0) continue;
      this.rings[r] += speed * this.ringSpeeds[r];
      if (this.rings[r] > limit) this.rings[r] = -1;
    }
  }

  /** How far the youngest ripple has travelled, in cells; infinite when there are none. */
  private newestRingRadius(): number {
    let newest: number = Number.POSITIVE_INFINITY;
    for (let r: number = 0; r < MAX_RINGS; r++) {
      if (this.rings[r] >= 0 && this.rings[r] < newest) newest = this.rings[r];
    }
    return newest;
  }

  /**
   * Starts a ripple at the centre, in a free slot or over the one furthest out,
   * as strong as the kick envelope is now and at a speed of its own.
   */
  private startRing(): void {
    let slot: number = 0;
    for (let r: number = 0; r < MAX_RINGS; r++) {
      if (this.rings[r] < 0) { slot = r; break; }
      if (this.rings[r] > this.rings[slot]) slot = r;
    }
    this.rings[slot] = 0;
    this.ringStrengths[slot] = SingularityVisualization.RING_MIN_STRENGTH
      + (1 - SingularityVisualization.RING_MIN_STRENGTH) * this.kickEnvelope;
    this.ringSpeeds[slot] = this.pickRingSpeed();
  }

  /**
   * Compiles and links a shader program.
   *
   * @param vertexSource - Vertex shader source
   * @param fragmentSource - Fragment shader source
   * @returns The linked program
   * @throws Error if compilation or linking fails
   */
  private createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl: WebGLRenderingContext = this.gl;
    const program: WebGLProgram | null = gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL program');

    const vertex: WebGLShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragment: WebGLShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log: string | null = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Failed to link WebGL program: ${log ?? 'unknown error'}`);
    }
    return program;
  }

  /**
   * Compiles a single shader stage.
   *
   * @param type - gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
   * @param source - Shader source
   * @returns The compiled shader
   * @throws Error if compilation fails
   */
  private compileShader(type: number, source: string): WebGLShader {
    const gl: WebGLRenderingContext = this.gl;
    const shader: WebGLShader | null = gl.createShader(type);
    if (!shader) throw new Error('Failed to create WebGL shader');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log: string | null = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Failed to compile shader: ${log ?? 'unknown error'}`);
    }
    return shader;
  }

  /**
   * Creates a buffer.
   *
   * @returns The buffer
   * @throws Error if the context will not make one
   */
  private createBuffer(): WebGLBuffer {
    const buffer: WebGLBuffer | null = this.gl.createBuffer();
    if (!buffer) throw new Error('Failed to create WebGL buffer');
    return buffer;
  }

  /**
   * Creates a texture clamped at its edges, so it may be any size, and leaves
   * it bound to the active texture unit.
   *
   * @param filter - gl.NEAREST to read it pixel for pixel, gl.LINEAR to blend between pixels
   * @returns The texture
   * @throws Error if the context will not make one
   */
  private createTexture(filter: number): WebGLTexture {
    const gl: WebGLRenderingContext = this.gl;
    const texture: WebGLTexture | null = gl.createTexture();
    if (!texture) throw new Error('Failed to create WebGL texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  // === Scene ================================================================

  /**
   * Ages the left half by one frame. The trail is copied out and drawn back
   * blurred in vertical strips; each strip is pushed away from the centre (the
   * surface's right edge), and spread evenly up and down and rippled in
   * proportion to its distance from the centre, so the waveform bleeds and
   * distorts away out toward the edge. It neither rises nor sinks, so neither
   * the top nor the bottom of a half fills up more than the other.
   *
   * Each strip is blurred on its own rather than the trail in one pass: the
   * soft edges that leaves between strips build up over the frames into the
   * fine streaks that give the trail its detail.
   */
  private bleedTrail(
    scene: HTMLCanvasElement,
    sceneCtx: CanvasRenderingContext2D,
    scratch: HTMLCanvasElement,
    scratchCtx: CanvasRenderingContext2D
  ): void {
    const width: number = scene.width;
    const height: number = scene.height;
    const columns: number = SingularityVisualization.BLEED_COLUMNS;
    const columnWidth: number = width / columns;
    const stretch: number = SingularityVisualization.BLEED_STRETCH;

    this.copySurface(scratchCtx, scene);

    // Work in the surface's own pixels while redrawing it from the scratch.
    sceneCtx.save();
    sceneCtx.setTransform(1, 0, 0, 1, 0, 0);
    sceneCtx.clearRect(0, 0, width, height);
    sceneCtx.filter = `blur(${SingularityVisualization.TRAIL_BLUR}px)`;
    for (let c: number = 0; c < columns; c++) {
      const sourceX: number = c * columnWidth;
      // 0 at the centre (the right edge), 1 at the outer edge.
      const reach: number = (width - sourceX - columnWidth / 2) / width;
      const spread: number = height * SingularityVisualization.BLEED_SPREAD * reach;
      const ripple: number = Math.sin(this.ripplePhase + c * SingularityVisualization.RIPPLE_STEP)
        * height * SingularityVisualization.BLEED_RIPPLE * reach;
      const targetX: number = width + (sourceX - width) * stretch;
      sceneCtx.drawImage(
        scratch,
        sourceX, 0, columnWidth, height,
        targetX, -spread / 2 + ripple, columnWidth * stretch, height + spread
      );
    }
    sceneCtx.restore();
  }

  /** Draws the left half of the waveform onto the scene, from the left edge to the centre. */
  private drawWaveform(ctx: CanvasRenderingContext2D): void {
    this.calculatePoints();
    const height: number = this.height;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.strokeWave(ctx, SingularityVisualization.COLOR_GLOW, height * SingularityVisualization.GLOW_WIDTH_FRACTION);
    this.strokeWave(ctx, SingularityVisualization.COLOR_MAIN, height * SingularityVisualization.MAIN_WIDTH_FRACTION);
    this.strokeWave(ctx, SingularityVisualization.COLOR_HIGHLIGHT, height * SingularityVisualization.HIGHLIGHT_WIDTH_FRACTION);
    ctx.restore();
  }

  /** Strokes the waveform in one colour and width. */
  private strokeWave(ctx: CanvasRenderingContext2D, color: string, lineWidth: number): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, lineWidth);
    this.buildSmoothPath(ctx, this.points, this.points.length - 1);
    ctx.stroke();
  }

  /** Fills points from the first half of the time-domain buffer, edge to centre. */
  private calculatePoints(): void {
    const data: Uint8Array<ArrayBuffer> = this.dataArray;
    const samples: number = SingularityVisualization.HALF_SAMPLES;
    const centreX: number = this.width / 2;
    const centreY: number = this.height / 2;
    const amplitude: number = this.height * SingularityVisualization.AMP_FRACTION;
    const sampleStep: number = (data.length / 2) / samples;

    for (let i: number = 0; i < samples; i++) {
      const sample: number = (data[(i * sampleStep) | 0] - 128) / 128;
      this.points[i].x = (i / (samples - 1)) * centreX;
      this.points[i].y = centreY + sample * amplitude;
    }
  }

  // === Audio & colour =======================================================

  /**
   * Reads the spectrum once for the frame and acts on it:
   *
   * - the bass drives the glow;
   * - the kick band drives the envelope each ripple takes its strength from; a
   *   kick starts a ripple at once if the last is RING_MIN_SPACING out, and
   *   otherwise a quieter one follows once the last is fillSpacing out;
   * - when the bass is over BASS_THRESHOLD and the hue cooldown has passed, it
   *   jumps the hue. Some jumps recolour everything at once; the rest sweep the
   *   new colour in over a fraction of a second.
   */
  private updateAudio(): void {
    // Seed the cooldown on the first frame so the first hue jump is held off for a
    // full cooldown rather than firing almost immediately when play starts.
    if (this.lastBassTriggerTime === Number.NEGATIVE_INFINITY) {
      this.lastBassTriggerTime = performance.now();
    }

    this.analyser.getByteFrequencyData(this.freqArray);

    const binCount: number = this.freqArray.length;
    const bassBins: number = Math.max(1, (binCount * SingularityVisualization.BASS_BIN_FRACTION) | 0);
    let sum: number = 0;
    for (let b: number = 0; b < bassBins; b++) sum += this.freqArray[b];
    const bassLevel: number = sum / bassBins / 255;

    const follow: number = bassLevel > this.glowLevel ? SingularityVisualization.GLOW_ATTACK : SingularityVisualization.GLOW_RELEASE;
    this.glowLevel += (bassLevel - this.glowLevel) * follow;

    const kickLevel: number = this.kickLevel();
    this.kickEnvelope = kickLevel > this.kickEnvelope
      ? kickLevel
      : this.kickEnvelope + (kickLevel - this.kickEnvelope) * SingularityVisualization.KICK_RELEASE;
    const kick: boolean = kickLevel > this.previousKick
      && kickLevel >= this.kickAverage + SingularityVisualization.ONSET_MARGIN
      && kickLevel >= SingularityVisualization.ONSET_FLOOR;
    this.previousKick = kickLevel;
    this.kickAverage += (kickLevel - this.kickAverage) * SingularityVisualization.KICK_AVERAGE_RATE;
    const newest: number = this.newestRingRadius();
    if ((kick && newest >= SingularityVisualization.RING_MIN_SPACING) || newest >= this.fillSpacing) {
      this.startRing();
      this.fillSpacing = this.pickFillSpacing();
    }

    if (bassLevel < SingularityVisualization.BASS_THRESHOLD) return;
    const now: number = performance.now();
    if (now - this.lastBassTriggerTime < SingularityVisualization.BASS_COOLDOWN_MS) return;
    this.lastBassTriggerTime = now;

    const from: number = this.currentHue();
    this.hue = (this.hue + SingularityVisualization.HUE_JUMP_DEGREES) % 360;

    if (Math.random() < SingularityVisualization.SNAP_PROBABILITY) {
      this.sweep = 1;
    } else {
      this.sweepFromHue = from;
      this.sweep = 0;
    }
  }

  /**
   * The average level (0-1) of the kick band in this frame's spectrum: the bins
   * from KICK_LOW_HZ up to KICK_HIGH_HZ, and at least one bin however coarse
   * the FFT.
   */
  private kickLevel(): number {
    const binCount: number = this.freqArray.length;
    const sampleRate: number = this.analyser.context?.sampleRate || SingularityVisualization.FALLBACK_SAMPLE_RATE;
    const binHz: number = sampleRate / (binCount * 2);
    const low: number = Math.min(binCount - 1, Math.floor(SingularityVisualization.KICK_LOW_HZ / binHz));
    const high: number = Math.min(binCount, Math.max(low + 1, Math.ceil(SingularityVisualization.KICK_HIGH_HZ / binHz)));
    let sum: number = 0;
    for (let b: number = low; b < high; b++) sum += this.freqArray[b];
    return sum / (high - low) / 255;
  }

  /**
   * The hue being shown: the target hue, or partway along the shorter arc
   * toward it while a sweep is in progress.
   */
  private currentHue(): number {
    if (this.sweep >= 1) return this.hue;
    let delta: number = this.hue - this.sweepFromHue;
    if (delta > SingularityVisualization.HALF_TURN_DEGREES) delta -= 360;
    else if (delta < -SingularityVisualization.HALF_TURN_DEGREES) delta += 360;
    // Ease out, so the change lands quickly and settles.
    const eased: number = 1 - (1 - this.sweep) * (1 - this.sweep);
    return (this.sweepFromHue + delta * eased + 360) % 360;
  }

  /** Rebuilds the afterglow colour ramp when the shown hue moves. */
  private updateColors(): void {
    const hue: number = this.currentHue();
    const hueInt: number = Math.floor(hue);
    if (hueInt === this.cachedHue) return;
    this.cachedHue = hueInt;

    const stops: readonly {at: number; color: Rgb}[] = [
      {at: 0, color: SingularityVisualization.UNLIT},
      {
        at: SingularityVisualization.DEEP_STOP,
        color: this.hslToRgb(hue + SingularityVisualization.DEEP_HUE_SHIFT, SingularityVisualization.DEEP_SATURATION, SingularityVisualization.DEEP_LIGHTNESS),
      },
      {at: SingularityVisualization.MAIN_STOP, color: this.hslToRgb(hue, SingularityVisualization.MAIN_SATURATION, SingularityVisualization.MAIN_LIGHTNESS)},
      {at: 1, color: this.hslToRgb(hue, SingularityVisualization.HOT_SATURATION, SingularityVisualization.HOT_LIGHTNESS)},
    ];

    const top: number = SingularityVisualization.RAMP_STEPS - 1;
    let stop: number = 0;
    for (let step: number = 0; step <= top; step++) {
      const at: number = step / top;
      while (stop < stops.length - 2 && at > stops[stop + 1].at) stop++;
      const from: {at: number; color: Rgb} = stops[stop];
      const to: {at: number; color: Rgb} = stops[stop + 1];
      const t: number = (at - from.at) / (to.at - from.at);
      this.ramp[step * 3] = Math.round(from.color.r + (to.color.r - from.color.r) * t);
      this.ramp[step * 3 + 1] = Math.round(from.color.g + (to.color.g - from.color.g) * t);
      this.ramp[step * 3 + 2] = Math.round(from.color.b + (to.color.b - from.color.b) * t);
    }
    this.rampDirty = true;
  }

  public override destroy(): void {
    this.destroyed = true;
    this.sceneCanvas = null;
    this.sceneCtx = null;
    this.scratchCanvas = null;
    this.scratchCtx = null;
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
