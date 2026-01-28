/**
 * @fileoverview Help Topics view component displaying application documentation.
 *
 * This component displays help documentation organized into categories:
 * - Getting Started
 * - Supported Formats
 * - Visualizations
 * - Window Modes
 * - Keyboard Shortcuts
 * - Dependencies
 * - Playlist
 * - Settings
 *
 * @module app/components/help/help-topics-view
 */

import {Component, ChangeDetectionStrategy, signal, computed} from '@angular/core';

/**
 * Help topic definition with metadata for sidebar navigation.
 */
interface HelpTopic {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly description: string;
}

/**
 * Available help topics for the sidebar navigation.
 */
const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: 'getting-started',
    name: 'Getting Started',
    icon: 'fa-solid fa-rocket',
    description: 'Learn the basics of ONIXPlayer.',
  },
  {
    id: 'supported-formats',
    name: 'Supported Formats',
    icon: 'fa-solid fa-file-audio',
    description: 'Audio and video formats supported by ONIXPlayer.',
  },
  {
    id: 'visualizations',
    name: 'Visualizations',
    icon: 'fa-solid fa-wave-square',
    description: 'Audio visualization modes and how to use them.',
  },
  {
    id: 'window-modes',
    name: 'Window Modes',
    icon: 'fa-solid fa-desktop',
    description: 'Desktop, fullscreen, and miniplayer modes.',
  },
  {
    id: 'keyboard-shortcuts',
    name: 'Keyboard Shortcuts',
    icon: 'fa-solid fa-keyboard',
    description: 'Keyboard shortcuts for controlling playback and navigation.',
  },
  {
    id: 'dependencies',
    name: 'Dependencies',
    icon: 'fa-solid fa-puzzle-piece',
    description: 'External dependencies required for media playback.',
  },
  {
    id: 'playlist',
    name: 'Playlist',
    icon: 'fa-solid fa-list',
    description: 'Managing your playlist and adding media files.',
  },
  {
    id: 'settings',
    name: 'Settings',
    icon: 'fa-solid fa-gear',
    description: 'Configuring ONIXPlayer preferences and appearance.',
  },
];

/**
 * Help Topics view component displaying application documentation.
 *
 * Features:
 * - Sidebar navigation with topic categories
 * - Detailed help content for each topic
 * - Consistent styling with Configuration view
 *
 * @example
 * <app-help-topics-view />
 */
@Component({
  selector: 'app-help-topics-view',
  standalone: true,
  imports: [],
  templateUrl: './help-topics-view.html',
  styleUrl: './help-topics-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelpTopicsView {
  // ============================================================================
  // Template Data
  // ============================================================================

  /** Available help topics for the sidebar */
  public readonly topics: readonly HelpTopic[] = HELP_TOPICS;

  /** Currently selected topic ID */
  public readonly selectedTopic: ReturnType<typeof signal<string>> = signal<string>('getting-started');

  /** Current topic details */
  public readonly currentTopic: ReturnType<typeof computed<HelpTopic | undefined>> = computed(
    (): HelpTopic | undefined => HELP_TOPICS.find(
      (t: HelpTopic): boolean => t.id === this.selectedTopic()
    )
  );

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Selects a help topic by ID.
   *
   * @param topicId - The topic ID to select
   */
  public onSelectTopic(topicId: string): void {
    this.selectedTopic.set(topicId);
  }
}
