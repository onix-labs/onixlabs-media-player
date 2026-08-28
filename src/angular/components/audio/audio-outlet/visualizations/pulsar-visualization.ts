/**
 * @fileoverview Pulsar visualization with mirrored curved waveforms.
 *
 * Creates an ambient visual effect with mirrored waveforms that curve
 * around a central pulsating circle. The waveforms bend away from the
 * center creating a wing-like pattern. Colors cycle through the spectrum.
 *
 * Technical details:
 * - Mirrored waveforms on left and right
 * - Arc-based bending creates curved appearance
 * - Central circle pulses with audio
 * - HSL color cycling for smooth transitions
 * - Optimized with canvas reuse and pre-allocated arrays
 * - Waveform rotation independent of trail rotation
 *
 * Performance optimizations:
 * - Reuses trail/temp canvases instead of recreating
 * - Pre-allocated point arrays avoid GC pressure
 * - Gradient colors cached and only updated on hue change
 *
 * @module app/components/audio/audio-outlet/visualizations/pulsar-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';
import {TWO_PI} from './visualization-constants';

/**
 * Pulsar visualization with curved mirrored waveforms.
 *
 * Renders mirrored curved waveforms that wrap around a central
 * pulsating circle, with smooth color cycling.
 */
export class PulsarVisualization extends Canvas2DVisualization {
  /** Radians the trail rotates per frame. */
  private static readonly ROTATION_SPEED: number = 0.005;

  /** Radians the waveforms rotate per frame. */
  private static readonly WAVEFORM_ROTATION_SPEED: number = 0.005;

  /** Per-frame trail fade rate. */
  private static readonly FADE_RATE: number = 0.75;

  /** Per-frame outward zoom applied to the trail. */
  private static readonly ZOOM_SCALE: number = 1.03;

  /**
   * Degrees the hue advances per frame.
   *
   * How much hue is on screen at once is set by how long content survives, and
   * that is governed by the outward zoom rather than by the fade: at roughly
   * two percent per frame, content injected near the middle reaches the edge
   * in about a hundred frames, well before the fade has touched it. So this
   * rate times a hundred is the spread of hue visible at any moment - around
   * 25 degrees here, a coherent band that travels rather than a static wheel.
   */
  private static readonly HUE_CYCLE_SPEED: number = 0.15;

  /**
   * Number of concentric rings the trail is redrawn in.
   *
   * Canvas2D can only transform a whole image at once, so a single rotate and
   * scale moves every radius identically - a uniform smear that never forms
   * structure. Rings give each radius its own transform.
   *
   * Most of the character comes from the per-ring *zoom* rather than the
   * per-ring rotation, following Trig Stretch: that displacement rotates every
   * radius by the same amount and puts all of its variation into the radius.
   *
   * Set to 1 to go back to a single uniform rotation.
   */
  private static readonly TRAIL_RING_COUNT: number = 60;

  /**
   * Extra rotation at the outermost ring versus the innermost, in radians per
   * frame.
   *
   * This is the shear. Rings tile the trail exactly rather than overlapping:
   * an overlap would composite the shared band twice and leave bright seams,
   * where an exact edge only risks a faint one.
   */
  private static readonly RING_SHEAR: number = 0.01;

  /**
   * Amplitude of the cosine ripple applied to each ring's zoom.
   *
   * Large enough that the trough dips below 1, so bands genuinely contract
   * rather than merely expanding more slowly. That is what makes content ride
   * in and out as it orbits, which is the part of Trig Stretch worth having.
   *
   * This does not empty the frame the way the cubic did, and the difference is
   * worth being precise about. The cubic contracts the rim *always* - it is
   * monotonic in radius and fixed in time - so the outer region drains and
   * never refills. The ripple contracts a given radius only while the crest is
   * elsewhere, and the phase drifts, so every radius spends equal time
   * expanding and contracting. Its time-average is zero, leaving the net flow
   * at each radius outward and the frame filled.
   */
  private static readonly RING_RIPPLE: number = 0.02;

