/**
 * @fileoverview Alchemy visualization - a frame-feedback effect engine.
 *
 * A re-implementation, from behavioural analysis, of the effect engine behind
 * the Windows Media Player "Alchemy" visualization. Nothing here is derived
 * from Microsoft source or object code; only the observable structure of the
 * engine informed the design, and every line below is original.
 *
 * The original engine works like this:
 *
 * 1. It owns a small, fixed-size software surface - far smaller than the
 *    window - and renders everything into it.
 * 2. Each frame it feeds the *previous* frame back into the surface through a
 *    parameterised warp (zoom, rotate, translate, anisotropic stretch and a
 *    per-row sinusoidal displacement), attenuated slightly so old content
 *    decays.
 * 3. It then draws the oscilloscope trace on top, optionally kaleidoscoped
 *    into N rotational divisions and mirrored.
 * 4. Finally it stretches the small surface up to the window.
 *
 * Step 4 is why Alchemy looks soft and liquid rather than sharp: the whole
 * effect is computed at low resolution and upscaled. Step 2 is the heart of
 * it - the "smear" is not a blur, it is the previous frame redrawn slightly
 * transformed, so detail migrates across the surface over many frames.
 *
 * Crucially the original is *one* warp driven by a parameter block, not a set
 * of hand-written effects; its named presets are just different parameter
 * values. This implementation keeps that design: the engine lives in an
 * abstract base and each preset is a small subclass supplying only its
 * parameter block.
 *
 * The eleven presets below are the ones the original registers, read from its
 * string table (ids 101-110 and 115). The twelfth entry it lists, "Random", is
 * a cycler rather than a preset and so has no counterpart here.
 *
 * Technical details:
 * - Ping-pong pair of low-resolution offscreen surfaces for the feedback path
 * - Per-row displacement applied as horizontal strips (a scanline warp that an
 *   affine transform cannot express)
 * - Additive scope rendering with rotational divisions and optional mirroring
 *
 * @module app/components/audio/audio-outlet/visualizations/alchemy-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';
import {TWO_PI, HALF, RGB_MID, DEGREES_FULL_CIRCLE} from './visualization-constants';

// ============================================================================
// Surface
// ============================================================================

/**
 * Height, in pixels, of the internal feedback surface.
 *
 * The effect is computed at this height and upscaled to the canvas. Keeping it
 * low is not a performance compromise - it is what produces Alchemy's soft,
 * liquid look, and it makes the per-frame feedback cost independent of display
 * size.
 */
const SURFACE_HEIGHT: number = 400;

/** Widest the internal surface may get, for very wide aspect ratios. */
const SURFACE_MAX_WIDTH: number = 800;

/**
 * Maximum number of horizontal strips used for the per-row displacement.
 *
 * The original precomputed a displacement value per scanline. Drawing one
 * strip per scanline would mean hundreds of draw calls per frame, so rows are
 * grouped into at most this many strips - visually indistinguishable once the
 * surface is upscaled and smoothed.
 */
const MAX_WARP_STRIPS: number = 64;

// ============================================================================
// Feedback decay
// ============================================================================

/** Slow decay - long, heavy trails that fill the surface. */
const FALLOFF_LOW: number = 0.03;

/** Moderate decay - the default sense of motion. */
const FALLOFF_MID: number = 0.055;

/** Fast decay - short trails, the trace stays legible. */
const FALLOFF_HIGH: number = 0.085;

// ============================================================================
// Feedback zoom
// ============================================================================

/** No zoom; content stays put and only decays. */
const SCALE_HOLD: number = 1;

/** Barely-there outward drift. */
const SCALE_CREEP_OUT: number = 1.006;

/** Steady outward zoom - content flows off the edges. */
const SCALE_OUT: number = 1.014;

/** Aggressive outward zoom. */
const SCALE_OUT_FAST: number = 1.026;

/** Inward zoom - content is drawn toward the centre. */
const SCALE_IN: number = 0.99;

// ============================================================================
// Feedback anisotropy (the "Stretch" family)
// ============================================================================

/** Equal scaling on both axes. */
const STRETCH_EVEN: number = 1;

/** Horizontal exaggeration. */
const STRETCH_WIDE: number = 1.022;

/** Vertical compression. */
const STRETCH_NARROW: number = 0.985;

