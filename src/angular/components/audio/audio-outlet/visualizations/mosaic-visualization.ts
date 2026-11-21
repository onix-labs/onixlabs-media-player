/**
 * @fileoverview Mosaic visualization (Signature / Mosaic).
 *
 * A waveform playing on a very low-resolution dot screen:
 *
 *   1. Scene - Reactor's horizontal waveform, laid flat and split in the middle.
 *      Only the left half is ever drawn: it runs from the left edge to the centre
 *      on a half-width trail surface that, every frame, is pushed away from the
 *      centre, lifted straight up, faded, blurred and rippled, so it bleeds,
 *      fades and distorts away up and out toward its edge. The right half is the
 *      same surface flipped horizontally and vertically, so it is the left half
 *      rotated through the centre and its trail sinks straight down instead. A
 *      bass hit reverses which side rises. The scene is never shown directly.
 *
 *   2. Dots - the screen is a grid of cells about 18 physical pixels across,
 *      each holding one plain rounded rectangle on black. The scene is shrunk
 *      to one pixel per cell and read back, so each dot knows how much of the
 *      waveform's light falls on it, joined by a faint glow under the whole
 *      grid that follows the bass, so quiet passages sit dark and heavy ones
 *      make the screen breathe. A dot's total light picks its colour from a
 *      ramp: near-white at full strength, through the main colour, into a
 *      deeper and darker shade, and out to an unlit dot. As the trail fades its
 *      dots cool through that ramp, like phosphor afterglow.
 *
 *   3. Ripples - a dot's size is a little over its full size plus the sum of the
 *      waves passing through it, so even at rest the dots overlap. Broad waves flow out from the centre, like
 *      stones dropped in water, close enough that neighbouring waves always
 *      overlap, so the whole grid rolls outward and never sits flat. A kick
 *      starts a wave at once, so the waves bunch up with the drums; between
 *      kicks a quieter one follows at an uneven gap, so they never tick along
 *      like a metronome. Each wave also travels at a speed of its own, so a
 *      fast one can catch a slow one, swell the dots doubly as they cross, and
 *      pass it. Each wave takes its size from the kick drum as it
 *      leaves the centre: in silence the dots roll gently, just overlapping, and
 *      a kick swells them well past their cells, over their neighbours. No dot
 *      ever shrinks enough to let black show between them. The waves also act
 *      as lenses: under a wave each dot takes its light from a spot pulled
 *      toward the wave's crest, so the crest magnifies the picture and the
 *      waveform bends as the rings pass through it. The swell is huge
 *      down the middle of the screen and tapers away toward the left and right
 *      edges, where the waves only just ripple the dots.
 *
 * The dots are drawn by the graphics card, all of them in a single call, onto a
 * WebGL surface that is then laid onto the canvas: thousands of overlapping
 * rounded dots are far too many to draw one by one on a 2D canvas each frame.
 *
 * The colour drifts slowly round the hue wheel, as Reactor's does. Every so
 * often (gated by a cooldown) a bass hit also jumps the hue: sometimes the whole
 * screen recolours at once, and sometimes the new colour sweeps in over a
 * fraction of a second.
 *
 * @module app/components/audio/audio-outlet/visualizations/mosaic-visualization
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

/**
 * Places one dot: a unit square (aCorner, -0.5 to 0.5) scaled to the dot's
 * size this frame and centred on its cell. Bigger dots are given a nearer
 * depth, so the depth test puts them on top of their neighbours whatever
 * order they are drawn in. The dot reads its light from its own cell moved by
 * aWarp, which the waves bend like a lens.
 */
const DOT_VERTEX_SHADER: string = `
attribute vec2 aCorner;
attribute vec2 aCell;
attribute float aScale;
attribute vec2 aWarp;
uniform vec2 uCanvas;
uniform vec2 uOrigin;
uniform vec2 uGrid;
uniform float uPitch;
uniform float uSide;
uniform float uMaxScale;
varying vec2 vLocal;
varying vec2 vLightUv;
void main() {
  vec2 centre = uOrigin + (aCell + 0.5) * uPitch;
  vec2 clip = (centre + aCorner * uSide * aScale) / uCanvas * 2.0 - 1.0;
  float depth = 1.0 - 2.0 * clamp(aScale / uMaxScale, 0.0, 1.0);
  gl_Position = vec4(clip.x, -clip.y, depth * 0.999, 1.0);
  vLocal = aCorner;
  vLightUv = (aCell + 0.5 + aWarp) / uGrid;
}
`;

/**
 * Fills one dot: cuts its corners round, reads the light that falls on its
 * cell, adds the bass glow, and colours it from the afterglow ramp.
 */
const DOT_FRAGMENT_SHADER: string = `
precision mediump float;
varying vec2 vLocal;
varying vec2 vLightUv;
uniform sampler2D uLight;
uniform sampler2D uRamp;
uniform float uCorner;
uniform float uGlow;
void main() {
  vec2 inset = abs(vLocal) - vec2(0.5 - uCorner);
  if (length(max(inset, 0.0)) > uCorner) discard;
  float light = min(1.0, texture2D(uLight, vLightUv).r + uGlow);
  float rampStep = floor(light * 255.0);
  gl_FragColor = vec4(texture2D(uRamp, vec2((rampStep + 0.5) / 256.0, 0.5)).rgb, 1.0);
}
`;

/** The uniforms the dot program reads. */
const DOT_UNIFORMS: readonly string[] = [
  'uCanvas', 'uOrigin', 'uGrid', 'uPitch', 'uSide', 'uMaxScale', 'uLight', 'uRamp', 'uCorner', 'uGlow',
];

/**
 * Mosaic visualization: a mirrored waveform bleeding away, shown on a grid of
 * rounded dots that each light up with the waveform beneath them.
 */
