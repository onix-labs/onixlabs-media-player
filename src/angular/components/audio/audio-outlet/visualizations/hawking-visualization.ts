/**
 * @fileoverview Hawking visualization with dual spiked circular waveforms.
 *
 * Two overlapping circular waveforms sit in the middle of the screen, one
 * red and one blue, each rendered as radial spikes (rather than a smooth
 * wave) whose lengths follow the audio. The time-domain waveform data is
 * repeated twice around each circle, giving the shapes two-fold symmetry.
 * The circles counter-rotate slowly, and their trails zoom outward like
 * sparks shedding from the ring.
 *
 * Colouring: both circles use a gradient that turns slowly, red one way and
 * blue the other, so the vivid end walks round the shape — vibrant at one end
 * of the screen, fading out toward the top. The two hues start at red and
 * blue and cycle slowly through the palette (as in Reactor), keeping their
 * separation; particles keep the hue they were born with. Overlapping
 * trails blend additively.
 *
 * @module app/components/audio/audio-outlet/visualizations/hawking-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';

/**
 * A single emitted particle. Particles spawn on the waveform circle's
 * circumference, fly outward, and fade to nothing.
 */
interface Particle {
  /** Position (px) */
  x: number;
  y: number;
  /** Velocity (px/frame) */
  vx: number;
  vy: number;
  /** Radius (px) */
  size: number;
  /** Remaining life (1 → 0; dead at 0) */
  life: number;
  /** Life lost per frame */
  decay: number;
  /** Peak opacity (0-1), driven by the waveform amplitude at spawn */
  intensity: number;
  /** Hue (0-360) the particle was born with (its circle's hue at spawn) */
  hue: number;
  /** Whether the particle is filled (true) or an outline (false) */
  filled: boolean;
}

/**
 * Hawking visualization with two overlapping spiked circular waveforms.
 *
 * Renders red and blue spike rings at the screen centre, counter-rotating,
 * with outward-drifting additive trails.
 */
export class HawkingVisualization extends Canvas2DVisualization {
  /** Per-frame trail fade rate. */
  private static readonly FADE_RATE: number = 0.035;

  /** Per-frame outward zoom applied to the trails. */
  private static readonly ZOOM_SCALE: number = 1.008;

  /** Base glow blur radius in pixels. */
  private static readonly BASE_GLOW_BLUR: number = 12;

  /** Number of spikes around each circle. */
  private static readonly SPIKE_COUNT: number = 128;

  /** How many times the waveform data repeats around each circle. */
  private static readonly DATA_REPEATS: number = 2;

  /**
   * Radians the colour gradient turns per frame, red one way and blue the
   * other. A fraction of the geometry's rate: the colour is meant to drift
   * across the shape rather than travel with it.
   */
  private static readonly COLOR_ROTATION_SPEED: number = 0.003;

  /** Radians the red circle rotates per frame (blue rotates opposite). */
  private static readonly ROTATION_SPEED: number = 0.012;

  /** Base circle radius as a fraction of the shorter screen dimension. */
  private static readonly BASE_RADIUS_FRACTION: number = 0.28;

  /** Maximum spike length as a fraction of the base radius (keeps
   *  full-amplitude spike tips just inside the shorter screen edge). */
  private static readonly SPIKE_LENGTH_FRACTION: number = 0.75;

  /** Data sampling offset for the blue circle, as a fraction of the spikes. */
  private static readonly BLUE_DATA_OFFSET_FRACTION: number = 0.25;

  /** Line width of the base ring outline. */
  private static readonly RING_LINE_WIDTH: number = 1.5;

  /** Starting hue for the first circle (red). */
  private static readonly START_HUE_1: number = 0;

  /** Starting hue for the second circle (blue). */
  private static readonly START_HUE_2: number = 220;

  /** Degrees the hues advance per frame (palette cycling, as in Reactor). */
  private static readonly HUE_CYCLE_SPEED: number = 0.5;

