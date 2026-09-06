/**
 * @fileoverview Draws the active Windows Media Player skin.
 *
 * The component is a renderer and nothing more: it takes the immutable render
 * tree the {@link SkinService} publishes and turns each node into an absolutely
 * positioned element, then routes pointer input back into the runtime. All
 * decisions about what a node looks like were already made upstream.
 *
 * Two behaviours are worth knowing about.
 *
 * **Button groups hit-test by colour.** A group draws one image and carries a
 * second, never-drawn mapping image whose flat colour regions identify its
 * buttons. Pointer moves over a group are resolved against that image rather
 * than against DOM geometry, so overlapping and non-rectangular buttons work
 * the way the skin author intended.
 *
 * **Video and visualisation panes are reported, not drawn.** A skin marks out
 * where they belong with VIDEO and EFFECTS elements; the component emits those
 * rectangles in view coordinates and leaves the parent to position the
 * application's real outlets over them.
 *
 * @module app/components/skin/skin-host
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  output,
  signal,
  type OutputEmitterRef,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {NgTemplateOutlet} from '@angular/common';
import {SkinService} from '../../../skin/skin.service';
import type {SkinElement} from '../../../skin/skin-element';
import type {SkinRenderNode, SkinRuntime, SkinSliderState} from '../../../skin/skin-runtime';

/** A rectangle in view coordinates. */
export interface SkinSlotRect {
  /** Left edge in pixels, relative to the skin's origin */
  readonly left: number;
  /** Top edge in pixels, relative to the skin's origin */
  readonly top: number;
  /** Width in pixels */
  readonly width: number;
  /** Height in pixels */
  readonly height: number;
}

/** Where a skin wants the application's own media panes placed. */
export interface SkinSlots {
  /** Rectangle reserved for video, or null when the skin declares none */
  readonly video: SkinSlotRect | null;
  /** Rectangle reserved for visualisations, or null when the skin declares none */
  readonly effects: SkinSlotRect | null;
}

/** CSS reference pixels per inch, as the browser defines them. */
const PIXELS_PER_INCH: number = 96;

/** Typographic points per inch. */
const POINTS_PER_INCH: number = 72;

/** Points-to-pixels ratio, for the font sizes skins express in points. */
const POINTS_TO_PIXELS: number = PIXELS_PER_INCH / POINTS_PER_INCH;

/**
 * Renders the active skin and routes input back into its runtime.
 *
 * @example
 * <!-- In a parent template -->
 * <app-skin-host (slotsChange)="placeOutlets($event)" />
 */
