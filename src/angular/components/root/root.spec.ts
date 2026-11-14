/**
 * @fileoverview Unit tests for the Root component.
 *
 * Tests cover:
 * - Component creation
 * - Computed signals (isFullscreen, isMiniplayer, viewMode, isVideo, cursorHidden, showControls)
 * - Host bindings (fullscreenClass, miniplayerClass, cursorHiddenClass)
 * - Event listeners (Escape key, Tab key, mouse events for drag)
 * - Configuration mode (enter, exit, exit fullscreen/miniplayer first)
 * - About mode (enter, exit)
 * - Miniplayer mouse enter/leave for controls visibility
 * - ngOnDestroy cleanup
 *
 * All child components are ignored via NO_ERRORS_SCHEMA. Services are mocked
 * with writable signals so that reactive state can be manipulated in tests.
 *
 * @module app/components/root/root.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {Component, forwardRef, output, OutputEmitterRef, signal, WritableSignal, NO_ERRORS_SCHEMA} from '@angular/core';
import {Root} from './root';
import {LayoutOutlet} from '../layout/layout-outlet/layout-outlet';
import {ElectronService} from '../../services/electron.service';
import {MediaPlayerService} from '../../services/media-player.service';
import {SettingsService} from '../../services/settings.service';
import {DependencyService} from '../../services/dependency.service';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock ElectronService with writable signals and vi.fn() methods.
 * All signals are writable so tests can manipulate reactive state.
 */
function createMockElectronService(): Record<string, unknown> {
  return {
    isFullscreen: signal(false),
    viewMode: signal('desktop' as 'desktop' | 'miniplayer' | 'fullscreen'),
    menuShowConfig: signal(0),
    menuOpenFile: signal(0),
    menuShowHelp: signal(0),
    menuOpenPlaylist: signal(0),
    menuSavePlaylist: signal(0),
    menuSavePlaylistAs: signal(0),
    menuSelectAspectMode: signal(''),
    exitConfigurationModeRequested: signal(0),
    fadeOutRequested: signal(0),
    platformInfo: signal({platform: 'darwin', supportsGlass: false, systemTheme: 'dark' as const}),
    playlist: signal({items: [], currentIndex: -1, shuffleEnabled: false, repeatEnabled: false}),
    streamingBusy: signal(false),
    exitFullscreen: vi.fn().mockResolvedValue(undefined),
    exitMiniplayer: vi.fn().mockResolvedValue(undefined),
    openFileDialog: vi.fn().mockResolvedValue([]),
    addFilesWithAutoPlay: vi.fn().mockResolvedValue(undefined),
    setTrafficLightVisibility: vi.fn().mockResolvedValue(undefined),
    setConfigurationMode: vi.fn().mockResolvedValue(undefined),
    showConfigurationWindow: vi.fn().mockResolvedValue(undefined),
    getWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
    setWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
    saveMiniplayerBounds: vi.fn().mockResolvedValue(undefined),
    openPlaylistDialog: vi.fn().mockResolvedValue(null),
    savePlaylistDialog: vi.fn().mockResolvedValue(null),
    savePlaylistToFile: vi.fn().mockResolvedValue(undefined),
    loadPlaylistFromFile: vi.fn().mockResolvedValue({count: 0, filePath: ''}),
    getPlaylistSourcePath: vi.fn().mockResolvedValue(null),
  };
}

/**
 * Creates a mock MediaPlayerService with writable signals.
 */
function createMockMediaPlayerService(): Record<string, unknown> {
  return {
    currentMediaType: signal(null as 'audio' | 'video' | null),
  };
}

/**
 * Creates a mock SettingsService with writable signals.
 */
function createMockSettingsService(): Record<string, unknown> {
  return {
    controlsAutoHideDelay: signal(5),
    glassEnabled: signal(true),
    backgroundColor: signal('#1e1e1e'),
    backgroundHue: signal(0),
    backgroundSaturation: signal(0),
    backgroundLightness: signal(12),
    windowTintHue: signal(0),
    windowTintSaturation: signal(0),
    windowTintLightness: signal(0),
    windowTintAlpha: signal(0),
    colorScheme: signal('system' as 'system' | 'dark' | 'light'),
  };
}

/**
 * Creates a mock DependencyService with writable signals.
 */
