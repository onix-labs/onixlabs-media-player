/**
 * @fileoverview Unit tests for the visualization registry and factory.
 *
 * Tests cover:
 * - createVisualization: every registered id builds the right class on the
 *   canvas it was given, and unknown ids are rejected
 * - That the factory, VISUALIZATION_METADATA, VISUALIZATION_TYPES and
 *   VISUALIZATION_GROUPS all describe the same set of visualizations
 *
 * Canvas 2D, WebGL and Web Audio are faked; see visualization-test-fakes.group3.
 *
 * @module app/components/audio/audio-outlet/visualizations/index.spec
 */

import {
  AlbumArtVisualization,
  AmbienceTwirlVisualization,
  AmbienceWarpVisualization,
  AnalyzerVisualization,
  BlankVisualization,
  ClassicVisualization,
  HalluciaVisualization,
  HawkingVisualization,
  InfinityVisualization,
  LogoVisualization,
  ModernVisualization,
  NeonVisualization,
  OnixVisualization,
  PlasmaVisualization,
  PulsarVisualization,
  RIPPLE_METADATA,
  RIPPLE_TYPE,
  ReactorVisualization,
  RippleVisualization,
  SpotlightVisualization,
  VISUALIZATION_GROUPS,
  VISUALIZATION_METADATA,
  VISUALIZATION_TYPES,
  Visualization,
  VisualizationConfig,
  VisualizationGroup,
  VisualizationOption,
  createVisualization,
} from './index';
import {CanvasFakes, FakeAnalyser, createFakeAnalyser, installCanvasFakes} from './visualization-test-fakes.group3';

type VisualizationConstructor = new (config: VisualizationConfig) => Visualization;

/** Every id the factory is expected to know, and the class it should build. */
const EXPECTED_CLASSES: ReadonlyArray<readonly [string, VisualizationConstructor]> = [
  ['bars', AnalyzerVisualization],
  ['waveform', ClassicVisualization],
  ['modern', ModernVisualization],
  ['tunnel', PlasmaVisualization],
  ['infinity', InfinityVisualization],
  ['neon', NeonVisualization],
  ['hawking', HawkingVisualization],
  ['onix', OnixVisualization],
  ['water', ReactorVisualization],
  ['spotlight', SpotlightVisualization],
  ['ambience-zoom', AmbienceTwirlVisualization],
  ['ambience-stretch', AmbienceWarpVisualization],
  ['ambience-ripple', RippleVisualization],
  ['pulsar', PulsarVisualization],
  ['hallucia', HalluciaVisualization],
  ['blank', BlankVisualization],
  ['logo', LogoVisualization],
  ['album-art', AlbumArtVisualization],
];

const EXPECTED_IDS: readonly string[] = EXPECTED_CLASSES.map(([id]: readonly [string, VisualizationConstructor]): string => id);