@Component({
  selector: 'app-skin-host',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './skin-host.html',
  styleUrl: './skin-host.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SkinHost implements OnDestroy {
  /** The skin subsystem this component draws */
  private readonly skins: SkinService = inject(SkinService);

  /** This component's host element, measured to size the skin */
  private readonly hostElement: ElementRef<HTMLElement> = inject(ElementRef);

  /** Observer keeping the skin's view size in step with the host element */
  private readonly resizeObserver: ResizeObserver;

  /** Slider currently being dragged, so moves outside it still track */
  private readonly dragging: WritableSignal<SkinRenderNode | null> = signal<SkinRenderNode | null>(null);

  /** The active skin's render tree, or null when no skin is active */
  public readonly tree: Signal<SkinRenderNode | null> = this.skins.renderTree;

  /** Where the skin wants the application's video and visualisation panes */
  public readonly slotsChange: OutputEmitterRef<SkinSlots> = output<SkinSlots>();

  /** Rectangles the skin reserved for the application's own panes */
  private readonly slots: Signal<SkinSlots> = computed((): SkinSlots => {
    const root: SkinRenderNode | null = this.tree();
    if (root === null) return {video: null, effects: null};

    const found: {video: SkinSlotRect | null; effects: SkinSlotRect | null} = {
      video: null,
      effects: null,
    };
    this.collectSlots(root, 0, 0, found);
    return found;
  });

  /**
   * Wires up size tracking and slot reporting.
   */
  public constructor() {
    this.resizeObserver = new ResizeObserver((entries: readonly ResizeObserverEntry[]): void => {
      const box: DOMRectReadOnly | undefined = entries[0]?.contentRect;
      if (box === undefined) return;
      this.skins.resize(Math.round(box.width), Math.round(box.height));
    });

    this.resizeObserver.observe(this.hostElement.nativeElement);

    effect((): void => {
      this.slotsChange.emit(this.slots());
    });
  }

  /**
   * Stops observing the host element.
   */
  public ngOnDestroy(): void {
    this.resizeObserver.disconnect();
  }

  /**
   * Walks the render tree accumulating offsets to find the media panes.
   *
   * @param node - Node to inspect
   * @param offsetLeft - Accumulated left offset of the node's parent
   * @param offsetTop - Accumulated top offset of the node's parent
   * @param found - Collector receiving the first pane of each kind
   */
  private collectSlots(
    node: SkinRenderNode,
    offsetLeft: number,
    offsetTop: number,
    found: {video: SkinSlotRect | null; effects: SkinSlotRect | null}
  ): void {
    const left: number = offsetLeft + node.left;
    const top: number = offsetTop + node.top;

    if (node.visible) {
      const rect: SkinSlotRect = {left, top, width: node.width, height: node.height};
      if (node.kind === 'video' && found.video === null) found.video = rect;
      if (node.kind === 'effects' && found.effects === null) found.effects = rect;
    }

    for (const child of node.children) {
      this.collectSlots(child, left, top, found);
    }
  }

  /**
   * Whether a node should act as a window drag handle.
   *
   * A skinned window is frameless, so there is no title bar to grab: the skin's
   * own background has to move the window, exactly as the original did.
   * Anything the user can operate is excluded, or its buttons and sliders would
   * drag the window instead of responding.
   *
   * @param node - Node being drawn
   * @returns True when dragging the node should move the window
   */
  public isDragRegion(node: SkinRenderNode): boolean {
    return node.kind === 'container' || node.kind === 'text' || node.kind === 'unsupported';
  }

  /**
   * Converts a skin's point-based font size to CSS pixels.
   *
   * @param points - Font size as the skin expresses it
   * @returns Equivalent size in pixels
   */
  public fontPixels(points: number): number {
    return points * POINTS_TO_PIXELS;
  }

  /**
   * Position of a slider's thumb along its track, in pixels.
   *
   * @param node - The slider node
   * @returns Offset of the thumb's leading edge
   */
  public thumbOffset(node: SkinRenderNode): number {
    const slider: SkinSliderState | null = node.slider;
    if (slider === null) return 0;

    const span: number = slider.maximum - slider.minimum;
    if (span <= 0) return 0;

    const fraction: number = Math.min(1, Math.max(0, (slider.value - slider.minimum) / span));
    const track: number = slider.horizontal ? node.width : node.height;
    const thumb: number = slider.horizontal ? slider.thumbWidth : slider.thumbHeight;
    const travel: number = Math.max(0, track - thumb);

    // A vertical slider's maximum sits at the top, which is the smaller
    // coordinate, so its travel runs the other way.
    return slider.horizontal ? fraction * travel : travel - fraction * travel;
  }

  /**
   * Records that the pointer entered or left an interactive node.
   *
   * @param node - Node the pointer moved over
   * @param inside - Whether the pointer is now over it
   */
  public onHover(node: SkinRenderNode, inside: boolean): void {
    const runtime: SkinRuntime | null = this.skins.current();
    if (runtime === null) return;

    runtime.setHovered(node.element, inside);
    if (!inside && node.kind === 'buttongroup') this.clearGroupHover(runtime, node);
  }

  /**
   * Clears hover state from every mapped child of a button group.
   *
   * @param runtime - The active runtime
   * @param node - The group the pointer left
   */
  private clearGroupHover(runtime: SkinRuntime, node: SkinRenderNode): void {
    for (const child of node.children) {
      runtime.setHovered(child.element, false);
      runtime.setPressed(child.element, false);
    }
  }

  /**
   * Resolves a pointer move over a button group against its mapping image.
   *
   * @param node - The group under the pointer
   * @param event - The pointer event
   */
  public onGroupMove(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    const runtime: SkinRuntime | null = this.skins.current();
    if (runtime === null) return;

    const bounds: DOMRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const hit: SkinElement | null = runtime.hitTest(
      node.element,
      event.clientX - bounds.left,
      event.clientY - bounds.top
    );

    for (const child of node.children) {
      runtime.setHovered(child.element, child.element === hit);
    }
  }

  /**
   * Dispatches a click on a button group to whichever mapped button was hit.
   *
   * @param node - The group that was clicked
   * @param event - The pointer event
   */
  public onGroupClick(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    const runtime: SkinRuntime | null = this.skins.current();
    if (runtime === null) return;

    const bounds: DOMRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const hit: SkinElement | null = runtime.hitTest(
      node.element,
      event.clientX - bounds.left,
      event.clientY - bounds.top
    );

    if (hit !== null) runtime.click(hit);
  }

  /**
   * Records a press or release on an interactive node.
   *
   * @param node - Node under the pointer
   * @param down - Whether the button is now held
   */
  public onPress(node: SkinRenderNode, down: boolean): void {
    this.skins.current()?.setPressed(node.element, down);
  }

  /**
   * Dispatches a click to the runtime.
   *
   * @param node - Node that was clicked
   */
  public onClick(node: SkinRenderNode): void {
    this.skins.current()?.click(node.element);
  }

  /**
   * Begins dragging a slider and applies the value under the pointer.
   *
   * @param node - The slider node
   * @param event - The pointer event
   */
  public onSliderDown(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragging.set(node);
    this.applySliderValue(node, event);
  }

  /**
   * Tracks a slider drag.
   *
   * @param node - The slider node
   * @param event - The pointer event
   */
  public onSliderMove(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    if (this.dragging() !== node) return;
    this.applySliderValue(node, event);
  }

  /**
   * Ends a slider drag.
   *
   * @param event - The pointer event
   */
  public onSliderUp(event: Readonly<PointerEvent>): void {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    this.dragging.set(null);
  }

  /**
   * Maps a pointer position onto a slider's value and applies it.
   *
   * @param node - The slider node
   * @param event - The pointer event
   */
  private applySliderValue(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    const runtime: SkinRuntime | null = this.skins.current();
    const slider: SkinSliderState | null = node.slider;
    if (runtime === null || slider === null) return;

    const bounds: DOMRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const thumb: number = slider.horizontal ? slider.thumbWidth : slider.thumbHeight;
    const track: number = Math.max(1, (slider.horizontal ? bounds.width : bounds.height) - thumb);
    const offset: number = slider.horizontal
      ? event.clientX - bounds.left - thumb / 2
      : event.clientY - bounds.top - thumb / 2;

    const raw: number = Math.min(1, Math.max(0, offset / track));
    const fraction: number = slider.horizontal ? raw : 1 - raw;

    runtime.setSliderValue(node.element, slider.minimum + fraction * (slider.maximum - slider.minimum));
  }
}