// ============================================================================
// Feedback rotation (the "Spin"/"SuperStar" family)
// ============================================================================

/** No rotation. */
const SPIN_STILL: number = 0;

/** Slow rotational drift. */
const SPIN_DRIFT: number = 0.0035;

/** Clear rotation - combined with zoom this produces spiral arms. */
const SPIN_TURN: number = 0.011;

/** Fast rotation. */
const SPIN_WHIRL: number = 0.024;

// ============================================================================
// Feedback translation (the "Shift"/"Push" family)
// ============================================================================

/** No translation. */
const SHIFT_STILL: number = 0;

/** Gentle directional push, in surface pixels per frame. */
const SHIFT_NUDGE: number = 0.7;

/** Strong directional push, in surface pixels per frame. */
const SHIFT_SLIDE: number = 1.6;

// ============================================================================
// Per-row displacement (the "WonderWave"/"Ocean" family)
// ============================================================================

/** No scanline displacement. */
const OCEAN_FLAT: number = 0;

/** Subtle scanline ripple, in surface pixels. */
const OCEAN_RIPPLE: number = 2;

/** Pronounced scanline swell, in surface pixels. */
const OCEAN_SWELL: number = 5;

/** Few wave cycles down the surface - long, lazy waves. */
const LOOPS_LONG: number = 1.5;

/** Many wave cycles down the surface - tight ripples. */
const LOOPS_SHORT: number = 3.5;

/** Slow wave phase advance per frame. */
const SHAKE_CALM: number = 0.018;

/** Fast wave phase advance per frame. */
const SHAKE_BRISK: number = 0.05;

// ============================================================================
// Soft smear
// ============================================================================

/** Smear disabled. */
const SMEAR_NONE: number = 0;

/** Light second-tap offset, in surface pixels. */
const SMEAR_SOFT: number = 0.8;

/** Heavy second-tap offset, in surface pixels. */
const SMEAR_HEAVY: number = 1.8;

/** Alpha of the smear tap relative to the main feedback draw. */
const SMEAR_TAP_ALPHA: number = 0.35;

// ============================================================================
// Audio response
// ============================================================================

/** Number of low-frequency bins averaged to derive the bass level. */
const BASS_BIN_COUNT: number = 24;

/** Bass does not affect the zoom. */
const BASS_JUMP_NONE: number = 0;

/** Bass adds a little extra zoom on each beat. */
const BASS_JUMP_SOFT: number = 0.025;

/** Bass punches the zoom hard on each beat. */
const BASS_JUMP_HARD: number = 0.07;

/** Trace amplitude is only mildly bass-driven. */
const BASS_FLEX_CALM: number = 0.3;

/** Trace amplitude swells strongly with bass. */
const BASS_FLEX_WILD: number = 0.85;

/** Smoothing applied to the bass envelope, per frame. */
const BASS_SMOOTHING: number = 0.18;

// ============================================================================
// Colour
// ============================================================================

/** Slow hue rotation, in degrees per frame. */
const HUE_DRIFT_SLOW: number = 0.15;

/** Moderate hue rotation, in degrees per frame. */
const HUE_DRIFT_MED: number = 0.4;

/** Fast hue rotation, in degrees per frame. */
const HUE_DRIFT_FAST: number = 1.2;

/** Saturation of the scope trace, as a percentage. */
const SCOPE_SATURATION: number = 100;

/** Lightness of the scope trace, as a percentage. */
const SCOPE_LIGHTNESS: number = 60;

/** Hue offset applied to the second (mirrored) trace, in degrees. */
const MIRROR_HUE_OFFSET: number = 180;

// ============================================================================
// Scope rendering
// ============================================================================

/** Number of samples taken across the waveform for the trace. */
const SCOPE_POINTS: number = 256;

/** Stroke width of the trace on the internal surface, in pixels. */
const SCOPE_LINE_WIDTH: number = 1.5;

/** Glow blur radius applied to the trace, in surface pixels. */
const SCOPE_GLOW_BLUR: number = 8;

/** Trace deflection as a fraction of surface height, at unit amplitude. */
const SCOPE_AMPLITUDE: number = 0.42;

/** Radius of the radial trace at rest, as a fraction of the smaller axis. */
const RADIAL_BASE_RADIUS: number = 0.22;