  /**
   * How much slower the outermost ring zooms than the innermost.
   *
   * Trig Stretch pulls the rim inward outright, but that empties the outer
   * region: content drains toward the centre with nothing drawn out there to
   * replace it, and the field collapses into a circle with dark corners.
   *
   * So the cubic is kept as a *differential* rather than a reversal. Every
   * ring still zooms outward - the base zoom minus ripple minus this stays
   * above 1 - so the field fills the frame as it did before, but the rim
   * expands more slowly than the middle and content bunches up as it travels
   * out. That keeps the folding character without the collapse.
   */
  private static readonly RING_CUBIC_PULL: number = 0.01;

  /**
   * Number of ripple cycles spanning the radius.
   *
   * More than one, and this is why. At a single cycle there is one crest and
   * one trough across the whole field, so as the phase drifts the crest sweeps
   * everything: at one moment most of the visible area is expanding, half a
   * cycle later most of it is contracting. That reads as the whole scene
   * sucking in and exploding out rather than as bands travelling through it.
   *
   * Several cycles keep expanding and contracting bands on screen at the same
   * time, so they cancel and only the local motion is left. The residual
   * breathing falls roughly as one over this value, measured area-weighted
   * since the outer rings cover most of the pixels:
   *
   *   cycles 1  swing 0.0194      cycles 3  swing 0.0067
   *   cycles 2  swing 0.0099      cycles 4  swing 0.0051
   *
   * TRAIL_RING_COUNT has to keep up: below about five rings per cycle the
   * rings cannot resolve the ripple.
   */
  private static readonly RIPPLE_CYCLES: number = 6;

  /**
   * Ring widths the ring boundaries slide per frame.
   *
   * The boundaries are where one ring's zoom meets the next one's, so any step
   * in zoom lands there as a seam. Holding them at fixed radii lets those
   * seams bake into the trail frame after frame until they read as hard
   * concentric shells pushing past each other. Sliding them means a given
   * radius falls in one ring on some frames and its neighbour on others, so
   * the step is dithered over time and the trail averages it away.
   *
   * Deliberately not harmonic with RIPPLE_DRIFT, so the two do not lock.
   */
  private static readonly RING_BOUNDARY_DRIFT: number = 0.13;

  /**
   * Radians the ripple pattern drifts per frame.
   *
   * Signed so the bands travel outward with the flow rather than against it,
   * and fast enough that no radius sits in the contracting half for long.
   */
  private static readonly RIPPLE_DRIFT: number = 0.15;

  /**
   * Minimum gap between transients acting, in milliseconds.
   *
   * Both responses are dramatic - one reverses the field, the other throws the
   * palette across the wheel and inverts the frame - so a hit gets ten seconds
   * to itself. That is long enough for what it did to settle and be read as an
   * event, where at the fraction of a second a beat allows the two branches
   * would trade back and forth and the whole thing would read as a flicker.
   *
   * It is a rolling gap rather than a fixed window, so the ten seconds are
   * measured from whichever hit last acted.
   */
  private static readonly TRANSIENT_REFRACTORY_MS: number = 10000;

  /**
   * Degrees the hue jumps on a transient.
   *
   * Has to stay small against the smooth cycle or it swamps it. At 55 degrees
   * with a 400ms refractory the kick could contribute 138 degrees a second
   * against the cycle's 15, so on anything with a beat the hue lurched about
   * instead of cycling and the smooth drift was invisible underneath. This is
   * an accent on the cycle, not a replacement for it.
   *
   * That was measured against a much shorter refractory than the one
   * {@link TRANSIENT_REFRACTORY_MS} now holds, so the kick sits further under
   * the cycle than these numbers suggest rather than closer to it.
   */
  private static readonly TRANSIENT_HUE_KICK: number = 18;

  /**
   * How often a transient jumps the palette instead of reversing the spin.
   *
   * The two responses are exclusive: a hit does one or the other, chosen fresh
   * each time. Doing both on the same hit would read as one louder event rather
   * than as two things the visualization can do, and an even split is what
   * makes it clear that which one fires is not tied to anything in the audio.
   */
  private static readonly TRANSIENT_PALETTE_JUMP_CHANCE: number = 0.5;

  /**
   * Degrees the hue jumps when a transient takes the palette branch.
   *
   * The golden angle, which is what Reactor jumps by. Successive jumps never
   * revisit a hue they have already landed on and never land near the one
   * before, so the palette reads as arriving somewhere arbitrary each time
   * without the risk a true random draw carries of landing on the colour it
   * just left and showing nothing.
   */
  private static readonly TRANSIENT_HUE_JUMP: number = 137.5;

