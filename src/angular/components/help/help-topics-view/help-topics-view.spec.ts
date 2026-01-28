/**
 * @fileoverview Unit tests for HelpTopicsView component.
 *
 * Tests cover:
 * - Component creation
 * - Template data (topics, selectedTopic, currentTopic)
 * - Event handlers (onSelectTopic)
 *
 * @module app/components/help/help-topics-view.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {NO_ERRORS_SCHEMA} from '@angular/core';

import {HelpTopicsView} from './help-topics-view';

// =============================================================================
// Test Suite
// =============================================================================

describe('HelpTopicsView', (): void => {
  let component: HelpTopicsView;
  let fixture: ComponentFixture<HelpTopicsView>;

  beforeEach(async (): Promise<void> => {
    await TestBed.configureTestingModule({
      imports: [HelpTopicsView],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(HelpTopicsView);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  // ===========================================================================
  // Component Creation
  // ===========================================================================

  describe('component creation', (): void => {
    it('should create', (): void => {
      expect(component).toBeTruthy();
    });
  });

  // ===========================================================================
  // Template Data
  // ===========================================================================

  describe('template data', (): void => {
    it('topics should contain 8 help topics', (): void => {
      expect(component.topics).toHaveLength(8);
    });

    it('topics should contain expected topic IDs', (): void => {
      const topicIds: readonly string[] = component.topics.map(
        (t: {id: string}): string => t.id
      );
      expect(topicIds).toContain('getting-started');
      expect(topicIds).toContain('supported-formats');
      expect(topicIds).toContain('visualizations');
      expect(topicIds).toContain('window-modes');
      expect(topicIds).toContain('keyboard-shortcuts');
      expect(topicIds).toContain('dependencies');
      expect(topicIds).toContain('playlist');
      expect(topicIds).toContain('settings');
    });

    it('should default to getting-started topic', (): void => {
      expect(component.selectedTopic()).toBe('getting-started');
    });

    it('currentTopic should return the selected topic', (): void => {
      const topic: {id: string; name: string} | undefined = component.currentTopic();
      expect(topic).toBeDefined();
      expect(topic!.id).toBe('getting-started');
      expect(topic!.name).toBe('Getting Started');
    });

    it('each topic should have required properties', (): void => {
      for (const topic of component.topics) {
        expect(topic.id).toBeDefined();
        expect(topic.name).toBeDefined();
        expect(topic.icon).toBeDefined();
        expect(topic.description).toBeDefined();
        expect(typeof topic.id).toBe('string');
        expect(typeof topic.name).toBe('string');
        expect(typeof topic.icon).toBe('string');
        expect(typeof topic.description).toBe('string');
      }
    });
  });

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  describe('event handlers', (): void => {
    it('onSelectTopic should change the selected topic', (): void => {
      component.onSelectTopic('keyboard-shortcuts');
      expect(component.selectedTopic()).toBe('keyboard-shortcuts');
      expect(component.currentTopic()!.id).toBe('keyboard-shortcuts');
    });

    it('onSelectTopic should update currentTopic computed value', (): void => {
      component.onSelectTopic('visualizations');
      const topic: {id: string; name: string} | undefined = component.currentTopic();
      expect(topic).toBeDefined();
      expect(topic!.id).toBe('visualizations');
      expect(topic!.name).toBe('Visualizations');
    });

    it('selecting each topic should work correctly', (): void => {
      for (const topic of component.topics) {
        component.onSelectTopic(topic.id);
        expect(component.selectedTopic()).toBe(topic.id);
        expect(component.currentTopic()?.id).toBe(topic.id);
      }
    });
  });
});