/** Additional radial deflection, as a fraction of the smaller axis. */
const RADIAL_WAVE_DEPTH: number = 0.3;

/**
 * The numeric half of a preset.
 *
 * Every field is a continuous quantity, which is what allows one preset to be
 * eased into the next: the engine interpolates this block and the warp simply
 * reads whatever the current values happen to be.
 */
interface AlchemyParams {
  /** Fraction of brightness lost by the previous frame each frame. */
  readonly falloff: number;

  /** Uniform zoom applied to the previous frame each frame. */
  readonly scale: number;

  /** Extra horizontal scale factor, multiplied with `scale`. */
  readonly stretchX: number;

  /** Extra vertical scale factor, multiplied with `scale`. */
  readonly stretchY: number;

  /** Rotation applied to the previous frame each frame, in radians. */
  readonly spin: number;

  /** Horizontal translation of the previous frame, in surface pixels. */
  readonly xShift: number;

  /** Vertical translation of the previous frame, in surface pixels. */
  readonly yShift: number;

  /** Amplitude of the per-row sinusoidal displacement, in surface pixels. */
  readonly ocean: number;

  /** Number of sine cycles spanning the surface height. */
  readonly sinLoops: number;

  /** Phase advance of the row displacement per frame, in radians. */
  readonly sinShake: number;

  /** Offset of the soft-smear second tap, in surface pixels. Zero disables. */
  readonly smear: number;

  /** Extra zoom contributed by the bass envelope. */
  readonly bassJump: number;

  /** Trace amplitude contributed by the bass envelope. */
  readonly bassFlex: number;

  /** Hue rotation per frame, in degrees. */
  readonly hueDrift: number;
}

/** How the oscilloscope trace is laid out on the surface. */
type ScopeMode = 'linear' | 'radial';

/**
 * A complete preset: the parameter block plus the discrete choices that go
 * with it. Supplied by each concrete subclass through the constructor.
 */
interface AlchemySpec {
  /** Display name, matching the preset it is modelled on. */
  readonly name: string;

  /** Layout of the trace. */
  readonly scope: ScopeMode;

  /** Rotational copies of the trace drawn around the centre. */
  readonly divisions: number;

  /** Whether a hue-shifted mirrored copy of the trace is drawn. */
  readonly mirrored: boolean;

  /** Starting hue for this preset, in degrees. */
  readonly startHue: number;

  /** The interpolatable parameter block. */
  readonly params: AlchemyParams;
}


/**
 * Alchemy - a frame-feedback visualization that cycles through parameterised
 * presets.
 *
 * Each frame the previous frame is redrawn into the surface through a warp
 * (zoom, spin, shift, stretch, scanline displacement and optional smear),
 * attenuated so it decays, and the oscilloscope trace is drawn on top. The
 * low-resolution surface is then stretched to fill the canvas.
 */
export abstract class AlchemyVisualization extends Canvas2DVisualization {
  public readonly name: string;
  public readonly category: string = 'Alchemy';

  /** The discrete choices and parameter block for this preset. */
  private readonly spec: AlchemySpec;

  /** Time-domain samples for the trace. */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Frequency bins, used only for the bass envelope. */
  private freqArray: Uint8Array<ArrayBuffer>;

  /** Front surface - holds the current frame. */
  private frontCanvas: HTMLCanvasElement | null = null;
  private frontCtx: CanvasRenderingContext2D | null = null;

  /** Back surface - the warp target, swapped with the front each frame. */
  private backCanvas: HTMLCanvasElement | null = null;
  private backCtx: CanvasRenderingContext2D | null = null;

  /** Dimensions of the internal surfaces. */
  private surfaceWidth: number = 0;
  private surfaceHeight: number = 0;

  /** The parameter block driving the warp. */
  private readonly params: AlchemyParams;

  /** Current hue of the trace, in degrees. */
  private hue: number;

  /** Phase of the per-row displacement, in radians. */
  private wavePhase: number = 0;

  /** Smoothed bass level in the range 0 to 1. */
  private bass: number = 0;