function createMockDependencyService(): Record<string, unknown> {
  return {
    noDependenciesInstalled: signal(false),
    ffmpegInstalled: signal(true),
    fluidsynthInstalled: signal(false),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Root', (): void => {
  let component: Root;
  let fixture: ComponentFixture<Root>;
  let mockElectron: Record<string, unknown>;
  let mockMediaPlayer: Record<string, unknown>;
  let mockSettings: Record<string, unknown>;
  let mockDeps: Record<string, unknown>;

  beforeEach(async (): Promise<void> => {
    mockElectron = createMockElectronService();
    mockMediaPlayer = createMockMediaPlayerService();
    mockSettings = createMockSettingsService();
    mockDeps = createMockDependencyService();

    await TestBed.configureTestingModule({
      imports: [Root],
      schemas: [NO_ERRORS_SCHEMA],
    })
      .overrideComponent(Root, {
        set: {
          imports: [],
          schemas: [NO_ERRORS_SCHEMA],
        },
      })
      .overrideProvider(ElectronService, {useValue: mockElectron})
      .overrideProvider(MediaPlayerService, {useValue: mockMediaPlayer})
      .overrideProvider(SettingsService, {useValue: mockSettings})
      .overrideProvider(DependencyService, {useValue: mockDeps})
      .compileComponents();

    fixture = TestBed.createComponent(Root);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Component Creation
  // ============================================================================

  describe('creation', (): void => {
    it('should create', (): void => {
      expect(component).toBeTruthy();
    });
  });

  // ============================================================================
  // Computed Signals
  // ============================================================================

  describe('computed signals', (): void => {
    it('isFullscreen returns false when viewMode is desktop', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);

      const result: boolean = component.isFullscreen();
      expect(result).toBe(false);
    });

    it('isFullscreen returns true when electron isFullscreen is true', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);

      const result: boolean = component.isFullscreen();
      expect(result).toBe(true);
    });

    it('viewMode reflects electron viewMode signal', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');

      const result: string = component.viewMode();
      expect(result).toBe('fullscreen');
    });

    it('isMiniplayer returns true when viewMode is miniplayer', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      const result: boolean = component.isMiniplayer();
      expect(result).toBe(true);
    });

    it('isMiniplayer returns false when viewMode is desktop', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');

      const result: boolean = component.isMiniplayer();
      expect(result).toBe(false);
    });

    it('isMiniplayer returns false when viewMode is fullscreen', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');

      const result: boolean = component.isMiniplayer();
      expect(result).toBe(false);
    });

    it('isVideo returns true when currentMediaType is video', (): void => {
      (mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>).set('video');

      const result: boolean = component.isVideo();
      expect(result).toBe(true);
    });

    it('isVideo returns false when currentMediaType is audio', (): void => {
      (mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>).set('audio');

      const result: boolean = component.isVideo();
      expect(result).toBe(false);
    });

    it('isVideo returns false when currentMediaType is null', (): void => {
      (mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>).set(null);

      const result: boolean = component.isVideo();
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // cursorHidden
  // ============================================================================

  describe('cursorHidden', (): void => {
    it('returns false in desktop mode regardless of controls visibility', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');

      const result: boolean = component.cursorHidden();
      expect(result).toBe(false);
    });

    it('returns false in fullscreen mode when controls are visible', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      // showControls will return true because controlsVisible defaults to true
      // and autoHideDelay is 5 (non-zero)

      const result: boolean = component.cursorHidden();
      expect(result).toBe(false);
    });

    it('returns true in fullscreen mode when controls are hidden', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      // Trigger mouse leave to hide controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.cursorHidden();
      expect(result).toBe(true);
    });

    it('returns true in miniplayer mode when controls are hidden', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      // Hide controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.cursorHidden();
      expect(result).toBe(true);
    });
  });

  // ============================================================================
  // showControls
  // ============================================================================

  describe('showControls', (): void => {
    it('always returns true in desktop mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');
      // Even if controlsVisible were false, desktop mode always shows controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.showControls();
      expect(result).toBe(true);
    });

    it('respects controlsVisible in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // Initially, controlsVisible is true
      expect(component.showControls()).toBe(true);

      // After mouse leave, controlsVisible becomes false
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);
    });

    it('always returns true when autoHideDelay is 0 in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(0);

      // Even after hiding controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.showControls();
      expect(result).toBe(true);
    });

    it('always returns true when autoHideDelay is 0 in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(0);

      // Even after hiding controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.showControls();
      expect(result).toBe(true);
    });

    it('respects controlsVisible in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // Initially visible
      expect(component.showControls()).toBe(true);

      // After mouse leave, hidden
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);
    });
  });

  // ============================================================================
  // Host Bindings
  // ============================================================================

  describe('host bindings', (): void => {
    it('fullscreenClass returns true when fullscreen', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);

      const result: boolean = component.fullscreenClass;
      expect(result).toBe(true);
    });

    it('fullscreenClass returns false when not fullscreen', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);

      const result: boolean = component.fullscreenClass;
      expect(result).toBe(false);
    });

    it('miniplayerClass returns true when miniplayer', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      const result: boolean = component.miniplayerClass;
      expect(result).toBe(true);
    });

    it('miniplayerClass returns false when not miniplayer', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');

      const result: boolean = component.miniplayerClass;
      expect(result).toBe(false);
    });

    it('cursorHiddenClass returns false in desktop mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');

      const result: boolean = component.cursorHiddenClass;
      expect(result).toBe(false);
    });

    it('cursorHiddenClass returns true when fullscreen and controls hidden', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);
      // Force controls hidden
      component.onMiniplayerMouseLeave();

      const result: boolean = component.cursorHiddenClass;
      expect(result).toBe(true);
    });
  });

  // ============================================================================
  // Escape Key Handler
  // ============================================================================

  describe('onEscapeKey', (): void => {
    it('calls exitFullscreen when in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);

      component.onEscapeKey();

      expect(mockElectron['exitFullscreen']).toHaveBeenCalled();
    });

    it('does not call exitFullscreen when not in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);

      component.onEscapeKey();

      expect(mockElectron['exitFullscreen']).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Tab Key Handler
  // ============================================================================

  describe('onKeyDown', (): void => {
    it('prevents default on Tab key press', (): void => {
      const event: KeyboardEvent = new KeyboardEvent('keydown', {key: 'Tab'});
      const preventDefaultSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(event, 'preventDefault');

      component.onKeyDown(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('does not prevent default on non-Tab key press', (): void => {
      const event: KeyboardEvent = new KeyboardEvent('keydown', {key: 'Enter'});
      const preventDefaultSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(event, 'preventDefault');

      component.onKeyDown(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Mouse Events for Drag (miniplayer)
  // ============================================================================

  describe('onMouseDown', (): void => {
    it('does nothing when not in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');
      const event: MouseEvent = new MouseEvent('mousedown', {screenX: 100, screenY: 100});

      component.onMouseDown(event);

      expect(mockElectron['getWindowPosition']).not.toHaveBeenCalled();
    });

    it('starts drag tracking in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      const div: HTMLDivElement = document.createElement('div');
      document.body.appendChild(div);
      const event: MouseEvent = new MouseEvent('mousedown', {screenX: 100, screenY: 100, bubbles: true});
      Object.defineProperty(event, 'target', {value: div});

      component.onMouseDown(event);

      expect(mockElectron['getWindowPosition']).toHaveBeenCalled();
      document.body.removeChild(div);
    });

    it('does not start drag when clicking a button', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      // Create a button element and use it as the event target
      const button: HTMLButtonElement = document.createElement('button');
      document.body.appendChild(button);

      const event: MouseEvent = new MouseEvent('mousedown', {
        screenX: 100,
        screenY: 100,
        bubbles: true,
      });
      Object.defineProperty(event, 'target', {value: button});

      component.onMouseDown(event);

      expect(mockElectron['getWindowPosition']).not.toHaveBeenCalled();

      document.body.removeChild(button);
    });
  });

  describe('onMouseMoveForDrag', (): void => {
    it('shows controls temporarily on mouse move in fullscreen when not dragging', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // First hide the controls
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);

      // Mouse move should show them temporarily
      const event: MouseEvent = new MouseEvent('mousemove', {screenX: 200, screenY: 200});
      component.onMouseMoveForDrag(event);

      expect(component.showControls()).toBe(true);
    });
  });

  describe('onMouseUp', (): void => {
    it('saves miniplayer bounds after drag completes', async (): Promise<void> => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      // Start drag
      const div: HTMLDivElement = document.createElement('div');
      document.body.appendChild(div);
      const downEvent: MouseEvent = new MouseEvent('mousedown', {screenX: 100, screenY: 100, bubbles: true});
      Object.defineProperty(downEvent, 'target', {value: div});
      component.onMouseDown(downEvent);

      // Wait for getWindowPosition to resolve
      await vi.waitFor((): void => {
        expect(mockElectron['getWindowPosition']).toHaveBeenCalled();
      });

      // Move mouse far enough to exceed drag threshold
      const moveEvent: MouseEvent = new MouseEvent('mousemove', {screenX: 200, screenY: 200});
      component.onMouseMoveForDrag(moveEvent);

      // Release mouse
      component.onMouseUp();

      expect(mockElectron['saveMiniplayerBounds']).toHaveBeenCalled();
      document.body.removeChild(div);
    });

    it('does not save bounds when not dragging', (): void => {
      component.onMouseUp();

      expect(mockElectron['saveMiniplayerBounds']).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Help Mode
  // ============================================================================

  describe('enterHelpMode', (): void => {
    it('sets isHelpMode to true and notifies main process', async (): Promise<void> => {
      await component.enterHelpMode();

      expect(component.isHelpMode()).toBe(true);
      expect(mockElectron['setConfigurationMode']).toHaveBeenCalledWith(true);
    });

    it('exits fullscreen before entering help mode', async (): Promise<void> => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);

      await component.enterHelpMode();

      expect(mockElectron['exitFullscreen']).toHaveBeenCalled();
      expect(component.isHelpMode()).toBe(true);
    });

    it('exits miniplayer before entering help mode', async (): Promise<void> => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      await component.enterHelpMode();

      expect(mockElectron['exitMiniplayer']).toHaveBeenCalled();
      expect(component.isHelpMode()).toBe(true);
    });

    it('does not exit fullscreen when not fullscreen', async (): Promise<void> => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);

      await component.enterHelpMode();

      expect(mockElectron['exitFullscreen']).not.toHaveBeenCalled();
    });
  });

  describe('exitHelpMode', (): void => {
    it('sets isHelpMode to false and notifies main process', (): void => {
      component.isHelpMode.set(true);

      component.exitHelpMode();

      expect(component.isHelpMode()).toBe(false);
      expect(mockElectron['setConfigurationMode']).toHaveBeenCalledWith(false);
    });
  });

  // ============================================================================
  // Configuration Window
  // ============================================================================

  describe('onOpenDependencySettings', (): void => {
    it('opens configuration window with dependencies category', (): void => {
      component.onOpenDependencySettings();

      expect(mockElectron['showConfigurationWindow']).toHaveBeenCalledWith('dependencies');
    });
  });

  // ============================================================================
  // Miniplayer Controls Visibility
  // ============================================================================

  describe('onMiniplayerMouseEnter', (): void => {
    it('shows controls when mouse enters', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // First hide controls
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);

      // Mouse enter should show them
      component.onMiniplayerMouseEnter();
      expect(component.showControls()).toBe(true);
    });
  });

  describe('onMiniplayerMouseLeave', (): void => {
    it('hides controls when mouse leaves in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // Controls start visible
      expect(component.showControls()).toBe(true);

      // Mouse leave should hide them
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);
    });

    it('hides controls when mouse leaves in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // Controls start visible
      expect(component.showControls()).toBe(true);

      // Mouse leave should hide them
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);
    });
  });

  // ============================================================================
  // Lifecycle
  // ============================================================================

  describe('ngOnDestroy', (): void => {
    it('does not throw when called', (): void => {
      expect((): void => component.ngOnDestroy()).not.toThrow();
    });

    it('does not throw when called with no active timeout', (): void => {
      // Ensure no timeout is running
      component.onMiniplayerMouseLeave();
      expect((): void => component.ngOnDestroy()).not.toThrow();
    });

    it('cleans up without error after showing controls temporarily', (): void => {
      // Trigger showControlsTemporarily by mouse enter
      component.onMiniplayerMouseEnter();

      // ngOnDestroy should clear the timeout without errors
      expect((): void => component.ngOnDestroy()).not.toThrow();
    });
  });
});

