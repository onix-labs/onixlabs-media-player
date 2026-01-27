/**
 * @fileoverview Unit tests for DependencyService.
 *
 * Tests reactive signal state, computed signal derivations, and HTTP
 * command methods using a mock ElectronService.
 *
 * @module app/services/dependency.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {DependencyService, DependencyState, DependencyStatus, InstallProgress, DependencyId} from './dependency.service';
import {ElectronService} from './electron.service';
import {MEDIA_EXTENSIONS, FFMPEG_EXTENSIONS, MIDI_EXTENSIONS} from '../constants/media.constants';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock ElectronService for testing.
 *
 * Provides a controllable serverUrl signal and stub callbacks
 * so that DependencyService can be constructed without a real
 * Electron environment.
 */
function createMockElectronService(): {
  serverUrl: ReturnType<typeof signal<string>>;
  onSettingsUpdate: ReturnType<typeof vi.fn>;
  onDependencyStateUpdate: ReturnType<typeof vi.fn>;
  onDependencyProgressUpdate: ReturnType<typeof vi.fn>;
  openSoundFontDialog: ReturnType<typeof vi.fn>;
} {
  return {
    serverUrl: signal('http://127.0.0.1:12345'),
    onSettingsUpdate: vi.fn(),
    onDependencyStateUpdate: vi.fn(),
    onDependencyProgressUpdate: vi.fn(),
    openSoundFontDialog: vi.fn().mockResolvedValue([]),
  };
}

/**
 * Creates a DependencyStatus object with sensible defaults.
 */
function createDependencyStatus(
  id: DependencyId,
  installed: boolean,
): DependencyStatus {
  return {
    id,
    name: id === 'ffmpeg' ? 'FFmpeg' : 'FluidSynth',
    installed,
    path: installed ? `/usr/local/bin/${id}` : null,
    description: `${id} dependency`,
    manualInstallUrl: `https://example.com/${id}`,
  };
}

/**
 * Creates a full DependencyState with the given installation flags.
 */
