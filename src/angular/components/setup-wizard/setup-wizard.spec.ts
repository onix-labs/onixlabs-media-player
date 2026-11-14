/**
 * @fileoverview Tests for SetupWizard.
 *
 * The wizard is the first-run gate: if it breaks, first launch is bricked.
 * Tests cover step navigation and its boundaries, the port validation rules
 * including the 1024/65535 edges, saving only a valid port when leaving the
 * port step, completion ordering, and graceful behaviour when the preload
 * API is absent.
 *
 * @module app/components/setup-wizard.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, type WritableSignal} from '@angular/core';
import {SetupWizard} from './setup-wizard';
import {ElectronService} from '../../services/electron.service';
import {DependencyService} from '../../services/dependency.service';

// ============================================================================
// Helpers
// ============================================================================

/** The preload API surface the wizard uses. */
interface MockApi {
  setupGetPort: ReturnType<typeof vi.fn>;
  setupSetPort: ReturnType<typeof vi.fn>;
  setupValidatePort: ReturnType<typeof vi.fn>;
  setupComplete: ReturnType<typeof vi.fn>;
  setupSkip: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
}

/**
 * Creates a preload API stub and installs it on window.
 *
 * @returns The stub, so tests can assert against it
 */
function installApi(): MockApi {
  const api: MockApi = {
    setupGetPort: vi.fn().mockResolvedValue(0),
    setupSetPort: vi.fn().mockResolvedValue(undefined),
    setupValidatePort: vi.fn().mockResolvedValue(true),
    setupComplete: vi.fn().mockResolvedValue(undefined),
    setupSkip: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as {mediaPlayer: MockApi | undefined}).mediaPlayer = api;
  return api;
}

/** Removes the preload API from window. */
function removeApi(): void {
  (window as unknown as {mediaPlayer: MockApi | undefined}).mediaPlayer = undefined;
}