  /** Gradient lightness (%) at the vivid bottom stop. */
  private static readonly GRADIENT_LIGHTNESS_BOTTOM: number = 50;

  /** Gradient lightness (%) at the faded top stop. */
  private static readonly GRADIENT_LIGHTNESS_TOP: number = 52;

  /** Gradient alpha at the faded top stop. */
  private static readonly GRADIENT_TOP_ALPHA: number = 0.45;

  /** Glow colour lightness (%). */
  private static readonly GLOW_LIGHTNESS: number = 55;

  /** Particle colour lightness (%). */
  private static readonly PARTICLE_LIGHTNESS: number = 56;

  /** Maximum live particles (shared pool for both circles). */
  private static readonly MAX_PARTICLES: number = 320;

  /** Spawn attempts per circle per frame (each rolls against the amplitude). */
  private static readonly SPAWN_ATTEMPTS: number = 5;

  /** Spawn probability multiplier applied to the sampled amplitude. */
  private static readonly SPAWN_PROBABILITY: number = 0.85;

  /** Minimum particle radius (px). */
  private static readonly PARTICLE_MIN_SIZE: number = 2.5;

  /** Random particle radius range above the minimum (px). */
  private static readonly PARTICLE_SIZE_RANGE: number = 9;

  /** Base outward particle speed (px/frame). */
  private static readonly PARTICLE_BASE_SPEED: number = 0.6;

  /** Additional outward speed scaled by amplitude (px/frame). */
  private static readonly PARTICLE_AMP_SPEED: number = 2.2;

  /** Maximum random sideways (tangential) speed (px/frame). */
  private static readonly PARTICLE_SIDEWAYS_SPEED: number = 0.45;

  /** Minimum per-frame life decay (≈1.4s lifetime at 60fps). */
  private static readonly PARTICLE_DECAY_MIN: number = 0.012;

  /** Random additional per-frame life decay. */
  private static readonly PARTICLE_DECAY_RANGE: number = 0.018;

  /** Outline stroke width as a fraction of the particle size (min 1px). */
  private static readonly PARTICLE_OUTLINE_FRACTION: number = 0.3;

  public readonly name: string = 'Hawking';
  public readonly category: string = 'Bars & Waves';

  private dataArray: Uint8Array<ArrayBuffer>;

  /** Trail canvases for each circle. */
  private redTrailCanvas: HTMLCanvasElement | null = null;
  private redTrailCtx: CanvasRenderingContext2D | null = null;
  private blueTrailCanvas: HTMLCanvasElement | null = null;
  private blueTrailCtx: CanvasRenderingContext2D | null = null;

  /** Temp canvas for the zoom effect. */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Current hue of each circle (0-360; circle 1 starts red, 2 starts blue). */
  private hue1: number = HawkingVisualization.START_HUE_1;
  private hue2: number = HawkingVisualization.START_HUE_2;

  /** Integer hues the cached styles were built for (-1 = uncached). */
  private cachedStyleHue1: number = -1;
  private cachedStyleHue2: number = -1;

  /** Cached vertical gradients (rebuilt on hue change or resize). */
  private gradient1: CanvasGradient | null = null;
  private gradient2: CanvasGradient | null = null;

  /** Cached glow colours (rebuilt alongside the gradients). */
  private glow1: string = '';
  private glow2: string = '';

  /** Screen centre and ring geometry (recomputed on resize). */
  private screenCenterX: number = 0;
  private screenCenterY: number = 0;
  private baseRadius: number = 0;

  /** Current angle of the red gradient (blue is its negation). */
  private colorAngle: number = 0;

  /** Current rotation angle of the red circle (blue is its negation). */
  private rotationAngle: number = 0;

  /** Pre-allocated particle pool (dead particles have life <= 0). */
  private readonly particles: Particle[];

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;