  /**
   * The colour the mirrored waveforms take while darkened.
   *
   * These strokes are not additive - they land in the trail buffer as they are
   * - so black does not mean absent. It carves the arms out of the glow they
   * have been building, which is why the darkened state reads as a shape
   * rather than as the waveforms having stopped.
   */
  private static readonly WAVEFORM_DARK: {r: number; g: number; b: number} = {r: 0, g: 0, b: 0};

  /**
   * The colour the mirrored waveforms take while lit.
   *
   * Pure white rather than the pale tint of the current hue. The arms are read
   * against the ring field they cross, not against the background, and the
   * rings are themselves lit tints of that same hue - so a tinted arm sat in
   * the middle of the range it had to stand out from and washed into it. White
   * and black are the two ends nothing in the field occupies.
   */
  private static readonly WAVEFORM_LIT: {r: number; g: number; b: number} = {r: 255, g: 255, b: 255};

  /**
   * Opacity of the arms.
   *
   * Full. At the six tenths this ran at, the core landed as a wash over the
   * rings rather than as a line on top of them, which is the whole of what the
   * arms are for; the halo cannot carry them on its own.
   */
  private static readonly WAVEFORM_ALPHA: number = 1;

  /** Number of low-frequency bins averaged for bass transient detection. */
  private static readonly BASS_BINS: number = 16;

  /** Minimum frame-over-frame bass rise that counts as a transient. */
  private static readonly TRANSIENT_THRESHOLD: number = 15;

  /** Minimum bass level required before a transient is considered. */
  private static readonly MIN_LEVEL: number = 50;

  /** Number of points sampled across each mirrored waveform half. */
  private static readonly WAVEFORM_SAMPLES: number = 32;

  /**
   * How far an arm reaches outward, as a multiple of the half-width.
   *
   * The sweep runs from its far outer end in to the centre, so this only moves
   * the outer end: at one the arm starts level with the side of the frame, and
   * above that it starts beyond it and its outer end crops, the way the outer
   * ends already crop under {@link CONTENT_SCALE}. The inner end stays on
   * `minArcRadius` either way, which is what keeps the arms meeting the centre
   * circle where they always did.
   */
  private static readonly WAVEFORM_LENGTH_SCALE: number = 2;

  /** Number of points around the pulsating center circle. */
  private static readonly CENTER_CIRCLE_POINTS: number = 128;

  /**
   * Uniform scale applied to everything drawn, as a zoom.
   *
   * Applied to the arc radius, along with the centre circle and the
   * amplitudes, which together make a true zoom; the outer ends of the
   * waveforms crop at the sides as they should.
   *
   * It is not the knob for how far the arms reach - that is
   * {@link WAVEFORM_LENGTH_SCALE}, which moves their outer end without
   * touching the size of anything else.
   */
  private static readonly CONTENT_SCALE: number = 0.75;

  /** Base glow blur radius in pixels. */
  private static readonly BASE_GLOW_BLUR: number = 18;

  /** Alpha of the neon halo stroke, before the caller's own alpha. */
  private static readonly NEON_HALO_ALPHA: number = 0.22;

  /** Alpha of the halo's shadow, which is what actually spreads the colour. */
  private static readonly NEON_HALO_SHADOW_ALPHA: number = 0.55;

  /** Extra line width of the halo stroke, in pixels. */
  private static readonly NEON_HALO_WIDTH: number = 5;

  /** Blur on the core stroke, as a fraction of the halo blur. */
  private static readonly NEON_CORE_BLUR_SCALE: number = 0.45;

  /** How far the hot centre line is lifted toward white, per channel. */
  private static readonly NEON_HOT_LIFT: number = 20;

  /** Alpha of the hot centre line. */
  private static readonly NEON_HOT_ALPHA: number = 0.55;

  /** Width of the hot centre line, as a fraction of the core width. */
  private static readonly NEON_HOT_WIDTH_FRACTION: number = 0.25;

  /**
   * Blur radius of the bloom pass, in pixels.
   *
   * Applied to the whole trail at composite time rather than per stroke. One
   * full-canvas blur is cheaper than giving every stroke a wide shadow, and it
   * is the only thing that makes the *trails* glow as well as the strokes -
   * once content has been baked into the trail buffer there is no stroke left
   * to attach a shadow to.
   */
  private static readonly BLOOM_BLUR: number = 16;

