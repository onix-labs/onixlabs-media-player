/**
 * @fileoverview Tests for SoundFontList, the installed-SoundFont list shared
 * by the settings window and the setup wizard.
 *
 * @module app/components/shared/soundfont-list.spec
 */

import {signal} from '@angular/core';
import type {WritableSignal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import type {ComponentFixture} from '@angular/core/testing';
import {DependencyService} from '../../../services/dependency.service';
import type {SoundFontInfo} from '../../../services/dependency.service';
import {SoundFontList} from './soundfont-list';

/** The part of DependencyService the list reads and drives. */
interface FakeDependencies {
  readonly soundFonts: WritableSignal<SoundFontInfo[]>;
  readonly activeSoundFont: WritableSignal<string | null>;
  readonly setActiveSoundFont: ReturnType<typeof vi.fn<(fileName: string | null) => Promise<void>>>;
  readonly removeSoundFont: ReturnType<typeof vi.fn<(fileName: string) => Promise<void>>>;
}

const SOUNDFONTS: SoundFontInfo[] = [
  {fileName: 'tiny.sf2', filePath: '/data/soundfonts/tiny.sf2', sizeBytes: 512},
  {fileName: 'small.sf2', filePath: '/data/soundfonts/small.sf2', sizeBytes: 1536},
  {fileName: 'general.sf2', filePath: '/data/soundfonts/general.sf2', sizeBytes: 148 * 1024 * 1024},
];

describe('SoundFontList', (): void => {
  let deps: FakeDependencies;
  let fixture: ComponentFixture<SoundFontList>;
  let host: HTMLElement;

  const all = <T extends Element>(selector: string): T[] => Array.from(host.querySelectorAll<T>(selector));
  const texts = (selector: string): string[] => all<HTMLElement>(selector).map((element: HTMLElement): string => element.textContent?.trim() ?? '');

  beforeEach(async (): Promise<void> => {
    deps = {
      soundFonts: signal<SoundFontInfo[]>(SOUNDFONTS),
      activeSoundFont: signal<string | null>(null),
      setActiveSoundFont: vi.fn<(fileName: string | null) => Promise<void>>().mockResolvedValue(undefined),
      removeSoundFont: vi.fn<(fileName: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      imports: [SoundFontList],
      providers: [{provide: DependencyService, useValue: deps}],
    });
    fixture = TestBed.createComponent(SoundFontList);
    host = fixture.nativeElement;
    await fixture.whenStable();
  });

  it('lists the installed SoundFonts in order', (): void => {
    expect(texts('.soundfont-name')).toEqual(['tiny.sf2', 'small.sf2', 'general.sf2']);
  });

  it('shows each SoundFont\'s size in bytes, kilobytes or megabytes', (): void => {
    expect(texts('.soundfont-size')).toEqual(['512 B', '1.5 KB', '148.0 MB']);
  });

  it('follows the installed SoundFonts as they change', async (): Promise<void> => {
    deps.soundFonts.set([SOUNDFONTS[1]]);
    await fixture.whenStable();

    expect(texts('.soundfont-name')).toEqual(['small.sf2']);
  });

  it('marks only the active SoundFont, by its path', async (): Promise<void> => {
    deps.activeSoundFont.set('/data/soundfonts/small.sf2');
    await fixture.whenStable();

    expect(all<HTMLElement>('.soundfont-item').map((item: HTMLElement): boolean => item.classList.contains('selected'))).toEqual([false, true, false]);
    expect(all<HTMLElement>('.soundfont-radio').map((radio: HTMLElement): boolean => radio.classList.contains('active'))).toEqual([false, true, false]);
    expect(all<HTMLElement>('.soundfont-select').map((button: HTMLElement): string | null => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  });

  it('marks none when no SoundFont is active', (): void => {
    expect(host.querySelector('.soundfont-item.selected')).toBeNull();
  });

  it('makes a SoundFont active when its radio is clicked', async (): Promise<void> => {
    all<HTMLButtonElement>('.soundfont-select')[2].click();
    await fixture.whenStable();

    expect(deps.setActiveSoundFont).toHaveBeenCalledExactlyOnceWith('general.sf2');
  });

  it('removes a SoundFont when its bin is clicked', async (): Promise<void> => {
    all<HTMLButtonElement>('.soundfont-remove')[0].click();
    await fixture.whenStable();

    expect(deps.removeSoundFont).toHaveBeenCalledExactlyOnceWith('tiny.sf2');
  });

  it('names the SoundFont each button acts on, for assistive technology', (): void => {
    expect(all<HTMLElement>('.soundfont-select').map((button: HTMLElement): string | null => button.getAttribute('aria-label'))).toEqual(['Use tiny.sf2', 'Use small.sf2', 'Use general.sf2']);
    expect(all<HTMLElement>('.soundfont-remove').map((button: HTMLElement): string | null => button.getAttribute('aria-label'))).toEqual(['Remove tiny.sf2', 'Remove small.sf2', 'Remove general.sf2']);
  });
});
