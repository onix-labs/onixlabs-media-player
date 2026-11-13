/**
 * @fileoverview Unit tests for AboutView component.
 *
 * Tests cover:
 * - Component creation
 * - Template data (version, versionInfo, audioExtensions, videoExtensions,
 *   dependencies, githubUrl, onixlabsUrl, currentYear)
 * - Version and licences loaded from the main process
 * - Event handlers (openExternal and openLicense, with and without the
 *   Electron preload bridge)
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
import type {AboutInfo} from '../../../types/electron';

const ABOUT_INFO: AboutInfo = {
  version: '2026.11.0',
  licenses: [
    {id: 'onixplayer', name: 'ONIXPlayer', version: '2026.11.0', license: 'MIT'},
    {id: 'ffmpeg', name: 'FFmpeg', version: '9.0.2', license: 'GPL-2.0-or-later'},
    {id: 'javascript', name: 'JavaScript libraries', version: null, license: 'MIT and others'},
  ],
  sourceUrl: 'https://github.com/onix-labs/onixlabs-media-player/releases/tag/2026.11.0',
};

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
    it('version should be empty when window.mediaPlayer is not defined', (): void => {
      expect(component.version()).toBe('');
      expect(component.licenses()).toEqual([]);
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

    it('dependencies should contain FFmpeg, FluidSynth and libopenmpt', (): void => {
      const deps: readonly {name: string; description: string; url: string}[] = component.dependencies;
      expect(deps).toHaveLength(3);

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
  // Version and Licences
  // ===========================================================================

  describe('version and licences', (): void => {
    let openLicense: ReturnType<typeof vi.fn>;
    let openExternal: ReturnType<typeof vi.fn>;

    beforeEach(async (): Promise<void> => {
      openLicense = vi.fn().mockResolvedValue(true);
      openExternal = vi.fn().mockResolvedValue(undefined);
      (window as unknown as Record<string, unknown>)['mediaPlayer'] = {
        getVersionInfo: (): null => null,
        getAboutInfo: vi.fn().mockResolvedValue(ABOUT_INFO),
        openLicense,
        openExternal,
      };

      fixture = TestBed.createComponent(AboutView);
      component = fixture.componentInstance;
      await fixture.whenStable();
      fixture.detectChanges();
    });

    afterEach((): void => {
      delete (window as unknown as Record<string, unknown>)['mediaPlayer'];
    });

    it('shows the version the main process reports', (): void => {
      const cell: HTMLElement | null = fixture.nativeElement.querySelector('[data-testid="app-version"]');
      expect(cell?.textContent?.trim()).toBe('2026.11.0');
    });

    it('lists each licence with its version and licence', (): void => {
      const items: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('[data-testid="licenses"] button'));
      expect(items).toHaveLength(3);
      expect(items[1]?.textContent).toContain('FFmpeg');
      expect(items[1]?.textContent).toContain('9.0.2');
      expect(items[1]?.textContent).toContain('GPL-2.0-or-later');
    });

    it('opens a licence by id when clicked', (): void => {
      const items: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('[data-testid="licenses"] button'));
      items[1]?.click();
      expect(openLicense).toHaveBeenCalledWith('ffmpeg');
    });

    it('links to the release that carries the bundled programs\' source', (): void => {
      const link: HTMLElement | null = fixture.nativeElement.querySelector('.source-link');
      link?.click();
      expect(openExternal).toHaveBeenCalledWith(ABOUT_INFO.sourceUrl);
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