  /**
   * Strength of the additive bloom pass.
   *
   * Safe to raise, unlike additive strokes: the bloom is composited onto the
   * main canvas, which is cleared every frame, so it brightens once rather
   * than compounding.
   */
  private static readonly BLOOM_STRENGTH: number = 0.5;

  /** Saturation and lightness levels for the center-circle gradient. */
  private static readonly GRADIENT_LEVELS: ReadonlyArray<{s: number; l: number}> = [
    {s: 85, l: 12},
    {s: 80, l: 22},
    {s: 75, l: 35},
    {s: 70, l: 45},
    {s: 75, l: 50}
  ];

  public readonly name: string = 'Pulsar';
  public readonly category: string = 'Nostalgia';

  /** Frequency buffer for bass transient detection. */
  private frequencyData: Uint8Array<ArrayBuffer>;
  private prevBass: number = 0;

  /** Time-domain audio buffer. */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Trail canvas (reused, not recreated each frame) - THIS IS THE KEY OPTIMIZATION. */
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

  /** Temp canvas for the zoom/rotate effect (reused, not recreated each frame). */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Hue cycling with caching. */
  private hueOffset: number = 210;
  private cachedHue: number = -1;
  private cachedGradientColors: Array<{r: number; g: number; b: number}> = [];
  /** Current waveform rotation angle. */
  private waveformAngle: number = 0;

  /** Direction the trail currently rotates, +1 or -1. Flipped by transients. */
  private spinDirection: number = 1;

  /**
   * Whether the mirrored waveforms are currently drawn black rather than lit.
   *
   * Latched, not momentary: the transient that darkens them leaves them dark,
   * and the next transient to take the same branch lights them again.
   */
  private waveformDarkened: boolean = false;

  /** Timestamp of the last transient that was acted on, in milliseconds. */
  private lastTransientMs: number = 0;

  /** Phase of the ring ripple, so the bands migrate rather than sitting still. */
  private ripplePhase: number = 0;

  /** Offset of the ring boundaries, in ring widths, so seams do not bake in. */
  private ringPhase: number = 0;

  /** Pre-allocated point arrays to avoid GC pressure. */
  private readonly leftPoints: Array<{x: number; y: number}>;
  private readonly rightPoints: Array<{x: number; y: number}>;
  private readonly centerPoints: Array<{x: number; y: number}>;

  /** Pre-computed layout values (updated on resize). */
  private centerX: number = 0;
  private centerY: number = 0;
  private halfWidth: number = 0;
  private minArcRadius: number = 0;
  private baseCircleRadius: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    // Pre-allocate point arrays
    this.leftPoints = new Array(PulsarVisualization.WAVEFORM_SAMPLES);
    this.rightPoints = new Array(PulsarVisualization.WAVEFORM_SAMPLES);
    this.centerPoints = new Array(PulsarVisualization.CENTER_CIRCLE_POINTS + 1);

    for (let i: number = 0; i < PulsarVisualization.WAVEFORM_SAMPLES; i++) {
      this.leftPoints[i] = {x: 0, y: 0};
      this.rightPoints[i] = {x: 0, y: 0};
    }
    for (let i: number = 0; i <= PulsarVisualization.CENTER_CIRCLE_POINTS; i++) {
      this.centerPoints[i] = {x: 0, y: 0};
    }

    // Hard-coded look; the setters below are no-ops so the (removed) controls can't change these.
    this.sensitivity = 0.2;       // 20%
    this.trailIntensity = 0;      // minimal trails
    this.lineWidth = 1;           // 1px
    this.glowIntensity = 1;       // 100%
    this.waveformSmoothing = 1;   // 100%
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;

    // Cycle hue and update cached colors if needed
    this.hueOffset = (this.hueOffset + PulsarVisualization.HUE_CYCLE_SPEED) % 360;
    this.updateGradientColors();

    // Ensure canvases exist
    if (!this.trailCanvas || !this.trailCtx || !this.tempCanvas || !this.tempCtx) {
      this.onResize();
    }

    const trailCtx: CanvasRenderingContext2D = this.trailCtx!;
    const trailCanvas: HTMLCanvasElement = this.trailCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;

