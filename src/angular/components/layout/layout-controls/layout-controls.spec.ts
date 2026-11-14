/**
 * @fileoverview Unit tests for LayoutControls component.
 *
 * Tests cover:
 * - Component creation
 * - Computed signal values (canOpenFiles, isPlaying, progress, volume, hasTrack,
 *   currentTime, totalDuration, trackTitle, canSkipBackward, canSkipForward,
 *   backwardIcon, forwardIcon, playPauseIcon)
 * - Event handlers (onEject, onShuffle, onRepeat, onBackward, onPlayPause,
 *   onForward, onMuteToggle, onVolumeChange, onToggleFullscreen,
 *   onEnterMiniplayer, onProgressMouseDown)
 * - Shift key state tracking for icon and behavior changes
 *
 * Dependencies (MediaPlayerService, ElectronService, DependencyService) are
 * fully mocked with writable signals and vi.fn() stubs.
 *
 * @module app/components/layout/layout-controls.spec
 */

import {signal, WritableSignal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {NO_ERRORS_SCHEMA} from '@angular/core';
import {LayoutControls} from './layout-controls';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {DependencyService} from '../../../services/dependency.service';
import {SettingsService} from '../../../services/settings.service';
import type {PlaylistItem, PlaylistState} from '../../../types/electron';

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Creates a mock MediaPlayerService with writable signals and vi.fn() stubs.
 */
function createMockMediaPlayerService(): Record<string, unknown> {
  return {
    isPlaying: signal(false),
    currentTrack: signal(null),
    progress: signal(0),
    currentVolume: signal(1),
    isMuted: signal(false),
    isShuffleEnabled: signal(false),
    isRepeatEnabled: signal(false),
    time: signal(0),
    totalDuration: signal(0),
    playlistCount: signal(0),
    formatTime: vi.fn((seconds: number): string => {
      const m: number = Math.floor(seconds / 60);
      const s: number = Math.floor(seconds % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }),
    playbackState: signal('idle'),
    eject: vi.fn().mockResolvedValue(undefined),
    toggleShuffle: vi.fn().mockResolvedValue(undefined),
    toggleRepeat: vi.fn().mockResolvedValue(undefined),
    previous: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    skipBackward: vi.fn().mockResolvedValue(undefined),
    skipForward: vi.fn().mockResolvedValue(undefined),
    togglePlayPause: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    setVolume: vi.fn().mockResolvedValue(undefined),
    toggleMute: vi.fn().mockResolvedValue(undefined),
    seekToProgress: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock ElectronService with writable signals and vi.fn() stubs.
 */
function createMockElectronService(): Record<string, unknown> {
  return {
    isFullscreen: signal(false),
    isConfigOpen: signal(false),
    playlist: signal<PlaylistState>({
      items: [],
      currentIndex: -1,
      shuffleEnabled: false,
      repeatEnabled: false,
    }),
    toggleFullscreen: vi.fn().mockResolvedValue(undefined),
    enterMiniplayer: vi.fn().mockResolvedValue(undefined),
    showOpenUrlWindow: vi.fn().mockResolvedValue(undefined),
    // SettingsService is constructed transitively by this component and
    // registers itself for SSE settings pushes in its constructor.
    serverUrl: signal(''),
    onSettingsUpdate: vi.fn().mockReturnValue((): void => {}),
    authFetch: vi.fn().mockResolvedValue({ok: true, json: vi.fn().mockResolvedValue({})}),
  };
}

/**
 * Creates a mock DependencyService with writable signals.
 */
function createMockDependencyService(): Record<string, unknown> {
  return {
    noDependenciesInstalled: signal(false),
  };
}

/**
 * Helper to create a PlaylistItem for testing.
 */
function createPlaylistItem(id: string, title: string, artist?: string): PlaylistItem {
  return {
    id,
    filePath: `/music/${title}.mp3`,
    title,
    artist,
    duration: 180,
    type: 'audio',
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('LayoutControls', (): void => {
  let component: LayoutControls;
  let fixture: ComponentFixture<LayoutControls>;
  let mockMediaPlayer: ReturnType<typeof createMockMediaPlayerService>;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let mockDeps: ReturnType<typeof createMockDependencyService>;

  beforeEach(async (): Promise<void> => {
    mockMediaPlayer = createMockMediaPlayerService();
    mockElectron = createMockElectronService();
    mockDeps = createMockDependencyService();

    await TestBed.configureTestingModule({
      imports: [LayoutControls],
      providers: [
        {provide: MediaPlayerService, useValue: mockMediaPlayer},
        {provide: ElectronService, useValue: mockElectron},
        {provide: DependencyService, useValue: mockDeps},
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(LayoutControls);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  // ==========================================================================
  // Component Creation
  // ==========================================================================

  it('should create', (): void => {
    expect(component).toBeTruthy();
  });

  // ==========================================================================
  // Computed Signals - canOpenFiles
  // ==========================================================================

  describe('canOpenFiles', (): void => {
    it('should return true when dependencies are installed', (): void => {
      (mockDeps['noDependenciesInstalled'] as WritableSignal<boolean>).set(false);
      const result: boolean = component.canOpenFiles();
      expect(result).toBe(true);
    });

    it('should return false when no dependencies are installed', (): void => {
      (mockDeps['noDependenciesInstalled'] as WritableSignal<boolean>).set(true);
      const result: boolean = component.canOpenFiles();
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // Computed Signals - Playback State
  // ==========================================================================

  describe('isPlaying', (): void => {
    it('should reflect media player playing state', (): void => {
      (mockMediaPlayer['isPlaying'] as WritableSignal<boolean>).set(true);
      const result: boolean = component.isPlaying();
      expect(result).toBe(true);
    });
  });

  describe('progress', (): void => {
    it('should reflect media player progress', (): void => {
      (mockMediaPlayer['progress'] as WritableSignal<number>).set(42.5);
      const result: number = component.progress();
      expect(result).toBe(42.5);
    });
  });

  describe('volume', (): void => {
    it('should compute volume as percentage (0-100)', (): void => {
      (mockMediaPlayer['currentVolume'] as WritableSignal<number>).set(0.75);
      const result: number = component.volume();
      expect(result).toBe(75);
    });
  });

  describe('hasTrack', (): void => {
    it('should return false when no track is loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(null);
      const result: boolean = component.hasTrack();
      expect(result).toBe(false);
    });

    it('should return true when a track is loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track One')
      );
      const result: boolean = component.hasTrack();
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // Computed Signals - Time Display
  // ==========================================================================

  describe('currentTime', (): void => {
    it('should format time correctly', (): void => {
      (mockMediaPlayer['time'] as WritableSignal<number>).set(125);
      const result: string = component.currentTime();
      expect(result).toBe('2:05');
      expect(mockMediaPlayer['formatTime']).toHaveBeenCalledWith(125);
    });
  });

  describe('totalDuration', (): void => {
    it('should format total duration correctly', (): void => {
      (mockMediaPlayer['totalDuration'] as WritableSignal<number>).set(240);
      const result: string = component.totalDuration();
      expect(result).toBe('4:00');
      expect(mockMediaPlayer['formatTime']).toHaveBeenCalledWith(240);
    });
  });

  // ==========================================================================
  // Computed Signals - Skip Navigation
  // ==========================================================================

  describe('canSkipBackward', (): void => {
    it('should return true when playlist count is at least 1', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(1);
      const result: boolean = component.canSkipBackward();
      expect(result).toBe(true);
    });

    it('should return false when playlist is empty', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(0);
      const result: boolean = component.canSkipBackward();
      expect(result).toBe(false);
    });
  });

  describe('canSkipForward', (): void => {
    it('should return false when single track without shift or repeat', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(1);
      (mockMediaPlayer['isRepeatEnabled'] as WritableSignal<boolean>).set(false);
      const result: boolean = component.canSkipForward();
      expect(result).toBe(false);
    });

    it('should return true when shift is pressed', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(1);
      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      const result: boolean = component.canSkipForward();
      expect(result).toBe(true);
    });

    it('should return true when multiple tracks and not at end', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(3);
      (mockMediaPlayer['isRepeatEnabled'] as WritableSignal<boolean>).set(false);
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [
          createPlaylistItem('a', 'A'),
          createPlaylistItem('b', 'B'),
          createPlaylistItem('c', 'C'),
        ],
        currentIndex: 0,
        shuffleEnabled: false,
        repeatEnabled: false,
      });
      const result: boolean = component.canSkipForward();
      expect(result).toBe(true);
    });

    it('should return true when repeat is enabled', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(2);
      (mockMediaPlayer['isRepeatEnabled'] as WritableSignal<boolean>).set(true);
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [
          createPlaylistItem('a', 'A'),
          createPlaylistItem('b', 'B'),
        ],
        currentIndex: 1,
        shuffleEnabled: false,
        repeatEnabled: true,
      });
      const result: boolean = component.canSkipForward();
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // Computed Signals - Icons
  // ==========================================================================

  describe('backwardIcon', (): void => {
    it('should show step icon by default', (): void => {
      const result: string = component.backwardIcon();
      expect(result).toBe('fa-solid fa-backward-step');
    });

    it('should show backward icon when shift pressed and track loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );
      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      const result: string = component.backwardIcon();
      expect(result).toBe('fa-solid fa-backward');
    });
  });

  describe('forwardIcon', (): void => {
    it('should show step icon by default', (): void => {
      const result: string = component.forwardIcon();
      expect(result).toBe('fa-solid fa-forward-step');
    });

    it('should show forward icon when shift pressed and track loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );
      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      const result: string = component.forwardIcon();
      expect(result).toBe('fa-solid fa-forward');
    });
  });

  describe('playPauseIcon', (): void => {
    it('should show play icon when not playing', (): void => {
      (mockMediaPlayer['isPlaying'] as WritableSignal<boolean>).set(false);
      const result: string = component.playPauseIcon();
      expect(result).toBe('fa-solid fa-play');
    });

    it('should show pause icon when playing', (): void => {
      (mockMediaPlayer['isPlaying'] as WritableSignal<boolean>).set(true);
      const result: string = component.playPauseIcon();
      expect(result).toBe('fa-solid fa-pause');
    });

    it('should show stop icon when shift pressed and track loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );
      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      const result: string = component.playPauseIcon();
      expect(result).toBe('fa-solid fa-stop');
    });
  });

  // ==========================================================================
  // Event Handlers - Transport Controls
  // ==========================================================================

  describe('onBackward', (): void => {
    it('should call previous() without shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: false});
      await component.onBackward(event);
      expect(mockMediaPlayer['previous']).toHaveBeenCalled();
      expect(mockMediaPlayer['skipBackward']).not.toHaveBeenCalled();
    });

    it('should call skipBackward() with shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: true});
      await component.onBackward(event);
      expect(mockMediaPlayer['skipBackward']).toHaveBeenCalled();
      expect(mockMediaPlayer['previous']).not.toHaveBeenCalled();
    });
  });

  describe('onPlayPause', (): void => {
    it('should call togglePlayPause() without shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: false});
      await component.onPlayPause(event);
      expect(mockMediaPlayer['togglePlayPause']).toHaveBeenCalled();
      expect(mockMediaPlayer['stop']).not.toHaveBeenCalled();
    });

    it('should call stop() with shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: true});
      await component.onPlayPause(event);
      expect(mockMediaPlayer['stop']).toHaveBeenCalled();
      expect(mockMediaPlayer['togglePlayPause']).not.toHaveBeenCalled();
    });
  });

  describe('onForward', (): void => {
    it('should call next() without shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: false});
      await component.onForward(event);
      expect(mockMediaPlayer['next']).toHaveBeenCalled();
      expect(mockMediaPlayer['skipForward']).not.toHaveBeenCalled();
    });

    it('should call skipForward() with shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: true});
      await component.onForward(event);
      expect(mockMediaPlayer['skipForward']).toHaveBeenCalled();
      expect(mockMediaPlayer['next']).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event Handlers - Playlist Modes
  // ==========================================================================

  describe('onShuffle', (): void => {
    it('should call toggleShuffle', async (): Promise<void> => {
      await component.onShuffle();
      expect(mockMediaPlayer['toggleShuffle']).toHaveBeenCalled();
    });
  });

  describe('onRepeat', (): void => {
    it('should call toggleRepeat', async (): Promise<void> => {
      await component.onRepeat();
      expect(mockMediaPlayer['toggleRepeat']).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event Handlers - File Operations
  // ==========================================================================

  describe('onEject', (): void => {
    it('should call eject', async (): Promise<void> => {
      await component.onEject();
      expect(mockMediaPlayer['eject']).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event Handlers - Volume Control
  // ==========================================================================

  describe('onMuteToggle', (): void => {
    it('should call toggleMute', async (): Promise<void> => {
      await component.onMuteToggle();
      expect(mockMediaPlayer['toggleMute']).toHaveBeenCalled();
    });
  });

  describe('onVolumeMouseDown', (): void => {
    it('should call setVolume with calculated percentage on mousedown', (): void => {
      const target: HTMLDivElement = document.createElement('div');
      Object.defineProperty(target, 'getBoundingClientRect', {
        value: (): DOMRect => ({
          left: 0,
          width: 100,
          top: 0,
          right: 100,
          bottom: 10,
          height: 10,
          x: 0,
          y: 0,
          toJSON: (): string => '',
        }),
      });

      const event: MouseEvent = new MouseEvent('mousedown', {clientX: 75, bubbles: true});
      Object.defineProperty(event, 'currentTarget', {value: target, writable: false});

      component.onVolumeMouseDown(event);
      expect(mockMediaPlayer['setVolume']).toHaveBeenCalledWith(0.75);
    });
  });

  // ==========================================================================
  // Event Handlers - Window Control
  // ==========================================================================

  describe('onToggleFullscreen', (): void => {
    it('should call toggleFullscreen on electron service', async (): Promise<void> => {
      await component.onToggleFullscreen();
      expect(mockElectron['toggleFullscreen']).toHaveBeenCalled();
    });
  });

  describe('onEnterMiniplayer', (): void => {
    it('should call enterMiniplayer on electron service', async (): Promise<void> => {
      await component.onEnterMiniplayer();
      expect(mockElectron['enterMiniplayer']).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event Handlers - Seek Control
  // ==========================================================================

  describe('onProgressMouseDown', (): void => {
    /** Creates a progress element with a mocked bounding rect. */
    function createSeekBar(left: number, width: number): HTMLProgressElement {
      const target: HTMLProgressElement = document.createElement('progress');
      Object.defineProperty(target, 'getBoundingClientRect', {
        value: (): DOMRect => ({
          left,
          width,
          top: 0,
          right: left + width,
          bottom: 10,
          height: 10,
          x: left,
          y: 0,
          toJSON: (): void => {},
        }),
      });
      return target;
    }

    /** Dispatches a mousedown on the seek bar at the given X position. */
    function pressSeekBar(target: HTMLProgressElement, clientX: number): void {
      const event: MouseEvent = new MouseEvent('mousedown', {clientX});
      Object.defineProperty(event, 'currentTarget', {value: target, writable: false});
      component.onProgressMouseDown(event);
    }

    it('should preview the pressed position without seeking until release', (): void => {
      pressSeekBar(createSeekBar(0, 200), 100);

      // No seek yet — only a local preview of the drag position
      expect(mockMediaPlayer['seekToProgress']).not.toHaveBeenCalled();
      expect(component.progress()).toBe(50);
    });

    it('should seek once to the release position on mouseup', (): void => {
      pressSeekBar(createSeekBar(0, 200), 100);

      // Drag to 75% then release there
      document.dispatchEvent(new MouseEvent('mousemove', {clientX: 150}));
      expect(mockMediaPlayer['seekToProgress']).not.toHaveBeenCalled();

      document.dispatchEvent(new MouseEvent('mouseup', {clientX: 150}));
      expect(mockMediaPlayer['seekToProgress']).toHaveBeenCalledTimes(1);
      expect(mockMediaPlayer['seekToProgress']).toHaveBeenCalledWith(75);
    });

    it('should clamp percentage to 0-100 range', (): void => {
      const target: HTMLProgressElement = createSeekBar(100, 200);

      // Release before the progress bar (should clamp to 0)
      pressSeekBar(target, 50);
      document.dispatchEvent(new MouseEvent('mouseup', {clientX: 50}));
      expect(mockMediaPlayer['seekToProgress']).toHaveBeenCalledWith(0);

      // Release after the progress bar (should clamp to 100)
      pressSeekBar(target, 400);
      document.dispatchEvent(new MouseEvent('mouseup', {clientX: 400}));
      expect(mockMediaPlayer['seekToProgress']).toHaveBeenCalledWith(100);
    });
  });

  // ==========================================================================
  // Keyboard Event Listeners
  // ==========================================================================

  describe('keyboard events', (): void => {
    it('should track shift key press and release', (): void => {
      // Shift pressed: icons should change when track is loaded
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );

      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      expect(component.backwardIcon()).toBe('fa-solid fa-backward');

      component.onKeyUp(new KeyboardEvent('keyup', {key: 'Shift'}));
      expect(component.backwardIcon()).toBe('fa-solid fa-backward-step');
    });

    it('should ignore non-Shift key events', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );

      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Control'}));
      expect(component.backwardIcon()).toBe('fa-solid fa-backward-step');
    });
  });
});

// ============================================================================
// Rendered behaviour
// ============================================================================

describe('LayoutControls rendered', (): void => {
  let component: LayoutControls;
  let fixture: ComponentFixture<LayoutControls>;
  let host: HTMLElement;
  let mockMediaPlayer: ReturnType<typeof createMockMediaPlayerService>;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let mockDeps: ReturnType<typeof createMockDependencyService>;
  let seekMode: WritableSignal<'drop' | 'drag'>;

  /** Returns a spy from the fake MediaPlayerService by name. */
  function playerSpy(name: string): ReturnType<typeof vi.fn> {
    return mockMediaPlayer[name] as ReturnType<typeof vi.fn>;
  }

  /** Sets a writable signal on one of the fake services and re-renders. */
  async function setSignal<T>(service: Record<string, unknown>, name: string, value: T): Promise<void> {
    (service[name] as WritableSignal<T>).set(value);
    await fixture.whenStable();
  }

  /** Finds the button that carries the given icon. */
  function buttonWithIcon(icon: string): HTMLButtonElement {
    return host.querySelector(`i.${icon}`)!.closest('button')!;
  }

  /** Finds a transport button by its position in the centre group. */
  function transportButton(position: 'backward' | 'playPause' | 'forward'): HTMLButtonElement {
    const index: number = ['backward', 'playPause', 'forward'].indexOf(position);
    return host.querySelectorAll<HTMLButtonElement>('.button-group.center button')[index];
  }

  /** Names the icon inside an element, ignoring the shared style class. */
  function iconName(container: Element): string {
    return Array.from(container.querySelector('i')!.classList)
      .filter((name: string): boolean => name !== 'fa-solid')
      .join(' ');
  }

  /** Names the icon currently shown on a transport button. */
  function transportIcon(position: 'backward' | 'playPause' | 'forward'): string {
    return iconName(transportButton(position));
  }

  /** Clicks an element, optionally with Shift held. */
  function click(element: HTMLElement, shiftKey: boolean = false): void {
    element.dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey}));
  }

  /** Gives an element a known horizontal extent: 200px wide starting at x=100. */
  function layOut(element: Element): void {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({left: 100, width: 200} as DOMRect);
  }

  /** Returns the seek bar, laid out 200px wide starting at x=100. */
  function seekBar(): HTMLProgressElement {
    return host.querySelector<HTMLProgressElement>('.seek-bar-container progress')!;
  }

  /** Returns the volume slider, laid out 200px wide starting at x=100. */
  function volumeSlider(): HTMLElement {
    return host.querySelector<HTMLElement>('.volume-slider')!;
  }

  /** Presses the mouse on an element at a horizontal position. */
  function press(element: Element, clientX: number): MouseEvent {
    const event: MouseEvent = new MouseEvent('mousedown', {bubbles: true, cancelable: true, clientX});
    element.dispatchEvent(event);
    return event;
  }

  /** Moves the mouse over the document to a horizontal position. */
  function drag(clientX: number): void {
    document.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX}));
  }

  /** Releases the mouse over the document at a horizontal position. */
  function release(clientX: number): void {
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX}));
  }

  /** Loads a track so the transport buttons are enabled. */
  async function loadTrack(playlistCount: number = 1): Promise<void> {
    (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(playlistCount);
    await setSignal<PlaylistItem | null>(mockMediaPlayer, 'currentTrack', createPlaylistItem('1', 'Song'));
  }

  beforeEach(async (): Promise<void> => {
    mockMediaPlayer = createMockMediaPlayerService();
    mockElectron = createMockElectronService();
    mockDeps = createMockDependencyService();
    seekMode = signal<'drop' | 'drag'>('drop');

    await TestBed.configureTestingModule({
      imports: [LayoutControls],
      providers: [
        {provide: MediaPlayerService, useValue: mockMediaPlayer},
        {provide: ElectronService, useValue: mockElectron},
        {provide: DependencyService, useValue: mockDeps},
        {provide: SettingsService, useValue: {seekMode}},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LayoutControls);
    component = fixture.componentInstance;
    host = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    layOut(seekBar());
    layOut(volumeSlider());
  });

  afterEach((): void => {
    fixture.destroy();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Button availability
  // ==========================================================================

  describe('button availability', (): void => {
    it('disables everything that needs a track while nothing is loaded', (): void => {
      const disabled: boolean[] = ['fa-shuffle', 'fa-repeat', 'fa-backward-step', 'fa-play', 'fa-forward-step', 'fa-tv', 'fa-picture-in-picture']
        .map((icon: string): boolean => buttonWithIcon(icon).disabled);

      expect(disabled).toEqual([true, true, true, true, true, true, true]);
    });

    it('keeps eject, open URL and mute available while nothing is loaded', (): void => {
      expect(buttonWithIcon('fa-eject').disabled).toBe(false);
      expect(buttonWithIcon('fa-link').disabled).toBe(false);
      expect(buttonWithIcon('fa-volume-high').disabled).toBe(false);
    });

    it('disables eject and open URL when nothing can be played', async (): Promise<void> => {
      await setSignal(mockDeps, 'noDependenciesInstalled', true);

      expect(buttonWithIcon('fa-eject').disabled).toBe(true);
      expect(buttonWithIcon('fa-link').disabled).toBe(true);
    });

    it('enables the track buttons once a track is loaded', async (): Promise<void> => {
      await loadTrack();

      const disabled: boolean[] = ['fa-shuffle', 'fa-repeat', 'fa-backward-step', 'fa-play', 'fa-tv', 'fa-picture-in-picture']
        .map((icon: string): boolean => buttonWithIcon(icon).disabled);
      expect(disabled).toEqual([false, false, false, false, false, false]);
    });

    it('keeps next disabled for the only track in the playlist', async (): Promise<void> => {
      await loadTrack(1);

      expect(transportButton('forward').disabled).toBe(true);
    });

    it('keeps next disabled on the last track of the playlist', async (): Promise<void> => {
      await loadTrack(3);
      await setSignal<PlaylistState>(mockElectron, 'playlist', {items: [], currentIndex: 2, shuffleEnabled: false, repeatEnabled: false});

      expect(transportButton('forward').disabled).toBe(true);
    });

    it('enables next when a later track exists', async (): Promise<void> => {
      await loadTrack(3);
      await setSignal<PlaylistState>(mockElectron, 'playlist', {items: [], currentIndex: 1, shuffleEnabled: false, repeatEnabled: false});

      expect(transportButton('forward').disabled).toBe(false);
    });

    it('enables next on the last track when repeat is on', async (): Promise<void> => {
      await loadTrack(3);
      await setSignal<PlaylistState>(mockElectron, 'playlist', {items: [], currentIndex: 2, shuffleEnabled: false, repeatEnabled: true});
      await setSignal(mockMediaPlayer, 'isRepeatEnabled', true);

      expect(transportButton('forward').disabled).toBe(false);
    });

    it('disables fullscreen and miniplayer while the configuration window is open', async (): Promise<void> => {
      await loadTrack();
      await setSignal(mockElectron, 'isConfigOpen', true);

      expect(buttonWithIcon('fa-tv').disabled).toBe(true);
      expect(buttonWithIcon('fa-picture-in-picture').disabled).toBe(true);
    });
  });

  // ==========================================================================
  // Displayed state
  // ==========================================================================

  describe('displayed state', (): void => {
    it('shows the elapsed and total time', async (): Promise<void> => {
      (mockMediaPlayer['time'] as WritableSignal<number>).set(65);
      await setSignal(mockMediaPlayer, 'totalDuration', 200);

      expect(host.querySelector('.time-display.current')?.textContent).toBe('1:05');
      expect(host.querySelector('.time-display.total')?.textContent).toBe('3:20');
    });

    it('fills the seek bar to the playback progress', async (): Promise<void> => {
      await setSignal(mockMediaPlayer, 'progress', 40);

      expect(seekBar().value).toBe(40);
    });

    it('shows a pause icon while playing', async (): Promise<void> => {
      await setSignal(mockMediaPlayer, 'isPlaying', true);

      expect(transportIcon('playPause')).toBe('fa-pause');
    });

    it('highlights shuffle and repeat when they are on', async (): Promise<void> => {
      (mockMediaPlayer['isShuffleEnabled'] as WritableSignal<boolean>).set(true);
      await setSignal(mockMediaPlayer, 'isRepeatEnabled', true);

      expect(buttonWithIcon('fa-shuffle').classList.contains('active')).toBe(true);
      expect(buttonWithIcon('fa-repeat').classList.contains('active')).toBe(true);
    });

    it('offers to enter fullscreen while windowed', (): void => {
      expect(buttonWithIcon('fa-tv').title).toBe('Enter fullscreen');
    });

    it('offers to exit fullscreen while fullscreen', async (): Promise<void> => {
      await setSignal(mockElectron, 'isFullscreen', true);

      expect(buttonWithIcon('fa-window-restore').title).toBe('Exit fullscreen');
      expect(host.querySelector('i.fa-tv')).toBeNull();
    });

    it.each([
      {volume: 0, icon: 'fa-volume-off'},
      {volume: 0.2, icon: 'fa-volume-low'},
      {volume: 0.33, icon: 'fa-volume-low'},
      {volume: 0.5, icon: 'fa-volume'},
      {volume: 0.66, icon: 'fa-volume'},
      {volume: 0.9, icon: 'fa-volume-high'},
    ])('shows $icon at volume $volume', async (testCase: {volume: number; icon: string}): Promise<void> => {
      await setSignal(mockMediaPlayer, 'currentVolume', testCase.volume);

      expect(iconName(host.querySelector('.button-group.right button')!)).toBe(testCase.icon);
    });

    it('shows the muted icon whatever the volume while muted', async (): Promise<void> => {
      await setSignal(mockMediaPlayer, 'isMuted', true);

      const button: HTMLButtonElement = host.querySelector<HTMLButtonElement>('.button-group.right button')!;
      expect(iconName(button)).toBe('fa-volume-xmark');
      expect(button.classList.contains('muted')).toBe(true);
    });

    it('positions the volume thumb at the volume level', async (): Promise<void> => {
      await setSignal(mockMediaPlayer, 'currentVolume', 0.4);

      expect(host.querySelector<HTMLElement>('.volume-thumb')!.style.left).toBe('40%');
      expect(host.querySelector<HTMLProgressElement>('.volume-slider progress')!.value).toBe(40);
    });
  });

  // ==========================================================================
  // Button clicks
  // ==========================================================================

  describe('button clicks', (): void => {
    beforeEach(async (): Promise<void> => {
      await loadTrack(3);
    });

    it('eject opens the file picker', (): void => {
      click(buttonWithIcon('fa-eject'));

      expect(playerSpy('eject')).toHaveBeenCalledTimes(1);
    });

    it('open URL opens the URL window', (): void => {
      click(buttonWithIcon('fa-link'));

      expect(mockElectron['showOpenUrlWindow']).toHaveBeenCalledTimes(1);
    });

    it('shuffle toggles shuffle', (): void => {
      click(buttonWithIcon('fa-shuffle'));

      expect(playerSpy('toggleShuffle')).toHaveBeenCalledTimes(1);
    });

    it('repeat toggles repeat', (): void => {
      click(buttonWithIcon('fa-repeat'));

      expect(playerSpy('toggleRepeat')).toHaveBeenCalledTimes(1);
    });

    it('mute toggles mute', (): void => {
      click(host.querySelector<HTMLButtonElement>('.button-group.right button')!);

      expect(playerSpy('toggleMute')).toHaveBeenCalledTimes(1);
    });

    it('fullscreen toggles fullscreen', (): void => {
      click(buttonWithIcon('fa-tv'));

      expect(mockElectron['toggleFullscreen']).toHaveBeenCalledTimes(1);
    });

    it('miniplayer enters the miniplayer', (): void => {
      click(buttonWithIcon('fa-picture-in-picture'));

      expect(mockElectron['enterMiniplayer']).toHaveBeenCalledTimes(1);
    });

    it.each([
      {position: 'backward' as const, shiftKey: false, expected: 'previous'},
      {position: 'backward' as const, shiftKey: true, expected: 'skipBackward'},
      {position: 'playPause' as const, shiftKey: false, expected: 'togglePlayPause'},
      {position: 'playPause' as const, shiftKey: true, expected: 'stop'},
      {position: 'forward' as const, shiftKey: false, expected: 'next'},
      {position: 'forward' as const, shiftKey: true, expected: 'skipForward'},
    ])('$position with shift=$shiftKey calls $expected only', (testCase: {position: 'backward' | 'playPause' | 'forward'; shiftKey: boolean; expected: string}): void => {
      click(transportButton(testCase.position), testCase.shiftKey);

      const called: string[] = ['previous', 'skipBackward', 'togglePlayPause', 'stop', 'next', 'skipForward']
        .filter((name: string): boolean => playerSpy(name).mock.calls.length > 0);
      expect(called).toEqual([testCase.expected]);
    });

    it('drops focus from a button once the mouse is released', (): void => {
      const button: HTMLButtonElement = buttonWithIcon('fa-shuffle');
      button.focus();

      button.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));

      expect(document.activeElement).not.toBe(button);
    });
  });

  // ==========================================================================
  // Shift key
  // ==========================================================================

  describe('holding Shift', (): void => {
    /** Presses or releases a key on the document and re-renders. */
    async function key(type: 'keydown' | 'keyup', name: string): Promise<void> {
      document.dispatchEvent(new KeyboardEvent(type, {key: name, bubbles: true}));
      await fixture.whenStable();
    }

    it('turns the transport buttons into skip back, stop and skip forward', async (): Promise<void> => {
      await loadTrack();

      await key('keydown', 'Shift');

      expect([transportIcon('backward'), transportIcon('playPause'), transportIcon('forward')])
        .toEqual(['fa-backward', 'fa-stop', 'fa-forward']);
    });

    it('enables skip forward even for the only track', async (): Promise<void> => {
      await loadTrack(1);

      await key('keydown', 'Shift');

      expect(transportButton('forward').disabled).toBe(false);
    });

    it('restores the normal buttons when Shift is released', async (): Promise<void> => {
      await loadTrack();
      await key('keydown', 'Shift');

      await key('keyup', 'Shift');

      expect([transportIcon('backward'), transportIcon('playPause'), transportIcon('forward')])
        .toEqual(['fa-backward-step', 'fa-play', 'fa-forward-step']);
    });

    it('leaves the icons alone while no track is loaded', async (): Promise<void> => {
      await key('keydown', 'Shift');

      expect([transportIcon('backward'), transportIcon('playPause'), transportIcon('forward')])
        .toEqual(['fa-backward-step', 'fa-play', 'fa-forward-step']);
    });

    it('ignores other keys being pressed', async (): Promise<void> => {
      await loadTrack();

      await key('keydown', 'Control');

      expect(transportIcon('playPause')).toBe('fa-play');
    });

    it('stays in Shift mode when another key is released', async (): Promise<void> => {
      await loadTrack();
      await key('keydown', 'Shift');

      await key('keyup', 'a');

      expect(transportIcon('playPause')).toBe('fa-stop');
    });
  });

  // ==========================================================================
  // Volume slider
  // ==========================================================================

  describe('volume slider', (): void => {
    it('sets the volume to the pressed position', (): void => {
      press(volumeSlider(), 150);

      expect(playerSpy('setVolume')).toHaveBeenCalledExactlyOnceWith(0.25);
    });

    it('suppresses the browser default on press so no text selection starts', (): void => {
      const event: MouseEvent = press(volumeSlider(), 150);

      expect(event.defaultPrevented).toBe(true);
    });

    it('follows the mouse while dragging, even outside the slider', (): void => {
      press(volumeSlider(), 150);

      drag(250);

      expect(playerSpy('setVolume')).toHaveBeenLastCalledWith(0.75);
    });

    it('stops at full volume when dragged past the right edge', (): void => {
      press(volumeSlider(), 150);

      drag(900);

      expect(playerSpy('setVolume')).toHaveBeenLastCalledWith(1);
    });

    it('stops at silence when dragged past the left edge', (): void => {
      press(volumeSlider(), 150);

      drag(-50);

      expect(playerSpy('setVolume')).toHaveBeenLastCalledWith(0);
    });

    it('sets the volume to the release position', (): void => {
      press(volumeSlider(), 150);

      release(200);

      expect(playerSpy('setVolume')).toHaveBeenLastCalledWith(0.5);
    });

    it('stops following the mouse after release', (): void => {
      press(volumeSlider(), 150);
      release(200);
      playerSpy('setVolume').mockClear();

      drag(250);
      release(250);

      expect(playerSpy('setVolume')).not.toHaveBeenCalled();
    });

    it('does not react to mouse movement before any press', (): void => {
      drag(250);
      release(250);

      expect(playerSpy('setVolume')).not.toHaveBeenCalled();
    });

    it('stops following the mouse when destroyed mid-drag', (): void => {
      press(volumeSlider(), 150);
      playerSpy('setVolume').mockClear();

      fixture.destroy();
      drag(250);

      expect(playerSpy('setVolume')).not.toHaveBeenCalled();
    });

    it('ignores a press that does not come from an element', (): void => {
      component.onVolumeMouseDown(new MouseEvent('mousedown', {clientX: 150}));

      expect(playerSpy('setVolume')).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Seek bar
  // ==========================================================================

  describe('seek bar', (): void => {
    beforeEach(async (): Promise<void> => {
      await setSignal(mockMediaPlayer, 'progress', 10);
    });

    it('previews the pressed position without seeking', async (): Promise<void> => {
      press(seekBar(), 150);
      await fixture.whenStable();

      expect(seekBar().value).toBe(25);
      expect(playerSpy('seekToProgress')).not.toHaveBeenCalled();
    });

    it('suppresses the browser default on press', (): void => {
      const event: MouseEvent = press(seekBar(), 150);

      expect(event.defaultPrevented).toBe(true);
    });

    it('moves the preview with the mouse without seeking in drop mode', async (): Promise<void> => {
      press(seekBar(), 150);

      drag(250);
      await fixture.whenStable();

      expect(seekBar().value).toBe(75);
      expect(playerSpy('seekToProgress')).not.toHaveBeenCalled();
    });

    it('keeps the preview inside the bar when dragged past its ends', async (): Promise<void> => {
      press(seekBar(), 150);

      drag(900);
      await fixture.whenStable();

      expect(seekBar().value).toBe(100);
    });

    it('seeks once to the release position', (): void => {
      press(seekBar(), 150);
      drag(250);

      release(200);

      expect(playerSpy('seekToProgress')).toHaveBeenCalledExactlyOnceWith(50);
    });

    it('holds the released position until the seek completes', async (): Promise<void> => {
      playerSpy('seekToProgress').mockReturnValue(new Promise<void>((): void => {}));
      press(seekBar(), 150);

      release(200);
      await fixture.whenStable();

      expect(seekBar().value).toBe(50);
    });

    it('returns to the playback progress once the seek completes', async (): Promise<void> => {
      press(seekBar(), 150);

      release(200);
      await fixture.whenStable();

      expect(seekBar().value).toBe(10);
    });

    it('logs when the seek to the release position fails', async (): Promise<void> => {
      const failure: Error = new Error('HTTP 500: Internal Server Error');
      const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});
      playerSpy('seekToProgress').mockRejectedValue(failure);
      press(seekBar(), 150);

      release(200);
      await fixture.whenStable();

      expect(errorSpy).toHaveBeenCalledWith('[LayoutControls] Seek failed:', failure);
    });

    it('returns to the playback progress when the seek fails', async (): Promise<void> => {
      vi.spyOn(console, 'error').mockImplementation((): void => {});
      playerSpy('seekToProgress').mockRejectedValue(new Error('HTTP 500: Internal Server Error'));
      press(seekBar(), 150);

      release(200);
      await fixture.whenStable();

      expect(seekBar().value).toBe(10);
    });

    it('stops following the mouse after release', async (): Promise<void> => {
      press(seekBar(), 150);
      release(200);
      await fixture.whenStable();
      playerSpy('seekToProgress').mockClear();

      drag(250);
      release(250);
      await fixture.whenStable();

      expect(seekBar().value).toBe(10);
      expect(playerSpy('seekToProgress')).not.toHaveBeenCalled();
    });

    it('stops following the mouse when destroyed mid-drag', (): void => {
      seekMode.set('drag');
      press(seekBar(), 150);

      fixture.destroy();
      drag(250);
      release(250);

      expect(playerSpy('seekToProgress')).not.toHaveBeenCalled();
    });

    it('ignores a press that does not come from an element', async (): Promise<void> => {
      component.onProgressMouseDown(new MouseEvent('mousedown', {clientX: 150}));
      await fixture.whenStable();

      expect(seekBar().value).toBe(10);
    });

    describe('in drag mode', (): void => {
      beforeEach((): void => {
        seekMode.set('drag');
      });

      it('seeks while the mouse moves', (): void => {
        press(seekBar(), 150);

        drag(250);

        expect(playerSpy('seekToProgress')).toHaveBeenCalledExactlyOnceWith(75);
      });

      it('skips positions that arrive while a seek is still in flight', (): void => {
        playerSpy('seekToProgress').mockReturnValue(new Promise<void>((): void => {}));
        press(seekBar(), 150);

        drag(250);
        drag(260);
        drag(270);

        expect(playerSpy('seekToProgress')).toHaveBeenCalledExactlyOnceWith(75);
      });

      it('seeks again once the previous seek has completed', async (): Promise<void> => {
        press(seekBar(), 150);
        drag(250);
        await fixture.whenStable();

        drag(260);

        expect(playerSpy('seekToProgress').mock.calls).toEqual([[75], [80]]);
      });

      it('logs when a live seek fails', async (): Promise<void> => {
        const failure: Error = new Error('HTTP 500: Internal Server Error');
        const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});
        playerSpy('seekToProgress').mockRejectedValue(failure);
        press(seekBar(), 150);

        drag(250);
        await fixture.whenStable();

        expect(errorSpy).toHaveBeenCalledWith('[LayoutControls] Seek failed:', failure);
      });

      it('seeks again after a live seek has failed', async (): Promise<void> => {
        vi.spyOn(console, 'error').mockImplementation((): void => {});
        playerSpy('seekToProgress').mockRejectedValue(new Error('HTTP 500: Internal Server Error'));
        press(seekBar(), 150);
        drag(250);
        await fixture.whenStable();

        drag(260);

        expect(playerSpy('seekToProgress').mock.calls).toEqual([[75], [80]]);
      });

      it('still seeks to the release position while a live seek is in flight', (): void => {
        playerSpy('seekToProgress').mockReturnValueOnce(new Promise<void>((): void => {}));
        press(seekBar(), 150);
        drag(250);

        release(200);

        expect(playerSpy('seekToProgress')).toHaveBeenLastCalledWith(50);
      });
    });
  });
});