export class MosaicVisualization extends Canvas2DVisualization {
  // --- Dots ---------------------------------------------------------------

  /** Target dot pitch, in physical (device) pixels. */
  private static readonly TILE_PHYSICAL_SIZE: number = 18;

  /** Smallest dot pitch allowed, in canvas pixels. */
  private static readonly MIN_TILE_SIZE: number = 6;

  /** Gap left around a dot of size 1, as a fraction of the pitch. */
  private static readonly GAP_FRACTION: number = 0.1;

  /** Corner radius as a fraction of the dot's side. */
  private static readonly CORNER_FRACTION: number = 0.22;

  /**
   * How brightly the waveform excites the dots beneath it.
   *
   * Averaged over a whole dot, a line only lights part of it, so the light is
   * boosted to bring a dot the waveform crosses up to full brightness.
   */
  private static readonly DOT_GAIN: number = 2.2;

  /**
   * Most dots drawn in a frame. Every dot is sized each frame, so on extremely
   * large screens the dots grow past their target size rather than let the
   * count run away.
   */
  private static readonly MAX_DOTS: number = 40_000;

  /** Half the side of the unit square every dot is drawn from, centred on its cell. */
  private static readonly HALF_SQUARE: number = 0.5;

  /**
   * How strongly the waves bend the picture like lenses: a dot takes its light
   * from this many dots toward the nearest crest per unit of the swell's slope
   * (scaled, like the swell, by how far across the screen the dot is). A full
   * kick's wave moves the light about eighteen dots down the middle of the screen.
   */
  private static readonly LENS_STRENGTH: number = 80;

  /** Resolution of the per-frame table of wave swell by distance, in dots. */
  private static readonly FIELD_STEP: number = 0.1;

  // --- Afterglow colour ramp ------------------------------------------------

  /** Light (0-1) at which a dot shows the deep shade. */
  private static readonly DEEP_STOP: number = 0.3;

  /** Light (0-1) at which a dot shows the main colour. */
  private static readonly MAIN_STOP: number = 0.65;

  /** How far round the hue wheel the deep shade sits from the main colour (degrees). */
  private static readonly DEEP_HUE_SHIFT: number = 40;

  /** Saturation and lightness of the deep shade (percent). */
  private static readonly DEEP_SATURATION: number = 85;
  private static readonly DEEP_LIGHTNESS: number = 20;

  /** Saturation and lightness of the main colour (percent). */
  private static readonly MAIN_SATURATION: number = 85;
  private static readonly MAIN_LIGHTNESS: number = 55;

  /** Saturation and lightness of a fully lit, near-white dot (percent). */
  private static readonly HOT_SATURATION: number = 100;
  private static readonly HOT_LIGHTNESS: number = 92;

  /** Steps in the colour ramp, one per byte of light. */
  private static readonly RAMP_STEPS: number = 256;

  // --- Bass glow ------------------------------------------------------------

  /** Light the glow adds to every dot at full bass (0-1). */
  private static readonly GLOW_AMOUNT: number = 0.3;

  /** How fast the glow follows the bass up and lets it go (fraction per frame). */
  private static readonly GLOW_ATTACK: number = 0.3;
  private static readonly GLOW_RELEASE: number = 0.03;

  // --- Bass ripples --------------------------------------------------------

  /**
   * Ripples that can be spreading at once; a new one replaces the furthest out.
   * Enough for kicks RING_MIN_SPACING apart to fill a 4K screen.
   */
  private static readonly MAX_RINGS: number = 32;

  /**
   * Closest a kick may start a ripple behind the last one, in dots. Kicks
   * closer together than this would merge into one swelling.
   */
  private static readonly RING_MIN_SPACING: number = 6;

  /**
   * Range of gaps, in dots, after which a quieter ripple follows when no kick
   * has started one; a fresh gap is picked at random each time. With RING_WIDTH
   * at half the shortest, neighbours always overlap enough that no dot is left
   * out of a wave.
   */
  private static readonly RING_FILL_SPACING_MIN: number = 10;
  private static readonly RING_FILL_SPACING_MAX: number = 14;

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
   * How fast the kick envelope follows the kick up and lets it go (fraction
   * per frame). It rises at once and fades over about a second, so a kick
   * landing between two ripples still swells the next one.
   */
  private static readonly KICK_ATTACK: number = 1;
  private static readonly KICK_RELEASE: number = 0.03;

  /** Strength (0-1) of a ripple that leaves the centre in silence, so the waves never stop. */
  private static readonly RING_MIN_STRENGTH: number = 0.25;

  /** Frames a ripple at the usual speed takes to reach the corners (about four seconds). */
  private static readonly RING_FRAMES: number = 240;

  /**
   * Range of speeds a ripple may travel at, as multiples of the usual speed;
   * each picks one at random as it starts, so a fast one can catch and pass a
   * slow one.
   */
  private static readonly RING_SPEED_MIN: number = 0.5;
  private static readonly RING_SPEED_MAX: number = 1.5;

  /** Half-width of a ripple, in dots. */
  private static readonly RING_WIDTH: number = 6;

  /**
   * Smallest a dot gets, between the waves, as a fraction of a dot that just
   * fills its cell (less the gap). Over 1/(1 - GAP_FRACTION), so even at rest
   * every dot overlaps its neighbours and no black shows between them.
   */
  private static readonly DOT_FLOOR: number = 1.2;

  /**
   * How much a full-strength crest adds to a dot's size, on top of DOT_FLOOR,
   * as a fraction of a dot that just fills its cell.
   */
  private static readonly RING_SIZE: number = 2.2;