    // Pre-allocate the particle pool
    this.particles = [];
    for (let i: number = 0; i < HawkingVisualization.MAX_PARTICLES; i++) {
      this.particles.push({x: 0, y: 0, vx: 0, vy: 0, size: 0, life: 0, decay: 0, intensity: 0, hue: 0, filled: true});
    }
    // Hard-coded look; the setters below are no-ops so the (removed) controls can't change these.
    this.sensitivity = 0.5;       // 50%
    this.trailIntensity = 0.5;    // 50%
    this.lineWidth = 2;           // 2px
    this.glowIntensity = 0.5;     // 50%
    this.waveformSmoothing = 0;   // spikes, not curves
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    if (width <= 0 || height <= 0) return;

    // Ensure canvases exist
    if (!this.redTrailCanvas || !this.blueTrailCanvas || !this.tempCanvas) {
      this.onResize();
    }

    // Get time domain data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Counter-rotate the circles
    this.rotationAngle += HawkingVisualization.ROTATION_SPEED;
    this.colorAngle += HawkingVisualization.COLOR_ROTATION_SPEED;

    // Cycle both hues through the palette (they keep their 220° separation)
    this.hue1 = (this.hue1 + HawkingVisualization.HUE_CYCLE_SPEED) % 360;
    this.hue2 = (this.hue2 + HawkingVisualization.HUE_CYCLE_SPEED) % 360;
    this.refreshCircleStyles();

    const spikeScale: number = this.baseRadius * HawkingVisualization.SPIKE_LENGTH_FRACTION;
    const blueDataOffset: number = Math.floor(HawkingVisualization.SPIKE_COUNT * HawkingVisualization.BLUE_DATA_OFFSET_FRACTION);

    // Red circle (rotates clockwise; trails drift outward)
    this.applyDirectionalZoom(
      this.redTrailCanvas!, this.redTrailCtx!,
      this.tempCanvas!, this.tempCtx!,
      this.screenCenterX, this.screenCenterY,
      HawkingVisualization.FADE_RATE, HawkingVisualization.ZOOM_SCALE
    );
    this.drawSpikeCircle(this.redTrailCtx!, this.rotationAngle, 0, spikeScale, this.gradient1!, this.glow1);

    // Blue circle (rotates counter-clockwise, samples offset for variation)
    this.applyDirectionalZoom(
      this.blueTrailCanvas!, this.blueTrailCtx!,
      this.tempCanvas!, this.tempCtx!,
      this.screenCenterX, this.screenCenterY,
      HawkingVisualization.FADE_RATE, HawkingVisualization.ZOOM_SCALE
    );
    this.drawSpikeCircle(this.blueTrailCtx!, -this.rotationAngle, blueDataOffset, spikeScale, this.gradient2!, this.glow2);

    // Emit new particles from each circle's circumference (spawn chance,
    // size, speed, and intensity all follow the waveform amplitude at the
    // sampled position)
    this.spawnParticles(this.rotationAngle, 0, this.hue1, 1);
    this.spawnParticles(-this.rotationAngle, blueDataOffset, this.hue2, -1);