  protected constructor(config: VisualizationConfig, spec: AlchemySpec) {
    super(config);
    this.name = spec.name;
    this.spec = spec;
    this.params = spec.params;
    this.hue = spec.startHue;
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    if (this.width <= 0 || this.height <= 0) return;

    const aspect: number = this.width / this.height;
    const height: number = SURFACE_HEIGHT;
    const width: number = Math.max(1, Math.min(SURFACE_MAX_WIDTH, Math.round(height * aspect)));

    // Nothing to do if the surface size is unchanged - the aspect ratio has to
    // move meaningfully before the low-resolution surface changes at all.
    if (width === this.surfaceWidth && height === this.surfaceHeight && this.frontCanvas) {
      return;
    }

    this.surfaceWidth = width;
    this.surfaceHeight = height;

    const front: {canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D} = this.createSurface(width, height);
    const back: {canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D} = this.createSurface(width, height);

    this.frontCanvas = front.canvas;
    this.frontCtx = front.ctx;
    this.backCanvas = back.canvas;
    this.backCtx = back.ctx;
  }

  /**
   * Creates one of the internal feedback surfaces.
   *
   * @param width - Surface width in pixels
   * @param height - Surface height in pixels
   * @returns The canvas and its 2D context
   */
  private createSurface(width: number, height: number): {canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D} {
    const canvas: HTMLCanvasElement = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx: CanvasRenderingContext2D = canvas.getContext('2d', {alpha: true})!;
    return {canvas, ctx};
  }

  public draw(): void {
    this.updateFade();

    if (this.width <= 0 || this.height <= 0) return;

    if (!this.frontCanvas || !this.backCanvas) {
      this.onResize();
      if (!this.frontCanvas || !this.backCanvas) return;
    }

    this.analyser.getByteTimeDomainData(this.dataArray);
    this.analyser.getByteFrequencyData(this.freqArray);

    this.updateBass();

    this.applyFeedback();
    this.renderScope();
    this.blitToCanvas();

    this.applyFadeOverlay();
  }

  /**
   * Updates the smoothed bass envelope from the low frequency bins.
   *
   * The envelope is smoothed rather than used raw so that beat-driven zoom
   * reads as a swell instead of a single-frame jolt.
   */
  private updateBass(): void {
    const bins: number = Math.min(BASS_BIN_COUNT, this.freqArray.length);
    if (bins <= 0) return;

    let total: number = 0;
    for (let i: number = 0; i < bins; i++) {
      total += this.freqArray[i];
    }

    const level: number = (total / bins / RGB_MID) * HALF * this.sensitivityFactor;
    this.bass += (level - this.bass) * BASS_SMOOTHING;
  }

  /**
   * Redraws the previous frame into the surface through the parameterised warp.
   *
   * This is the whole effect. The previous frame is drawn into the back
   * surface transformed and attenuated, the surfaces are swapped, and the
   * trace is then drawn on top of the result. Because the output of one frame
   * is the input of the next, small per-frame transforms compound into the
   * large-scale flow that characterises the effect.
   */
  private applyFeedback(): void {
    const src: HTMLCanvasElement = this.frontCanvas!;
    const dst: CanvasRenderingContext2D = this.backCtx!;
    const params: AlchemyParams = this.params;
    const width: number = this.surfaceWidth;
    const height: number = this.surfaceHeight;

    dst.setTransform(1, 0, 0, 1, 0, 0);
    dst.globalCompositeOperation = 'source-over';
    dst.clearRect(0, 0, width, height);

    this.wavePhase += params.sinShake;

    // Bass adds to the zoom, so beats push the image outward (or inward, when
    // the preset's base zoom is < 1) without changing the preset's character.
    const zoom: number = params.scale + this.bass * params.bassJump;
    const centreX: number = width * HALF;
    const centreY: number = height * HALF;

    dst.save();
    dst.imageSmoothingEnabled = true;
    dst.imageSmoothingQuality = 'high';
    dst.globalAlpha = 1 - params.falloff;

    dst.translate(centreX + params.xShift, centreY + params.yShift);
    dst.rotate(params.spin);
    dst.scale(zoom * params.stretchX, zoom * params.stretchY);
    dst.translate(-centreX, -centreY);

    this.drawDisplaced(dst, src);

    // SoftSmear: a second, fainter tap at a small offset. Repeated every frame
    // this bleeds detail outward and is what softens hard trace edges into the
    // characteristic wash.
    if (params.smear > 0) {
      dst.globalAlpha = (1 - params.falloff) * SMEAR_TAP_ALPHA;
      dst.save();
      dst.translate(params.smear, params.smear);
      this.drawDisplaced(dst, src);
      dst.restore();
    }

    dst.restore();

    this.swapSurfaces();
  }