  /**
   * How strongly a wave swells a dot, by how far across the screen the dot is:
   * CENTRE_MAGNIFY times RING_SIZE down the middle, easing to EDGE_MAGNIFY
   * times it at the left and right edges. The ease is squared, so the swell
   * falls away quickly from the middle and tapers off toward the sides.
   */
  private static readonly CENTRE_MAGNIFY: number = 1.6;
  private static readonly EDGE_MAGNIFY: number = 0.25;

  /** Widths a ripple travels beyond the corners before it is dropped, its tail long gone. */
  private static readonly RING_TAIL: number = 3;

  // --- Waveform -------------------------------------------------------------

  /** Samples per half waveform (edge to centre). */
  private static readonly HALF_SAMPLES: number = 48;

  /** Waveform amplitude as a fraction of screen height. */
  private static readonly AMP_FRACTION: number = 0.45;

  /** Width of the glow stroke as a fraction of screen height. */
  private static readonly GLOW_WIDTH_FRACTION: number = 0.035;

  /** Width of the main stroke as a fraction of screen height. */
  private static readonly MAIN_WIDTH_FRACTION: number = 0.012;

  /** Width of the highlight stroke as a fraction of screen height. */
  private static readonly HIGHLIGHT_WIDTH_FRACTION: number = 0.004;

  /**
   * Stroke colours of the waveform. The scene only carries light, so it is
   * drawn in white; the dots give it its colour.
   */
  private static readonly COLOR_GLOW: string = 'rgba(255, 255, 255, 0.35)';
  private static readonly COLOR_MAIN: string = 'rgba(255, 255, 255, 0.75)';
  private static readonly COLOR_HIGHLIGHT: string = 'rgb(255, 255, 255)';

  // --- Trail (bleed / fade / distort) ---------------------------------------

  /**
   * Most pixels the half-width trail may hold. 320x360, half of 640x360.
   *
   * The dots only ever show the scene averaged over each cell, so it
   * renders small and is sampled up; that keeps the per-frame stretch and blur
   * cheap whatever the display size.
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

  /**
   * Per-frame rise of the left half's trail, as a fraction of height. The right
   * half is its flipped copy, so its trail sinks by the same amount.
   */
  private static readonly RISE_FRACTION: number = 0.004;

  /** Per-frame fade of the trail (low = long-lived trails). */
  private static readonly TRAIL_FADE: number = 0.035;

  /** Blur applied to the trail each frame, in trail pixels. */
  private static readonly TRAIL_BLUR: number = 1;

  // --- Colour cycling -------------------------------------------------------

  /** Per-frame hue drift (degrees). */
  private static readonly HUE_CYCLE_SPEED: number = 0.05;

  /** Starting hue (degrees) - blue, matching Reactor. */
  private static readonly START_HUE: number = 220;

  /** Saturation and lightness of an unlit dot (percent). */
  private static readonly BACKGROUND_SATURATION: number = 80;
  private static readonly BACKGROUND_LIGHTNESS: number = 5;

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

  /** Per-frame progress of a sweeping hue change (0.05 = twenty frames). */
  private static readonly HUE_SWEEP_RATE: number = 0.05;

  public readonly name: string = 'Mosaic';
  public readonly category: string = 'Signature';

  /** The dots stay crisp; the scene beneath them is soft by design. */
  public override readonly rendersAtNativeResolution: boolean = true;

  // --- State ----------------------------------------------------------------

  /** Time-domain audio buffer (for the waveform). */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Frequency-domain audio buffer (for the bass trigger). */
  private freqArray: Uint8Array<ArrayBuffer>;

  /** Hue the scene is heading for (degrees). */
  private hue: number;

  /** Hue a sweeping change started from (degrees). */
  private sweepFromHue: number = 0;

  /** Progress of a sweeping hue change: 0 (just started) to 1 (done). */
  private sweep: number = 1;

  /** Integer hue the colour ramp was built for (-1 = unbuilt). */
  private cachedHue: number = -1;

  /** The afterglow colour ramp: RGB for each byte of light, unlit to near-white. */
  private readonly ramp: Uint8ClampedArray = new Uint8ClampedArray(MosaicVisualization.RAMP_STEPS * 3);

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

  /** How far the last ripple must travel before a quieter one follows it, in dots. */
  private fillSpacing: number = MosaicVisualization.RING_FILL_SPACING_MIN;

  /** The bass glow, following the bass level (0-1). */
  private glowLevel: number = 0;

  /** Radius of each ripple's crest, in dots; negative when the slot is free. */
  private readonly rings: Float32Array = new Float32Array(MosaicVisualization.MAX_RINGS).fill(-1);

  /** Strength of each ripple (0-1), fixed from the kick as it left the centre. */
  private readonly ringStrengths: Float32Array = new Float32Array(MosaicVisualization.MAX_RINGS);

  /** Speed of each ripple, as a multiple of the usual speed. */
  private readonly ringSpeeds: Float32Array = new Float32Array(MosaicVisualization.MAX_RINGS);

  /** Phase of the trail ripple (radians). */
  private ripplePhase: number = 0;

  /** +1 while the left half rises and the right sinks, -1 the other way round; flipped by each bass trigger. */
  private riseDirection: number = 1;

  /** Pre-allocated points of the left half of the waveform (avoids per-frame allocation). */
  private readonly points: Point[];

  /** Dot grid, recomputed on resize. */
  private tileSize: number = 0;
  private columns: number = 0;
  private rows: number = 0;
  private originX: number = 0;
  private originY: number = 0;

  /** Each dot's distance from the centre, in dots, and the furthest of them. */
  private dotDistance: Float32Array = new Float32Array(0);
  private maxDistance: number = 0;

  /** Each dot's size this frame, as a multiple of a dot that just fills its cell. */
  private dotScale: Float32Array = new Float32Array(0);

