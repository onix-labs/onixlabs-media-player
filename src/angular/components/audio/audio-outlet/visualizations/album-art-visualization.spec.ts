/**
 * @fileoverview Unit tests for the Album Art visualization.
 *
 * Tests cover:
 * - Loading: track artwork, the placeholder fallback, superseded loads,
 *   reloading when the track changes
 * - Artwork: fitted, centred, clipped to rounded corners
 * - Background: blurred wash built once and reused, rebuilt on change
 * - Drop shadow: built once and reused, rebuilt when the drawn size changes
 * - Edge inputs: no artwork, undecoded image, zero-sized and tiny canvases
 *
 * Canvas 2D, the analyser and the Image constructor are faked; see
 * visualization-test-fakes.group2.
 *
 * @module app/components/audio/audio-outlet/visualizations/album-art-visualization.spec
 */

import {AlbumArtVisualization} from './album-art-visualization';
import {
  FakeAnalyser,
  FakeContext2D,
  FakeImage,
  installCanvasFakes,
  installFakeClock,
  installFakeImage,
} from './visualization-test-fakes.group2';
import type {CanvasFakes, FakeClock, ImageFakes, RecordedCall} from './visualization-test-fakes.group2';

// ============================================================================
// Helpers
// ============================================================================

const WIDTH: number = 800;
const HEIGHT: number = 600;

/** Side of the box the artwork is fitted into at 800x600: 70% of the shorter side. */
const ART_SIZE: number = 420;

const PLACEHOLDER: string = 'album-art.png';
const TRACK_A: string = 'http://localhost/artwork/a';
const TRACK_B: string = 'http://localhost/artwork/b';