  /**
   * Draws the source surface, applying the per-row sinusoidal displacement.
   *
   * The original precomputed a displacement per scanline into a lookup table
   * and moved bits row by row. An affine transform cannot express that, so
   * rows are grouped into strips, each sampling the source at its own
   * horizontal offset.
   *
   * The offset is applied to the *source* rectangle, not the destination, for
   * two reasons: it is what the original's table actually does (each row reads
   * from a displaced source position), and it means the destination rectangles
   * tile the surface exactly. Offsetting the destination instead would open
   * wedge-shaped gaps between strips once the outer transform rotates them.
   *
   * Where a strip samples beyond the source edge the result is transparent,
   * which is the correct behaviour - there is no content to shift in from
   * outside the surface.
   *
   * When the displacement amplitude is zero this collapses to a single draw.
   *
   * @param dst - Destination context, already transformed
   * @param src - Source surface
   */
  private drawDisplaced(dst: CanvasRenderingContext2D, src: HTMLCanvasElement): void {
    const width: number = this.surfaceWidth;
    const height: number = this.surfaceHeight;
    const params: AlchemyParams = this.params;

    if (params.ocean <= 0) {
      dst.drawImage(src, 0, 0, width, height);
      return;
    }

    const strips: number = Math.min(MAX_WARP_STRIPS, height);
    for (let i: number = 0; i < strips; i++) {
      const y0: number = Math.round((i * height) / strips);
      const y1: number = Math.round(((i + 1) * height) / strips);
      const stripHeight: number = y1 - y0;
      if (stripHeight <= 0) continue;

      const phase: number = (y0 / height) * params.sinLoops * TWO_PI + this.wavePhase;
      const displacement: number = Math.sin(phase) * params.ocean;

      dst.drawImage(
        src,
        -displacement, y0, width, stripHeight,
        0, y0, width, stripHeight
      );
    }
  }

  /** Swaps the front and back surfaces after a warp. */
  private swapSurfaces(): void {
    const canvas: HTMLCanvasElement = this.frontCanvas!;
    const ctx: CanvasRenderingContext2D = this.frontCtx!;
    this.frontCanvas = this.backCanvas;
    this.frontCtx = this.backCtx;
    this.backCanvas = canvas;
    this.backCtx = ctx;
  }