  /** How strongly the waves swell each dot, by how far across the screen it is. */
  private dotMagnify: Float32Array = new Float32Array(0);

  /** Each dot's direction out from the centre, as x and y; zero for a dot on the centre. */
  private dotOutward: Float32Array = new Float32Array(0);

  /** How far each dot's light is moved this frame by the lenses, as x and y, in dots. */
  private dotWarp: Float32Array = new Float32Array(0);

  /** Each dot's slot in the swell-by-distance table. */
  private dotBin: Uint32Array = new Uint32Array(0);

  /** The waves' combined swell at each distance from the centre, rebuilt each frame. */
  private field: Float32Array = new Float32Array(0);

  /** Side of a dot of size 1, in canvas pixels. */
  private dotSide: number = 0;

  // --- Graphics card --------------------------------------------------------

  /** The WebGL surface the dots are drawn on, laid onto the canvas each frame. */
  private readonly glCanvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;

  /** Draws many copies of one shape in a single call. */
  private readonly instancing: ANGLE_instanced_arrays;

  /** The dot program, its uniforms and its attributes. */
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly cornerAttribute: number;
  private readonly cellAttribute: number;
  private readonly scaleAttribute: number;
  private readonly warpAttribute: number;

  /** The unit square every dot is drawn from, each dot's cell, size and lens warp. */
  private readonly cornerBuffer: WebGLBuffer;
  private readonly cellBuffer: WebGLBuffer;
  private readonly scaleBuffer: WebGLBuffer;
  private readonly warpBuffer: WebGLBuffer;

  /** The light falling on each dot, and the afterglow ramp. */
  private readonly lightTexture: WebGLTexture;
  private readonly rampTexture: WebGLTexture;

  /** Set once destroy() runs so a trailing frame cannot resurrect the surfaces. */
  private destroyed: boolean = false;

  /** Half-width trail surface the left half of the waveform is drawn onto and bled away on. */
  private sceneCanvas: HTMLCanvasElement | null = null;
  private sceneCtx: CanvasRenderingContext2D | null = null;

  /** Scratch surface used while bleeding the trail. */
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;

  /** The scene shrunk to one pixel per dot, handed to the graphics card each frame. */
  private dotsCanvas: HTMLCanvasElement | null = null;
  private dotsCtx: CanvasRenderingContext2D | null = null;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.hue = MosaicVisualization.START_HUE;
    this.points = MosaicVisualization.allocatePoints(MosaicVisualization.HALF_SAMPLES);

    this.glCanvas = document.createElement('canvas');
    const gl: WebGLRenderingContext | null = this.glCanvas.getContext('webgl', {alpha: false, antialias: false});
    if (!gl) throw new Error('Failed to get WebGL context');
    this.gl = gl;
    const instancing: ANGLE_instanced_arrays | null = gl.getExtension('ANGLE_instanced_arrays');
    if (!instancing) throw new Error('WebGL instanced drawing is not available');
    this.instancing = instancing;

    this.program = this.createProgram(DOT_VERTEX_SHADER, DOT_FRAGMENT_SHADER);
    for (const name of DOT_UNIFORMS) this.uniforms[name] = gl.getUniformLocation(this.program, name);
    this.cornerAttribute = gl.getAttribLocation(this.program, 'aCorner');
    this.cellAttribute = gl.getAttribLocation(this.program, 'aCell');
    this.scaleAttribute = gl.getAttribLocation(this.program, 'aScale');
    this.warpAttribute = gl.getAttribLocation(this.program, 'aWarp');