/** Creates a DependencyService stub covering what the wizard reads. */
function createMockDeps(): Record<string, unknown> {
  return {
    dependencyState: signal(null),
    installProgress: signal(null),
    isOperationInProgress: signal(false),
    ffmpegInstalled: signal(false),
    fluidsynthInstalled: signal(false),
    ytdlpInstalled: signal(false),
    soundFonts: signal([]),
    soundFontError: signal(null),
    installDependency: vi.fn().mockResolvedValue(undefined),
    installSoundFont: vi.fn().mockResolvedValue(undefined),
    removeSoundFont: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Builds an input event carrying a port value.
 *
 * @param value - The raw input value
 * @returns An Event whose target has that value
 */
function portEvent(value: string): Event {
  return {target: {value}} as unknown as Event;
}

// ============================================================================
// Tests
// ============================================================================

describe('SetupWizard', (): void => {
  let component: SetupWizard;
  let api: MockApi;

  beforeEach((): void => {
    api = installApi();

    TestBed.configureTestingModule({
      providers: [
        SetupWizard,
        {provide: ElectronService, useValue: {}},
        {provide: DependencyService, useValue: createMockDeps()},
      ],
    });

    component = TestBed.inject(SetupWizard);
  });

  afterEach((): void => {
    removeApi();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Navigation
  // ==========================================================================

  describe('navigation', (): void => {
    it('starts on the welcome step', (): void => {
      expect(component.currentStep()).toBe('welcome');
      expect(component.isFirstStep).toBe(true);
    });

    it('advances one step at a time', async (): Promise<void> => {
      await component.next();

      expect(component.currentStep()).toBe('port');
    });

    it('goes back one step at a time', async (): Promise<void> => {
      await component.next();

      component.back();

      expect(component.currentStep()).toBe('welcome');
    });

    it('is a no-op going back from the first step', (): void => {
      component.back();

      expect(component.currentStep()).toBe('welcome');
    });

    it('is a no-op going forward from the last step', async (): Promise<void> => {
      component.currentStep.set('complete');

      await component.next();

      expect(component.currentStep()).toBe('complete');
      expect(component.isLastStep).toBe(true);
    });

    it('walks the full sequence in order', async (): Promise<void> => {
      const seen: string[] = [component.currentStep()];
      for (let i: number = 0; i < component.steps.length - 1; i++) {
        await component.next();
        seen.push(component.currentStep());
      }

      expect(seen).toEqual([...component.steps]);
    });
  });

  // ==========================================================================
  // Step Completion
  // ==========================================================================

  describe('step completion', (): void => {
    it('marks earlier steps complete and later ones not', async (): Promise<void> => {
      await component.next();
      await component.next();

      expect(component.currentStep()).toBe('components');
      expect(component.isStepCompleted('welcome')).toBe(true);
      expect(component.isStepCompleted('port')).toBe(true);
      expect(component.isStepCompleted('components')).toBe(false);
      expect(component.isStepCompleted('complete')).toBe(false);
    });

    it('never marks the current step complete', (): void => {
      expect(component.isStepCompleted('welcome')).toBe(false);
      expect(component.isCurrentStep('welcome')).toBe(true);
    });
  });

  // ==========================================================================
  // Port Validation
  // ==========================================================================

  describe('port validation', (): void => {
    it('treats 0 as valid auto-assign without asking the main process', async (): Promise<void> => {
      await component.onPortChange(portEvent('0'));

      expect(component.portValid()).toBe(true);
      expect(component.portValidationMessage()).toBe('');
      expect(api.setupValidatePort).not.toHaveBeenCalled();
    });

    it('rejects a privileged port', async (): Promise<void> => {
      await component.onPortChange(portEvent('1023'));

      expect(component.portValid()).toBe(false);
      expect(component.portValidationMessage()).toBe('Port must be between 1024 and 65535');
      expect(api.setupValidatePort).not.toHaveBeenCalled();
    });

    it('accepts the lower bound', async (): Promise<void> => {
      await component.onPortChange(portEvent('1024'));

      expect(component.portValid()).toBe(true);
      expect(api.setupValidatePort).toHaveBeenCalledWith(1024);
    });

    it('accepts the upper bound', async (): Promise<void> => {
      await component.onPortChange(portEvent('65535'));

      expect(component.portValid()).toBe(true);
      expect(api.setupValidatePort).toHaveBeenCalledWith(65535);
    });

    it('rejects above the upper bound', async (): Promise<void> => {
      await component.onPortChange(portEvent('65536'));

      expect(component.portValid()).toBe(false);
      expect(api.setupValidatePort).not.toHaveBeenCalled();
    });

    it('rejects a negative port', async (): Promise<void> => {
      await component.onPortChange(portEvent('-1'));

      expect(component.portValid()).toBe(false);
    });

    it('treats unparseable input as auto-assign', async (): Promise<void> => {
      await component.onPortChange(portEvent('abc'));

      expect(component.serverPort()).toBe(0);
      expect(component.portValid()).toBe(true);
    });

    it('reports a port that is already in use', async (): Promise<void> => {
      api.setupValidatePort.mockResolvedValue(false);

      await component.onPortChange(portEvent('8080'));

      expect(component.portValid()).toBe(false);
      expect(component.portValidationMessage()).toBe('Port is already in use');
    });

    it('clears the validating flag afterwards', async (): Promise<void> => {
      await component.onPortChange(portEvent('8080'));

      expect(component.validatingPort()).toBe(false);
    });

    it('clears the validating flag even when the check throws', async (): Promise<void> => {
      api.setupValidatePort.mockRejectedValue(new Error('IPC down'));

      await expect(component.onPortChange(portEvent('8080'))).rejects.toThrow('IPC down');
      expect(component.validatingPort()).toBe(false);
    });

    it('resets to auto-assign', async (): Promise<void> => {
      await component.onPortChange(portEvent('1023'));

      await component.setAutoPort();

      expect(component.serverPort()).toBe(0);
      expect(component.portValid()).toBe(true);
      expect(component.portValidationMessage()).toBe('');
    });
  });

  // ==========================================================================
  // Saving the Port
  // ==========================================================================

  describe('saving the port', (): void => {
    it('saves when leaving the port step with a valid port', async (): Promise<void> => {
      component.currentStep.set('port');
      await component.onPortChange(portEvent('8080'));

      await component.next();

      expect(api.setupSetPort).toHaveBeenCalledWith(8080);
      expect(component.currentStep()).toBe('components');
    });

    it('does not save an invalid port, but still advances', async (): Promise<void> => {
      component.currentStep.set('port');
      await component.onPortChange(portEvent('80'));

      await component.next();

      expect(api.setupSetPort).not.toHaveBeenCalled();
      expect(component.currentStep()).toBe('components');
    });

    it('does not save when leaving any other step', async (): Promise<void> => {
      await component.next();

      expect(api.setupSetPort).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Completion
  // ==========================================================================

  describe('completion', (): void => {
    it('completes through the preload API', async (): Promise<void> => {
      await component.finish();

      expect(api.setupComplete).toHaveBeenCalled();
    });

    it('skips through the preload API', async (): Promise<void> => {
      await component.skip();

      expect(api.setupSkip).toHaveBeenCalled();
    });

    it('opens external URLs through the preload API', (): void => {
      component.openExternalUrl('https://example.com');

      expect(api.openExternal).toHaveBeenCalledWith('https://example.com');
    });
  });

  // ==========================================================================
  // Missing Preload API
  // ==========================================================================

  describe('components', (): void => {
    /** The DependencyService stub the wizard was given. */
    function deps(): Record<string, unknown> {
      return TestBed.inject(DependencyService) as unknown as Record<string, unknown>;
    }

    /** A dependency status as the server reports it. */
    function status(id: string, source: string | null): Record<string, unknown> {
      return {id, name: id, installed: source !== null, path: source ? `/bin/${id}` : null, source, version: null, managed: id === 'yt-dlp', description: '', websiteUrl: ''};
    }

    it('has a single components step between port and complete', (): void => {
      expect(component.steps).toEqual(['welcome', 'port', 'components', 'complete']);
    });

    it('lists FFmpeg and FluidSynth as the built-in components', (): void => {
      (deps()['dependencyState'] as WritableSignal<unknown>).set({
        ffmpeg: status('ffmpeg', 'bundled'),
        fluidsynth: status('fluidsynth', 'bundled'),
        ytdlp: status('yt-dlp', null),
      });

      expect(component.builtInComponents().map((d: {id: string}): string => d.id)).toEqual(['ffmpeg', 'fluidsynth']);
      expect(component.ytdlpStatus()?.id).toBe('yt-dlp');
    });

    it('downloads yt-dlp through the dependency service', async (): Promise<void> => {
      await component.downloadYtDlp();

      expect(deps()['installDependency']).toHaveBeenCalledWith('yt-dlp');
    });

    it('chooses a SoundFont through the dependency service', async (): Promise<void> => {
      await component.chooseSoundFont();

      expect(deps()['installSoundFont']).toHaveBeenCalled();
    });

    it('removes a SoundFont through the dependency service', async (): Promise<void> => {
      await component.removeSoundFont('GeneralUser.sf2');

      expect(deps()['removeSoundFont']).toHaveBeenCalledWith('GeneralUser.sf2');
    });

    it('formats SoundFont sizes', (): void => {
      expect(component.formatFileSize(512)).toBe('512 B');
      expect(component.formatFileSize(2048)).toBe('2.0 KB');
      expect(component.formatFileSize(31 * 1024 * 1024)).toBe('31.0 MB');
    });

    it('shows only yt-dlp progress', (): void => {
      const progress: WritableSignal<unknown> = deps()['installProgress'] as WritableSignal<unknown>;

      progress.set({dependencyId: 'yt-dlp', status: 'installing', message: 'Downloading', percent: 40});
      expect(component.ytdlpProgress()?.percent).toBe(40);

      progress.set({dependencyId: 'ffmpeg', status: 'error', message: 'FFmpeg is built into ONIXPlayer'});
      expect(component.ytdlpProgress()).toBeNull();
    });
  });

  describe('without the preload API', (): void => {
    beforeEach((): void => {
      removeApi();
    });

    it('reports the API as unavailable rather than throwing', async (): Promise<void> => {
      await component.onPortChange(portEvent('8080'));

      expect(component.portValid()).toBe(false);
      expect(component.portValidationMessage()).toBe('API not available');
    });

    it('finishes without throwing', async (): Promise<void> => {
      await expect(component.finish()).resolves.toBeUndefined();
    });

    it('skips without throwing', async (): Promise<void> => {
      await expect(component.skip()).resolves.toBeUndefined();
    });

    it('still advances through steps', async (): Promise<void> => {
      component.currentStep.set('port');

      await component.next();

      expect(component.currentStep()).toBe('components');
    });

    it('does not throw opening an external URL', (): void => {
      expect((): void => component.openExternalUrl('https://example.com')).not.toThrow();
    });
  });
});

// ============================================================================
// Start-up state
// ============================================================================

describe('SetupWizard start-up', (): void => {
  let mockDeps: Record<string, unknown>;

  /**
   * Creates the wizard and lets its initial port lookup finish.
   *
   * @param platform - The platform the main process reports
   */
  async function createWizard(platform: string = 'darwin'): Promise<SetupWizard> {
    TestBed.configureTestingModule({
      providers: [
        SetupWizard,
        {provide: ElectronService, useValue: {platformInfo: signal({platform, supportsGlass: false, systemTheme: 'dark'})}},
        {provide: DependencyService, useValue: mockDeps},
      ],
    });
    const wizard: SetupWizard = TestBed.inject(SetupWizard);
    await Promise.resolve();
    return wizard;
  }

  beforeEach((): void => {
    mockDeps = createMockDeps();
  });

  afterEach((): void => {
    removeApi();
    vi.restoreAllMocks();
  });

  it('starts with the port that is already saved', async (): Promise<void> => {
    const api: MockApi = installApi();
    api.setupGetPort.mockResolvedValue(8080);

    const wizard: SetupWizard = await createWizard();

    expect(wizard.serverPort()).toBe(8080);
  });

  it('starts on auto-assign when the preload API is absent', async (): Promise<void> => {
    removeApi();

    const wizard: SetupWizard = await createWizard();

    expect(wizard.serverPort()).toBe(0);
  });

  it.each(['darwin', 'win32', 'linux'])('reports the %s platform from the main process', async (platform: string): Promise<void> => {
    installApi();

    const wizard: SetupWizard = await createWizard(platform);

    expect(wizard.platform).toBe(platform);
  });

  it('lists no built-in components before the dependency state has loaded', async (): Promise<void> => {
    installApi();

    const wizard: SetupWizard = await createWizard();

    expect(wizard.builtInComponents()).toEqual([]);
  });

  it('has no yt-dlp status before the dependency state has loaded', async (): Promise<void> => {
    installApi();

    const wizard: SetupWizard = await createWizard();

    expect(wizard.ytdlpStatus()).toBeNull();
  });

  it('shows no yt-dlp progress while nothing is being downloaded', async (): Promise<void> => {
    installApi();

    const wizard: SetupWizard = await createWizard();

    expect(wizard.ytdlpProgress()).toBeNull();
  });
});

// ============================================================================
// Rendered behaviour
// ============================================================================

describe('SetupWizard rendered', (): void => {
  let fixture: ComponentFixture<SetupWizard>;
  let host: HTMLElement;
  let api: MockApi;
  let mockDeps: Record<string, unknown>;

  /** A dependency status as the server reports it. */
  function status(id: string, source: string | null, version: string | null = null): Record<string, unknown> {
    return {
      id,
      name: id,
      installed: source !== null,
      path: source ? `/bin/${id}` : null,
      source,
      version,
      managed: id === 'yt-dlp',
      description: `${id} description`,
      websiteUrl: `https://example.com/${id}`,
    };
  }

  /** Publishes a dependency state, as the server would. */
  async function publishState(ffmpeg: string | null, fluidsynth: string | null, ytdlp: string | null): Promise<void> {
    (mockDeps['dependencyState'] as WritableSignal<unknown>).set({
      ffmpeg: status('ffmpeg', ffmpeg, '7.1'),
      fluidsynth: status('fluidsynth', fluidsynth),
      ytdlp: status('yt-dlp', ytdlp),
    });
    await fixture.whenStable();
  }

  /** Sets a signal on the fake DependencyService and re-renders. */
  async function setDeps(name: string, value: unknown): Promise<void> {
    (mockDeps[name] as WritableSignal<unknown>).set(value);
    await fixture.whenStable();
  }

  /** Finds a button by the text it shows. */
  function button(label: string): HTMLButtonElement | undefined {
    return Array.from(host.querySelectorAll('button')).find((candidate: HTMLButtonElement): boolean => candidate.textContent.trim() === label);
  }

  /** Clicks a button and waits for the wizard to settle. */
  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await fixture.whenStable();
  }

  /** Clicks Next the given number of times. */
  async function advance(times: number): Promise<void> {
    for (let i: number = 0; i < times; i++) {
      await click(button('Next')!);
    }
  }

  /** Types into the fixed-port box, as a user would. */
  async function typePort(value: string): Promise<void> {
    const input: HTMLInputElement = host.querySelector<HTMLInputElement>('.port-input')!;
    input.value = value;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    await fixture.whenStable();
  }

  /** Reads an element's text with whitespace collapsed. */
  function text(selector: string, root: Element = host): string {
    return (root.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  /** Describes each stepper entry as "Label:state". */
  function stepper(): string[] {
    return Array.from(host.querySelectorAll('.stepper-item')).map((item: Element): string => {
      const state: string = item.classList.contains('current') ? 'current' : item.classList.contains('completed') ? 'completed' : 'upcoming';
      return `${text('.stepper-label', item)}:${state}`;
    });
  }

  /** Reads the value shown against a label in the completion summary. */
  function summary(label: string): string {
    const item: Element = Array.from(host.querySelectorAll('.summary-item'))
      .find((candidate: Element): boolean => text('.summary-label', candidate) === label)!;
    return text('.summary-value', item);
  }

  /** Creates the wizard and waits for its first render. */
  async function createWizard(): Promise<void> {
    fixture = TestBed.createComponent(SetupWizard);
    host = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  }

  beforeEach((): void => {
    api = installApi();
    mockDeps = createMockDeps();

    TestBed.configureTestingModule({
      imports: [SetupWizard],
      providers: [
        {provide: ElectronService, useValue: {}},
        {provide: DependencyService, useValue: mockDeps},
      ],
    });
  });

  afterEach((): void => {
    fixture.destroy();
    removeApi();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Navigation
  // ==========================================================================

  describe('navigation', (): void => {
    beforeEach(async (): Promise<void> => {
      await createWizard();
    });

    it('opens on the welcome step with only a Next button', (): void => {
      expect(text('.welcome-step h1')).toBe("Let's get started");
      expect(button('Back')).toBeUndefined();
      expect(button('Next')!.disabled).toBe(false);
      expect(button('Finish')).toBeUndefined();
    });

    it('marks the welcome step as current in the stepper', (): void => {
      expect(stepper()).toEqual(['Welcome:current', 'Port:upcoming', 'Components:upcoming', 'Complete:upcoming']);
    });

    it('moves to the port step and ticks off the welcome step on Next', async (): Promise<void> => {
      await advance(1);

      expect(text('.port-step h2')).toBe('Server Port Configuration');
      expect(stepper()).toEqual(['Welcome:completed', 'Port:current', 'Components:upcoming', 'Complete:upcoming']);
      expect(host.querySelectorAll('.stepper-dot .fa-check')).toHaveLength(1);
    });

    it('returns to the previous step on Back', async (): Promise<void> => {
      await advance(1);

      await click(button('Back')!);

      expect(host.querySelector('.welcome-step')).not.toBeNull();
      expect(stepper()[0]).toBe('Welcome:current');
    });

    it('fills the connecting line up to the current step', async (): Promise<void> => {
      await advance(3);

      const lines: boolean[] = Array.from(host.querySelectorAll('.stepper-line'))
        .map((line: Element): boolean => line.classList.contains('completed'));
      expect(lines).toEqual([true, true, false]);
    });

    it('offers Finish instead of Next on the last step', async (): Promise<void> => {
      await advance(3);

      expect(host.querySelector('.complete-step')).not.toBeNull();
      expect(button('Next')).toBeUndefined();
      expect(button('Finish')).toBeDefined();
    });

    it('completes setup when Finish is clicked', async (): Promise<void> => {
      await advance(3);

      await click(button('Finish')!);

      expect(api.setupComplete).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Port step
  // ==========================================================================

  describe('port step', (): void => {
    /** Returns which port option is highlighted. */
    function selectedOption(): string {
      return text('.port-option.selected .option-label');
    }

    beforeEach(async (): Promise<void> => {
      await createWizard();
      await advance(1);
    });

    it('starts on Automatic with an empty port box', (): void => {
      expect(selectedOption()).toBe('Automatic');
      expect(host.querySelector<HTMLInputElement>('.port-input')!.value).toBe('');
      expect(host.querySelector('.port-status')).toBeNull();
    });

    it('selects Fixed Port and confirms a free port', async (): Promise<void> => {
      await typePort('8080');

      expect(api.setupValidatePort).toHaveBeenCalledExactlyOnceWith(8080);
      expect(selectedOption()).toBe('Fixed Port');
      expect(host.querySelector('.port-status.valid')).not.toBeNull();
      expect(button('Next')!.disabled).toBe(false);
    });

    it('shows a spinner while the port is being checked', async (): Promise<void> => {
      api.setupValidatePort.mockReturnValue(new Promise<boolean>((): void => {}));

      await typePort('8080');

      expect(host.querySelector('.port-status.validating')).not.toBeNull();
    });

    it('rejects a privileged port and blocks Next', async (): Promise<void> => {
      await typePort('80');

      expect(text('.port-error')).toBe('Port must be between 1024 and 65535');
      expect(host.querySelector('.port-input')!.classList.contains('invalid')).toBe(true);
      expect(host.querySelector('.port-status.invalid')).not.toBeNull();
      expect(button('Next')!.disabled).toBe(true);
      expect(api.setupValidatePort).not.toHaveBeenCalled();
    });

    it('reports a port that is already in use and blocks Next', async (): Promise<void> => {
      api.setupValidatePort.mockResolvedValue(false);

      await typePort('8080');

      expect(text('.port-error')).toBe('Port is already in use');
      expect(button('Next')!.disabled).toBe(true);
    });

    it('clears the problem and unblocks Next when Automatic is chosen', async (): Promise<void> => {
      await typePort('80');

      await click(host.querySelector<HTMLButtonElement>('.port-option-button')!);

      expect(selectedOption()).toBe('Automatic');
      expect(host.querySelector('.port-error')).toBeNull();
      expect(host.querySelector<HTMLInputElement>('.port-input')!.value).toBe('');
      expect(button('Next')!.disabled).toBe(false);
    });

    it('returns to Automatic when the port box is cleared', async (): Promise<void> => {
      await typePort('8080');

      await typePort('');

      expect(selectedOption()).toBe('Automatic');
      expect(host.querySelector('.port-status')).toBeNull();
    });

    it('saves the chosen port when moving on', async (): Promise<void> => {
      await typePort('8080');

      await advance(1);

      expect(api.setupSetPort).toHaveBeenCalledExactlyOnceWith(8080);
      expect(host.querySelector('.dependencies-step')).not.toBeNull();
    });

    it('shows the chosen port in the summary', async (): Promise<void> => {
      await typePort('8080');

      await advance(2);

      expect(summary('Server Port:')).toBe('8080');
    });

    it('shows Automatic in the summary when no port was chosen', async (): Promise<void> => {
      await advance(2);

      expect(summary('Server Port:')).toBe('Automatic');
    });
  });

  it('shows a previously saved port as the fixed port', async (): Promise<void> => {
    api.setupGetPort.mockResolvedValue(9000);
    await createWizard();

    await advance(1);

    expect(text('.port-option.selected .option-label')).toBe('Fixed Port');
    expect(host.querySelector<HTMLInputElement>('.port-input')!.value).toBe('9000');
  });

  // ==========================================================================
  // Components step
  // ==========================================================================

  describe('components step', (): void => {
    /** Returns the cards for FFmpeg, FluidSynth and (when loaded) yt-dlp. */
    function cards(): Element[] {
      return Array.from(host.querySelectorAll('.dependency-card'));
    }

    beforeEach(async (): Promise<void> => {
      await createWizard();
      await advance(2);
    });

    it('shows no component cards before the dependency state has loaded', (): void => {
      expect(cards()).toHaveLength(0);
    });

    it('lists the built-in engines with their version and description', async (): Promise<void> => {
      await publishState('bundled', 'bundled', null);

      expect(text('.dependency-name', cards()[0])).toBe('ffmpeg 7.1');
      expect(text('.dependency-name', cards()[1])).toBe('fluidsynth');
      expect(text('.dependency-description', cards()[0])).toBe('ffmpeg description');
    });

    it('describes a bundled engine as built in', async (): Promise<void> => {
      await publishState('bundled', 'bundled', null);

      expect(text('.dependency-status-text', cards()[0])).toBe('Built in');
      expect(cards()[0].classList.contains('installed')).toBe(true);
      expect(cards()[0].querySelector('.dependency-indicator i')!.classList.contains('fa-circle-check')).toBe(true);
    });

    it('flags an engine that is missing from the build', async (): Promise<void> => {
      await publishState(null, 'bundled', null);

      expect(text('.dependency-status-text', cards()[0])).toBe('Missing from this build');
      expect(cards()[0].querySelector('.dependency-indicator')!.classList.contains('missing')).toBe(true);
      expect(cards()[0].querySelector('.dependency-indicator i')!.classList.contains('fa-circle-xmark')).toBe(true);
    });

    it('shows the path of an engine found on the system', async (): Promise<void> => {
      await publishState('system', 'bundled', null);

      expect(text('.dependency-status-text', cards()[0])).toBe('Using /bin/ffmpeg');
    });

    it('opens an engine\'s website in the browser', async (): Promise<void> => {
      await publishState('bundled', 'bundled', null);

      await click(cards()[1].querySelector<HTMLButtonElement>('.dep-button.link')!);

      expect(api.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/fluidsynth');
    });

    it('explains that MIDI will not play without a SoundFont', (): void => {
      expect(text('.soundfont-empty')).toContain('No SoundFont chosen');
      expect(host.querySelector('.soundfont-list')).toBeNull();
    });

    it('lists the chosen SoundFonts with their sizes', async (): Promise<void> => {
      await setDeps('soundFonts', [
        {fileName: 'Piano.sf2', filePath: '/fonts/Piano.sf2', sizeBytes: 2048},
        {fileName: 'Orchestra.sf2', filePath: '/fonts/Orchestra.sf2', sizeBytes: 31 * 1024 * 1024},
      ]);

      const rows: string[] = Array.from(host.querySelectorAll('.soundfont-item'))
        .map((row: Element): string => `${text('.soundfont-name', row)} ${text('.soundfont-size', row)}`);
      expect(rows).toEqual(['Piano.sf2 2.0 KB', 'Orchestra.sf2 31.0 MB']);
      expect(host.querySelector('.soundfont-empty')).toBeNull();
    });

    it('removes the SoundFont whose bin is clicked', async (): Promise<void> => {
      await setDeps('soundFonts', [
        {fileName: 'Piano.sf2', filePath: '/fonts/Piano.sf2', sizeBytes: 2048},
        {fileName: 'Orchestra.sf2', filePath: '/fonts/Orchestra.sf2', sizeBytes: 4096},
      ]);

      await click(host.querySelectorAll<HTMLButtonElement>('.soundfont-remove')[1]);

      expect(mockDeps['removeSoundFont']).toHaveBeenCalledExactlyOnceWith('Orchestra.sf2');
    });

    it('opens the SoundFont picker', async (): Promise<void> => {
      await click(button('Choose SoundFont...')!);

      expect(mockDeps['installSoundFont']).toHaveBeenCalledTimes(1);
    });

    it('shows why a SoundFont operation failed', async (): Promise<void> => {
      await setDeps('soundFontError', 'Could not install the SoundFont: the server returned 500.');

      expect(text('.soundfont-section .install-progress.error')).toBe('Could not install the SoundFont: the server returned 500.');
    });

    it('offers yt-dlp as an optional download', async (): Promise<void> => {
      await publishState('bundled', 'bundled', null);

      expect(text('.dependency-status-text', cards()[2])).toBe('Not downloaded (optional)');
      expect(button('Download')!.disabled).toBe(false);
    });

    it('downloads yt-dlp when Download is clicked', async (): Promise<void> => {
      await publishState('bundled', 'bundled', null);

      await click(button('Download')!);

      expect(mockDeps['installDependency']).toHaveBeenCalledExactlyOnceWith('yt-dlp');
    });

    it('disables Download while a download is running', async (): Promise<void> => {
      await publishState('bundled', 'bundled', null);

      await setDeps('isOperationInProgress', true);

      expect(button('Download')!.disabled).toBe(true);
    });

    it('withdraws the Download button once yt-dlp has been downloaded', async (): Promise<void> => {
      await publishState('bundled', 'bundled', 'downloaded');

      expect(text('.dependency-status-text', cards()[2])).toBe('Downloaded');
      expect(button('Download')).toBeUndefined();
    });

    it('shows the path of a system yt-dlp and still offers a download', async (): Promise<void> => {
      await publishState('bundled', 'bundled', 'system');

      expect(text('.dependency-status-text', cards()[2])).toBe('Using /bin/yt-dlp');
      expect(button('Download')).toBeDefined();
    });

    it('opens the yt-dlp website in the browser', async (): Promise<void> => {
      await publishState('bundled', 'bundled', null);

      await click(cards()[2].querySelector<HTMLButtonElement>('.dep-button.link')!);

      expect(api.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/yt-dlp');
    });

    it('shows the download message and a bar filled to the reported percentage', async (): Promise<void> => {
      await setDeps('installProgress', {dependencyId: 'yt-dlp', status: 'installing', message: 'Downloading yt-dlp', percent: 40});

      expect(text('.install-progress-header')).toBe('Downloading yt-dlp');
      expect(host.querySelector<HTMLElement>('.install-progress-fill')!.style.width).toBe('40%');
    });

    it('shows the message without a bar when the percentage is unknown', async (): Promise<void> => {
      await setDeps('installProgress', {dependencyId: 'yt-dlp', status: 'updating', message: 'Checking for updates'});

      expect(text('.install-progress-header')).toBe('Checking for updates');
      expect(host.querySelector('.install-progress-bar')).toBeNull();
    });

    it('shows why the download failed', async (): Promise<void> => {
      await setDeps('installProgress', {dependencyId: 'yt-dlp', status: 'error', message: 'Could not install yt-dlp: network down'});

      expect(text('.dependency-list > .install-progress.error')).toBe('Could not install yt-dlp: network down');
    });

    it('shows no progress once the download has succeeded', async (): Promise<void> => {
      await setDeps('installProgress', {dependencyId: 'yt-dlp', status: 'success', message: 'Done'});

      expect(host.querySelector('.install-progress')).toBeNull();
    });

    it('shows no progress for another dependency', async (): Promise<void> => {
      await setDeps('installProgress', {dependencyId: 'ffmpeg', status: 'installing', message: 'Installing FFmpeg'});

      expect(host.querySelector('.install-progress')).toBeNull();
    });
  });

  // ==========================================================================
  // Summary
  // ==========================================================================

  describe('summary', (): void => {
    beforeEach(async (): Promise<void> => {
      await createWizard();
      await advance(3);
    });

    it('reports every component as unavailable before anything is detected', (): void => {
      expect([summary('FFmpeg:'), summary('FluidSynth:'), summary('yt-dlp:')])
        .toEqual(['Not installed', 'Not installed', 'Not downloaded (optional)']);
    });

    it('reports the detected components', async (): Promise<void> => {
      (mockDeps['ffmpegInstalled'] as WritableSignal<boolean>).set(true);
      (mockDeps['fluidsynthInstalled'] as WritableSignal<boolean>).set(true);
      await setDeps('ytdlpInstalled', true);

      expect([summary('FFmpeg:'), summary('FluidSynth:'), summary('yt-dlp:')]).toEqual(['Built in', 'Built in', 'Installed']);
    });

    it('colours each summary value by whether the component is available', async (): Promise<void> => {
      await setDeps('ffmpegInstalled', true);

      const values: Element[] = Array.from(host.querySelectorAll('.summary-item .summary-value'));
      expect(values[1].classList.contains('installed')).toBe(true);
      expect(values[2].classList.contains('missing')).toBe(true);
    });
  });
});