    // Composite both trail canvases to the main canvas with additive
    // blending so the overlapping circles mix rather than occlude
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.redTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.blueTrailCanvas!, 0, 0);

    // Particles render additively on top, then fade out as they fly
    this.updateAndDrawParticles(ctx);
    ctx.globalCompositeOperation = 'source-over';

    this.applyFadeOverlay();
  }

  /**
   * Attempts to emit particles from a circle's circumference.
   *
   * A handful of random spike positions are sampled each frame; each rolls
   * its waveform amplitude as the spawn probability, so louder audio sheds
   * more, bigger, brighter, and faster particles. Particles inherit a slight
   * sideways drift in the circle's rotation direction.
   *
   * @param rotation - The circle's current rotation angle (rad)
   * @param dataOffset - Spike-index offset into the data mapping
   * @param hue - The circle's current hue; particles keep it as they fade
   * @param rotationSign - Rotation direction (+1 or -1) for sideways drift
   */
  private spawnParticles(rotation: number, dataOffset: number, hue: number, rotationSign: number): void {
    const spikeCount: number = HawkingVisualization.SPIKE_COUNT;
    const dataLength: number = this.dataArray.length;

    for (let attempt: number = 0; attempt < HawkingVisualization.SPAWN_ATTEMPTS; attempt++) {
      const spike: number = Math.floor(Math.random() * spikeCount);

      // Same data mapping as the spikes (repeated around the circle)
      const repeatPosition: number = ((spike + dataOffset) * HawkingVisualization.DATA_REPEATS) % spikeCount;
      const dataIndex: number = Math.floor((repeatPosition / spikeCount) * dataLength);
      const amplitude: number = Math.min(1, Math.abs((this.dataArray[dataIndex] - 128) / 128) * this.sensitivityFactor);

      if (Math.random() >= amplitude * HawkingVisualization.SPAWN_PROBABILITY) continue;

      const particle: Particle | undefined = this.particles.find((p: Particle): boolean => p.life <= 0);
      if (!particle) return;

      const angle: number = rotation + (spike / spikeCount) * Math.PI * 2 - Math.PI / 2;
      const cos: number = Math.cos(angle);
      const sin: number = Math.sin(angle);
      const outwardSpeed: number = HawkingVisualization.PARTICLE_BASE_SPEED
        + amplitude * HawkingVisualization.PARTICLE_AMP_SPEED
        + Math.random() * HawkingVisualization.PARTICLE_BASE_SPEED;
      const sidewaysSpeed: number = rotationSign * Math.random() * HawkingVisualization.PARTICLE_SIDEWAYS_SPEED;

      particle.x = this.screenCenterX + cos * this.baseRadius;
      particle.y = this.screenCenterY + sin * this.baseRadius;
      particle.vx = cos * outwardSpeed - sin * sidewaysSpeed;
      particle.vy = sin * outwardSpeed + cos * sidewaysSpeed;
      particle.size = HawkingVisualization.PARTICLE_MIN_SIZE
        + Math.random() * HawkingVisualization.PARTICLE_SIZE_RANGE * (0.35 + amplitude * 0.65);
      particle.life = 1;
      particle.decay = HawkingVisualization.PARTICLE_DECAY_MIN + Math.random() * HawkingVisualization.PARTICLE_DECAY_RANGE;
      particle.intensity = (0.35 + amplitude * 0.65) * (0.6 + Math.random() * 0.4);
      particle.hue = Math.round(hue) % 360;
      // Circles only. Squares read as debris rather than as radiation, and the
      // corners gave away that the emission is drawn rather than emitted.
      particle.filled = Math.random() < 0.5;
    }
  }

  /**
   * Advances and renders all live particles: they fly outward along their
   * velocity and fade linearly to nothing as their life runs out.
   *
   * @param ctx - The main canvas context (additive compositing active)
   */
  private updateAndDrawParticles(ctx: CanvasRenderingContext2D): void {
    for (const particle of this.particles) {
      if (particle.life <= 0) continue;

      particle.life -= particle.decay;
      if (particle.life <= 0) continue;

      particle.x += particle.vx;
      particle.y += particle.vy;

      const alpha: number = particle.life * particle.intensity;
      const color: string = `hsla(${particle.hue}, 100%, ${HawkingVisualization.PARTICLE_LIGHTNESS}%, ${alpha})`;
      const size: number = particle.size;

      ctx.beginPath();
      ctx.arc(particle.x, particle.y, size, 0, Math.PI * 2);
      if (particle.filled) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, size * HawkingVisualization.PARTICLE_OUTLINE_FRACTION);
        ctx.stroke();
      }
    }
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  // Fixed visual parameters: ignore the global controls (values set in constructor).
  public override setSensitivity(): void { /* fixed */ }
  public override setTrailIntensity(): void { /* fixed */ }
  public override setLineWidth(): void { /* fixed */ }
  public override setGlowIntensity(): void { /* fixed */ }
  public override setWaveformSmoothing(): void { /* fixed */ }

  protected override onResize(): void {
    const width: number = this.width;
    const height: number = this.height;

    this.screenCenterX = width / 2;
    this.screenCenterY = height / 2;
    this.baseRadius = Math.min(width, height) * HawkingVisualization.BASE_RADIUS_FRACTION;

    // Create trail canvases if needed
    if (!this.redTrailCanvas) {
      const redTrail: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.redTrailCanvas = redTrail.canvas;
      this.redTrailCtx = redTrail.ctx;
    }

    if (!this.blueTrailCanvas) {
      const blueTrail: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.blueTrailCanvas = blueTrail.canvas;
      this.blueTrailCtx = blueTrail.ctx;
    }

    if (!this.tempCanvas) {
      const temp: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = temp.canvas;
      this.tempCtx = temp.ctx;
    }

    // Resize canvases while preserving trail content
    this.resizeCanvasPreserving(this.redTrailCanvas, this.redTrailCtx!, width, height);
    this.resizeCanvasPreserving(this.blueTrailCanvas, this.blueTrailCtx!, width, height);
    // Temp canvas doesn't need content preserved (it's just working space)
    this.tempCanvas.width = width;
    this.tempCanvas.height = height;

    // Gradients are height-dependent — force a rebuild at the current hues
    this.cachedStyleHue1 = -1;
    this.cachedStyleHue2 = -1;
    this.refreshCircleStyles();

    this.ctx.clearRect(0, 0, width, height);
  }

  /**
   * Rebuilds each circle's vertical gradient (vivid at the bottom of the
   * screen, faded at the top) and glow colour when its hue has drifted to a
   * new integer degree. Cached per integer hue so the palette cycling
   * doesn't allocate a gradient every frame.
   */
  private refreshCircleStyles(): void {
    const intHue1: number = Math.round(this.hue1) % 360;
    if (intHue1 !== this.cachedStyleHue1) {
      this.cachedStyleHue1 = intHue1;
      this.glow1 = `hsla(${intHue1}, 100%, ${HawkingVisualization.GLOW_LIGHTNESS}%, 1)`;
    }

    const intHue2: number = Math.round(this.hue2) % 360;
    if (intHue2 !== this.cachedStyleHue2) {
      this.cachedStyleHue2 = intHue2;
      this.glow2 = `hsla(${intHue2}, 100%, ${HawkingVisualization.GLOW_LIGHTNESS}%, 1)`;
    }

    // The gradients turn every frame, so unlike the glows they cannot be cached
    // against the hue. Two per frame is nothing next to what the trails cost.
    this.gradient1 = this.buildAngledGradient(intHue1, this.colorAngle);
    this.gradient2 = this.buildAngledGradient(intHue2, -this.colorAngle);
  }

  /**
   * Builds the stroke gradient for a hue along an axis through the centre.
   *
   * At an angle of zero the axis runs bottom to top, which is where this
   * started as a fixed vertical gradient. Turning it walks the vivid end round
   * the shape instead of pinning it to the bottom of the screen, and the two
   * circles turn opposite ways so their colour crosses rather than tracks.
   *
   * The axis spans the screen diagonal from the centre, so the gradient covers
   * the corners at every angle rather than running out partway round.
   *
   * @param hue - Integer hue (0-360)
   * @param angle - Angle of the gradient axis (rad)
   * @returns The gradient, or null if the trail context isn't ready yet
   */
  private buildAngledGradient(hue: number, angle: number): CanvasGradient | null {
    const ctx: CanvasRenderingContext2D | null = this.redTrailCtx ?? this.blueTrailCtx;
    if (!ctx) return null;

    const reach: number = Math.hypot(this.width, this.height) * 0.5;
    const dx: number = Math.sin(angle) * reach;
    const dy: number = -Math.cos(angle) * reach;
    const gradient: CanvasGradient = ctx.createLinearGradient(
      this.screenCenterX - dx, this.screenCenterY - dy,
      this.screenCenterX + dx, this.screenCenterY + dy
    );
    gradient.addColorStop(0, `hsla(${hue}, 100%, ${HawkingVisualization.GRADIENT_LIGHTNESS_BOTTOM}%, 1)`);
    gradient.addColorStop(1, `hsla(${hue}, 100%, ${HawkingVisualization.GRADIENT_LIGHTNESS_TOP}%, ${HawkingVisualization.GRADIENT_TOP_ALPHA})`);
    return gradient;
  }

  /**
   * Draws one spiked circular waveform onto a trail canvas.
   *
   * Each spike is a radial line from the base ring outward, its length
   * driven by the waveform sample for that position. The time-domain data
   * is repeated {@link DATA_REPEATS} times around the circle, giving the
   * shape rotational symmetry. A thin base ring anchors the spikes.
   *
   * @param trailCtx - The trail canvas context to draw into
   * @param rotation - Rotation angle of the circle (rad)
   * @param dataOffset - Spike-index offset into the data mapping (varies the
   *   pattern between the two circles)
   * @param spikeScale - Maximum spike length in pixels
   * @param gradient - Stroke gradient (vibrant bottom, faded top)
   * @param glowColor - Shadow colour for the glow pass
   */
  private drawSpikeCircle(
    trailCtx: CanvasRenderingContext2D,
    rotation: number,
    dataOffset: number,
    spikeScale: number,
    gradient: CanvasGradient,
    glowColor: string
  ): void {
    const spikeCount: number = HawkingVisualization.SPIKE_COUNT;
    const dataLength: number = this.dataArray.length;
    const centerX: number = this.screenCenterX;
    const centerY: number = this.screenCenterY;
    const baseRadius: number = this.baseRadius;

    trailCtx.save();
    trailCtx.strokeStyle = gradient;
    trailCtx.lineCap = 'round';
    trailCtx.shadowColor = glowColor;
    trailCtx.shadowBlur = this.getScaledGlowBlur(HawkingVisualization.BASE_GLOW_BLUR);

    // Spikes: radial lines whose length follows the waveform amplitude.
    // The data maps onto 1/DATA_REPEATS of the circle and repeats around it.
    trailCtx.lineWidth = this.lineWidth;
    trailCtx.beginPath();
    for (let i: number = 0; i < spikeCount; i++) {
      const angle: number = rotation + (i / spikeCount) * Math.PI * 2 - Math.PI / 2;

      // Repeat the waveform data around the circle
      const repeatPosition: number = ((i + dataOffset) * HawkingVisualization.DATA_REPEATS) % spikeCount;
      const dataIndex: number = Math.floor((repeatPosition / spikeCount) * dataLength);
      const amplitude: number = Math.abs((this.dataArray[dataIndex] - 128) / 128) * this.sensitivityFactor;

      const spikeLength: number = amplitude * spikeScale;
      const cos: number = Math.cos(angle);
      const sin: number = Math.sin(angle);

      trailCtx.moveTo(centerX + cos * baseRadius, centerY + sin * baseRadius);
      trailCtx.lineTo(centerX + cos * (baseRadius + spikeLength), centerY + sin * (baseRadius + spikeLength));
    }
    trailCtx.stroke();

    // Thin base ring anchoring the spikes
    trailCtx.lineWidth = HawkingVisualization.RING_LINE_WIDTH;
    trailCtx.beginPath();
    trailCtx.arc(centerX, centerY, baseRadius, 0, Math.PI * 2);
    trailCtx.stroke();

    trailCtx.restore();
  }

  public override destroy(): void {
    this.redTrailCanvas = null;
    this.redTrailCtx = null;
    this.blueTrailCanvas = null;
    this.blueTrailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
    this.gradient1 = null;
    this.gradient2 = null;
    this.cachedStyleHue1 = -1;
    this.cachedStyleHue2 = -1;
  }
}