    this.cornerBuffer = this.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    // The unit square's corners, in triangle-strip order.
    const h: number = MosaicVisualization.HALF_SQUARE;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-h, -h, h, -h, -h, h, h, h]), gl.STATIC_DRAW);
    this.cellBuffer = this.createBuffer();
    this.scaleBuffer = this.createBuffer();
    this.warpBuffer = this.createBuffer();
    // The light is read smoothly, so a lens can pull it from between two dots.
    this.lightTexture = this.createTexture(gl.LINEAR);
    this.rampTexture = this.createTexture(gl.NEAREST);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }

  public override draw(): void {
    if (this.destroyed) return;
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    if (width <= 0 || height <= 0) return;

    if (!this.sceneCanvas || !this.scratchCanvas || !this.dotsCanvas) this.onResize();
    if (!this.sceneCtx || !this.scratchCtx || !this.dotsCtx) return;

    // Advance time-based state. A bass hit may start a ring and jump the hue.
    this.updateAudio();
    this.hue = (this.hue + MosaicVisualization.HUE_CYCLE_SPEED) % 360;
    this.sweepFromHue = (this.sweepFromHue + MosaicVisualization.HUE_CYCLE_SPEED) % 360;
    if (this.sweep < 1) this.sweep = Math.min(1, this.sweep + MosaicVisualization.HUE_SWEEP_RATE);
    this.updateColors();
    this.ripplePhase += MosaicVisualization.RIPPLE_SPEED;
    this.advanceRings();

    this.analyser.getByteTimeDomainData(this.dataArray);

    // Age the scene, then lay the fresh waveform over it.
    this.bleedTrail();
    this.drawWaveform(this.sceneCtx);

    // Light each dot with the scene beneath it, have the graphics card draw
    // every dot on black at the size the waves give it, and lay that down.
    this.exciteDots(this.dotsCtx);
    this.renderDots();
    ctx.drawImage(this.glCanvas, 0, 0);

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

    if (!this.sceneCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.sceneCanvas = offscreen.canvas;
      this.sceneCtx = offscreen.ctx;
    }
    if (!this.scratchCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.scratchCanvas = offscreen.canvas;
      this.scratchCtx = offscreen.ctx;
    }
    if (!this.dotsCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.dotsCanvas = offscreen.canvas;
      this.dotsCtx = offscreen.ctx;
    }
    if (this.glCanvas.width !== width || this.glCanvas.height !== height) {
      this.glCanvas.width = width;
      this.glCanvas.height = height;
    }

    // The scene holds only the left half, at no more than its pixel budget,
    // and is drawn into in canvas coordinates through a transform.
    const halfWidth: number = width / 2;
    const scene: {width: number; height: number} =
      this.getSurfaceSize(Math.ceil(halfWidth), height, MosaicVisualization.HALF_PIXEL_BUDGET);
    if (this.sceneCanvas.width !== scene.width || this.sceneCanvas.height !== scene.height) {
      this.sceneCanvas.width = scene.width;
      this.sceneCanvas.height = scene.height;
      this.scratchCanvas.width = scene.width;
      this.scratchCanvas.height = scene.height;
    }
    this.applySurfaceTransform(this.sceneCtx!, halfWidth, height);

    this.layoutTiles(width, height);
    if (this.dotsCanvas.width !== this.columns || this.dotsCanvas.height !== this.rows) {
      this.dotsCanvas.width = this.columns;
      this.dotsCanvas.height = this.rows;
    }
    this.uploadCells();
    this.seedRings();
    this.ctx.clearRect(0, 0, width, height);
  }

  // === Dots =================================================================

  /**
   * How many canvas pixels make up one physical pixel.
   *
   * The canvas is sized in CSS pixels at most, and may be smaller still, so a
   * canvas pixel covers devicePixelRatio physical pixels or more.
   *
   * @param width - Canvas width
   * @returns Canvas pixels per physical pixel
   */
  private canvasPixelsPerPhysicalPixel(width: number): number {
    const dpr: number = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const cssWidth: number = this.canvas.clientWidth > 0 ? this.canvas.clientWidth : width;
    return width / (cssWidth * dpr);
  }

  /**
   * Lays the dots out as a grid centred on the canvas, so any partial dots at
   * the edges are cut evenly on both sides.
   */
  private layoutTiles(width: number, height: number): void {
    let pitch: number = MosaicVisualization.TILE_PHYSICAL_SIZE * this.canvasPixelsPerPhysicalPixel(width);
    if (!Number.isFinite(pitch) || pitch < MosaicVisualization.MIN_TILE_SIZE) pitch = MosaicVisualization.MIN_TILE_SIZE;
    const estimate: number = Math.ceil(width / pitch) * Math.ceil(height / pitch);
    if (estimate > MosaicVisualization.MAX_DOTS) pitch *= Math.sqrt(estimate / MosaicVisualization.MAX_DOTS);

    this.tileSize = pitch;
    this.columns = Math.ceil(width / pitch);
    this.rows = Math.ceil(height / pitch);
    this.originX = (width - this.columns * pitch) / 2;
    this.originY = (height - this.rows * pitch) / 2;

    // Distance of each dot's middle from the canvas centre, in dots.
    const centreX: number = (width / 2 - this.originX) / pitch;
    const centreY: number = (height / 2 - this.originY) / pitch;
    const count: number = this.columns * this.rows;
    this.dotDistance = new Float32Array(count);
    this.dotScale = new Float32Array(count);
    this.dotMagnify = new Float32Array(count);
    this.dotOutward = new Float32Array(count * 2);
    this.dotWarp = new Float32Array(count * 2);
    this.dotBin = new Uint32Array(count);
    const gap: number = Math.max(1, pitch * MosaicVisualization.GAP_FRACTION);
    this.dotSide = pitch - gap;
    this.maxDistance = 0;
    for (let row: number = 0; row < this.rows; row++) {
      for (let column: number = 0; column < this.columns; column++) {
        const distance: number = Math.hypot(column + 0.5 - centreX, row + 0.5 - centreY);
        this.dotDistance[row * this.columns + column] = distance;
        if (distance > 0) {
          this.dotOutward[(row * this.columns + column) * 2] = (column + 0.5 - centreX) / distance;
          this.dotOutward[(row * this.columns + column) * 2 + 1] = (row + 0.5 - centreY) / distance;
        }
        // 1 down the middle, 0 at the left and right edges of the screen.
        const across: number = Math.max(0, 1 - Math.abs(column + 0.5 - centreX) / (width / 2 / pitch));
        this.dotMagnify[row * this.columns + column] = MosaicVisualization.EDGE_MAGNIFY
          + (MosaicVisualization.CENTRE_MAGNIFY - MosaicVisualization.EDGE_MAGNIFY) * across * across;
        if (distance > this.maxDistance) this.maxDistance = distance;
      }
    }
    for (let i: number = 0; i < count; i++) {
      this.dotBin[i] = Math.round(this.dotDistance[i] / MosaicVisualization.FIELD_STEP);
    }
    this.field = new Float32Array(Math.ceil(this.maxDistance / MosaicVisualization.FIELD_STEP) + 2);
  }

  /**
   * Shrinks the scene onto the dot surface, one pixel per dot, so each dot
   * holds the light of the scene across its cell. The half-width trail fills
   * the left half, then is drawn again rotated through the centre - flipped
   * horizontally and vertically - to fill the right. The light is added over
   * black, boosted so a dot the waveform crosses reads as fully lit.
   */
  private exciteDots(ctx: CanvasRenderingContext2D): void {
    const pitch: number = this.tileSize;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgb(0, 0, 0)';
    ctx.fillRect(0, 0, this.columns, this.rows);
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `brightness(${MosaicVisualization.DOT_GAIN})`;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const x: number = -this.originX / pitch;
    const y: number = -this.originY / pitch;
    const halfWidth: number = this.width / 2 / pitch;
    const height: number = this.height / pitch;
    ctx.drawImage(this.sceneCanvas!, x, y, halfWidth, height);
    // The canvas centre, in dot coordinates, doubled: the point reflection
    // through it maps p to 2c - p.
    ctx.translate((x + halfWidth) * 2, (y + height / 2) * 2);
    ctx.scale(-1, -1);
    ctx.drawImage(this.sceneCanvas!, x, y, halfWidth, height);
    ctx.restore();
  }

  /**
   * Draws every dot on black, in a single call: the light texture is refreshed
   * from the dot surface, each dot's size this frame is handed over, and the
   * graphics card rounds, colours and stacks the dots.
   */
  private renderDots(): void {
    const gl: WebGLRenderingContext = this.gl;
    const count: number = this.columns * this.rows;
    const maxScale: number = this.measureDots();

    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lightTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.dotsCanvas!);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    if (this.rampDirty) {
      const bytes: Uint8Array = new Uint8Array(this.ramp.buffer);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, MosaicVisualization.RAMP_STEPS, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes);
      this.rampDirty = false;
    }

    const u: Record<string, WebGLUniformLocation | null> = this.uniforms;
    gl.uniform2f(u['uCanvas'], this.width, this.height);
    gl.uniform2f(u['uOrigin'], this.originX, this.originY);
    gl.uniform2f(u['uGrid'], this.columns, this.rows);
    gl.uniform1f(u['uPitch'], this.tileSize);
    gl.uniform1f(u['uSide'], this.dotSide);
    gl.uniform1f(u['uMaxScale'], maxScale);
    gl.uniform1i(u['uLight'], 0);
    gl.uniform1i(u['uRamp'], 1);
    gl.uniform1f(u['uCorner'], MosaicVisualization.CORNER_FRACTION);
    gl.uniform1f(u['uGlow'], MosaicVisualization.GLOW_AMOUNT * this.glowLevel * this.glowLevel);

    this.bindAttribute(this.cornerBuffer, this.cornerAttribute, 2, 0);
    this.bindAttribute(this.cellBuffer, this.cellAttribute, 2, 1);
    this.bindAttribute(this.scaleBuffer, this.scaleAttribute, 1, 1);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dotScale);
    this.bindAttribute(this.warpBuffer, this.warpAttribute, 2, 1);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dotWarp);

    this.instancing.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, count);
  }

  /**
   * Points an attribute at a buffer, stepping once per corner (0) or once per
   * dot (1), and leaves the buffer bound.
   */
  private bindAttribute(buffer: WebGLBuffer, attribute: number, size: number, perDot: number): void {
    const gl: WebGLRenderingContext = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, 0, 0);
    this.instancing.vertexAttribDivisorANGLE(attribute, perDot);
  }

  /** Hands the graphics card every dot's cell, and room for every dot's size and warp. */
  private uploadCells(): void {
    const gl: WebGLRenderingContext = this.gl;
    const count: number = this.columns * this.rows;
    const cells: Float32Array = new Float32Array(count * 2);
    for (let i: number = 0; i < count; i++) {
      cells[i * 2] = i % this.columns;
      cells[i * 2 + 1] = (i / this.columns) | 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, cells, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.scaleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.dotScale.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.warpBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.dotWarp.byteLength, gl.DYNAMIC_DRAW);
  }

  /**
   * Works out every dot's size and lens warp. A wave's swell depends only on
   * distance from the centre, so the waves are summed once into a table by
   * distance, and each dot reads its distance's entry.
   *
   * The lens pulls a dot's light along the swell's slope: toward a crest from
   * either side, so the crest is magnified. The slope is read from the table
   * as the difference between the entries either side of the dot's.
   *
   * @returns The biggest dot's size, to spread the depths across
   */
  private measureDots(): number {
    this.buildField();
    const scales: Float32Array = this.dotScale;
    const field: Float32Array = this.field;
    const bins: Uint32Array = this.dotBin;
    const magnify: Float32Array = this.dotMagnify;
    const outward: Float32Array = this.dotOutward;
    const warp: Float32Array = this.dotWarp;
    const floor: number = MosaicVisualization.DOT_FLOOR;
    const size: number = MosaicVisualization.RING_SIZE;
    const lens: number = MosaicVisualization.LENS_STRENGTH / (2 * MosaicVisualization.FIELD_STEP);
    const last: number = field.length - 1;
    let max: number = floor;
    for (let i: number = 0; i < scales.length; i++) {
      const bin: number = bins[i];
      const scale: number = floor + field[bin] * size * magnify[i];
      scales[i] = scale;
      if (scale > max) max = scale;
      const slope: number = field[bin < last ? bin + 1 : last] - field[bin > 0 ? bin - 1 : 0];
      const pull: number = slope * lens * magnify[i];
      warp[i * 2] = outward[i * 2] * pull;
      warp[i * 2 + 1] = outward[i * 2 + 1] * pull;
    }
    return max;
  }

  /** Sums every wave's swell into the table by distance from the centre. */
  private buildField(): void {
    const field: Float32Array = this.field;
    const step: number = MosaicVisualization.FIELD_STEP;
    const width: number = MosaicVisualization.RING_WIDTH;
    // Past three widths a ripple's swell is under a thousandth: leave it out.
    const reach: number = 3 * width;
    field.fill(0);
    for (let r: number = 0; r < MosaicVisualization.MAX_RINGS; r++) {
      const radius: number = this.rings[r];
      if (radius < 0) continue;
      // Eases in over its first width, so a new wave does not pop at the centre.
      const easeIn: number = radius < width ? radius / width : 1;
      const strength: number = this.ringStrengths[r] * easeIn;
      const first: number = Math.max(0, Math.ceil((radius - reach) / step));
      const last: number = Math.min(field.length - 1, Math.floor((radius + reach) / step));
      for (let b: number = first; b <= last; b++) {
        const offset: number = (b * step - radius) / width;
        field[b] += strength * Math.exp(-offset * offset);
      }
    }
  }

  /** How far out a ripple travels before it is dropped, in dots. */
  private ringLimit(): number {
    return this.maxDistance + MosaicVisualization.RING_TAIL * MosaicVisualization.RING_WIDTH;
  }

  /**
   * Fills the screen with quiet waves at uneven gaps, so it starts out rolling
   * rather than waiting for the first waves to spread.
   */
  private seedRings(): void {
    this.rings.fill(-1);
    const limit: number = this.ringLimit();
    let radius: number = 0;
    for (let r: number = 0; r < MosaicVisualization.MAX_RINGS && radius <= limit; r++) {
      this.rings[r] = radius;
      this.ringStrengths[r] = MosaicVisualization.RING_MIN_STRENGTH;
      this.ringSpeeds[r] = this.pickRingSpeed();
      const gap: number = this.pickFillSpacing();
      // The gap behind the innermost is the one the next quiet ripple waits for.
      if (r === 0) this.fillSpacing = gap;
      radius += gap;
    }
  }

  /** A random speed, as a multiple of the usual one, between RING_SPEED_MIN and RING_SPEED_MAX. */
  private pickRingSpeed(): number {
    const range: number = MosaicVisualization.RING_SPEED_MAX - MosaicVisualization.RING_SPEED_MIN;
    return MosaicVisualization.RING_SPEED_MIN + Math.random() * range;
  }

  /** A random gap, in dots, between RING_FILL_SPACING_MIN and RING_FILL_SPACING_MAX. */
  private pickFillSpacing(): number {
    const range: number = MosaicVisualization.RING_FILL_SPACING_MAX - MosaicVisualization.RING_FILL_SPACING_MIN;
    return MosaicVisualization.RING_FILL_SPACING_MIN + Math.random() * range;
  }

  /** Moves every ripple outward, freeing the slots of those past the corners. */
  private advanceRings(): void {
    const speed: number = this.maxDistance / MosaicVisualization.RING_FRAMES;
    const limit: number = this.ringLimit();
    for (let r: number = 0; r < MosaicVisualization.MAX_RINGS; r++) {
      if (this.rings[r] < 0) continue;
      this.rings[r] += speed * this.ringSpeeds[r];
      if (this.rings[r] > limit) this.rings[r] = -1;
    }
  }

  /** How far the youngest ripple has travelled, in dots; infinite when there are none. */
  private newestRingRadius(): number {
    let newest: number = Number.POSITIVE_INFINITY;
    for (let r: number = 0; r < MosaicVisualization.MAX_RINGS; r++) {
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
    for (let r: number = 0; r < MosaicVisualization.MAX_RINGS; r++) {
      if (this.rings[r] < 0) { slot = r; break; }
      if (this.rings[r] > this.rings[slot]) slot = r;
    }
    this.rings[slot] = 0;
    this.ringStrengths[slot] = MosaicVisualization.RING_MIN_STRENGTH
      + (1 - MosaicVisualization.RING_MIN_STRENGTH) * this.kickEnvelope;
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
   * Creates a texture clamped at its edges, so it may be any size.
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
   * faded and blurred in vertical strips; each strip is lifted straight up,
   * pushed away from the centre (the surface's right edge), and spread and
   * rippled up or down in proportion to its distance from the centre, so the
   * waveform bleeds, fades and distorts away up and out. The right half is the
   * flipped copy, so its trail sinks and spreads away the other way.
   */
  private bleedTrail(): void {
    const scene: HTMLCanvasElement = this.sceneCanvas!;
    const ctx: CanvasRenderingContext2D = this.sceneCtx!;
    const scratch: HTMLCanvasElement = this.scratchCanvas!;
    const width: number = scene.width;
    const height: number = scene.height;
    const columns: number = MosaicVisualization.BLEED_COLUMNS;
    const columnWidth: number = width / columns;
    const stretch: number = MosaicVisualization.BLEED_STRETCH;
    const rise: number = -height * MosaicVisualization.RISE_FRACTION * this.riseDirection;

    this.copySurface(this.scratchCtx!, scene);

    // Work in the surface's own pixels while redrawing it from the scratch.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = 1 - MosaicVisualization.TRAIL_FADE;
    ctx.filter = `blur(${MosaicVisualization.TRAIL_BLUR}px)`;
    ctx.imageSmoothingEnabled = true;
    for (let c: number = 0; c < columns; c++) {
      const sourceX: number = c * columnWidth;
      // 0 at the centre (the right edge), 1 at the outer edge.
      const reach: number = (width - sourceX - columnWidth / 2) / width;
      const spread: number = height * MosaicVisualization.BLEED_SPREAD * reach;
      const ripple: number = Math.sin(this.ripplePhase + c * MosaicVisualization.RIPPLE_STEP)
        * height * MosaicVisualization.BLEED_RIPPLE * reach;
      const targetX: number = width + (sourceX - width) * stretch;
      ctx.drawImage(
        scratch,
        sourceX, 0, columnWidth, height,
        targetX, -spread / 2 + ripple + rise, columnWidth * stretch, height + spread
      );
    }
    ctx.restore();
  }

  /** Draws the left half of the waveform onto the scene, from the left edge to the centre. */
  private drawWaveform(ctx: CanvasRenderingContext2D): void {
    this.calculatePoints();
    const height: number = this.height;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.strokeWave(ctx, MosaicVisualization.COLOR_GLOW, height * MosaicVisualization.GLOW_WIDTH_FRACTION);
    this.strokeWave(ctx, MosaicVisualization.COLOR_MAIN, height * MosaicVisualization.MAIN_WIDTH_FRACTION);
    this.strokeWave(ctx, MosaicVisualization.COLOR_HIGHLIGHT, height * MosaicVisualization.HIGHLIGHT_WIDTH_FRACTION);
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
    const samples: number = MosaicVisualization.HALF_SAMPLES;
    const centreX: number = this.width / 2;
    const centreY: number = this.height / 2;
    const amplitude: number = this.height * MosaicVisualization.AMP_FRACTION;
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
   *   reverses which side's trail rises and jumps the hue. Some jumps recolour
   *   everything at once; the rest sweep the new colour in over a fraction of a
   *   second.
   */
  private updateAudio(): void {
    // Seed the cooldown on the first frame so the first hue jump is held off for a
    // full cooldown rather than firing almost immediately when play starts.
    if (this.lastBassTriggerTime === Number.NEGATIVE_INFINITY) {
      this.lastBassTriggerTime = performance.now();
    }

    this.analyser.getByteFrequencyData(this.freqArray);

    const binCount: number = this.freqArray.length;
    const bassBins: number = Math.max(1, (binCount * MosaicVisualization.BASS_BIN_FRACTION) | 0);
    let sum: number = 0;
    for (let b: number = 0; b < bassBins; b++) sum += this.freqArray[b];
    const bassLevel: number = sum / bassBins / 255;

    const follow: number = bassLevel > this.glowLevel ? MosaicVisualization.GLOW_ATTACK : MosaicVisualization.GLOW_RELEASE;
    this.glowLevel += (bassLevel - this.glowLevel) * follow;

    const kickLevel: number = this.kickLevel();
    const kickFollow: number = kickLevel > this.kickEnvelope ? MosaicVisualization.KICK_ATTACK : MosaicVisualization.KICK_RELEASE;
    this.kickEnvelope += (kickLevel - this.kickEnvelope) * kickFollow;
    const kick: boolean = kickLevel > this.previousKick
      && kickLevel >= this.kickAverage + MosaicVisualization.ONSET_MARGIN
      && kickLevel >= MosaicVisualization.ONSET_FLOOR;
    this.previousKick = kickLevel;
    this.kickAverage += (kickLevel - this.kickAverage) * MosaicVisualization.KICK_AVERAGE_RATE;
    const newest: number = this.newestRingRadius();
    if ((kick && newest >= MosaicVisualization.RING_MIN_SPACING) || newest >= this.fillSpacing) {
      this.startRing();
      this.fillSpacing = this.pickFillSpacing();
    }

    const now: number = performance.now();
    if (bassLevel < MosaicVisualization.BASS_THRESHOLD) return;
    if (now - this.lastBassTriggerTime < MosaicVisualization.BASS_COOLDOWN_MS) return;
    this.lastBassTriggerTime = now;
    this.riseDirection = -this.riseDirection;

    const from: number = this.currentHue();
    this.hue = (this.hue + MosaicVisualization.HUE_JUMP_DEGREES) % 360;

    if (Math.random() < MosaicVisualization.SNAP_PROBABILITY) {
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
    const sampleRate: number = this.analyser.context?.sampleRate || MosaicVisualization.FALLBACK_SAMPLE_RATE;
    const binHz: number = sampleRate / (binCount * 2);
    const low: number = Math.min(binCount - 1, Math.floor(MosaicVisualization.KICK_LOW_HZ / binHz));
    const high: number = Math.min(binCount, Math.max(low + 1, Math.ceil(MosaicVisualization.KICK_HIGH_HZ / binHz)));
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
    if (delta > MosaicVisualization.HALF_TURN_DEGREES) delta -= 360;
    else if (delta < -MosaicVisualization.HALF_TURN_DEGREES) delta += 360;
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
      {at: 0, color: this.hslToRgb(hue, MosaicVisualization.BACKGROUND_SATURATION, MosaicVisualization.BACKGROUND_LIGHTNESS)},
      {
        at: MosaicVisualization.DEEP_STOP,
        color: this.hslToRgb(hue + MosaicVisualization.DEEP_HUE_SHIFT, MosaicVisualization.DEEP_SATURATION, MosaicVisualization.DEEP_LIGHTNESS),
      },
      {at: MosaicVisualization.MAIN_STOP, color: this.hslToRgb(hue, MosaicVisualization.MAIN_SATURATION, MosaicVisualization.MAIN_LIGHTNESS)},
      {at: 1, color: this.hslToRgb(hue, MosaicVisualization.HOT_SATURATION, MosaicVisualization.HOT_LIGHTNESS)},
    ];

    const top: number = MosaicVisualization.RAMP_STEPS - 1;
    let stop: number = 0;
    for (let step: number = 0; step <= top; step++) {
      const at: number = step / top;
      while (stop < stops.length - 2 && at > stops[stop + 1].at) stop++;
      const from: {at: number; color: Rgb} = stops[stop];
      const to: {at: number; color: Rgb} = stops[stop + 1];
      const t: number = (at - from.at) / (to.at - from.at);
      this.ramp[step * 3] = from.color.r + (to.color.r - from.color.r) * t;
      this.ramp[step * 3 + 1] = from.color.g + (to.color.g - from.color.g) * t;
      this.ramp[step * 3 + 2] = from.color.b + (to.color.b - from.color.b) * t;
    }
    this.rampDirty = true;
  }

  public override destroy(): void {
    this.destroyed = true;
    this.sceneCanvas = null;
    this.sceneCtx = null;
    this.scratchCanvas = null;
    this.scratchCtx = null;
    this.dotsCanvas = null;
    this.dotsCtx = null;
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