  /**
   * Draws the oscilloscope trace on top of the warped frame.
   *
   * The trace is drawn additively and repeated around the centre once per
   * division, which is how the original produced its kaleidoscopic presets.
   */
  private renderScope(): void {
    const ctx: CanvasRenderingContext2D = this.frontCtx!;
    const spec: AlchemySpec = this.spec;
    const params: AlchemyParams = this.params;

    this.hue = (this.hue + params.hueDrift) % DEGREES_FULL_CIRCLE;

    const amplitude: number = this.sensitivityFactor * (1 + this.bass * params.bassFlex);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = SCOPE_LINE_WIDTH;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowBlur = this.getScaledGlowBlur(SCOPE_GLOW_BLUR);

    this.strokeDivisions(ctx, spec, amplitude, this.hue);

    if (spec.mirrored) {
      const mirrorHue: number = (this.hue + MIRROR_HUE_OFFSET) % DEGREES_FULL_CIRCLE;
      ctx.save();
      ctx.translate(this.surfaceWidth, 0);
      ctx.scale(-1, 1);
      this.strokeDivisions(ctx, spec, amplitude, mirrorHue);
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Strokes the trace once per rotational division.
   *
   * @param ctx - Surface context
   * @param spec - Spec supplying the layout and division count
   * @param amplitude - Amplitude multiplier for the trace
   * @param hue - Trace hue in degrees
   */
  private strokeDivisions(
    ctx: CanvasRenderingContext2D,
    spec: AlchemySpec,
    amplitude: number,
    hue: number
  ): void {
    const colour: string = `hsl(${hue}, ${SCOPE_SATURATION}%, ${SCOPE_LIGHTNESS}%)`;
    ctx.strokeStyle = colour;
    ctx.shadowColor = colour;

    const centreX: number = this.surfaceWidth * HALF;
    const centreY: number = this.surfaceHeight * HALF;
    const divisions: number = Math.max(1, spec.divisions);

    for (let division: number = 0; division < divisions; division++) {
      ctx.save();
      if (division > 0) {
        ctx.translate(centreX, centreY);
        ctx.rotate((division * TWO_PI) / divisions);
        ctx.translate(-centreX, -centreY);
      }
      if (spec.scope === 'radial') {
        this.traceRadial(ctx, amplitude);
      } else {
        this.traceLinear(ctx, amplitude);
      }
      ctx.restore();
    }
  }

  /**
   * Strokes the waveform as a horizontal trace across the surface.
   *
   * @param ctx - Surface context
   * @param amplitude - Amplitude multiplier for the trace
   */
  private traceLinear(ctx: CanvasRenderingContext2D, amplitude: number): void {
    const width: number = this.surfaceWidth;
    const height: number = this.surfaceHeight;
    const centreY: number = height * HALF;
    const deflection: number = height * SCOPE_AMPLITUDE * amplitude;
    const samples: number = this.dataArray.length;

    ctx.beginPath();
    for (let i: number = 0; i < SCOPE_POINTS; i++) {
      const t: number = i / (SCOPE_POINTS - 1);
      const sample: number = this.dataArray[Math.min(samples - 1, Math.floor(t * samples))];
      const value: number = (sample - RGB_MID) / RGB_MID;
      const x: number = t * width;
      const y: number = centreY + value * deflection;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /**
   * Strokes the waveform as a closed radial trace around the centre.
   *
   * @param ctx - Surface context
   * @param amplitude - Amplitude multiplier for the trace
   */
  private traceRadial(ctx: CanvasRenderingContext2D, amplitude: number): void {
    const width: number = this.surfaceWidth;
    const height: number = this.surfaceHeight;
    const centreX: number = width * HALF;
    const centreY: number = height * HALF;
    const axis: number = Math.min(width, height);
    const baseRadius: number = axis * RADIAL_BASE_RADIUS;
    const depth: number = axis * RADIAL_WAVE_DEPTH * amplitude;
    const samples: number = this.dataArray.length;

    ctx.beginPath();
    for (let i: number = 0; i <= SCOPE_POINTS; i++) {
      const t: number = i / SCOPE_POINTS;
      const sample: number = this.dataArray[Math.min(samples - 1, Math.floor(t * samples))];
      const value: number = (sample - RGB_MID) / RGB_MID;
      const angle: number = t * TWO_PI;
      const radius: number = baseRadius + value * depth;
      const x: number = centreX + Math.cos(angle) * radius;
      const y: number = centreY + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  /**
   * Stretches the low-resolution surface up to fill the canvas.
   *
   * The upscale is deliberately smoothed. Alchemy's soft, liquid quality comes
   * from computing the effect small and interpolating it up; rendering the
   * feedback at native resolution instead produces a sharper, thinner image
   * that does not read as the same effect.
   */
  private blitToCanvas(): void {
    const ctx: CanvasRenderingContext2D = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.frontCanvas!, 0, 0, this.surfaceWidth, this.surfaceHeight, 0, 0, this.width, this.height);
  }

  public override destroy(): void {
    this.frontCanvas = null;
    this.frontCtx = null;
    this.backCanvas = null;
    this.backCtx = null;
  }
}

// ============================================================================
// Concrete presets
//
// One visualization per preset the original registers, read from its string
// table. They share the engine above and differ only in their parameter block
// and the discrete choices - scope layout, division count, mirroring - that go
// with it.
// ============================================================================

/** Alchemy - Standard Render Cycle. The default cycle: a slow outward creep with a light smear. */
export class AlchemyStandardRenderCycleVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "Standard Render Cycle",
      scope: 'linear',
      divisions: 1,
      mirrored: false,
      startHue: 200,
      params: {
        falloff: FALLOFF_MID,
        scale: SCALE_CREEP_OUT,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_STILL,
        xShift: SHIFT_STILL,
        yShift: SHIFT_STILL,
        ocean: OCEAN_FLAT,
        sinLoops: LOOPS_LONG,
        sinShake: SHAKE_CALM,
        smear: SMEAR_SOFT,
        bassJump: BASS_JUMP_SOFT,
        bassFlex: BASS_FLEX_CALM,
        hueDrift: HUE_DRIFT_SLOW,
      },
    });
  }
}

/** Alchemy - Linear Shift. Constant diagonal translation with no zoom or rotation. */
export class AlchemyLinearShiftVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "Linear Shift",
      scope: 'linear',
      divisions: 1,
      mirrored: false,
      startHue: 120,
      params: {
        falloff: FALLOFF_MID,
        scale: SCALE_HOLD,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_STILL,
        xShift: SHIFT_NUDGE,
        yShift: -SHIFT_NUDGE,
        ocean: OCEAN_FLAT,
        sinLoops: LOOPS_LONG,
        sinShake: SHAKE_CALM,
        smear: SMEAR_NONE,
        bassJump: BASS_JUMP_NONE,
        bassFlex: BASS_FLEX_CALM,
        hueDrift: HUE_DRIFT_MED,
      },
    });
  }
}

