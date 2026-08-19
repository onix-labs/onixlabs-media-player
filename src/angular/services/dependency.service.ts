/**
 * @fileoverview Angular service for managing external dependency state.
 *
 * This service provides reactive state for the dependency management UI,
 * including binary detection status, install/uninstall progress, and
 * SoundFont file management.
 *
 * State is synchronized via SSE events from the unified media server.
 * Commands (install, uninstall, etc.) are sent via HTTP POST requests.
 *
 * @module app/services/dependency.service
 */

import {Injectable, signal, computed, inject, effect, OnDestroy, EffectRef} from '@angular/core';
import {ElectronService} from './electron.service';
import {FFMPEG_EXTENSIONS, MIDI_EXTENSIONS, TRACKER_EXTENSIONS} from '../constants/media.constants';

// ============================================================================
// Types
// ============================================================================

/**
 * Identifier for a managed dependency.
 */
export type DependencyId = 'ffmpeg' | 'fluidsynth' | 'openmpt123' | 'yt-dlp';

/**
 * Status of a single dependency.
 */
export interface DependencyStatus {
  readonly id: DependencyId;
  readonly name: string;
  readonly installed: boolean;
  readonly path: string | null;
  readonly description: string;
  readonly manualInstallUrl: string;
}

/**
 * Overall dependency state received from the server.
 */
export interface DependencyState {
  readonly ffmpeg: DependencyStatus;
  readonly fluidsynth: DependencyStatus;
  readonly openmpt123: DependencyStatus;
  readonly ytdlp: DependencyStatus;
  readonly soundfonts: SoundFontInfo[];
  readonly activeSoundFont: string | null;
  readonly hardwareEncoders: HardwareEncoderInfo;
}

/**
 * Information about an installed SoundFont file.
 */
export interface SoundFontInfo {
  readonly fileName: string;
  readonly filePath: string;
  readonly sizeBytes: number;
}

/**
 * Information about available hardware encoders.
 */
export interface HardwareEncoderInfo {
  readonly available: boolean;
  readonly encoders: readonly string[];
}

/**
 * Progress update during dependency installation or uninstallation.
 */
export interface InstallProgress {
  readonly dependencyId: DependencyId;
  readonly status: 'installing' | 'uninstalling' | 'updating' | 'success' | 'error';
  readonly message: string;
  readonly output?: string;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Service that manages external dependency state and installation.
 *
 * Provides reactive signals for:
 * - FFmpeg and FluidSynth installation status
 * - Install/uninstall progress with terminal output
 * - SoundFont file management
 *
 * @example
 * export class MyComponent {
 *   private deps = inject(DependencyService);
 *   hasMissing = this.deps.hasMissingDependencies;
 * }
 */
@Injectable({providedIn: 'root'})
export class DependencyService implements OnDestroy {
  // ============================================================================
  // Dependencies
  // ============================================================================

  /** Electron service for server URL and IPC access */
  private readonly electron: ElectronService = inject(ElectronService);

  // ============================================================================
  // Public Signals
  // ============================================================================

  /** Full dependency state (updated via SSE) */
  public readonly dependencyState: ReturnType<typeof signal<DependencyState | null>> = signal<DependencyState | null>(null);

  /** Install/uninstall progress (updated via SSE) */
  public readonly installProgress: ReturnType<typeof signal<InstallProgress | null>> = signal<InstallProgress | null>(null);

  /**
   * Why the last SoundFont operation failed, or null if the last one worked.
   *
   * SoundFont commands report success implicitly, by the file list changing.
   * A failure changes nothing, so without this the operation is invisible.
   */
  public readonly soundFontError: ReturnType<typeof signal<string | null>> = signal<string | null>(null);

  /** Whether state has been loaded from the server */
  public readonly isLoaded: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Effect reference for cleanup */
  private readonly serverUrlEffect: EffectRef;

  /** Removes the SSE dependency-state subscription on teardown. */
  private readonly unsubscribeState: () => void;

  /** Removes the SSE install-progress subscription on teardown. */
  private readonly unsubscribeProgress: () => void;

  // ============================================================================
  // Computed Signals
  // ============================================================================

  /** Whether FFmpeg is installed */
  public readonly ffmpegInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.dependencyState()?.ffmpeg.installed ?? false
  );