describe('visualization registry', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let config: VisualizationConfig;

  beforeEach((): void => {
    fakes = installCanvasFakes();
    analyser = createFakeAnalyser();
    canvas = document.createElement('canvas');
    config = {canvas, analyser: analyser.node};
  });

  afterEach((): void => {
    fakes.restore();
  });

  describe('createVisualization', (): void => {
    it.each(EXPECTED_CLASSES)('builds the registered class for "%s"', (id: string, expectedClass: VisualizationConstructor): void => {
      const viz: Visualization = createVisualization(id, config);

      expect(viz).toBeInstanceOf(expectedClass);
    });

    it.each(EXPECTED_IDS)('builds "%s" with the name and category its metadata advertises', (id: string): void => {
      const viz: Visualization = createVisualization(id, config);

      expect({name: viz.name, category: viz.category}).toEqual(VISUALIZATION_METADATA[id]);
    });

    it.each(EXPECTED_IDS)('builds "%s" on the canvas it was given', (id: string): void => {
      createVisualization(id, config);

      const canvasesUsed: HTMLCanvasElement[] = [
        ...fakes.recordings.map((recording): HTMLCanvasElement => recording.canvas),
        ...fakes.webglRecordings.map((recording): HTMLCanvasElement => recording.canvas),
      ];
      expect(canvasesUsed).toContain(canvas);
    });

    it('builds a new instance on every call', (): void => {
      const first: Visualization = createVisualization('bars', config);
      const second: Visualization = createVisualization('bars', config);

      expect(second).not.toBe(first);
    });

    it.each(['nope', '', 'Bars', ' bars', 'ripple'])('rejects the unknown id "%s"', (id: string): void => {
      expect((): Visualization => createVisualization(id, config)).toThrow(`Unknown visualization type: ${id}`);
    });

    it('requests no rendering context for an unknown id', (): void => {
      expect((): Visualization => createVisualization('nope', config)).toThrow();

      expect(fakes.recordings).toHaveLength(0);
      expect(fakes.webglRecordings).toHaveLength(0);
    });
  });

  describe('VISUALIZATION_TYPES', (): void => {
    it('lists every visualization in menu order', (): void => {
      expect(VISUALIZATION_TYPES).toEqual(EXPECTED_IDS);
    });

    it('lists no id twice', (): void => {
      expect(new Set(VISUALIZATION_TYPES).size).toBe(VISUALIZATION_TYPES.length);
    });

    it('lists Ripple under the id exported by its module', (): void => {
      expect(VISUALIZATION_TYPES).toContain(RIPPLE_TYPE);
    });

    it('lists only ids the factory can build', (): void => {
      for (const id of VISUALIZATION_TYPES) {
        expect(createVisualization(id, config)).toBeInstanceOf(Visualization);
      }
    });
  });

  describe('VISUALIZATION_METADATA', (): void => {
    it('describes exactly the listed visualizations', (): void => {
      expect(Object.keys(VISUALIZATION_METADATA).sort()).toEqual([...VISUALIZATION_TYPES].sort());
    });

    it('describes only ids the factory can build', (): void => {
      for (const id of Object.keys(VISUALIZATION_METADATA)) {
        expect(createVisualization(id, config)).toBeInstanceOf(Visualization);
      }
    });

    it('gives every visualization a distinct display name', (): void => {
      const names: string[] = Object.values(VISUALIZATION_METADATA).map((metadata: {name: string}): string => metadata.name);

      expect(new Set(names).size).toBe(names.length);
    });

    it('takes the Ripple entry from the metadata its module exports', (): void => {
      expect(VISUALIZATION_METADATA[RIPPLE_METADATA.id]).toEqual({
        name: RIPPLE_METADATA.name,
        category: RIPPLE_METADATA.category,
      });
    });
  });

  describe('VISUALIZATION_GROUPS', (): void => {
    it('groups the visualizations by category in menu order', (): void => {
      expect(VISUALIZATION_GROUPS.map((group: VisualizationGroup): string => group.category)).toEqual([
        'Bars & Waves',
        'Signature',
        'Nostalgia',
        'Simple',
      ]);
    });

    it('has one group per category', (): void => {
      const categories: string[] = VISUALIZATION_GROUPS.map((group: VisualizationGroup): string => group.category);

      expect(new Set(categories).size).toBe(categories.length);
    });

    it('offers every listed visualization exactly once, in list order', (): void => {
      const offered: string[] = VISUALIZATION_GROUPS.flatMap((group: VisualizationGroup): string[] =>
        group.options.map((option: VisualizationOption): string => option.value)
      );

      expect(offered).toEqual(VISUALIZATION_TYPES);
    });

    it('files each option under the category its metadata gives', (): void => {
      for (const group of VISUALIZATION_GROUPS) {
        for (const option of group.options) {
          expect(VISUALIZATION_METADATA[option.value].category).toBe(group.category);
        }
      }
    });

    it('labels each option with the name its metadata gives', (): void => {
      for (const group of VISUALIZATION_GROUPS) {
        for (const option of group.options) {
          expect(option.name).toBe(VISUALIZATION_METADATA[option.value].name);
        }
      }
    });

    it('lists the Nostalgia group as Twirl, Warp, Ripple, Pulsar and Hallucia', (): void => {
      const nostalgia: VisualizationGroup | undefined = VISUALIZATION_GROUPS.find(
        (group: VisualizationGroup): boolean => group.category === 'Nostalgia'
      );

      expect(nostalgia?.options.map((option: VisualizationOption): string => option.name)).toEqual([
        'Twirl',
        'Warp',
        'Ripple',
        'Pulsar',
        'Hallucia',
      ]);
    });
  });
});