    // Analyze bass frequencies to detect transients: a frame-over-frame rise in
    // low-band energy, above an absolute floor so quiet passages do not trigger
    // on noise.
    this.analyser.getByteFrequencyData(this.frequencyData);
    let bassSum: number = 0;
    for (let i: number = 0; i < PulsarVisualization.BASS_BINS; i++) {
      bassSum += this.frequencyData[i];
    }
    const bassAvg: number = bassSum / PulsarVisualization.BASS_BINS;
    const bassIncrease: number = bassAvg - this.prevBass;
    this.prevBass = bassAvg;

    const isTransient: boolean = bassIncrease > PulsarVisualization.TRANSIENT_THRESHOLD && bassAvg > PulsarVisualization.MIN_LEVEL;

    // Act on the trigger, one of two ways chosen fresh on each hit. Guarded by
    // a refractory period so a busy passage cannot act several times a second,
    // which reads as a stutter rather than as a beat.
    const now: number = performance.now();
    if (isTransient && now - this.lastTransientMs >= PulsarVisualization.TRANSIENT_REFRACTORY_MS) {
      this.lastTransientMs = now;
      if (Math.random() < PulsarVisualization.TRANSIENT_PALETTE_JUMP_CHANCE) {
        // Throw the palette somewhere else entirely and flip the arms between
        // black and lit. The hue jump is large enough to be a change of colour
        // rather than an accent, so it needs no help from the spin to register.
        this.hueOffset = (this.hueOffset + PulsarVisualization.TRANSIENT_HUE_JUMP) % 360;
        this.waveformDarkened = !this.waveformDarkened;
      } else {
        // Reverse the spin and accent the hue, as it always did.
        this.spinDirection = -this.spinDirection;
        this.hueOffset = (this.hueOffset + PulsarVisualization.TRANSIENT_HUE_KICK) % 360;
      }
      this.updateGradientColors();
    }

    // Copy current trails to temp canvas (reused, not recreated)
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(trailCanvas, 0, 0);

    // Clear trail canvas
    trailCtx.clearRect(0, 0, width, height);

    // Draw back previous trails with rotation, zoom, and fade.
    // Apply trail intensity multiplier to fade rate.
    const effectiveFadeRate: number = PulsarVisualization.FADE_RATE * this.getFadeMultiplier();
    this.ripplePhase = (this.ripplePhase + PulsarVisualization.RIPPLE_DRIFT) % TWO_PI;
    this.ringPhase = (this.ringPhase + PulsarVisualization.RING_BOUNDARY_DRIFT) % 1;
    this.drawShearedTrail(trailCtx, tempCanvas, effectiveFadeRate);

    // Get waveform data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Update waveform rotation
    this.waveformAngle -= PulsarVisualization.WAVEFORM_ROTATION_SPEED * this.spinDirection;