/** Alchemy - Stretch Shift. Anisotropic scaling: wider each frame, shorter each frame. */
export class AlchemyStretchShiftVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "Stretch Shift",
      scope: 'linear',
      divisions: 2,
      mirrored: false,
      startHue: 300,
      params: {
        falloff: FALLOFF_LOW,
        scale: SCALE_HOLD,
        stretchX: STRETCH_WIDE,
        stretchY: STRETCH_NARROW,
        spin: SPIN_STILL,
        xShift: SHIFT_STILL,
        yShift: SHIFT_NUDGE,
        ocean: OCEAN_FLAT,
        sinLoops: LOOPS_LONG,
        sinShake: SHAKE_CALM,
        smear: SMEAR_SOFT,
        bassJump: BASS_JUMP_SOFT,
        bassFlex: BASS_FLEX_WILD,
        hueDrift: HUE_DRIFT_MED,
      },
    });
  }
}

/** Alchemy - SuperStar. Rotation plus outward zoom, kaleidoscoped into six mirrored arms. */
export class AlchemySuperStarVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "SuperStar",
      scope: 'radial',
      divisions: 6,
      mirrored: true,
      startHue: 240,
      params: {
        falloff: FALLOFF_LOW,
        scale: SCALE_OUT,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_TURN,
        xShift: SHIFT_STILL,
        yShift: SHIFT_STILL,
        ocean: OCEAN_FLAT,
        sinLoops: LOOPS_LONG,
        sinShake: SHAKE_CALM,
        smear: SMEAR_NONE,
        bassJump: BASS_JUMP_HARD,
        bassFlex: BASS_FLEX_WILD,
        hueDrift: HUE_DRIFT_FAST,
      },
    });
  }
}

/** Alchemy - WonderWave. Strong per-scanline displacement, the surface rolling like water. */
export class AlchemyWonderWaveVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "WonderWave",
      scope: 'linear',
      divisions: 1,
      mirrored: true,
      startHue: 160,
      params: {
        falloff: FALLOFF_MID,
        scale: SCALE_CREEP_OUT,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_STILL,
        xShift: SHIFT_STILL,
        yShift: SHIFT_STILL,
        ocean: OCEAN_SWELL,
        sinLoops: LOOPS_LONG,
        sinShake: SHAKE_CALM,
        smear: SMEAR_SOFT,
        bassJump: BASS_JUMP_SOFT,
        bassFlex: BASS_FLEX_WILD,
        hueDrift: HUE_DRIFT_MED,
      },
    });
  }
}

/** Alchemy - Shift O' Scope. Fast decay and a hard sideways slide, keeping the trace legible. */
export class AlchemyShiftOScopeVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "Shift O' Scope",
      scope: 'linear',
      divisions: 2,
      mirrored: true,
      startHue: 30,
      params: {
        falloff: FALLOFF_HIGH,
        scale: SCALE_IN,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_DRIFT,
        xShift: SHIFT_SLIDE,
        yShift: SHIFT_STILL,
        ocean: OCEAN_RIPPLE,
        sinLoops: LOOPS_SHORT,
        sinShake: SHAKE_BRISK,
        smear: SMEAR_NONE,
        bassJump: BASS_JUMP_SOFT,
        bassFlex: BASS_FLEX_CALM,
        hueDrift: HUE_DRIFT_SLOW,
      },
    });
  }
}