  /** Whether FluidSynth is installed */
  public readonly fluidsynthInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.dependencyState()?.fluidsynth.installed ?? false
  );

  /** Whether openmpt123 is installed (required for tracker module playback) */
  public readonly openmpt123Installed: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.dependencyState()?.openmpt123.installed ?? false
  );

  /** Whether yt-dlp is installed (required for internet URL playback) */
  public readonly ytdlpInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.dependencyState()?.ytdlp.installed ?? false
  );

  /** Whether all dependencies are installed */
  public readonly allDependenciesInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.ffmpegInstalled() && this.fluidsynthInstalled() && this.openmpt123Installed()
  );

  /** Whether any dependencies are missing */
  public readonly hasMissingDependencies: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.isLoaded() && !this.allDependenciesInstalled()
  );

  /** List of missing dependencies */
  public readonly missingDependencies: ReturnType<typeof computed<DependencyStatus[]>> = computed(
    (): DependencyStatus[] => {
      const state: DependencyState | null = this.dependencyState();
      if (!state) return [];
      const missing: DependencyStatus[] = [];
      if (!state.ffmpeg.installed) missing.push(state.ffmpeg);
      if (!state.fluidsynth.installed) missing.push(state.fluidsynth);
      if (!state.openmpt123.installed) missing.push(state.openmpt123);
      return missing;
    }
  );

  /** Installed SoundFont files */
  public readonly soundFonts: ReturnType<typeof computed<SoundFontInfo[]>> = computed(
    (): SoundFontInfo[] => this.dependencyState()?.soundfonts ?? []
  );

  /** Active SoundFont path */
  public readonly activeSoundFont: ReturnType<typeof computed<string | null>> = computed(
    (): string | null => this.dependencyState()?.activeSoundFont ?? null
  );

  /** Available hardware encoders */
  public readonly hardwareEncoders: ReturnType<typeof computed<HardwareEncoderInfo>> = computed(
    (): HardwareEncoderInfo => this.dependencyState()?.hardwareEncoders ?? {available: false, encoders: []}
  );

  /** Whether at least one dependency is installed */
  public readonly anyDependencyInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.ffmpegInstalled() || this.fluidsynthInstalled() || this.openmpt123Installed()
  );

  /** Whether zero dependencies are installed (only true after state is loaded) */
  public readonly noDependenciesInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.isLoaded() && !this.anyDependencyInstalled()
  );

  /** Dynamic set of allowed file extensions based on installed dependencies */
  public readonly allowedExtensions: ReturnType<typeof computed<ReadonlySet<string>>> = computed(
    (): ReadonlySet<string> => {
      const allowed: Set<string> = new Set<string>();
      if (this.ffmpegInstalled()) FFMPEG_EXTENSIONS.forEach((ext: string): Set<string> => allowed.add(ext));
      if (this.fluidsynthInstalled()) MIDI_EXTENSIONS.forEach((ext: string): Set<string> => allowed.add(ext));
      if (this.openmpt123Installed()) TRACKER_EXTENSIONS.forEach((ext: string): Set<string> => allowed.add(ext));
      return allowed;
    }
  );

  /** Whether an install/uninstall operation is in progress */
  public readonly isOperationInProgress: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => {
      const progress: InstallProgress | null = this.installProgress();
      return progress !== null && (progress.status === 'installing' || progress.status === 'uninstalling' || progress.status === 'updating');
    }
  );

  // ============================================================================
  // Constructor
  // ============================================================================

  public constructor() {
    // Register SSE callbacks with ElectronService
    this.unsubscribeState = this.electron.onDependencyStateUpdate((state: unknown): void => {
      this.dependencyState.set(state as DependencyState);
      this.isLoaded.set(true);
    });

    this.unsubscribeProgress = this.electron.onDependencyProgressUpdate((progress: unknown): void => {
      this.installProgress.set(progress as InstallProgress);
    });

    // Fetch dependency state once serverUrl is available
    this.serverUrlEffect = effect((): void => {
      const serverUrl: string = this.electron.serverUrl();
      if (serverUrl && !this.isLoaded()) {
        void this.fetchDependencyState();
      }
    });
  }

  public ngOnDestroy(): void {
    this.serverUrlEffect.destroy();
    this.unsubscribeState();
    this.unsubscribeProgress();
  }

  // ============================================================================
  // Commands
  // ============================================================================

  /**
   * Installs a dependency using the platform package manager.
   * Progress is streamed via SSE events.
   */
  public async installDependency(id: DependencyId): Promise<void> {
    await this.runDependencyCommand(id, 'install', 'install');
  }

  /**
   * Uninstalls a dependency using the platform package manager.
   * Progress is streamed via SSE events.
   */
  public async uninstallDependency(id: DependencyId): Promise<void> {
    await this.runDependencyCommand(id, 'uninstall', 'uninstall');
  }

  /**
   * Updates a dependency to the latest version via the platform package manager.
   * Progress is streamed via SSE events. Primarily for yt-dlp.
   */
  public async updateDependency(id: DependencyId): Promise<void> {
    await this.runDependencyCommand(id, 'update', 'update');
  }

  /**
   * Opens the SoundFont file dialog and installs the selected file.
   */
  public async installSoundFont(): Promise<void> {
    const filePaths: string[] = await this.electron.openSoundFontDialog();
    if (filePaths.length === 0) return;

    await this.runSoundFontCommand('install', {sourcePath: filePaths[0]}, 'install the SoundFont');
  }

  /**
   * Removes a SoundFont file from the app data directory.
   */
  public async removeSoundFont(fileName: string): Promise<void> {
    await this.runSoundFontCommand('remove', {fileName}, `remove ${fileName}`);
  }

  /**
   * Sets the active SoundFont for MIDI playback.
   * Pass null to reset to auto-selection (first available).
   */
  public async setActiveSoundFont(fileName: string | null): Promise<void> {
    await this.runSoundFontCommand('select', {fileName}, 'select the SoundFont');
  }

  /**
   * Re-detects all binaries and refreshes the dependency state.
   */
  public async refreshDependencies(): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    try {
      const response: Response = await this.electron.authFetch(`${serverUrl}/dependencies/refresh`, {
        method: 'POST',
      });

      if (!response.ok) {
        console.error(`[DependencyService] Dependency refresh failed: the server returned ${response.status}.`);
      }
    } catch (error: unknown) {
      // Refresh is a background reconciliation with no control of its own to
      // report against; the state simply stays as it was.
      console.error('[DependencyService] Dependency refresh failed:', error);
    }
  }

  // ============================================================================
  // Private
  // ============================================================================

  /**
   * Posts a dependency command and reports failures through installProgress.
   *
   * Progress for a command that actually starts arrives over SSE. A request
   * that never gets that far — a non-2xx response, a dead server — produced
   * nothing at all before: the spinner state was never entered and no error
   * was shown, so the button simply appeared to do nothing. Failures now land
   * in the same signal the progress panel already renders an error state for.
   *
   * @param id - The dependency the command targets
   * @param endpoint - Command endpoint under /dependencies
   * @param action - Verb used in the failure message
   */
  private async runDependencyCommand(id: DependencyId, endpoint: string, action: string): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clear any previous progress
    this.installProgress.set(null);

    try {
      const response: Response = await this.electron.authFetch(`${serverUrl}/dependencies/${endpoint}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id}),
      });

      if (!response.ok) {
        this.reportDependencyFailure(id, `Could not ${action} ${id}: the server returned ${response.status}.`);
      }
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      this.reportDependencyFailure(id, `Could not ${action} ${id}: ${reason}`);
    }
  }

  /**
   * Puts a dependency command failure in front of the user.
   *
   * @param id - The dependency the command targeted
   * @param message - User-facing explanation
   */
  private reportDependencyFailure(id: DependencyId, message: string): void {
    console.error(`[DependencyService] ${message}`);
    this.installProgress.set({dependencyId: id, status: 'error', message});
  }

  /**
   * Posts a SoundFont command, reporting failures through soundFontError.
   *
   * @param endpoint - Command endpoint under /dependencies/soundfont
   * @param body - JSON body for the command
   * @param action - Phrase describing the attempt, used in the failure message
   */
  private async runSoundFontCommand(endpoint: string, body: Record<string, unknown>, action: string): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    this.soundFontError.set(null);

    try {
      const response: Response = await this.electron.authFetch(`${serverUrl}/dependencies/soundfont/${endpoint}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        this.reportSoundFontFailure(`Could not ${action}: the server returned ${response.status}.`);
      }
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      this.reportSoundFontFailure(`Could not ${action}: ${reason}`);
    }
  }

  /**
   * Puts a SoundFont operation failure in front of the user.
   *
   * @param message - User-facing explanation
   */
  private reportSoundFontFailure(message: string): void {
    console.error(`[DependencyService] ${message}`);
    this.soundFontError.set(message);
  }

  /**
   * Fetches the initial dependency state from the server.
   */
  private async fetchDependencyState(): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    try {
      const response: Response = await this.electron.authFetch(`${serverUrl}/dependencies`);
      if (response.ok) {
        const state: DependencyState = await response.json() as DependencyState;
        this.dependencyState.set(state);
        this.isLoaded.set(true);
      }
    } catch {
      // Will be retried on next SSE event or serverUrl change
    }
  }
}
