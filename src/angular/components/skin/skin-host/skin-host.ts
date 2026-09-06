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
 * **Every pointer event is dispatched here, not by CSS.** Nodes overlap
 * heavily and nest deeply, so each handler claims its event and stops it
 * bubbling: without that, clicking a mapped button inside a BUTTONGROUP fires
 * it once directly and once more when the group hit-tests the same pixel.
 * Window dragging is done the same way rather than with `-webkit-app-region`,
 * whose regions are a flat painted union that ignores stacking - any drag
 * region painted later simply covered the holes punched for the buttons, and
 * nothing was clickable at all.
 *
 * **Button groups hit-test by colour.** A group draws one image and carries a
 * second, never-drawn mapping image whose flat colour regions identify its
 * buttons. Pointer moves over a group are resolved against that image rather
 * than against DOM geometry, so overlapping and non-rectangular buttons work
 * the way the skin author intended.
 *
 * **The media pane is drawn inside the tree, not over it.** A skin marks out
 * where the picture goes with VIDEO and EFFECTS elements, and the parent hands
 * in a template to fill it. It has to render at that node's own position in the
 * tree rather than being layered behind the skin: skin chrome is opaque and
 * overlaps the pane on every side - this one paints a black backdrop across the
 * whole screen area - so anything stacked underneath is simply covered.
 *
 * @module app/components/skin/skin-host
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  input,
  signal,
  type InputSignal,
  type Signal,
  type TemplateRef,
  type WritableSignal,
} from '@angular/core';
import {NgTemplateOutlet} from '@angular/common';
import {SkinService} from '../../../skin/skin.service';
import type {SkinElement} from '../../../skin/skin-element';
import type {SkinRenderNode, SkinRuntime, SkinSliderState} from '../../../skin/skin-runtime';