/** Asserts a recorded rectangle-like argument list, tolerating float rounding. */
function expectNumbersClose(actual: readonly unknown[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value: number, index: number): void => {
    expect(actual[index]).toBeCloseTo(value, 6);
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('AlbumArtVisualization', (): void => {
  let fakes: CanvasFakes;
  let clock: FakeClock;
  let imageFakes: ImageFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let viz: AlbumArtVisualization;
  let main: FakeContext2D;

  /** The off-screen contexts, in the order the first full draw creates them. */
  const backgroundSource = (): FakeContext2D => fakes.contexts[1];
  const background = (): FakeContext2D => fakes.contexts[2];
  const shadow = (): FakeContext2D => fakes.contexts[3];

  /** Requests a track's artwork and completes the load at the given size. */
  function loadArtwork(url: string, width: number = 1000, height: number = 1000): FakeImage {
    viz.setArtworkUrl(url);
    const image: FakeImage = imageFakes.images[imageFakes.images.length - 1];
    image.succeed(width, height);
    return image;
  }

  /** The images drawn on the main canvas that are artwork rather than off-screen surfaces. */
  function artworkDraws(): RecordedCall[] {
    return main.callsTo('drawImage').filter((call: RecordedCall): boolean => call.args[0] instanceof FakeImage);
  }

  beforeEach((): void => {
    clock = installFakeClock();
    fakes = installCanvasFakes();
    imageFakes = installFakeImage();
    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new AlbumArtVisualization({canvas, analyser: analyser.node});
    main = fakes.contextFor(canvas);
    viz.resize(WIDTH, HEIGHT);
  });

  afterEach((): void => {
    imageFakes.restore();
    fakes.restore();
    clock.restore();
    vi.restoreAllMocks();
  });

  describe('construction', (): void => {
    it('identifies itself as Album Art in the Simple category', (): void => {
      expect(viz.name).toBe('Album Art');
      expect(viz.category).toBe('Simple');
    });

    it('asks to be rendered at native resolution', (): void => {
      expect(viz.rendersAtNativeResolution).toBe(true);
    });

    it('loads nothing until it is told about a track', (): void => {
      expect(imageFakes.images).toEqual([]);
    });
  });

  describe('loading artwork', (): void => {
    it('requests the track artwork from the given URL', (): void => {
      viz.setArtworkUrl(TRACK_A);

      expect(imageFakes.images.map((image: FakeImage): string => image.src)).toEqual([TRACK_A]);
    });

    it('requests the placeholder when the track cannot have artwork', (): void => {
      viz.setArtworkUrl(null);

      expect(imageFakes.images.map((image: FakeImage): string => image.src)).toEqual([PLACEHOLDER]);
    });

    it('does not reload when given the same URL again', (): void => {
      viz.setArtworkUrl(TRACK_A);

      viz.setArtworkUrl(TRACK_A);

      expect(imageFakes.images).toHaveLength(1);
    });

    it('does not reload the placeholder when told again there is no artwork', (): void => {
      viz.setArtworkUrl(null);

      viz.setArtworkUrl(null);

      expect(imageFakes.images).toHaveLength(1);
    });

    it('requests the new artwork when the track changes', (): void => {
      loadArtwork(TRACK_A);

      viz.setArtworkUrl(TRACK_B);

      expect(imageFakes.images.map((image: FakeImage): string => image.src)).toEqual([TRACK_A, TRACK_B]);
    });

    it('requests the artwork again when returning to an earlier track', (): void => {
      loadArtwork(TRACK_A);
      loadArtwork(TRACK_B);

      viz.setArtworkUrl(TRACK_A);

      expect(imageFakes.images.map((image: FakeImage): string => image.src)).toEqual([TRACK_A, TRACK_B, TRACK_A]);
    });

    it('falls back to the placeholder when the artwork fails to load', (): void => {
      viz.setArtworkUrl(TRACK_A);

      imageFakes.images[0].fail();

      expect(imageFakes.images.map((image: FakeImage): string => image.src)).toEqual([TRACK_A, PLACEHOLDER]);
    });

    it('shows the placeholder once it has loaded after a failed artwork load', (): void => {
      viz.setArtworkUrl(TRACK_A);
      imageFakes.images[0].fail();
      imageFakes.images[1].succeed(512, 512);

      viz.draw();

      expect(artworkDraws()[0].args[0]).toBe(imageFakes.images[1]);
    });

    it('gives up quietly when the placeholder itself fails to load', (): void => {
      viz.setArtworkUrl(TRACK_A);
      imageFakes.images[0].fail();
      imageFakes.images[1].fail();
      main.clear();

      viz.draw();

      expect(imageFakes.images).toHaveLength(2);
      expect(main.callsTo('drawImage')).toEqual([]);
    });

    it('switches to the placeholder when a track with artwork is followed by one without', (): void => {
      loadArtwork(TRACK_A);
      viz.setArtworkUrl(null);
      imageFakes.images[1].succeed(512, 512);

      viz.draw();

      expect(artworkDraws()[0].args[0]).toBe(imageFakes.images[1]);
    });
  });

  describe('superseded loads', (): void => {
    it('keeps showing the previous artwork while the next is still loading', (): void => {
      const first: FakeImage = loadArtwork(TRACK_A);
      viz.setArtworkUrl(TRACK_B);

      viz.draw();

      expect(artworkDraws()[0].args[0]).toBe(first);
    });

    it('shows the new artwork once it has loaded', (): void => {
      loadArtwork(TRACK_A);
      const second: FakeImage = loadArtwork(TRACK_B);

      viz.draw();

      expect(artworkDraws()[0].args[0]).toBe(second);
    });

    it('discards artwork that finishes loading after the track has changed again', (): void => {
      viz.setArtworkUrl(TRACK_A);
      const stale: FakeImage = imageFakes.images[0];
      const current: FakeImage = loadArtwork(TRACK_B);

      stale.succeed(1000, 1000);
      viz.draw();

      expect(artworkDraws()[0].args[0]).toBe(current);
    });

    it('does not fall back to the placeholder when a superseded load fails', (): void => {
      viz.setArtworkUrl(TRACK_A);
      const stale: FakeImage = imageFakes.images[0];
      viz.setArtworkUrl(TRACK_B);

      stale.fail();

      expect(imageFakes.images.map((image: FakeImage): string => image.src)).toEqual([TRACK_A, TRACK_B]);
    });
  });

  describe('drawing with no artwork', (): void => {
    it('only clears the canvas before any artwork has loaded', (): void => {
      viz.setArtworkUrl(TRACK_A);
      main.clear();

      viz.draw();

      expect(main.calls.map((call: RecordedCall): string => call.name)).toEqual(['clearRect']);
      expect(main.calls[0].args).toEqual([0, 0, WIDTH, HEIGHT]);
    });

    it('only clears the canvas for an image that decoded to nothing', (): void => {
      loadArtwork(TRACK_A, 0, 0);
      main.clear();

      viz.draw();

      expect(main.calls.map((call: RecordedCall): string => call.name)).toEqual(['clearRect']);
    });

    it.each([
      ['a width but no height', 100, 0],
      ['a height but no width', 0, 100],
    ])('only clears the canvas for an image with %s', (_label: string, width: number, height: number): void => {
      loadArtwork(TRACK_A, width, height);
      main.clear();

      viz.draw();

      expect(main.calls.map((call: RecordedCall): string => call.name)).toEqual(['clearRect']);
    });

    it('does nothing at all on a zero-sized canvas', (): void => {
      loadArtwork(TRACK_A);
      viz.resize(0, 0);
      main.clear();

      viz.draw();

      expect(main.calls).toEqual([]);
    });
  });

  describe('artwork', (): void => {
    it('centres square artwork in a box 70% of the shorter side', (): void => {
      const image: FakeImage = loadArtwork(TRACK_A, 1000, 1000);

      viz.draw();

      const draw: RecordedCall = artworkDraws()[0];
      expect(draw.args[0]).toBe(image);
      expectNumbersClose(draw.args.slice(1), [190, 90, ART_SIZE, ART_SIZE]);
    });

    it('fits landscape artwork to the box width, keeping its aspect ratio', (): void => {
      loadArtwork(TRACK_A, 2000, 1000);

      viz.draw();

      expectNumbersClose(artworkDraws()[0].args.slice(1), [190, 195, ART_SIZE, ART_SIZE / 2]);
    });

    it('fits portrait artwork to the box height, keeping its aspect ratio', (): void => {
      loadArtwork(TRACK_A, 500, 1000);

      viz.draw();

      expectNumbersClose(artworkDraws()[0].args.slice(1), [295, 90, ART_SIZE / 2, ART_SIZE]);
    });

    it('scales small artwork up to fill the box', (): void => {
      loadArtwork(TRACK_A, 100, 100);

      viz.draw();

      expectNumbersClose(artworkDraws()[0].args.slice(1), [190, 90, ART_SIZE, ART_SIZE]);
    });

    it('sizes the box from the height on a wide view and the width on a tall one', (): void => {
      loadArtwork(TRACK_A);
      viz.resize(600, 800);

      viz.draw();

      expectNumbersClose(artworkDraws()[0].args.slice(1), [90, 190, ART_SIZE, ART_SIZE]);
    });

    it('clips the artwork to rounded corners 4% of its shorter side', (): void => {
      loadArtwork(TRACK_A, 2000, 1000);

      viz.draw();

      const names: string[] = main.calls.map((call: RecordedCall): string => call.name);
      expectNumbersClose(main.callsTo('roundRect')[0].args, [190, 195, ART_SIZE, ART_SIZE / 2, ART_SIZE / 2 * 0.04]);
      expect(names.indexOf('clip')).toBeGreaterThan(names.indexOf('roundRect'));
      expect(names.lastIndexOf('drawImage')).toBeGreaterThan(names.indexOf('clip'));
    });

    it('draws the artwork at full opacity with high-quality smoothing', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();

      const draw: RecordedCall = artworkDraws()[0];
      expect(draw.state['globalAlpha']).toBe(1);
      expect(draw.state['imageSmoothingEnabled']).toBe(true);
      expect(draw.state['imageSmoothingQuality']).toBe('high');
    });

    it('draws background, then shadow, then artwork', (): void => {
      const image: FakeImage = loadArtwork(TRACK_A);

      viz.draw();

      const sources: unknown[] = main.callsTo('drawImage').map((call: RecordedCall): unknown => call.args[0]);
      expect(sources).toEqual([background().canvas, shadow().canvas, image]);
    });

    it('does not read the analyser, because it is not audio reactive', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();

      expect(analyser.spectrumReads).toEqual([]);
      expect(analyser.waveformReads).toEqual([]);
    });
  });

  describe('background', (): void => {
    it('stretches the middle of the blurred surface over the whole view, translucent', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();

      // Long side 192px, 24px margin for the 12px blur on every side.
      const wash: RecordedCall = main.callsTo('drawImage')[0];
      expect(wash.args).toEqual([background().canvas, 24, 24, 192, 144, 0, 0, WIDTH, HEIGHT]);
      expect(wash.state['globalAlpha']).toBe(0.35);
    });

    it('restores full opacity after drawing the background', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();

      expect(main.context.globalAlpha).toBe(1);
    });

    it('builds the background small, with a margin around the shown region', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();

      for (const surface of [backgroundSource(), background()]) {
        expect(surface.canvas.width).toBe(240);
        expect(surface.canvas.height).toBe(192);
      }
    });

    it('covers the padded surface with the artwork, centred and overscanned', (): void => {
      const image: FakeImage = loadArtwork(TRACK_A, 1000, 1000);

      viz.draw();

      // Cover scale 240/1000, enlarged 15%: 276px square, centred on 240x192.
      const cover: RecordedCall = backgroundSource().callsTo('drawImage')[0];
      expect(cover.args[0]).toBe(image);
      expectNumbersClose(cover.args.slice(1), [-18, -42, 276, 276]);
    });

    it('blurs, saturates and dims the artwork into the background', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();

      const filtered: RecordedCall = background().callsTo('drawImage')[0];
      expect(filtered.args).toEqual([backgroundSource().canvas, 0, 0]);
      expect(filtered.state['filter']).toBe('blur(12px) saturate(1.8) brightness(0.6)');
      expect(background().context.filter).toBe('none');
    });

    it('builds the background once and reuses it across frames', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();
      viz.draw();
      viz.draw();

      expect(background().callsTo('drawImage')).toHaveLength(1);
      expect(backgroundSource().callsTo('drawImage')).toHaveLength(1);
      expect(main.callsTo('drawImage').filter((call: RecordedCall): boolean => call.args[0] === background().canvas))
        .toHaveLength(3);
    });

    it('rebuilds the background when the artwork changes', (): void => {
      loadArtwork(TRACK_A);
      viz.draw();
      const next: FakeImage = loadArtwork(TRACK_B);

      viz.draw();

      const covers: RecordedCall[] = backgroundSource().callsTo('drawImage');
      expect(covers).toHaveLength(2);
      expect(covers[1].args[0]).toBe(next);
    });

    it('rebuilds the background at the new aspect ratio when the view is resized', (): void => {
      loadArtwork(TRACK_A);
      viz.draw();
      viz.resize(600, 800);
      main.clear();

      viz.draw();

      expect(background().callsTo('drawImage')).toHaveLength(2);
      expect(background().canvas.width).toBe(192);
      expect(background().canvas.height).toBe(240);
      expect(main.callsTo('drawImage')[0].args).toEqual([background().canvas, 24, 24, 144, 192, 0, 0, 600, 800]);
    });

    it('reuses the same off-screen surfaces when rebuilding', (): void => {
      loadArtwork(TRACK_A);
      viz.draw();
      const before: number = fakes.contexts.length;
      loadArtwork(TRACK_B);
      viz.resize(1024, 768);

      viz.draw();

      expect(fakes.contexts.length).toBe(before);
    });
  });

  describe('drop shadow', (): void => {
    it('casts the shadow from a shape drawn off the surface, so only the shadow shows', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();

      // Blur 8% and offset 3% of 420px; padding ceil(2 x 33.6 + 12.6) = 80.
      const cast: RecordedCall = shadow().callsTo('fill')[0];
      expect(shadow().canvas.width).toBe(580);
      expect(shadow().canvas.height).toBe(580);
      expectNumbersClose(shadow().callsTo('roundRect')[0].args, [80 - 580, 80, ART_SIZE, ART_SIZE, ART_SIZE * 0.04]);
      expect(cast.state['shadowOffsetX']).toBe(580);
      expect(cast.state['shadowOffsetY']).toBeCloseTo(12.6, 6);
      expect(cast.state['shadowBlur']).toBeCloseTo(33.6, 6);
      expect(cast.state['shadowColor']).toBe('rgba(0, 0, 0, 0.6)');
    });

    it('places the shadow surface so its padding surrounds the artwork', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();

      const placed: RecordedCall = main.callsTo('drawImage')[1];
      expect(placed.args[0]).toBe(shadow().canvas);
      expectNumbersClose(placed.args.slice(1), [190 - 80, 90 - 80]);
    });

    it('builds the shadow once and reuses it across frames', (): void => {
      loadArtwork(TRACK_A);

      viz.draw();
      viz.draw();
      viz.draw();

      expect(shadow().callsTo('fill')).toHaveLength(1);
    });

    it('reuses the shadow for new artwork drawn at the same size', (): void => {
      loadArtwork(TRACK_A, 1000, 1000);
      viz.draw();
      loadArtwork(TRACK_B, 600, 600);

      viz.draw();

      expect(shadow().callsTo('fill')).toHaveLength(1);
    });

    it('rebuilds the shadow when the artwork is drawn at a different size', (): void => {
      loadArtwork(TRACK_A, 1000, 1000);
      viz.draw();
      loadArtwork(TRACK_B, 2000, 1000);

      viz.draw();

      expect(shadow().callsTo('fill')).toHaveLength(2);
      expect(shadow().canvas.height).toBe(ART_SIZE / 2 + 2 * Math.ceil(210 * 0.08 * 2 + 210 * 0.03));
    });

    it('rebuilds the shadow when a resize changes the drawn size', (): void => {
      loadArtwork(TRACK_A);
      viz.draw();
      viz.resize(400, 300);

      viz.draw();

      expect(shadow().callsTo('fill')).toHaveLength(2);
      expect(shadow().callsTo('roundRect')[1].args[2]).toBeCloseTo(210, 6);
    });

    it.each([
      ['wide', 10000, 1],
      ['tall', 1, 10000],
    ])('still draws artwork too %s to be a whole pixel thick', (_label: string, width: number, height: number): void => {
      loadArtwork(TRACK_A, width, height);

      viz.draw();

      expect(artworkDraws()).toHaveLength(1);
    });

    it.each([
      ['wide', 10000, 1],
      ['tall', 1, 10000],
    ])('casts no shadow for artwork too %s to be a whole pixel thick', (_label: string, width: number, height: number): void => {
      loadArtwork(TRACK_A, width, height);

      viz.draw();

      // The blurred background and the artwork itself, with no shadow between.
      expect(main.callsTo('drawImage')).toHaveLength(2);
    });

    it('casts a shadow again once thicker artwork replaces a sliver', (): void => {
      loadArtwork(TRACK_A, 10000, 1);
      viz.draw();
      loadArtwork(TRACK_B, 1000, 1000);
      main.clear();

      viz.draw();

      expect(main.callsTo('drawImage')).toHaveLength(3);
    });
  });

  describe('numeric safety', (): void => {
    it.each([
      ['square artwork', 1000, 1000],
      ['a one-pixel image', 1, 1],
      ['a very wide image', 4000, 10],
      ['a very tall image', 10, 4000],
      ['an image too wide to be a pixel thick', 10000, 1],
      ['an image too tall to be a pixel thick', 1, 10000],
    ])('passes only finite numbers to the canvas for %s', (_label: string, width: number, height: number): void => {
      loadArtwork(TRACK_A, width, height);

      viz.draw();

      for (const ctx of fakes.contexts) {
        expect(ctx.invalidCalls()).toEqual([]);
      }
    });

    it('passes only finite numbers to the canvas on a one-pixel canvas', (): void => {
      loadArtwork(TRACK_A);
      viz.resize(1, 1);

      viz.draw();

      expect(artworkDraws()).toHaveLength(1);
      for (const ctx of fakes.contexts) {
        expect(ctx.invalidCalls()).toEqual([]);
      }
    });
  });
});
