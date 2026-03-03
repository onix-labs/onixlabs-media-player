/**
 * @fileoverview Unit tests for AboutView component.
 *
 * Tests cover:
 * - Component creation
 * - Template data (version, versionInfo, audioExtensions, videoExtensions,
 *   dependencies, githubUrl, onixlabsUrl, currentYear)
 * - Event handlers (openExternal with and without the Electron preload bridge)
 *
 * Since AboutView reads `window.mediaPlayer?.getVersionInfo()` during class
 * field initialization, versionInfo will be null when running outside Electron.
 * The openExternal method uses optional chaining, so it is safe to call without
 * the preload API present.
 *
 * @module app/components/about/about-view.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {NO_ERRORS_SCHEMA} from '@angular/core';

import {AboutView} from './about-view';

// =============================================================================
// Test Suite
// =============================================================================

describe('AboutView', (): void => {
  let component: AboutView;
  let fixture: ComponentFixture<AboutView>;

  beforeEach(async (): Promise<void> => {
    await TestBed.configureTestingModule({
      imports: [AboutView],
      schemas: [NO_ERRORS_SCHEMA],
    })
    .compileComponents();

    fixture = TestBed.createComponent(AboutView);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  // ===========================================================================
  // Component Creation
  // ===========================================================================

  describe('component creation', (): void => {
    it('should create', (): void => {
      expect(component).toBeTruthy();
    });
  });

  // ===========================================================================
  // Template Data
  // ===========================================================================

  describe('template data', (): void => {
    it('version should be 2026.0.1', (): void => {
      const value: string = component.version;
      expect(value).toBe('2026.0.1');
    });

    it('versionInfo should be null when window.mediaPlayer is not defined', (): void => {
      const value: unknown = component.versionInfo;
      expect(value).toBeNull();
    });

    it('audioExtensions should contain expected formats', (): void => {
      const extensions: readonly string[] = component.audioExtensions;
      expect(extensions).toContain('MP3');
      expect(extensions).toContain('FLAC');
      expect(extensions).toContain('WAV');
      expect(extensions).toContain('OGG');
      expect(extensions).toContain('M4A');
      expect(extensions).toContain('AAC');
      expect(extensions).toContain('WMA');
      expect(extensions).toContain('MIDI');
      expect(extensions).toHaveLength(8);
    });

    it('videoExtensions should contain expected formats', (): void => {
      const extensions: readonly string[] = component.videoExtensions;
      expect(extensions).toContain('MP4');
      expect(extensions).toContain('M4V');
      expect(extensions).toContain('MKV');
      expect(extensions).toContain('AVI');
      expect(extensions).toContain('WebM');
      expect(extensions).toContain('MOV');
      expect(extensions).toHaveLength(6);
    });

    it('dependencies should contain FFmpeg and FluidSynth', (): void => {
      const deps: readonly {name: string; description: string; url: string}[] = component.dependencies;
      expect(deps).toHaveLength(2);

      const ffmpeg: {name: string; description: string; url: string} | undefined =
        deps.find((d: {name: string}): boolean => d.name === 'FFmpeg');
      expect(ffmpeg).toBeDefined();
      expect(ffmpeg!.description).toBe('Media transcoding and format conversion');
      expect(ffmpeg!.url).toBe('https://ffmpeg.org');

      const fluidSynth: {name: string; description: string; url: string} | undefined =
        deps.find((d: {name: string}): boolean => d.name === 'FluidSynth');
      expect(fluidSynth).toBeDefined();
      expect(fluidSynth!.description).toBe('MIDI synthesis and playback');
      expect(fluidSynth!.url).toBe('https://www.fluidsynth.org');
    });

    it('githubUrl should be correct', (): void => {
      const url: string = component.githubUrl;
      expect(url).toBe('https://github.com/onix-labs/onixlabs-media-player');
    });

    it('onixlabsUrl should be correct', (): void => {
      const url: string = component.onixlabsUrl;
      expect(url).toBe('https://onixlabs.io');
    });

    it('currentYear should be current year', (): void => {
      const expectedYear: number = new Date().getFullYear();
      const year: number = component.currentYear;
      expect(year).toBe(expectedYear);
    });
  });

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  describe('event handlers', (): void => {
    it('openExternal should call window.mediaPlayer.openExternal when available', (): void => {
      const mockOpenExternal: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
      (window as unknown as Record<string, unknown>)['mediaPlayer'] = {
        openExternal: mockOpenExternal,
      };

      const testUrl: string = 'https://example.com';
      component.openExternal(testUrl);

      expect(mockOpenExternal).toHaveBeenCalledWith(testUrl);

      // Cleanup
      delete (window as unknown as Record<string, unknown>)['mediaPlayer'];
    });

    it('openExternal should not throw when window.mediaPlayer is not available', (): void => {
      // Ensure window.mediaPlayer is not defined
      delete (window as unknown as Record<string, unknown>)['mediaPlayer'];

      const testUrl: string = 'https://example.com';
      expect((): void => component.openExternal(testUrl)).not.toThrow();
    });
  });
});