/**
 * Renders the active skin and routes input back into its runtime.
 *
 * @example
 * <!-- In a parent template -->
 * <app-skin-host [mediaTemplate]="visualiser" mediaKind="effects" />
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

  /** Where the pointer was when a window drag began, null when not dragging */
  private windowDrag: {pointerX: number; pointerY: number} | null = null;

  /** The active skin's render tree, or null when no skin is active */
  public readonly tree: Signal<SkinRenderNode | null> = this.skins.renderTree;

  /**
   * Content to draw in the pane the skin reserves for the picture.
   *
   * Rendered inside the skin's own tree rather than layered over it. A skin's
   * chrome is opaque and overlaps the pane on every side - this one paints a
   * black backdrop across the whole screen area - so anything stacked behind
   * the skin is simply covered. Placing it at the pane's own node gives it the
   * z-order the author intended.
   */
  public readonly mediaTemplate: InputSignal<TemplateRef<unknown> | null> =
    input<TemplateRef<unknown> | null>(null);

  /** Which of the skin's two panes the media should occupy */
  public readonly mediaKind: InputSignal<'video' | 'effects'> = input<'video' | 'effects'>('effects');

  /**
   * Keeps the skin's view size in step with the host element.
   */
  public constructor() {
    this.resizeObserver = new ResizeObserver((entries: readonly ResizeObserverEntry[]): void => {
      const box: DOMRectReadOnly | undefined = entries[0]?.contentRect;
      if (box === undefined) return;
      this.skins.resize(Math.round(box.width), Math.round(box.height));
    });

    this.resizeObserver.observe(this.hostElement.nativeElement);
  }

  /**
   * Whether a node is the pane the media should be drawn in.
   *
   * @param node - Node being drawn
   * @returns True when the media template belongs here
   */
  public isMediaPane(node: SkinRenderNode): boolean {
    return node.kind === this.mediaKind() && this.mediaTemplate() !== null;
  }

  /**
   * Stops observing the host element.
   */
  public ngOnDestroy(): void {
    this.resizeObserver.disconnect();
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
  private isDragRegion(node: SkinRenderNode): boolean {
    if (node.interactive) return false;
    return node.kind === 'container' || node.kind === 'text' || node.kind === 'unsupported';
  }

  /**
   * Handles a press on any node, claiming the event for the innermost one.
   *
   * Nodes nest, so an unclaimed press would be seen by every ancestor as it
   * bubbled - a button press would also start a window drag on the container
   * behind it.
   *
   * @param node - Node the pointer went down on
   * @param event - The pointer event
   */
  public onPointerDown(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    event.stopPropagation();

    if (node.kind === 'slider') {
      this.onSliderDown(node, event);
      return;
    }

    if (node.kind === 'buttongroup') {
      this.pressGroup(node, event, true);
      return;
    }

    if (this.isDragRegion(node)) {
      this.beginWindowDrag(event);
      return;
    }

    if (node.interactive) this.onPress(node, true);
  }

  /**
   * Handles a release on any node.
   *
   * @param node - Node the pointer came up on
   * @param event - The pointer event
   */
  public onPointerUp(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    event.stopPropagation();

    // Released unconditionally. A capture that outlives its gesture routes
    // every later pointer event to one element, which leaves the whole skin
    // dead to hover and clicks - so it must not depend on which branch below
    // happens to run.
    const target: HTMLElement = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }

    if (this.windowDrag !== null) {
      this.endWindowDrag();
      return;
    }

    if (node.kind === 'slider') {
      this.onSliderUp();
      return;
    }

    if (node.kind === 'buttongroup') {
      this.pressGroup(node, event, false);
      return;
    }

    if (node.interactive) this.onPress(node, false);
  }

  /**
   * Handles pointer movement over a node.
   *
   * @param node - Node the pointer is over
   * @param event - The pointer event
   */
  public onPointerMove(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    if (this.windowDrag !== null) {
      this.moveWindow(event);
      return;
    }

    if (node.kind === 'buttongroup') this.onGroupMove(node, event);
    if (node.kind === 'slider') this.onSliderMove(node, event);
  }

  /**
   * Handles a click on any node, claiming it for the innermost one.
   *
   * @param node - Node that was clicked
   * @param event - The pointer event
   */
  public onNodeClick(node: SkinRenderNode, event: Readonly<MouseEvent>): void {
    event.stopPropagation();

    if (node.kind === 'buttongroup') this.onGroupClick(node, event);
    else if (node.interactive) this.onClick(node, event);
  }

  /**
   * Starts moving the window with the pointer.
   *
   * The window's own position is recorded in the main process rather than read
   * back here: a round trip on pointerdown would resolve after the first moves
   * had already been sent, and the drag would jump.
   *
   * @param event - The pointer event that began the drag
   */
  private beginWindowDrag(event: Readonly<PointerEvent>): void {
    const bridge: typeof window.mediaPlayer = window.mediaPlayer;
    if (bridge === undefined) return;

    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.windowDrag = {pointerX: event.screenX, pointerY: event.screenY};
    void bridge.beginSkinWindowDrag();
  }

  /**
   * Moves the window to follow the pointer.
   *
   * @param event - The pointer event
   */
  private moveWindow(event: Readonly<PointerEvent>): void {
    const drag: {pointerX: number; pointerY: number} | null = this.windowDrag;
    if (drag === null) return;

    void window.mediaPlayer?.dragSkinWindowBy(
      event.screenX - drag.pointerX,
      event.screenY - drag.pointerY
    );
  }

  /**
   * Ends a window drag.
   */
  private endWindowDrag(): void {
    this.windowDrag = null;
    void window.mediaPlayer?.endSkinWindowDrag();
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
    if (!node.interactive) return;

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
   * Presses or releases whichever mapped button of a group is under the pointer.
   *
   * @param node - The group the pointer is on
   * @param event - The pointer event
   * @param down - Whether the button is now held
   */
  private pressGroup(node: SkinRenderNode, event: Readonly<PointerEvent>, down: boolean): void {
    const runtime: SkinRuntime | null = this.skins.current();
    if (runtime === null) return;

    if (!down) {
      for (const child of node.children) runtime.setPressed(child.element, false);
      return;
    }

    const hit: SkinElement | null = this.hitTestGroup(runtime, node, event);
    if (hit !== null) runtime.setPressed(hit, true);
  }

  /**
   * Finds which mapped button of a group a pointer event landed on.
   *
   * @param runtime - The active runtime
   * @param node - The group under the pointer
   * @param event - The pointer event
   * @returns The button hit, or null when the pointer is on no button
   */
  private hitTestGroup(
    runtime: SkinRuntime,
    node: SkinRenderNode,
    event: Readonly<MouseEvent>
  ): SkinElement | null {
    const bounds: DOMRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return runtime.hitTest(node.element, event.clientX - bounds.left, event.clientY - bounds.top);
  }

  /**
   * Resolves a pointer move over a button group against its mapping image.
   *
   * @param node - The group under the pointer
   * @param event - The pointer event
   */
  private onGroupMove(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    const runtime: SkinRuntime | null = this.skins.current();
    if (runtime === null) return;

    const hit: SkinElement | null = this.hitTestGroup(runtime, node, event);
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
  private onGroupClick(node: SkinRenderNode, event: Readonly<MouseEvent>): void {
    const runtime: SkinRuntime | null = this.skins.current();
    if (runtime === null) return;

    const hit: SkinElement | null = this.hitTestGroup(runtime, node, event);
    if (hit !== null) runtime.click(hit, event);
  }

  /**
   * Records a press or release on an interactive node.
   *
   * @param node - Node under the pointer
   * @param down - Whether the button is now held
   */
  private onPress(node: SkinRenderNode, down: boolean): void {
    this.skins.current()?.setPressed(node.element, down);
  }

  /**
   * Dispatches a click to the runtime.
   *
   * @param node - Node that was clicked
   * @param event - The originating pointer event
   */
  private onClick(node: SkinRenderNode, event: Readonly<MouseEvent>): void {
    this.skins.current()?.click(node.element, event);
  }

  /**
   * Begins dragging a slider and applies the value under the pointer.
   *
   * @param node - The slider node
   * @param event - The pointer event
   */
  private onSliderDown(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
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
  private onSliderMove(node: SkinRenderNode, event: Readonly<PointerEvent>): void {
    if (this.dragging() !== node) return;
    this.applySliderValue(node, event);
  }

  /**
   * Ends a slider drag.
   */
  private onSliderUp(): void {
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