    // Draw the mirrored waveforms with rotation
    trailCtx.save();
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.waveformAngle);
    trailCtx.translate(-centerX, -centerY);
    this.drawMirroredWaveform(trailCtx);
    trailCtx.restore();

    // Clear main canvas and composite the trail onto it, then add a blurred
    // copy on top. The bloom is what makes the trails themselves glow: once
    // content is baked into the trail buffer there is no stroke left to hang a
    // shadow on, so the halo has to come from the buffer itself.
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(trailCanvas, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `blur(${PulsarVisualization.BLOOM_BLUR}px)`;
    ctx.globalAlpha = PulsarVisualization.BLOOM_STRENGTH;
    ctx.drawImage(trailCanvas, 0, 0);
    ctx.restore();

    // The background carries the same colour as the arms, so they read as
    // negative space in the field rather than as strokes over it.
    //
    // Slid underneath with destination-over rather than filled first: the
    // bloom above is a 'lighter' pass, and over an already-filled surface it
    // would wash the whole frame to that colour instead of haloing the trails.
    // This has to come before the fade overlay, which punches alpha out of the
    // finished frame and has to take the background with it.
    const background: {r: number; g: number; b: number} = this.waveformColor();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = `rgb(${background.r}, ${background.g}, ${background.b})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    this.applyFadeOverlay();
  }

  /**
   * Redraws the previous trail with rotation, zoom and fade, sheared by radius.
   *
   * The trail is clipped into concentric rings and each ring is turned by a
   * slightly different amount, so the outer field rotates faster than the
   * inner one. A single whole-image rotate turns every radius equally, which
   * smears rather than structures; letting neighbouring radii move at
   * different rates gives the feedback loop something to wind.
   *
   * Rings tile the trail exactly. Overlapping them would composite the shared
   * band twice and leave bright seams, which is worse than the faint one an
   * exact shared edge can leave.
   *
   * @param trailCtx - Destination trail context
   * @param tempCanvas - Copy of the previous trail to read from
   * @param fadeRate - Per-frame fade already scaled by trail intensity
   */
  private drawShearedTrail(
    trailCtx: CanvasRenderingContext2D,
    tempCanvas: HTMLCanvasElement,
    fadeRate: number
  ): void {
    // Floored to avoid a sub-pixel centre, which causes quadrant artifacts.
    const centerX: number = Math.floor(this.centerX);
    const centerY: number = Math.floor(this.centerY);
    const rings: number = Math.max(1, PulsarVisualization.TRAIL_RING_COUNT);

    // Far enough to cover the corners from wherever the centre sits.
    const maxRadius: number = Math.hypot(
      Math.max(centerX, this.width - centerX),
      Math.max(centerY, this.height - centerY)
    );

    // One extra band, because the sliding offset leaves a partial ring at each
    // end: the innermost shrinks to nothing as the offset advances and a new
    // one opens at the rim.
    const offset: number = this.ringPhase;
    for (let i: number = 0; i <= rings; i++) {
      const inner: number = Math.max(0, ((i - 1 + offset) / rings) * maxRadius);
      const outer: number = Math.min(maxRadius, ((i + offset) / rings) * maxRadius);
      if (outer <= inner) continue;
      const across: number = ((inner + outer) * 0.5) / maxRadius;
      const spin: number =
        (PulsarVisualization.ROTATION_SPEED + PulsarVisualization.RING_SHEAR * across)
        * this.spinDirection;

      // Trig Stretch in Canvas2D terms: a cosine of radius alternately expands
      // and contracts bands, travelling outward, over a small monotonic cubic.
      // Rotation is nearly uniform across rings, as it is there - the variation
      // that matters is radial.
      const ripple: number =
        Math.cos(across * TWO_PI * PulsarVisualization.RIPPLE_CYCLES - this.ripplePhase) * PulsarVisualization.RING_RIPPLE;
      const pull: number =
        PulsarVisualization.RING_CUBIC_PULL * across * across * across;
      const zoom: number = PulsarVisualization.ZOOM_SCALE + ripple - pull;

      trailCtx.save();

      // Clipped before the transform, so the ring is a region of the
      // destination rather than of the source being read.
      trailCtx.beginPath();
      trailCtx.arc(centerX, centerY, outer, 0, TWO_PI);
      if (inner > 0) {
        trailCtx.arc(centerX, centerY, inner, 0, TWO_PI, true);
      }
      trailCtx.clip();

      trailCtx.imageSmoothingEnabled = true;
      trailCtx.imageSmoothingQuality = 'high';
      trailCtx.globalAlpha = 1 - fadeRate;
      trailCtx.translate(centerX, centerY);
      trailCtx.rotate(spin);
      trailCtx.scale(zoom, zoom);
      trailCtx.translate(-centerX, -centerY);
      trailCtx.drawImage(tempCanvas, 0, 0);

      trailCtx.restore();
    }
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  // Fixed visual parameters: ignore the global controls (values set in constructor).
  public override setSensitivity(): void { /* fixed */ }
  public override setTrailIntensity(): void { /* fixed */ }
  public override setLineWidth(): void { /* fixed */ }
  public override setGlowIntensity(): void { /* fixed */ }
  public override setWaveformSmoothing(): void { /* fixed */ }

  protected override onResize(): void {
    // Pre-compute center values
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    this.halfWidth = this.width * 0.5;
    this.minArcRadius = this.halfWidth * 0.18;
    this.baseCircleRadius = this.halfWidth * 0.18 * PulsarVisualization.CONTENT_SCALE;

    // Create trail canvas if needed
    if (!this.trailCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.trailCanvas = offscreen.canvas;
      this.trailCtx = offscreen.ctx;
    }

    // Create temp canvas if needed
    if (!this.tempCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = offscreen.canvas;
      this.tempCtx = offscreen.ctx;
    }

    // Resize trail canvas while preserving content
    this.resizeCanvasPreserving(this.trailCanvas, this.trailCtx!, this.width, this.height);
    // Temp canvas doesn't need content preserved (it's just working space)
    this.tempCanvas.width = this.width;
    this.tempCanvas.height = this.height;

    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /** Cache gradient colors - only recalculate when hue changes by >= 1 degree. */
  private updateGradientColors(): void {
    const hueInt: number = Math.floor(this.hueOffset);
    if (hueInt === this.cachedHue) return;

    this.cachedHue = hueInt;
    this.cachedGradientColors = PulsarVisualization.GRADIENT_LEVELS.map(
      (level: {s: number; l: number}): {r: number; g: number; b: number} =>
        this.hslToRgb(this.hueOffset, level.s, level.l)
    );
  }

  /**
   * The colour the mirrored waveforms are drawn in.
   *
   * The background is filled with this too, so whichever state a transient has
   * left the arms in, they are the same colour as what sits behind them.
   *
   * @returns Black while a transient has them darkened, the lighter cycling
   *   colour otherwise
   */
  private waveformColor(): {r: number; g: number; b: number} {
    return this.waveformDarkened
      ? PulsarVisualization.WAVEFORM_DARK
      : PulsarVisualization.WAVEFORM_LIT;
  }

  private drawMirroredWaveform(ctx: CanvasRenderingContext2D): void {
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const halfWidth: number = this.halfWidth;
    const minArcRadius: number = this.minArcRadius;
    const sensitivityFactor: number = this.sensitivityFactor;
    const amplitudeScale: number = height * 0.3 * PulsarVisualization.CONTENT_SCALE;
    const bendStrength: number = 1.2;
    const numSamples: number = PulsarVisualization.WAVEFORM_SAMPLES;

    // How far out an arm begins. Both halves sweep from here in to the centre,
    // so `t` reads directly as a distance from it and no x coordinate is needed
    // in between - which is just as well, since past a scale of one that x
    // would sit outside the frame.
    const sweep: number = halfWidth * PulsarVisualization.WAVEFORM_LENGTH_SCALE;

    // Calculate downsampling step
    const sampleStep: number = (dataLength * 0.5) / numSamples;

    // Left half points (from the outer end in to center) - reuse pre-allocated array
    for (let i: number = 0; i < numSamples; i++) {
      const dataIndex: number = (i * sampleStep) | 0;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const t: number = i / (numSamples - 1);

      const distFromCenter: number = sweep * (1 - t);
      const arcRadius: number =
        (distFromCenter > minArcRadius ? distFromCenter : minArcRadius)
        * PulsarVisualization.CONTENT_SCALE;
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;
      const newAngle: number = Math.PI - arcAngle;

      this.leftPoints[i].x = centerX + arcRadius * Math.cos(newAngle);
      this.leftPoints[i].y = centerY + arcRadius * Math.sin(newAngle);
    }

    // Right half points (mirrored) - reuse pre-allocated array
    for (let i: number = 0; i < numSamples; i++) {
      const srcIdx: number = numSamples - 1 - i;
      const dataIndex: number = (srcIdx * sampleStep) | 0;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const t: number = srcIdx / (numSamples - 1);

      const distFromCenter: number = sweep * (1 - t);
      const arcRadius: number =
        (distFromCenter > minArcRadius ? distFromCenter : minArcRadius)
        * PulsarVisualization.CONTENT_SCALE;
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;

      this.rightPoints[i].x = centerX + arcRadius * Math.cos(arcAngle);
      this.rightPoints[i].y = centerY + arcRadius * Math.sin(arcAngle);
    }

    const color: {r: number; g: number; b: number} = this.waveformColor();

    // Draw left and right waveforms with glow
    const alpha: number = PulsarVisualization.WAVEFORM_ALPHA;
    this.drawWaveformSegment(ctx, this.leftPoints, numSamples, color, alpha);
    this.drawWaveformSegment(ctx, this.rightPoints, numSamples, color, alpha);

    // Draw center circle
    this.drawCenterCircle(ctx);
  }

  private drawCenterCircle(ctx: CanvasRenderingContext2D): void {
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const baseRadius: number = this.baseCircleRadius;
    const numPoints: number = PulsarVisualization.CENTER_CIRCLE_POINTS;
    const sensitivityFactor: number = this.sensitivityFactor;
    const amplitudeScale: number = height * 0.08 * PulsarVisualization.CONTENT_SCALE;
    const sampleStep: number = (dataLength * 0.25) / numPoints;

    // Calculate points (reuse pre-allocated array)
    for (let i: number = 0; i <= numPoints; i++) {
      const angle: number = (i / numPoints) * Math.PI * 2;
      const dataIndex: number = ((i * sampleStep) | 0) % dataLength;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const radius: number = baseRadius + sample * amplitudeScale;

      this.centerPoints[i].x = centerX + radius * Math.cos(angle);
      this.centerPoints[i].y = centerY + radius * Math.sin(angle);
    }

    const color: {r: number; g: number; b: number} = this.cachedGradientColors[this.cachedGradientColors.length - 1];
    const points: Array<{x: number; y: number}> = this.centerPoints;

    // Build smooth closed path using the base class helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, points, numPoints);
      ctx.closePath();
    };

    this.strokeNeon(ctx, buildPath, color, 1);
  }

  /**
   * Strokes a path as a neon tube: saturated halo, coloured core, hot centre.
   *
   * All three passes composite additively, which is what makes it read as
   * emitting rather than as a wide coloured line - where strokes overlap they
   * reinforce toward white instead of flattening to a constant.
   *
   * The wide part of the halo comes from the shadow rather than the stroke
   * width; the shadow alpha is therefore the dial for how far the colour
   * spreads, and the stroke alpha for how solid the tube looks.
   *
   * @param ctx - Destination context
   * @param buildPath - Rebuilds the path; called once per pass
   * @param color - Colour of every pass, halo included
   * @param alpha - Overall opacity applied to every pass
   */
  private strokeNeon(
    ctx: CanvasRenderingContext2D,
    buildPath: () => void,
    color: {r: number; g: number; b: number},
    alpha: number
  ): void {
    const blur: number = this.getScaledGlowBlur(PulsarVisualization.BASE_GLOW_BLUR);
    const r: number = color.r;
    const g: number = color.g;
    const b: number = color.b;

    // Deliberately not additive. These strokes land in the trail buffer, which
    // accumulates and fades at a fraction of a percent per frame, so anything
    // drawn with 'lighter' compounds frame on frame and saturates to white
    // within seconds. The neon look here comes from layering - wide soft halo,
    // core, hot filament - not from blend mode.
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Halo.
    ctx.shadowBlur = blur;
    ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${PulsarVisualization.NEON_HALO_SHADOW_ALPHA * alpha})`;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${PulsarVisualization.NEON_HALO_ALPHA * alpha})`;
    ctx.lineWidth = this.lineWidth + PulsarVisualization.NEON_HALO_WIDTH;
    buildPath();
    ctx.stroke();

    // Core. Keeps the halo's shadow colour, tightened.
    ctx.shadowBlur = blur * PulsarVisualization.NEON_CORE_BLUR_SCALE;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.lineWidth = this.lineWidth;
    buildPath();
    ctx.stroke();

    // Hot centre. No shadow: this pass is the filament, not the glow.
    const lift: number = PulsarVisualization.NEON_HOT_LIFT;
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(${Math.min(255, r + lift)}, ${Math.min(255, g + lift)}, `
      + `${Math.min(255, b + lift)}, ${PulsarVisualization.NEON_HOT_ALPHA * alpha})`;
    ctx.lineWidth = Math.max(1, this.lineWidth * PulsarVisualization.NEON_HOT_WIDTH_FRACTION);
    buildPath();
    ctx.stroke();

    ctx.restore();
  }

  private drawWaveformSegment(
    ctx: CanvasRenderingContext2D,
    points: Array<{x: number; y: number}>,
    count: number,
    color: {r: number; g: number; b: number},
    alpha: number
  ): void {
    if (count < 2) return;

    // Build path using the base class smooth path helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, points, count - 1);
    };

    this.strokeNeon(ctx, buildPath, color, alpha);
  }

  public override destroy(): void {
    this.trailCanvas = null;
    this.trailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}