/** Alchemy - Funktional. Everything at once: fast whirl, fast zoom, ripple and heavy smear. */
export class AlchemyFunktionalVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "Funktional",
      scope: 'radial',
      divisions: 3,
      mirrored: false,
      startHue: 0,
      params: {
        falloff: FALLOFF_LOW,
        scale: SCALE_OUT_FAST,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_WHIRL,
        xShift: SHIFT_STILL,
        yShift: SHIFT_STILL,
        ocean: OCEAN_RIPPLE,
        sinLoops: LOOPS_SHORT,
        sinShake: SHAKE_BRISK,
        smear: SMEAR_HEAVY,
        bassJump: BASS_JUMP_HARD,
        bassFlex: BASS_FLEX_WILD,
        hueDrift: HUE_DRIFT_FAST,
      },
    });
  }
}

/** Alchemy - Blur. Pure smear with no motion: the trace bleeds outward in place. */
export class AlchemyBlurVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "Blur",
      scope: 'linear',
      divisions: 1,
      mirrored: false,
      startHue: 210,
      params: {
        falloff: FALLOFF_MID,
        scale: SCALE_HOLD,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_STILL,
        xShift: SHIFT_STILL,
        yShift: SHIFT_STILL,
        ocean: OCEAN_FLAT,
        sinLoops: LOOPS_LONG,
        sinShake: SHAKE_CALM,
        smear: SMEAR_HEAVY,
        bassJump: BASS_JUMP_NONE,
        bassFlex: BASS_FLEX_CALM,
        hueDrift: HUE_DRIFT_SLOW,
      },
    });
  }
}

/** Alchemy - SwitchBlur. Smear with a slow rotational drift and a mirrored second trace. */
export class AlchemySwitchBlurVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "SwitchBlur",
      scope: 'linear',
      divisions: 2,
      mirrored: true,
      startHue: 270,
      params: {
        falloff: FALLOFF_MID,
        scale: SCALE_CREEP_OUT,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_DRIFT,
        xShift: SHIFT_STILL,
        yShift: SHIFT_STILL,
        ocean: OCEAN_FLAT,
        sinLoops: LOOPS_LONG,
        sinShake: SHAKE_CALM,
        smear: SMEAR_HEAVY,
        bassJump: BASS_JUMP_SOFT,
        bassFlex: BASS_FLEX_CALM,
        hueDrift: HUE_DRIFT_MED,
      },
    });
  }
}

/** Alchemy - Shift. The bare translation operation, harder than Linear Shift and unsmeared. */
export class AlchemyShiftVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "Shift",
      scope: 'linear',
      divisions: 1,
      mirrored: false,
      startHue: 90,
      params: {
        falloff: FALLOFF_MID,
        scale: SCALE_HOLD,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_STILL,
        xShift: SHIFT_SLIDE,
        yShift: SHIFT_NUDGE,
        ocean: OCEAN_FLAT,
        sinLoops: LOOPS_LONG,
        sinShake: SHAKE_CALM,
        smear: SMEAR_NONE,
        bassJump: BASS_JUMP_NONE,
        bassFlex: BASS_FLEX_CALM,
        hueDrift: HUE_DRIFT_SLOW,
      },
    });
  }
}

/** Alchemy - Bass Bounce. Zoom and trace amplitude driven hard by the bass envelope. */
export class AlchemyBassBounceVisualization extends AlchemyVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: "Bass Bounce",
      scope: 'radial',
      divisions: 1,
      mirrored: false,
      startHue: 340,
      params: {
        falloff: FALLOFF_MID,
        scale: SCALE_CREEP_OUT,
        stretchX: STRETCH_EVEN,
        stretchY: STRETCH_EVEN,
        spin: SPIN_STILL,
        xShift: SHIFT_STILL,
        yShift: SHIFT_STILL,
        ocean: OCEAN_FLAT,
        sinLoops: LOOPS_LONG,
        sinShake: SHAKE_CALM,
        smear: SMEAR_SOFT,
        bassJump: BASS_JUMP_HARD,
        bassFlex: BASS_FLEX_WILD,
        hueDrift: HUE_DRIFT_MED,
      },
    });
  }
}