// ============================================================================
// Rendered behaviour
// ============================================================================

type ViewMode = 'desktop' | 'miniplayer' | 'fullscreen';

/**
 * Stand-in for the layout outlet. Root reaches the real one through a view
 * query to toggle the playlist, so the stub answers to the same token.
 */
@Component({
  selector: 'app-layout-outlet',
  template: '',
  providers: [{provide: LayoutOutlet, useExisting: forwardRef((): typeof StubLayoutOutlet => StubLayoutOutlet)}],
})
class StubLayoutOutlet {
  public readonly togglePlaylist: ReturnType<typeof vi.fn> = vi.fn();
  public readonly openDependencySettings: OutputEmitterRef<void> = output<void>();
}

describe('Root rendered', (): void => {
  let fixture: ComponentFixture<Root>;
  let host: HTMLElement;
  let mockElectron: Record<string, unknown>;
  let mockMediaPlayer: Record<string, unknown>;
  let mockSettings: Record<string, unknown>;
  let mockDeps: Record<string, unknown>;
  let originalUrl: string;

  /** Returns a spy from the fake ElectronService by name. */
  function electronSpy(name: string): ReturnType<typeof vi.fn> {
    return mockElectron[name] as ReturnType<typeof vi.fn>;
  }

  /** Sets a writable signal on one of the fake services. */
  function setSignal<T>(service: Record<string, unknown>, name: string, value: T): void {
    (service[name] as WritableSignal<T>).set(value);
  }

  /** Puts the window into the given view mode, as the main process would. */
  function setViewMode(mode: ViewMode): void {
    setSignal<ViewMode>(mockElectron, 'viewMode', mode);
    setSignal<boolean>(mockElectron, 'isFullscreen', mode === 'fullscreen');
  }

  /**
   * Creates the component, optionally as one of the standalone windows.
   *
   * @param windowName - Value of the `window` query parameter, if any
   */
  function createRoot(windowName?: string): void {
    if (windowName !== undefined) {
      window.history.replaceState(null, '', `?window=${windowName}`);
    }
    fixture = TestBed.createComponent(Root);
    host = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  /**
   * Runs effects, lets promise chains finish without moving the clock, and re-renders.
   */
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  }

  /** Moves the mouse somewhere over the document. */
  function moveMouse(screenX: number = 0, screenY: number = 0): void {
    document.dispatchEvent(new MouseEvent('mousemove', {screenX, screenY, bubbles: true}));
  }

  /** Presses a key on the document and returns the event for inspection. */
  function pressKey(init: KeyboardEventInit): KeyboardEvent {
    const event: KeyboardEvent = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init});
    document.dispatchEvent(event);
    return event;
  }

  /** Returns the stand-in layout outlet rendered by the component. */
  function outlet(): StubLayoutOutlet {
    return fixture.debugElement.children
      .flatMap((child: ComponentFixture<Root>['debugElement']): ComponentFixture<Root>['debugElement'][] => [child, ...child.children])
      .find((child: ComponentFixture<Root>['debugElement']): boolean => child.name === 'app-layout-outlet')!
      .componentInstance as StubLayoutOutlet;
  }

  beforeEach(async (): Promise<void> => {
    vi.useFakeTimers();
    originalUrl = window.location.href;

    mockElectron = {
      ...createMockElectronService(),
      stop: vi.fn().mockResolvedValue(undefined),
      clearPlaylist: vi.fn().mockResolvedValue(undefined),
      clearRecentItems: vi.fn().mockResolvedValue(undefined),
      closeWindow: vi.fn().mockResolvedValue(undefined),
    };
    mockMediaPlayer = createMockMediaPlayerService();
    mockSettings = {
      ...createMockSettingsService(),
      setVideoAspectMode: vi.fn().mockResolvedValue(undefined),
    };
    mockDeps = {
      ...createMockDependencyService(),
      midiSupported: signal(false),
      trackerSupported: signal(false),
    };

    await TestBed.configureTestingModule({
      imports: [Root],
    })
      .overrideComponent(Root, {
        set: {
          imports: [StubLayoutOutlet],
          schemas: [NO_ERRORS_SCHEMA],
        },
      })
      .overrideProvider(ElectronService, {useValue: mockElectron})
      .overrideProvider(MediaPlayerService, {useValue: mockMediaPlayer})
      .overrideProvider(SettingsService, {useValue: mockSettings})
      .overrideProvider(DependencyService, {useValue: mockDeps})
      .compileComponents();
  });

  afterEach((): void => {
    fixture.destroy();
    window.history.replaceState(null, '', originalUrl);
    document.documentElement.style.removeProperty('--app-background-color');
    document.documentElement.style.removeProperty('--app-tint-color');
    document.documentElement.removeAttribute('data-color-scheme');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Which window is rendered
  // ============================================================================

  describe('window selection', (): void => {
    it('renders the media player when no window is named', (): void => {
      createRoot();

      expect(host.querySelector('.media-player-view')).not.toBeNull();
      expect(host.querySelector('app-layout-outlet')).not.toBeNull();
    });

    it.each([
      {windowName: 'configuration', selector: 'app-configuration-view'},
      {windowName: 'about', selector: 'app-about-view'},
      {windowName: 'setup-wizard', selector: 'app-setup-wizard'},
      {windowName: 'open-url', selector: 'app-open-url-dialog'},
    ])('renders only $selector for the $windowName window', (testCase: {windowName: string; selector: string}): void => {
      createRoot(testCase.windowName);

      expect(host.querySelector(testCase.selector)).not.toBeNull();
      expect(host.querySelector('.media-player-view')).toBeNull();
    });

    it('renders the media player for an unrecognised window name', (): void => {
      createRoot('nonsense');

      expect(host.querySelector('.media-player-view')).not.toBeNull();
    });
  });

  // ============================================================================
  // Chrome per view mode
  // ============================================================================

  describe('chrome', (): void => {
    it('shows the header and the full controls on the macOS desktop', (): void => {
      createRoot();

      expect(host.querySelector('app-layout-header')).not.toBeNull();
      expect(host.querySelector('app-layout-controls')).not.toBeNull();
      expect(host.querySelector('app-miniplayer-controls')).toBeNull();
    });

    it('omits the header on other platforms', (): void => {
      setSignal(mockElectron, 'platformInfo', {platform: 'win32', supportsGlass: false, systemTheme: 'dark'});

      createRoot();

      expect(host.querySelector('app-layout-header')).toBeNull();
    });

    it('swaps to the miniplayer controls in miniplayer mode', (): void => {
      setViewMode('miniplayer');

      createRoot();

      expect(host.querySelector('app-miniplayer-controls')).not.toBeNull();
      expect(host.querySelector('app-layout-controls')).toBeNull();
      expect(host.querySelector('app-layout-header')).toBeNull();
      expect(host.classList.contains('miniplayer')).toBe(true);
      expect(host.querySelector('.media-player-view')?.classList.contains('miniplayer-container')).toBe(true);
    });

    it('overlays the controls and drops the header in fullscreen', (): void => {
      setViewMode('fullscreen');

      createRoot();

      expect(host.querySelector('app-layout-header')).toBeNull();
      expect(host.querySelector('app-layout-controls')?.classList.contains('fullscreen-overlay')).toBe(true);
      expect(host.classList.contains('fullscreen')).toBe(true);
    });

    it('keeps the same layout outlet element when the view mode changes', (): void => {
      createRoot();
      const before: Element | null = host.querySelector('app-layout-outlet');

      setViewMode('miniplayer');
      fixture.detectChanges();

      expect(host.querySelector('app-layout-outlet')).toBe(before);
    });

    it('shows a busy cursor while a stream is being prepared', (): void => {
      createRoot();

      setSignal(mockElectron, 'streamingBusy', true);
      fixture.detectChanges();

      expect(host.classList.contains('cursor-busy')).toBe(true);
    });

    it('opens the dependency settings when the outlet asks for them', (): void => {
      createRoot();

      outlet().openDependencySettings.emit();

      expect(electronSpy('showConfigurationWindow')).toHaveBeenCalledExactlyOnceWith('dependencies');
    });
  });

  // ============================================================================
  // Appearance
  // ============================================================================

  describe('appearance', (): void => {
    const rootStyle: CSSStyleDeclaration = document.documentElement.style;

    beforeEach((): void => {
      setSignal(mockSettings, 'backgroundHue', 210);
      setSignal(mockSettings, 'backgroundSaturation', 40);
      setSignal(mockSettings, 'backgroundLightness', 20);
      setSignal(mockSettings, 'windowTintHue', 120);
      setSignal(mockSettings, 'windowTintSaturation', 30);
      setSignal(mockSettings, 'windowTintLightness', 15);
      setSignal(mockSettings, 'windowTintAlpha', 0.4);
    });

    it('paints a solid background when the platform has no glass support', (): void => {
      createRoot();

      expect(rootStyle.getPropertyValue('--app-background-color')).toBe('hsl(210, 40%, 20%)');
      expect(rootStyle.getPropertyValue('--app-tint-color')).toBe('transparent');
    });

    it('paints a solid background when glass is supported but switched off', (): void => {
      setSignal(mockElectron, 'platformInfo', {platform: 'darwin', supportsGlass: true, systemTheme: 'dark'});
      setSignal(mockSettings, 'glassEnabled', false);

      createRoot();

      expect(rootStyle.getPropertyValue('--app-background-color')).toBe('hsl(210, 40%, 20%)');
    });

    it('leaves the background transparent and applies the tint when glass is on', (): void => {
      setSignal(mockElectron, 'platformInfo', {platform: 'darwin', supportsGlass: true, systemTheme: 'dark'});

      createRoot();

      expect(rootStyle.getPropertyValue('--app-background-color')).toBe('transparent');
      expect(rootStyle.getPropertyValue('--app-tint-color')).toBe('hsla(120, 30%, 15%, 0.4)');
    });

    it('applies no tint when the tint is fully transparent', (): void => {
      setSignal(mockElectron, 'platformInfo', {platform: 'darwin', supportsGlass: true, systemTheme: 'dark'});
      setSignal(mockSettings, 'windowTintAlpha', 0);

      createRoot();

      expect(rootStyle.getPropertyValue('--app-tint-color')).toBe('transparent');
    });

    it('repaints when the background setting changes', (): void => {
      createRoot();

      setSignal(mockSettings, 'backgroundLightness', 55);
      fixture.detectChanges();

      expect(rootStyle.getPropertyValue('--app-background-color')).toBe('hsl(210, 40%, 55%)');
    });

    it('publishes the colour scheme on the document root', (): void => {
      setSignal(mockSettings, 'colorScheme', 'light');

      createRoot();

      expect(document.documentElement.getAttribute('data-color-scheme')).toBe('light');
    });

    it('updates the published colour scheme when the setting changes', (): void => {
      createRoot();

      setSignal(mockSettings, 'colorScheme', 'dark');
      fixture.detectChanges();

      expect(document.documentElement.getAttribute('data-color-scheme')).toBe('dark');
    });
  });

  // ============================================================================
  // Menu commands
  // ============================================================================

  describe('menu commands', (): void => {
    beforeEach((): void => {
      createRoot();
    });

    it('does nothing for menu commands that have not been triggered', async (): Promise<void> => {
      await settle();

      expect(electronSpy('openFileDialog')).not.toHaveBeenCalled();
      expect(electronSpy('openPlaylistDialog')).not.toHaveBeenCalled();
      expect(electronSpy('getPlaylistSourcePath')).not.toHaveBeenCalled();
      expect(electronSpy('savePlaylistDialog')).not.toHaveBeenCalled();
      expect(electronSpy('setConfigurationMode')).not.toHaveBeenCalled();
    });

    it('Open File shows a multi-select dialog limited to playable formats', async (): Promise<void> => {
      setSignal(mockElectron, 'menuOpenFile', 1);
      await settle();

      const filters: {name: string; extensions: string[]}[] = electronSpy('openFileDialog').mock.calls[0][1] as {name: string; extensions: string[]}[];
      expect(electronSpy('openFileDialog')).toHaveBeenCalledExactlyOnceWith(true, filters);
      expect(filters.map((filter: {name: string}): string => filter.name)).toEqual(['Media Files', 'Audio', 'Video']);
    });

    it('Open File adds the chosen files with auto-play', async (): Promise<void> => {
      electronSpy('openFileDialog').mockResolvedValue(['/music/a.mp3', '/music/b.mp3']);

      setSignal(mockElectron, 'menuOpenFile', 1);
      await settle();

      expect(electronSpy('addFilesWithAutoPlay')).toHaveBeenCalledExactlyOnceWith(['/music/a.mp3', '/music/b.mp3']);
    });

    it('Open File adds nothing when the dialog is cancelled', async (): Promise<void> => {
      setSignal(mockElectron, 'menuOpenFile', 1);
      await settle();

      expect(electronSpy('addFilesWithAutoPlay')).not.toHaveBeenCalled();
    });

    it('Open File shows no dialog when nothing can be played', async (): Promise<void> => {
      setSignal(mockDeps, 'noDependenciesInstalled', true);

      setSignal(mockElectron, 'menuOpenFile', 1);
      await settle();

      expect(electronSpy('openFileDialog')).not.toHaveBeenCalled();
    });

    it('Open File responds each time the menu item is used', async (): Promise<void> => {
      setSignal(mockElectron, 'menuOpenFile', 1);
      await settle();
      setSignal(mockElectron, 'menuOpenFile', 2);
      await settle();

      expect(electronSpy('openFileDialog')).toHaveBeenCalledTimes(2);
    });

    it('Open Playlist loads the chosen playlist file', async (): Promise<void> => {
      electronSpy('openPlaylistDialog').mockResolvedValue('/lists/mix.m3u');

      setSignal(mockElectron, 'menuOpenPlaylist', 1);
      await settle();

      expect(electronSpy('loadPlaylistFromFile')).toHaveBeenCalledExactlyOnceWith('/lists/mix.m3u');
    });

    it('Open Playlist loads nothing when the dialog is cancelled', async (): Promise<void> => {
      setSignal(mockElectron, 'menuOpenPlaylist', 1);
      await settle();

      expect(electronSpy('openPlaylistDialog')).toHaveBeenCalledTimes(1);
      expect(electronSpy('loadPlaylistFromFile')).not.toHaveBeenCalled();
    });

    it('Open Playlist shows no dialog when nothing can be played', async (): Promise<void> => {
      setSignal(mockDeps, 'noDependenciesInstalled', true);

      setSignal(mockElectron, 'menuOpenPlaylist', 1);
      await settle();

      expect(electronSpy('openPlaylistDialog')).not.toHaveBeenCalled();
    });

    it('Save Playlist overwrites the file the playlist was loaded from', async (): Promise<void> => {
      electronSpy('getPlaylistSourcePath').mockResolvedValue('/lists/mix.m3u');

      setSignal(mockElectron, 'menuSavePlaylist', 1);
      await settle();

      expect(electronSpy('savePlaylistToFile')).toHaveBeenCalledExactlyOnceWith('/lists/mix.m3u');
      expect(electronSpy('savePlaylistDialog')).not.toHaveBeenCalled();
    });

    it('Save Playlist asks where to save a playlist that has no file yet', async (): Promise<void> => {
      electronSpy('savePlaylistDialog').mockResolvedValue('/lists/new.m3u');

      setSignal(mockElectron, 'menuSavePlaylist', 1);
      await settle();

      expect(electronSpy('savePlaylistToFile')).toHaveBeenCalledExactlyOnceWith('/lists/new.m3u');
    });

    it('Save Playlist As always asks where to save', async (): Promise<void> => {
      electronSpy('getPlaylistSourcePath').mockResolvedValue('/lists/mix.m3u');
      electronSpy('savePlaylistDialog').mockResolvedValue('/lists/copy.m3u');

      setSignal(mockElectron, 'menuSavePlaylistAs', 1);
      await settle();

      expect(electronSpy('savePlaylistToFile')).toHaveBeenCalledExactlyOnceWith('/lists/copy.m3u');
    });

    it('Save Playlist As saves nothing when the dialog is cancelled', async (): Promise<void> => {
      setSignal(mockElectron, 'menuSavePlaylistAs', 1);
      await settle();

      expect(electronSpy('savePlaylistDialog')).toHaveBeenCalledTimes(1);
      expect(electronSpy('savePlaylistToFile')).not.toHaveBeenCalled();
    });

    it('Aspect Ratio saves the chosen mode', async (): Promise<void> => {
      setSignal(mockElectron, 'menuSelectAspectMode', '16:9');
      await settle();

      expect(mockSettings['setVideoAspectMode']).toHaveBeenCalledExactlyOnceWith('16:9');
    });

    it('Aspect Ratio clears the request so the same mode can be chosen again', async (): Promise<void> => {
      setSignal(mockElectron, 'menuSelectAspectMode', '16:9');
      await settle();

      expect((mockElectron['menuSelectAspectMode'] as WritableSignal<string>)()).toBe('');
    });

    it('Show Help replaces the player with the help topics', async (): Promise<void> => {
      setSignal(mockElectron, 'menuShowHelp', 1);
      await settle();

      expect(host.querySelector('app-help-topics-view')).not.toBeNull();
      expect(host.querySelector('.media-player-view')?.classList.contains('hidden')).toBe(true);
    });

    it('Show Help tells the main process an overlay is open', async (): Promise<void> => {
      setSignal(mockElectron, 'menuShowHelp', 1);
      await settle();

      expect(electronSpy('setConfigurationMode')).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('Show Help leaves fullscreen first', async (): Promise<void> => {
      setViewMode('fullscreen');

      setSignal(mockElectron, 'menuShowHelp', 1);
      await settle();

      expect(electronSpy('exitFullscreen')).toHaveBeenCalledTimes(1);
      expect(electronSpy('exitMiniplayer')).not.toHaveBeenCalled();
    });

    it('Show Help leaves the miniplayer first', async (): Promise<void> => {
      setViewMode('miniplayer');

      setSignal(mockElectron, 'menuShowHelp', 1);
      await settle();

      expect(electronSpy('exitMiniplayer')).toHaveBeenCalledTimes(1);
      expect(electronSpy('exitFullscreen')).not.toHaveBeenCalled();
    });

    it('the window close button returns from help to the player', async (): Promise<void> => {
      setSignal(mockElectron, 'menuShowHelp', 1);
      await settle();

      setSignal(mockElectron, 'exitConfigurationModeRequested', 1);
      await settle();

      expect(host.querySelector('app-help-topics-view')).toBeNull();
      expect(host.querySelector('.media-player-view')?.classList.contains('hidden')).toBe(false);
      expect(electronSpy('setConfigurationMode')).toHaveBeenLastCalledWith(false);
    });

    it('a close request outside help mode changes nothing', async (): Promise<void> => {
      setSignal(mockElectron, 'exitConfigurationModeRequested', 1);
      await settle();

      expect(electronSpy('setConfigurationMode')).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Keyboard
  // ============================================================================

  describe('keyboard', (): void => {
    beforeEach((): void => {
      createRoot();
    });

    it('Tab toggles the playlist on the desktop', (): void => {
      const event: KeyboardEvent = pressKey({key: 'Tab'});

      expect(outlet().togglePlaylist).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it.each(['fullscreen', 'miniplayer'] as const)('Tab is swallowed without toggling the playlist in %s mode', (mode: ViewMode): void => {
      setViewMode(mode);
      fixture.detectChanges();

      const event: KeyboardEvent = pressKey({key: 'Tab'});

      expect(outlet().togglePlaylist).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    });

    it('Tab is swallowed without toggling the playlist while help is open', async (): Promise<void> => {
      setSignal(mockElectron, 'menuShowHelp', 1);
      await settle();

      const event: KeyboardEvent = pressKey({key: 'Tab'});

      expect(outlet().togglePlaylist).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    });

    it('Escape leaves fullscreen', (): void => {
      setViewMode('fullscreen');
      fixture.detectChanges();

      pressKey({key: 'Escape'});

      expect(electronSpy('exitFullscreen')).toHaveBeenCalledTimes(1);
    });

    it('Escape does nothing outside fullscreen', (): void => {
      pressKey({key: 'Escape'});

      expect(electronSpy('exitFullscreen')).not.toHaveBeenCalled();
    });

    it.each([
      {name: 'Ctrl+D', init: {key: 'd', ctrlKey: true}},
      {name: 'Cmd+D', init: {key: 'd', metaKey: true}},
    ])('$name stops playback, wipes the playlist and history, then closes the window', async (testCase: {name: string; init: KeyboardEventInit}): Promise<void> => {
      const event: KeyboardEvent = pressKey(testCase.init);
      await settle();

      const order: number[] = ['stop', 'clearPlaylist', 'clearRecentItems', 'closeWindow']
        .map((name: string): number => electronSpy(name).mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a: number, b: number): number => a - b));
      expect(order).toHaveLength(4);
      expect(order.every((position: number): boolean => position > 0)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
    });

    it('a plain D does not trigger discreet mode', async (): Promise<void> => {
      const event: KeyboardEvent = pressKey({key: 'd'});
      await settle();

      expect(electronSpy('closeWindow')).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('does not close the window when wiping the playlist fails', async (): Promise<void> => {
      electronSpy('clearPlaylist').mockImplementation((): Promise<void> => new Promise<void>((): void => {}));

      pressKey({key: 'd', ctrlKey: true});
      await settle();

      expect(electronSpy('stop')).toHaveBeenCalledTimes(1);
      expect(electronSpy('closeWindow')).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Miniplayer window dragging
  // ============================================================================

  describe('miniplayer dragging', (): void => {
    /** Presses the mouse on an element inside the component. */
    function pressMouse(target: Element, screenX: number, screenY: number): void {
      target.dispatchEvent(new MouseEvent('mousedown', {screenX, screenY, bubbles: true}));
    }

    beforeEach((): void => {
      setViewMode('miniplayer');
      electronSpy('getWindowPosition').mockResolvedValue({x: 100, y: 200});
      createRoot();
    });

    it('moves the window by the distance the mouse has travelled', async (): Promise<void> => {
      pressMouse(host, 10, 10);
      await settle();

      moveMouse(30, 25);

      expect(electronSpy('setWindowPosition')).toHaveBeenLastCalledWith({x: 120, y: 215});
    });

    it('saves the window bounds when a drag ends', async (): Promise<void> => {
      pressMouse(host, 10, 10);
      await settle();
      moveMouse(30, 25);

      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));

      expect(electronSpy('saveMiniplayerBounds')).toHaveBeenCalledTimes(1);
    });

    it('does not save the bounds after a click without movement', async (): Promise<void> => {
      pressMouse(host, 10, 10);
      await settle();

      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));

      expect(electronSpy('saveMiniplayerBounds')).not.toHaveBeenCalled();
    });

    it('does not save the bounds when the mouse moved less than the drag threshold', async (): Promise<void> => {
      pressMouse(host, 10, 10);
      await settle();
      moveMouse(15, 5);

      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));

      expect(electronSpy('saveMiniplayerBounds')).not.toHaveBeenCalled();
    });

    it('treats vertical movement past the threshold as a drag', async (): Promise<void> => {
      pressMouse(host, 10, 10);
      await settle();
      moveMouse(10, 16);

      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));

      expect(electronSpy('saveMiniplayerBounds')).toHaveBeenCalledTimes(1);
    });

    it('stops moving the window once the mouse is released', async (): Promise<void> => {
      pressMouse(host, 10, 10);
      await settle();
      moveMouse(30, 25);
      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
      electronSpy('setWindowPosition').mockClear();

      moveMouse(80, 80);

      expect(electronSpy('setWindowPosition')).not.toHaveBeenCalled();
    });

    it('does not start a drag from a button', async (): Promise<void> => {
      const button: HTMLButtonElement = document.createElement('button');
      const icon: HTMLElement = document.createElement('i');
      button.appendChild(icon);
      host.appendChild(button);

      pressMouse(icon, 10, 10);
      await settle();
      moveMouse(30, 25);

      expect(electronSpy('setWindowPosition')).not.toHaveBeenCalled();
    });

    it('does not start a drag outside miniplayer mode', async (): Promise<void> => {
      setViewMode('desktop');
      fixture.detectChanges();

      pressMouse(host, 10, 10);
      await settle();
      moveMouse(30, 25);

      expect(electronSpy('getWindowPosition')).not.toHaveBeenCalled();
      expect(electronSpy('setWindowPosition')).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Auto-hiding controls
  // ============================================================================

  describe('auto-hiding controls', (): void => {
    const AUTO_HIDE_MS: number = 5000;

    /** Returns the element wrapping the player, which tracks the pointer. */
    function playerView(): Element {
      return host.querySelector('.media-player-view')!;
    }

    describe('in fullscreen', (): void => {
      beforeEach((): void => {
        setViewMode('fullscreen');
        createRoot();
      });

      it('hides the controls and the cursor once the mouse has been still for the delay', (): void => {
        moveMouse();

        vi.advanceTimersByTime(AUTO_HIDE_MS);
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).toBeNull();
        expect(host.classList.contains('cursor-hidden')).toBe(true);
      });

      it('keeps the controls until the delay has fully elapsed', (): void => {
        moveMouse();

        vi.advanceTimersByTime(AUTO_HIDE_MS - 1);
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).not.toBeNull();
        expect(host.classList.contains('cursor-hidden')).toBe(false);
      });

      it('restarts the delay each time the mouse moves', (): void => {
        moveMouse();
        vi.advanceTimersByTime(AUTO_HIDE_MS - 1);
        moveMouse();

        vi.advanceTimersByTime(AUTO_HIDE_MS - 1);
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).not.toBeNull();
      });

      it('brings the controls back when the mouse moves again', (): void => {
        moveMouse();
        vi.advanceTimersByTime(AUTO_HIDE_MS);
        fixture.detectChanges();

        moveMouse();
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).not.toBeNull();
      });

      it('hides the controls immediately when the pointer leaves the player', (): void => {
        moveMouse();

        playerView().dispatchEvent(new MouseEvent('mouseleave'));
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).toBeNull();
      });

      it('brings the controls back when the pointer re-enters the player', (): void => {
        playerView().dispatchEvent(new MouseEvent('mouseleave'));
        fixture.detectChanges();

        playerView().dispatchEvent(new MouseEvent('mouseenter'));
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).not.toBeNull();
      });

      it('uses the configured delay', (): void => {
        setSignal(mockSettings, 'controlsAutoHideDelay', 2);
        moveMouse();

        vi.advanceTimersByTime(2000);
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).toBeNull();
      });

      it('never hides the controls when auto-hide is disabled', (): void => {
        setSignal(mockSettings, 'controlsAutoHideDelay', 0);
        moveMouse();

        vi.advanceTimersByTime(AUTO_HIDE_MS * 10);
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).not.toBeNull();
      });

      it('keeps the controls when the pointer leaves while auto-hide is disabled', (): void => {
        setSignal(mockSettings, 'controlsAutoHideDelay', 0);

        playerView().dispatchEvent(new MouseEvent('mouseleave'));
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).not.toBeNull();
      });
    });

    describe('in the miniplayer', (): void => {
      beforeEach((): void => {
        setViewMode('miniplayer');
        createRoot();
        electronSpy('setTrafficLightVisibility').mockClear();
      });

      it('marks the overlay controls visible while the mouse is active', (): void => {
        moveMouse();
        fixture.detectChanges();

        expect(host.querySelector('app-miniplayer-controls')?.classList.contains('controls-visible')).toBe(true);
      });

      it('fades the overlay controls and the traffic lights once the mouse has been still', (): void => {
        moveMouse();

        vi.advanceTimersByTime(AUTO_HIDE_MS);
        fixture.detectChanges();

        expect(host.querySelector('app-miniplayer-controls')?.classList.contains('controls-visible')).toBe(false);
        expect(electronSpy('setTrafficLightVisibility')).toHaveBeenLastCalledWith(false);
      });

      it('restores the traffic lights when the controls come back', (): void => {
        playerView().dispatchEvent(new MouseEvent('mouseleave'));
        fixture.detectChanges();

        playerView().dispatchEvent(new MouseEvent('mouseenter'));
        fixture.detectChanges();

        expect(electronSpy('setTrafficLightVisibility')).toHaveBeenLastCalledWith(true);
      });
    });

    describe('on the desktop', (): void => {
      beforeEach((): void => {
        createRoot();
      });

      it('shows the traffic lights', (): void => {
        expect(electronSpy('setTrafficLightVisibility')).toHaveBeenLastCalledWith(true);
      });

      it('keeps the controls when the pointer leaves the player', (): void => {
        playerView().dispatchEvent(new MouseEvent('mouseleave'));
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).not.toBeNull();
        expect(host.classList.contains('cursor-hidden')).toBe(false);
      });

      it('does not hide controls that a later switch to fullscreen would need', (): void => {
        playerView().dispatchEvent(new MouseEvent('mouseleave'));
        moveMouse();
        vi.advanceTimersByTime(AUTO_HIDE_MS);

        setViewMode('fullscreen');
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).not.toBeNull();
      });

      it('starts no countdown when the pointer enters the player', (): void => {
        playerView().dispatchEvent(new MouseEvent('mouseenter'));
        setViewMode('fullscreen');

        vi.advanceTimersByTime(AUTO_HIDE_MS);
        fixture.detectChanges();

        expect(host.querySelector('app-layout-controls')).not.toBeNull();
      });
    });
  });
});
