/**
 * @fileoverview Setup wizard component for first-run configuration.
 *
 * This wizard guides users through initial application setup including:
 * 1. Welcome - Introduction to ONIXPlayer
 * 2. Server Port - Configure the media server port
 * 3. Components - Confirms the built-in media engines, lets the user choose a
 *    SoundFont for MIDI (none ships with the app), and offers to download
 *    yt-dlp for internet URLs
 * 4. Complete - Summary and finish
 *
 * The wizard appears on first launch or when launched with --first-run flag.
 *
 * @module app/components/setup-wizard
 */

import {Component, inject, signal, computed, ChangeDetectionStrategy, WritableSignal, Signal} from '@angular/core';
import {ElectronService} from '../../services/electron.service';
import {DependencyService} from '../../services/dependency.service';
import type {DependencyStatus, InstallProgress, SoundFontInfo} from '../../services/dependency.service';
import type {MediaPlayerAPI} from '../../types/electron';

/** Wizard step identifiers */
type WizardStep = 'welcome' | 'port' | 'components' | 'complete';

/**
 * Setup wizard component for first-run configuration.
 *
 * Displays a multi-step wizard that guides users through initial setup.
 * The wizard is displayed in a separate window and must be completed
 * before the main application window is shown.
 */
@Component({
  selector: 'app-setup-wizard',
  templateUrl: './setup-wizard.html',
  styleUrl: './setup-wizard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupWizard {
  // ============================================================================
  // Dependencies
  // ============================================================================

  /** Service for Electron-specific operations */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Service for dependency state */
  public readonly deps: DependencyService = inject(DependencyService);

  // ============================================================================
  // Wizard State
  // ============================================================================

  /** Current wizard step */
  public readonly currentStep: WritableSignal<WizardStep> = signal<WizardStep>('welcome');

  /** All wizard steps in order */
  public readonly steps: readonly WizardStep[] = ['welcome', 'port', 'components', 'complete'];

  /** Server port value */
  public readonly serverPort: WritableSignal<number> = signal<number>(0);

  /** Port validation state */
  public readonly portValid: WritableSignal<boolean> = signal<boolean>(true);

  /** Port validation message */
  public readonly portValidationMessage: WritableSignal<string> = signal<string>('');

  /** Whether port is being validated */
  public readonly validatingPort: WritableSignal<boolean> = signal<boolean>(false);

  // ============================================================================
  // Computed Properties
  // ============================================================================

  /** Current step index */
  public get currentStepIndex(): number {
    return this.steps.indexOf(this.currentStep());
  }

  /** Whether we're on the first step */
  public get isFirstStep(): boolean {
    return this.currentStepIndex === 0;
  }

  /** Whether we're on the last step */
  public get isLastStep(): boolean {
    return this.currentStepIndex === this.steps.length - 1;
  }

  /** Platform info for conditional rendering */
  public get platform(): string {
    return this.electron.platformInfo().platform;
  }

  /** The built-in components, in display order */
  public readonly builtInComponents: Signal<DependencyStatus[]> = computed((): DependencyStatus[] => {
    const state: ReturnType<typeof this.deps.dependencyState> = this.deps.dependencyState();
    return state ? [state.ffmpeg, state.fluidsynth] : [];
  });

  /** SoundFonts the user has installed (MIDI needs at least one) */
  public readonly soundFonts: Signal<SoundFontInfo[]> = this.deps.soundFonts;

  /** Why the last SoundFont operation failed, or null */
  public readonly soundFontError: Signal<string | null> = this.deps.soundFontError;

  /** yt-dlp status, or null before the state has loaded */
  public readonly ytdlpStatus: Signal<DependencyStatus | null> = computed(
    (): DependencyStatus | null => this.deps.dependencyState()?.ytdlp ?? null
  );

  /** Whether a yt-dlp download is running */
  public readonly isOperationInProgress: Signal<boolean> = this.deps.isOperationInProgress;

  /** Progress of the yt-dlp download, or null when there is nothing to show */
  public readonly ytdlpProgress: Signal<InstallProgress | null> = computed((): InstallProgress | null => {
    const progress: InstallProgress | null = this.deps.installProgress();
    return progress?.dependencyId === 'yt-dlp' ? progress : null;
  });

  // ============================================================================
  // Constructor
  // ============================================================================

  public constructor() {
    // Load initial port value
    void this.loadInitialPort();
  }

  /**
   * Loads the initial server port value from settings.
   */
  private async loadInitialPort(): Promise<void> {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api) {
      const port: number = await api.setupGetPort();
      this.serverPort.set(port);
    }
  }

  // ============================================================================
  // Navigation Methods
  // ============================================================================

  /**
   * Moves to the next wizard step.
   */
  public async next(): Promise<void> {
    const currentIndex: number = this.currentStepIndex;
    if (currentIndex < this.steps.length - 1) {
      // Handle step-specific actions before moving
      if (this.currentStep() === 'port') {
        await this.savePort();
      }
      this.currentStep.set(this.steps[currentIndex + 1]);
    }
  }

  /**
   * Moves to the previous wizard step.
   */
  public back(): void {
    const currentIndex: number = this.currentStepIndex;
    if (currentIndex > 0) {
      this.currentStep.set(this.steps[currentIndex - 1]);
    }
  }

  /**
   * Skips the wizard and closes without completing.
   */
  public async skip(): Promise<void> {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api) {
      await api.setupSkip();
    }
  }

  /**
   * Completes the wizard and closes.
   */
  public async finish(): Promise<void> {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api) {
      await api.setupComplete();
    }
  }

  // ============================================================================
  // Port Configuration
  // ============================================================================

  /**
   * Handles port input changes.
   */
  public async onPortChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const value: number = parseInt(input.value, 10);
    this.serverPort.set(isNaN(value) ? 0 : value);
    await this.validatePort();
  }

  /**
   * Sets port to auto-assign (0).
   */
  public async setAutoPort(): Promise<void> {
    this.serverPort.set(0);
    this.portValid.set(true);
    this.portValidationMessage.set('');
  }

  /**
   * Validates the current port value.
   */
  private async validatePort(): Promise<void> {
    const port: number = this.serverPort();
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;

    if (!api) {
      this.portValid.set(false);
      this.portValidationMessage.set('API not available');
      return;
    }

    // 0 is always valid (auto-assign)
    if (port === 0) {
      this.portValid.set(true);
      this.portValidationMessage.set('');
      return;
    }

    // Check range
    if (port < 1024 || port > 65535) {
      this.portValid.set(false);
      this.portValidationMessage.set('Port must be between 1024 and 65535');
      return;
    }

    // Check availability
    this.validatingPort.set(true);
    try {
      const available: boolean = await api.setupValidatePort(port);
      this.portValid.set(available);
      this.portValidationMessage.set(available ? '' : 'Port is already in use');
    } finally {
      this.validatingPort.set(false);
    }
  }

  /**
   * Saves the port setting.
   */
  private async savePort(): Promise<void> {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api && this.portValid()) {
      await api.setupSetPort(this.serverPort());
    }
  }

  // ============================================================================
  // Step Completion Status
  // ============================================================================

  /**
   * Checks if a step is completed.
   */
  public isStepCompleted(step: WizardStep): boolean {
    const stepIndex: number = this.steps.indexOf(step);
    return stepIndex < this.currentStepIndex;
  }

  /**
   * Checks if a step is the current step.
   */
  public isCurrentStep(step: WizardStep): boolean {
    return step === this.currentStep();
  }

  // ============================================================================
  // Components
  // ============================================================================

  /**
   * Downloads yt-dlp from its official releases.
   */
  public async downloadYtDlp(): Promise<void> {
    await this.deps.installDependency('yt-dlp');
  }

  /**
   * Opens a file picker and installs the chosen SoundFont.
   */
  public async chooseSoundFont(): Promise<void> {
    await this.deps.installSoundFont();
  }

  /**
   * Removes an installed SoundFont.
   */
  public async removeSoundFont(fileName: string): Promise<void> {
    await this.deps.removeSoundFont(fileName);
  }

  /**
   * Formats a file size for display.
   */
  public formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Opens a URL in the system default browser.
   */
  public openExternalUrl(url: string): void {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api) {
      void api.openExternal(url);
    }
  }
}
