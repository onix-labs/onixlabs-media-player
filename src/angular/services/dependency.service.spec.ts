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
import {DependencyService, DependencyState, DependencyStatus, InstallProgress, DependencyId, SoundFontInfo, HardwareEncoderInfo} from './dependency.service';
import {ElectronService} from './electron.service';
import {MEDIA_EXTENSIONS, FFMPEG_EXTENSIONS, MIDI_EXTENSIONS, TRACKER_EXTENSIONS} from '../constants/media.constants';

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
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSettingsUpdate: ReturnType<typeof vi.fn>;
  onDependencyStateUpdate: ReturnType<typeof vi.fn>;
  onDependencyProgressUpdate: ReturnType<typeof vi.fn>;
  openSoundFontDialog: ReturnType<typeof vi.fn>;
} {
  return {
    serverUrl: signal('http://127.0.0.1:12345'),
    // Delegates to the stubbed global fetch so tests keep asserting on it.
    authFetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
    onSettingsUpdate: vi.fn().mockReturnValue((): void => {}),
    onDependencyStateUpdate: vi.fn().mockReturnValue((): void => {}),
    onDependencyProgressUpdate: vi.fn().mockReturnValue((): void => {}),
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
  const names: Record<DependencyId, string> = {
    ffmpeg: 'FFmpeg',
    fluidsynth: 'FluidSynth',
    'yt-dlp': 'yt-dlp',
  };
  return {
    id,
    name: names[id],
    installed,
    path: installed ? `/usr/local/bin/${id}` : null,
    source: installed ? 'system' : null,
    version: null,
    managed: id === 'yt-dlp',
    description: `${id} dependency`,
    websiteUrl: `https://example.com/${id}`,
  };
}

/**
 * Creates a full DependencyState with the given installation flags.
 */
function createDependencyState(
  ffmpegInstalled: boolean,
  fluidsynthInstalled: boolean,
  ytdlpInstalled: boolean = false,
  trackerSupport: boolean = false,
  midiSupport: boolean = fluidsynthInstalled,
): DependencyState {
  return {
    ffmpeg: createDependencyStatus('ffmpeg', ffmpegInstalled),
    fluidsynth: createDependencyStatus('fluidsynth', fluidsynthInstalled),
    ytdlp: createDependencyStatus('yt-dlp', ytdlpInstalled),
    trackerSupport,
    midiSupport,
    soundfonts: [],
    activeSoundFont: null,
    hardwareEncoders: {available: false, encoders: []},
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

  describe('computed signals with all installed', (): void => {
    beforeEach((): void => {
      // Named "both" when there were only two dependencies; yt-dlp and
      // tracker support have since joined them.
      const state: DependencyState = createDependencyState(true, true, true, true);
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
      expect(result).toEqual(MEDIA_EXTENSIONS);
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
      expect(result).toEqual(FFMPEG_EXTENSIONS);
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
      expect(result).toEqual(MIDI_EXTENSIONS);
    });
  });

  // ==========================================================================
  // MIDI needs a SoundFont
  // ==========================================================================

  describe('MIDI without a SoundFont', (): void => {
    beforeEach((): void => {
      // FluidSynth is bundled, but no SoundFont has been installed yet
      const state: DependencyState = createDependencyState(true, true, false, false, false);
      service.dependencyState.set(state);
      service.isLoaded.set(true);
    });

    it('midiSupported is false', (): void => {
      expect(service.midiSupported()).toBe(false);
    });

    it('allowedExtensions offers no MIDI extension', (): void => {
      const result: ReadonlySet<string> = service.allowedExtensions();
      for (const ext of MIDI_EXTENSIONS) {
        expect(result.has(ext)).toBe(false);
      }
    });

    it('allows MIDI once a SoundFont makes it playable', (): void => {
      service.dependencyState.set(createDependencyState(true, true, false, false, true));

      expect(service.midiSupported()).toBe(true);
      expect(service.allowedExtensions().has('.mid')).toBe(true);
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

// ============================================================================
// Server synchronisation and command failures
// ============================================================================

/** Base URL the fake ElectronService reports for the media server. */
const SERVER_URL: string = 'http://127.0.0.1:12345';

/** A dependency command and the request it should make. */
interface DependencyCommandCase {
  readonly name: string;
  readonly act: (target: DependencyService) => Promise<void>;
  readonly endpoint: string;
  readonly verb: string;
}

/** A SoundFont command and the request it should make. */
interface SoundFontCommandCase {
  readonly name: string;
  readonly act: (target: DependencyService) => Promise<void>;
  readonly endpoint: string;
  readonly body: Record<string, unknown>;
  readonly attempt: string;
}

const DEPENDENCY_COMMANDS: readonly DependencyCommandCase[] = [
  {name: 'installDependency', act: (s: DependencyService): Promise<void> => s.installDependency('yt-dlp'), endpoint: 'install', verb: 'install'},
  {name: 'updateDependency', act: (s: DependencyService): Promise<void> => s.updateDependency('yt-dlp'), endpoint: 'update', verb: 'update'},
  {name: 'uninstallDependency', act: (s: DependencyService): Promise<void> => s.uninstallDependency('yt-dlp'), endpoint: 'uninstall', verb: 'uninstall'},
];

const SOUNDFONT_COMMANDS: readonly SoundFontCommandCase[] = [
  {
    name: 'installSoundFont',
    act: (s: DependencyService): Promise<void> => s.installSoundFont(),
    endpoint: 'install',
    body: {sourcePath: '/music/Piano.sf2'},
    attempt: 'install the SoundFont',
  },
  {
    name: 'removeSoundFont',
    act: (s: DependencyService): Promise<void> => s.removeSoundFont('Piano.sf2'),
    endpoint: 'remove',
    body: {fileName: 'Piano.sf2'},
    attempt: 'remove Piano.sf2',
  },
  {
    name: 'setActiveSoundFont',
    act: (s: DependencyService): Promise<void> => s.setActiveSoundFont('Piano.sf2'),
    endpoint: 'select',
    body: {fileName: 'Piano.sf2'},
    attempt: 'select the SoundFont',
  },
];

describe('DependencyService server communication', (): void => {
  let service: DependencyService;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let unsubscribeState: ReturnType<typeof vi.fn>;
  let unsubscribeProgress: ReturnType<typeof vi.fn>;

  /**
   * Builds a minimal fetch response.
   */
  function createResponse(ok: boolean, body: unknown = {}, status: number = ok ? 200 : 500): Response {
    return {ok, status, json: (): Promise<unknown> => Promise.resolve(body)} as Response;
  }

  /**
   * Runs pending effects and lets promise chains finish without moving the clock.
   */
  async function settle(): Promise<void> {
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
  }

  /**
   * Creates the service and lets its start-up effect (and any fetch it makes) settle.
   *
   * @param serverUrl - The server URL known at construction ('' = not yet known)
   */
  async function createService(serverUrl: string = SERVER_URL): Promise<void> {
    mockElectron.serverUrl.set(serverUrl);
    service = TestBed.inject(DependencyService);
    await settle();
  }

  /** Returns the callback registered for `dependencies:state` pushes. */
  function statePushHandler(): (state: unknown) => void {
    return mockElectron.onDependencyStateUpdate.mock.calls[0][0] as (state: unknown) => void;
  }

  /** Returns the callback registered for `dependencies:progress` pushes. */
  function progressPushHandler(): (progress: unknown) => void {
    return mockElectron.onDependencyProgressUpdate.mock.calls[0][0] as (progress: unknown) => void;
  }

  beforeEach((): void => {
    vi.useFakeTimers();

    mockElectron = createMockElectronService();
    unsubscribeState = vi.fn();
    unsubscribeProgress = vi.fn();
    mockElectron.onDependencyStateUpdate.mockReturnValue(unsubscribeState);
    mockElectron.onDependencyProgressUpdate.mockReturnValue(unsubscribeProgress);
    mockElectron.openSoundFontDialog.mockResolvedValue(['/music/Piano.sf2']);

    // The initial state fetch is refused by default, so each test starts unloaded.
    fetchSpy = vi.fn().mockResolvedValue(createResponse(false));
    vi.stubGlobal('fetch', fetchSpy);
    errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => {});

    TestBed.configureTestingModule({
      providers: [
        DependencyService,
        {provide: ElectronService, useValue: mockElectron},
      ],
    });
  });

  afterEach((): void => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Initial fetch
  // ==========================================================================

  describe('initial fetch', (): void => {
    it('requests the dependency state from the server', async (): Promise<void> => {
      await createService();

      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(`${SERVER_URL}/dependencies`, undefined);
    });

    it('applies the fetched state', async (): Promise<void> => {
      const state: DependencyState = createDependencyState(true, true, true);
      fetchSpy.mockResolvedValue(createResponse(true, state));

      await createService();

      expect(service.dependencyState()).toEqual(state);
      expect(service.isLoaded()).toBe(true);
    });

    it('stays unloaded when the server responds with an error', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createResponse(false));

      await createService();

      expect(service.dependencyState()).toBeNull();
      expect(service.isLoaded()).toBe(false);
    });

    it('stays unloaded when the request fails', async (): Promise<void> => {
      fetchSpy.mockRejectedValue(new Error('connection refused'));

      await createService();

      expect(service.dependencyState()).toBeNull();
      expect(service.isLoaded()).toBe(false);
    });

    it('makes no request while the server URL is unknown', async (): Promise<void> => {
      await createService('');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches once the server URL becomes available', async (): Promise<void> => {
      await createService('');
      const state: DependencyState = createDependencyState(true, false);
      fetchSpy.mockResolvedValue(createResponse(true, state));

      mockElectron.serverUrl.set(SERVER_URL);
      await settle();

      expect(service.dependencyState()).toEqual(state);
    });

    it('does not fetch when a push already delivered the state', async (): Promise<void> => {
      await createService('');
      statePushHandler()(createDependencyState(true, true));

      mockElectron.serverUrl.set(SERVER_URL);
      await settle();

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Server pushes
  // ==========================================================================

  describe('server pushes', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService();
    });

    it('replaces the dependency state when a state push arrives', (): void => {
      const state: DependencyState = createDependencyState(true, true);

      statePushHandler()(state);

      expect(service.dependencyState()).toBe(state);
    });

    it('marks the state as loaded when a state push arrives', (): void => {
      statePushHandler()(createDependencyState(false, false));

      expect(service.isLoaded()).toBe(true);
    });

    it('publishes install progress when a progress push arrives', (): void => {
      const progress: InstallProgress = {dependencyId: 'yt-dlp', status: 'installing', message: 'Downloading…', percent: 40};

      progressPushHandler()(progress);

      expect(service.installProgress()).toBe(progress);
    });

    it('reports an operation in progress while a pushed update is running', (): void => {
      progressPushHandler()({dependencyId: 'yt-dlp', status: 'updating', message: 'Updating…'});

      expect(service.isOperationInProgress()).toBe(true);
    });

    it('reports no operation in progress once a pushed error arrives', (): void => {
      progressPushHandler()({dependencyId: 'yt-dlp', status: 'error', message: 'Failed'});

      expect(service.isOperationInProgress()).toBe(false);
    });

    it('stops listening for state pushes when destroyed', (): void => {
      TestBed.resetTestingModule();

      expect(unsubscribeState).toHaveBeenCalledTimes(1);
    });

    it('stops listening for progress pushes when destroyed', (): void => {
      TestBed.resetTestingModule();

      expect(unsubscribeProgress).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Derived signals
  // ==========================================================================

  describe('derived signals', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService();
    });

    it('report nothing installed or supported before any state arrives', (): void => {
      expect(service.ytdlpInstalled()).toBe(false);
      expect(service.midiSupported()).toBe(false);
      expect(service.trackerSupported()).toBe(false);
      expect(service.anyDependencyInstalled()).toBe(false);
      expect(service.missingDependencies()).toEqual([]);
      expect(service.soundFonts()).toEqual([]);
      expect(service.activeSoundFont()).toBeNull();
      expect(service.hardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('hasMissingDependencies is false until the state has loaded', (): void => {
      expect(service.hasMissingDependencies()).toBe(false);
    });

    it('noDependenciesInstalled is false until the state has loaded', (): void => {
      expect(service.noDependenciesInstalled()).toBe(false);
    });

    it('ytdlpInstalled follows the pushed state', (): void => {
      statePushHandler()(createDependencyState(true, true, true));

      expect(service.ytdlpInstalled()).toBe(true);
    });

    it('missingDependencies lists each dependency that is not installed', (): void => {
      const state: DependencyState = createDependencyState(false, false);

      statePushHandler()(state);

      expect(service.missingDependencies()).toEqual([state.ffmpeg, state.fluidsynth]);
    });

    it('missingDependencies leaves out an installed dependency', (): void => {
      const state: DependencyState = createDependencyState(true, false);

      statePushHandler()(state);

      expect(service.missingDependencies()).toEqual([state.fluidsynth]);
    });

    it('anyDependencyInstalled is true when only FluidSynth is present', (): void => {
      statePushHandler()(createDependencyState(false, true));

      expect(service.anyDependencyInstalled()).toBe(true);
      expect(service.noDependenciesInstalled()).toBe(false);
    });

    it('soundFonts and activeSoundFont follow the pushed state', (): void => {
      const fonts: SoundFontInfo[] = [{fileName: 'Piano.sf2', filePath: '/fonts/Piano.sf2', sizeBytes: 1024}];

      statePushHandler()({...createDependencyState(true, true), soundfonts: fonts, activeSoundFont: 'Piano.sf2'});

      expect(service.soundFonts()).toEqual(fonts);
      expect(service.activeSoundFont()).toBe('Piano.sf2');
    });

    it('hardwareEncoders follows the pushed state', (): void => {
      const encoders: HardwareEncoderInfo = {available: true, encoders: ['h264_videotoolbox']};

      statePushHandler()({...createDependencyState(true, true), hardwareEncoders: encoders});

      expect(service.hardwareEncoders()).toEqual(encoders);
    });

    it('allowedExtensions adds tracker formats only when FFmpeg can decode them', (): void => {
      statePushHandler()(createDependencyState(false, false, false, true, false));

      expect(service.trackerSupported()).toBe(true);
      expect(service.allowedExtensions()).toEqual(TRACKER_EXTENSIONS);
    });
  });

  // ==========================================================================
  // Dependency commands
  // ==========================================================================

  describe('dependency commands', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService();
      fetchSpy.mockClear();
      fetchSpy.mockResolvedValue(createResponse(true));
    });

    it.each(DEPENDENCY_COMMANDS)('$name posts the dependency id to its endpoint', async (command: DependencyCommandCase): Promise<void> => {
      await command.act(service);

      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(`${SERVER_URL}/dependencies/${command.endpoint}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: 'yt-dlp'}),
      });
    });

    it.each(DEPENDENCY_COMMANDS)('$name clears the previous progress when it starts', async (command: DependencyCommandCase): Promise<void> => {
      service.installProgress.set({dependencyId: 'yt-dlp', status: 'success', message: 'Done'});

      await command.act(service);

      expect(service.installProgress()).toBeNull();
    });

    it.each(DEPENDENCY_COMMANDS)('$name surfaces an error state when the server refuses', async (command: DependencyCommandCase): Promise<void> => {
      fetchSpy.mockResolvedValue(createResponse(false, {}, 503));

      await command.act(service);

      expect(service.installProgress()).toEqual({
        dependencyId: 'yt-dlp',
        status: 'error',
        message: `Could not ${command.verb} yt-dlp: the server returned 503.`,
      });
    });

    it.each(DEPENDENCY_COMMANDS)('$name surfaces an error state when the request fails', async (command: DependencyCommandCase): Promise<void> => {
      fetchSpy.mockRejectedValue(new Error('network down'));

      await command.act(service);

      expect(service.installProgress()).toEqual({
        dependencyId: 'yt-dlp',
        status: 'error',
        message: `Could not ${command.verb} yt-dlp: network down`,
      });
    });

    it('describes a failure that is not an Error by its string form', async (): Promise<void> => {
      fetchSpy.mockRejectedValue('socket hang up');

      await service.installDependency('yt-dlp');

      expect(service.installProgress()?.message).toBe('Could not install yt-dlp: socket hang up');
    });

    it('logs a command failure', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createResponse(false, {}, 503));

      await service.installDependency('yt-dlp');

      expect(errorSpy).toHaveBeenCalledWith('[DependencyService] Could not install yt-dlp: the server returned 503.');
    });

    it('does not count a failed command as an operation in progress', async (): Promise<void> => {
      fetchSpy.mockRejectedValue(new Error('network down'));

      await service.installDependency('yt-dlp');

      expect(service.isOperationInProgress()).toBe(false);
    });

    it('does nothing while the server URL is unknown', async (): Promise<void> => {
      const previous: InstallProgress = {dependencyId: 'yt-dlp', status: 'success', message: 'Done'};
      service.installProgress.set(previous);
      mockElectron.serverUrl.set('');

      await service.installDependency('yt-dlp');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service.installProgress()).toBe(previous);
    });
  });

  // ==========================================================================
  // SoundFont commands
  // ==========================================================================

  describe('SoundFont commands', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService();
      fetchSpy.mockClear();
      fetchSpy.mockResolvedValue(createResponse(true));
    });

    it.each(SOUNDFONT_COMMANDS)('$name posts to its endpoint', async (command: SoundFontCommandCase): Promise<void> => {
      await command.act(service);

      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(`${SERVER_URL}/dependencies/soundfont/${command.endpoint}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(command.body),
      });
    });

    it.each(SOUNDFONT_COMMANDS)('$name clears the previous error when it succeeds', async (command: SoundFontCommandCase): Promise<void> => {
      service.soundFontError.set('Could not remove Old.sf2: the server returned 500.');

      await command.act(service);

      expect(service.soundFontError()).toBeNull();
    });

    it.each(SOUNDFONT_COMMANDS)('$name reports the status when the server refuses', async (command: SoundFontCommandCase): Promise<void> => {
      fetchSpy.mockResolvedValue(createResponse(false, {}, 409));

      await command.act(service);

      expect(service.soundFontError()).toBe(`Could not ${command.attempt}: the server returned 409.`);
    });

    it.each(SOUNDFONT_COMMANDS)('$name reports the reason when the request fails', async (command: SoundFontCommandCase): Promise<void> => {
      fetchSpy.mockRejectedValue(new Error('network down'));

      await command.act(service);

      expect(service.soundFontError()).toBe(`Could not ${command.attempt}: network down`);
    });

    it('describes a failure that is not an Error by its string form', async (): Promise<void> => {
      fetchSpy.mockRejectedValue('socket hang up');

      await service.removeSoundFont('Piano.sf2');

      expect(service.soundFontError()).toBe('Could not remove Piano.sf2: socket hang up');
    });

    it('logs a SoundFont failure', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createResponse(false, {}, 409));

      await service.removeSoundFont('Piano.sf2');

      expect(errorSpy).toHaveBeenCalledWith('[DependencyService] Could not remove Piano.sf2: the server returned 409.');
    });

    it('installSoundFont sends nothing when the file dialog is cancelled', async (): Promise<void> => {
      mockElectron.openSoundFontDialog.mockResolvedValue([]);

      await service.installSoundFont();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('installSoundFont installs only the first file when several are chosen', async (): Promise<void> => {
      mockElectron.openSoundFontDialog.mockResolvedValue(['/music/A.sf2', '/music/B.sf2']);

      await service.installSoundFont();

      const init: RequestInit = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.body).toBe(JSON.stringify({sourcePath: '/music/A.sf2'}));
    });

    it('setActiveSoundFont sends null to return to automatic selection', async (): Promise<void> => {
      await service.setActiveSoundFont(null);

      const init: RequestInit = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.body).toBe(JSON.stringify({fileName: null}));
    });

    it('does nothing while the server URL is unknown', async (): Promise<void> => {
      service.soundFontError.set('earlier failure');
      mockElectron.serverUrl.set('');

      await service.removeSoundFont('Piano.sf2');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service.soundFontError()).toBe('earlier failure');
    });
  });

  // ==========================================================================
  // Refresh
  // ==========================================================================

  describe('refreshDependencies', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService();
      fetchSpy.mockClear();
      errorSpy.mockClear();
    });

    it('logs the status when the server refuses', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createResponse(false, {}, 502));

      await service.refreshDependencies();

      expect(errorSpy).toHaveBeenCalledWith('[DependencyService] Dependency refresh failed: the server returned 502.');
    });

    it('logs and resolves when the request fails', async (): Promise<void> => {
      const failure: Error = new Error('network down');
      fetchSpy.mockRejectedValue(failure);

      await expect(service.refreshDependencies()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('[DependencyService] Dependency refresh failed:', failure);
    });

    it('logs nothing when the refresh is accepted', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createResponse(true));

      await service.refreshDependencies();

      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('sends nothing while the server URL is unknown', async (): Promise<void> => {
      mockElectron.serverUrl.set('');

      await service.refreshDependencies();

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