function createDependencyState(
  ffmpegInstalled: boolean,
  fluidsynthInstalled: boolean,
): DependencyState {
  return {
    ffmpeg: createDependencyStatus('ffmpeg', ffmpegInstalled),
    fluidsynth: createDependencyStatus('fluidsynth', fluidsynthInstalled),
    soundfonts: [],
    activeSoundFont: null,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('DependencyService', (): void => {
  let service: DependencyService;
  let mockElectron: ReturnType<typeof createMockElectronService>;

  beforeEach((): void => {
    mockElectron = createMockElectronService();

    // Suppress fetch calls made by the constructor's effect
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(null),
    }));

    TestBed.configureTestingModule({
      providers: [
        DependencyService,
        {provide: ElectronService, useValue: mockElectron},
      ],
    });

    service = TestBed.inject(DependencyService);
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Initial State
  // ==========================================================================

  describe('initial state', (): void => {
    it('starts with null dependency state', (): void => {
      const state: DependencyState | null = service.dependencyState();
      expect(state).toBeNull();
    });

    it('starts as not loaded', (): void => {
      const loaded: boolean = service.isLoaded();
      expect(loaded).toBe(false);
    });

    it('ffmpegInstalled is false initially', (): void => {
      const installed: boolean = service.ffmpegInstalled();
      expect(installed).toBe(false);
    });

    it('fluidsynthInstalled is false initially', (): void => {
      const installed: boolean = service.fluidsynthInstalled();
      expect(installed).toBe(false);
    });
  });

  // ==========================================================================
  // Computed Signals — Both Installed
  // ==========================================================================

  describe('computed signals with both installed', (): void => {
    beforeEach((): void => {
      const state: DependencyState = createDependencyState(true, true);
      service.dependencyState.set(state);
      service.isLoaded.set(true);
    });

    it('ffmpegInstalled returns true', (): void => {
      const result: boolean = service.ffmpegInstalled();
      expect(result).toBe(true);
    });

    it('fluidsynthInstalled returns true', (): void => {
      const result: boolean = service.fluidsynthInstalled();
      expect(result).toBe(true);
    });

    it('allDependenciesInstalled returns true', (): void => {
      const result: boolean = service.allDependenciesInstalled();
      expect(result).toBe(true);
    });

    it('hasMissingDependencies returns false', (): void => {
      const result: boolean = service.hasMissingDependencies();
      expect(result).toBe(false);
    });

    it('missingDependencies returns empty array', (): void => {
      const result: DependencyStatus[] = service.missingDependencies();
      expect(result).toEqual([]);
    });

    it('allowedExtensions returns MEDIA_EXTENSIONS', (): void => {
      const result: ReadonlySet<string> = service.allowedExtensions();
      expect(result).toBe(MEDIA_EXTENSIONS);
    });
  });

  // ==========================================================================
  // Computed Signals — Only FFmpeg
  // ==========================================================================

  describe('computed signals with only ffmpeg', (): void => {
    beforeEach((): void => {
      const state: DependencyState = createDependencyState(true, false);
      service.dependencyState.set(state);
      service.isLoaded.set(true);
    });

    it('ffmpegInstalled returns true', (): void => {
      const result: boolean = service.ffmpegInstalled();
      expect(result).toBe(true);
    });

    it('fluidsynthInstalled returns false', (): void => {
      const result: boolean = service.fluidsynthInstalled();
      expect(result).toBe(false);
    });

    it('allDependenciesInstalled returns false', (): void => {
      const result: boolean = service.allDependenciesInstalled();
      expect(result).toBe(false);
    });

    it('hasMissingDependencies returns true when loaded', (): void => {
      const result: boolean = service.hasMissingDependencies();
      expect(result).toBe(true);
    });

    it('allowedExtensions returns FFMPEG_EXTENSIONS', (): void => {
      const result: ReadonlySet<string> = service.allowedExtensions();
      expect(result).toBe(FFMPEG_EXTENSIONS);
    });
  });

  // ==========================================================================
  // Computed Signals — Only FluidSynth
  // ==========================================================================

  describe('computed signals with only fluidsynth', (): void => {
    beforeEach((): void => {
      const state: DependencyState = createDependencyState(false, true);
      service.dependencyState.set(state);
      service.isLoaded.set(true);
    });

    it('allowedExtensions returns MIDI_EXTENSIONS', (): void => {
      const result: ReadonlySet<string> = service.allowedExtensions();
      expect(result).toBe(MIDI_EXTENSIONS);
    });
  });

  // ==========================================================================
  // Computed Signals — None Installed
  // ==========================================================================

  describe('computed signals with none installed', (): void => {
    beforeEach((): void => {
      const state: DependencyState = createDependencyState(false, false);
      service.dependencyState.set(state);
      service.isLoaded.set(true);
    });

    it('noDependenciesInstalled returns true when loaded', (): void => {
      const result: boolean = service.noDependenciesInstalled();
      expect(result).toBe(true);
    });

    it('allowedExtensions returns empty set', (): void => {
      const result: ReadonlySet<string> = service.allowedExtensions();
      expect(result.size).toBe(0);
    });
  });

  // ==========================================================================
  // isOperationInProgress
  // ==========================================================================

  describe('isOperationInProgress', (): void => {
    it('returns true for installing status', (): void => {
      const progress: InstallProgress = {
        dependencyId: 'ffmpeg',
        status: 'installing',
        message: 'Installing FFmpeg...',
      };
      service.installProgress.set(progress);

      const result: boolean = service.isOperationInProgress();
      expect(result).toBe(true);
    });

    it('returns true for uninstalling status', (): void => {
      const progress: InstallProgress = {
        dependencyId: 'fluidsynth',
        status: 'uninstalling',
        message: 'Uninstalling FluidSynth...',
      };
      service.installProgress.set(progress);

      const result: boolean = service.isOperationInProgress();
      expect(result).toBe(true);
    });

    it('returns false for success status', (): void => {
      const progress: InstallProgress = {
        dependencyId: 'ffmpeg',
        status: 'success',
        message: 'FFmpeg installed successfully.',
      };
      service.installProgress.set(progress);

      const result: boolean = service.isOperationInProgress();
      expect(result).toBe(false);
    });

    it('returns false for null progress', (): void => {
      service.installProgress.set(null);

      const result: boolean = service.isOperationInProgress();
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // Commands
  // ==========================================================================

  describe('commands', (): void => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach((): void => {
      fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
      vi.stubGlobal('fetch', fetchSpy);
    });

    it('installDependency calls fetch with correct URL', async (): Promise<void> => {
      await service.installDependency('ffmpeg');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:12345/dependencies/install',
        expect.objectContaining({
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({id: 'ffmpeg'}),
        }),
      );
    });

    it('uninstallDependency calls fetch with correct URL', async (): Promise<void> => {
      await service.uninstallDependency('fluidsynth');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:12345/dependencies/uninstall',
        expect.objectContaining({
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({id: 'fluidsynth'}),
        }),
      );
    });

    it('removeSoundFont calls fetch with correct URL', async (): Promise<void> => {
      await service.removeSoundFont('GeneralUser.sf2');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:12345/dependencies/soundfont/remove',
        expect.objectContaining({
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({fileName: 'GeneralUser.sf2'}),
        }),
      );
    });

    it('refreshDependencies calls POST to correct URL', async (): Promise<void> => {
      await service.refreshDependencies();

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:12345/dependencies/refresh',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });
  });
});
