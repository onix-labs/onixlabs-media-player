/**
 * @fileoverview Configuration view component for the settings panel.
 *
 * This component provides the main settings/configuration interface.
 * It replaces the media player view when the user enters configuration mode.
 *
 * Layout:
 * - Header with title and close button
 * - Sidebar with search and category navigation
 * - Main panel for displaying settings based on selected category
 *
 * @module app/components/configuration/configuration-view
 */

import {Component, output, signal, computed, inject} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {SettingsService, VISUALIZATION_OPTIONS, VisualizationType} from '../../../services/settings.service';

/**
 * Settings category definition.
 */
interface SettingsCategory {
  /** Unique identifier for the category */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** Font Awesome icon class */
  readonly icon: string;
  /** Description shown in the panel */
  readonly description: string;
}

/**
 * Available settings categories.
 * Future categories (playback, audio) can be added here.
 */
const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    id: 'visualization',
    name: 'Visualization',
    icon: 'fa-solid fa-waveform-lines',
    description: 'Configure audio visualization preferences.',
  },
  // Future categories:
  // { id: 'playback', name: 'Playback', icon: 'fa-solid fa-play', description: 'Playback settings.' },
  // { id: 'audio', name: 'Audio', icon: 'fa-solid fa-volume-high', description: 'Audio output settings.' },
];

/**
 * Configuration view component providing the settings interface.
 *
 * Features:
 * - Category-based settings navigation
 * - Search filtering (filters categories by name)
 * - Visualization default type selection
 * - Close button to return to media player
 *
 * @example
 * <!-- In a parent template -->
 * <app-configuration-view (close)="exitConfigurationMode()" />
 */
@Component({
  selector: 'app-configuration-view',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './configuration-view.html',
  styleUrl: './configuration-view.scss',
})
export class ConfigurationView {
  // ============================================================================
  // Dependencies
  // ============================================================================

  /** Settings service for reading and updating preferences */
  private readonly settingsService: SettingsService = inject(SettingsService);

  // ============================================================================
  // Outputs
  // ============================================================================

  /** Event emitted when the close button is clicked */
  public readonly close = output<void>();

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Search query for filtering categories */
  public readonly searchQuery: ReturnType<typeof signal<string>> = signal<string>('');

  /** Currently selected category ID */
  public readonly selectedCategory: ReturnType<typeof signal<string>> = signal<string>('visualization');

  // ============================================================================
  // Computed Values
  // ============================================================================

  /** Filtered categories based on search query */
  public readonly filteredCategories: ReturnType<typeof computed<readonly SettingsCategory[]>> = computed(
    (): readonly SettingsCategory[] => {
      const query: string = this.searchQuery().toLowerCase().trim();
      if (!query) return SETTINGS_CATEGORIES;
      return SETTINGS_CATEGORIES.filter(
        (cat: SettingsCategory): boolean => cat.name.toLowerCase().includes(query)
      );
    }
  );

  /** Current category details */
  public readonly currentCategory: ReturnType<typeof computed<SettingsCategory | undefined>> = computed(
    (): SettingsCategory | undefined => SETTINGS_CATEGORIES.find(
      (cat: SettingsCategory): boolean => cat.id === this.selectedCategory()
    )
  );

  /** Current default visualization type */
  public readonly currentDefaultVisualization: ReturnType<typeof computed<VisualizationType>> = computed(
    (): VisualizationType => this.settingsService.defaultVisualization()
  );

  // ============================================================================
  // Template Data
  // ============================================================================

  /** Available visualization options for the dropdown */
  public readonly visualizationOptions = VISUALIZATION_OPTIONS;

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Handles close button click.
   * Emits the close event to return to the media player view.
   */
  public onClose(): void {
    this.close.emit();
  }

  /**
   * Handles category selection.
   *
   * @param categoryId - The ID of the category to select
   */
  public onSelectCategory(categoryId: string): void {
    this.selectedCategory.set(categoryId);
  }

  /**
   * Handles search input changes.
   *
   * @param event - The input event
   */
  public onSearchChange(event: Event): void {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    this.searchQuery.set(input.value);
  }

  /**
   * Handles default visualization selection change.
   *
   * @param event - The change event from the select element
   */
  public async onDefaultVisualizationChange(event: Event): Promise<void> {
    const select: HTMLSelectElement = event.target as HTMLSelectElement;
    const type: VisualizationType = select.value as VisualizationType;
    await this.settingsService.setDefaultVisualization(type);
  }
}
