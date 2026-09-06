/**
 * @fileoverview Drives a loaded skin: layout, bindings, events and rendering.
 *
 * The runtime owns the live element tree and the loop that keeps it consistent.
 * That loop is a fixed-point iteration rather than a dependency graph: a pass
 * re-evaluates every bound attribute on every element, and passes repeat until
 * nothing changes or a ceiling is reached. Skins bind elements to each other
 * freely and often circularly - `btnAppFillTop.width` reads `svEntireApp.width`
 * which reads `view.width` - and settling by iteration handles that without
 * having to extract dependencies from arbitrary JScript.
 *
 * Geometry follows the original's alignment model, measured against a design
 * pass. Because a skin's layout is arbitrary JScript rather than something
 * readable off the markup, the only way to learn where the author put things is
 * to ask: the view is briefly set to the size the skin was drawn for, settled,
 * and walked, and every element's box recorded. Growth away from that size is
 * then distributed per `horizontalAlignment` and `verticalAlignment` - `left`
 * keeps an element put, `right` moves it by the parent's full growth, `center`
 * by half, `stretch` grows the element itself.
 *
 * Properties the skin computes are exempt: they were recalculated for the
 * current size already, and adjusting them again would count the resize twice.
 * Skins mix the two freely on one element, which is why the distinction has to
 * be made per property rather than per element.
 *
 * Rendering is a snapshot. Each settled pass produces an immutable tree of
 * {@link SkinRenderNode}, which is what the host component draws; nothing in
 * the template reaches back into the mutable element state.
 *
 * @module app/skin/skin-runtime
 */

import type {MediaPlayerService} from '../services/media-player.service';
import {SkinElement, type SkinElementHost, type SkinImageMetrics} from './skin-element';
import {SkinExpressionEngine, type SkinScriptError} from './skin-expression';
import {parseSkinDefinition, type SkinAttribute, type SkinDefinition, type SkinNode} from './wms-parser';
import {
  parseSkinColour,
  toCssColour,
  type SkinImage,
  type SkinImageService,
  type SkinRegionBounds,
} from './skin-image.service';
import {WmpObjectModel} from './wmp-object-model';

/**
 * The application's visualiser, as a skin's EFFECTS element drives it.
 *
 * Structurally satisfied by `AudioOutlet`, so the real outlet can be handed
 * straight in without the skin subsystem depending on the component.
 */
export interface SkinVisualiser {
  /** Advances to the next visualisation */
  readonly nextVisualization: () => void;
  /** Returns to the previous visualisation */
  readonly previousVisualization: () => void;
  /** Name of the visualisation now showing */
  readonly visualizationName: () => string;
  /** Category the current visualisation belongs to */
  readonly visualizationCategory: () => string;
}

/** How a render node should be drawn. */
export type SkinRenderKind =
  | 'container'
  | 'button'
  | 'buttongroup'
  | 'text'
  | 'slider'
  | 'video'
  | 'effects'
  | 'unsupported';

/** Text styling resolved for a TEXT-like element. */
export interface SkinTextStyle {
  /** Text to display, already resolved from value bindings */
  readonly content: string;
  /** CSS colour for the text */
  readonly colour: string;
  /** Font family as named by the skin */
  readonly fontFamily: string;
  /** Font size in CSS pixels, converted from the points skins express */
  readonly fontSize: number;
  /** Whether the skin asked for bold */
  readonly bold: boolean;
  /** Whether the skin asked for italic */
  readonly italic: boolean;
  /** CSS text alignment derived from the skin's justification */
  readonly align: string;
  /** Whether text wraps rather than clipping to one line */
  readonly wrap: boolean;
}

/** Resolved state of a SLIDER-like element. */
export interface SkinSliderState {
  /** Current value */
  readonly value: number;
  /** Lowest value the slider accepts */
  readonly minimum: number;
  /** Highest value the slider accepts */
  readonly maximum: number;
  /** Whether the slider runs horizontally */
  readonly horizontal: boolean;
  /** Thumb image URL, or null when not yet loaded */
  readonly thumbUrl: string | null;
  /** Thumb width in pixels */
  readonly thumbWidth: number;
  /** Thumb height in pixels */
  readonly thumbHeight: number;
}

/** An immutable snapshot of one element, ready to render. */
export interface SkinRenderNode {
  /** Stable key for template tracking */
  readonly key: string;
  /** The element this node was produced from */
  readonly element: SkinElement;
  /** How the node should be drawn */
  readonly kind: SkinRenderKind;
  /** Left offset within the parent, in pixels */
  readonly left: number;
  /** Top offset within the parent, in pixels */
  readonly top: number;
  /** Width in pixels */
  readonly width: number;
  /** Height in pixels */
  readonly height: number;
  /** Stacking order within the parent */
  readonly zIndex: number;
  /** Opacity in the range 0-1, from the skin's alphaBlend */
  readonly opacity: number;
  /** Whether the element is drawn at all */
  readonly visible: boolean;
  /** Whether the element responds to input */
  readonly enabled: boolean;
  /** Whether pointer events pass through to what is beneath */
  readonly passthrough: boolean;
  /** Whether the node responds to a click rather than dragging the window */
  readonly interactive: boolean;
  /** CSS cursor for the element */
  readonly cursor: string;
  /** Tooltip text, empty when the skin gives none */
  readonly tooltip: string;
  /** CSS background colour, or null for transparent */
  readonly backgroundColour: string | null;
  /** Background image URL, or null when absent or not yet loaded */
  readonly backgroundImage: string | null;
  /** Whether the background image tiles rather than stretching */
  readonly tiled: boolean;
  /** Text styling, present only for text nodes */
  readonly text: SkinTextStyle | null;
  /** Slider state, present only for slider nodes */
  readonly slider: SkinSliderState | null;
  /** Child nodes in stacking order */
  readonly children: readonly SkinRenderNode[];
}

/**
 * An element's geometry as it is at the skin's design size.
 *
 * This is the reference the alignment model measures growth against, captured
 * by running the skin's own layout at the size it was drawn for.
 */
interface SkinDesignBox {
  /** Parent's width at the design size */
  readonly parentWidth: number;
  /** Parent's height at the design size */
  readonly parentHeight: number;
  /** Element's left offset at the design size */
  readonly left: number;
  /** Element's top offset at the design size */
  readonly top: number;
  /** Element's width at the design size */
  readonly width: number;
  /** Element's height at the design size */
  readonly height: number;
}

/** Maximum layout passes before the runtime stops chasing a fixed point. */
const MAX_LAYOUT_PASSES: number = 8;

/** Fully opaque alpha, as skins express it. */
const ALPHA_OPAQUE: number = 255;

/** Upper bound of WMP's volume scale, which typed volume sliders span. */
const WMP_VOLUME_MAXIMUM: number = 100;

/** Default font size, in points, when a skin names none. */
const DEFAULT_FONT_SIZE: number = 8;

/** CSS reference pixels per inch, as the browser defines them. */
const PIXELS_PER_INCH: number = 96;

/** Typographic points per inch. */
const POINTS_PER_INCH: number = 72;

/** Points-to-pixels ratio, for the font sizes skins express in points. */
const POINTS_TO_PIXELS: number = PIXELS_PER_INCH / POINTS_PER_INCH;

/**
 * Line height used to give an unsized text element a height.
 *
 * Skins routinely state a TEXT's position and width but not its height, leaving
 * it to size to its own font the way a label does. Without this such an element
 * is zero pixels tall and draws nothing at all.
 */
const TEXT_LINE_HEIGHT: number = 1.25;

/** Fallback text colour when a skin names none. */
const DEFAULT_TEXT_COLOUR: string = '#000000';

/** Tags rendered as a bare container with an optional background. */
const CONTAINER_TAGS: ReadonlySet<string> = new Set<string>(['VIEW', 'SUBVIEW', 'BUTTONGROUP']);

/** Tags rendered as a clickable image with hover, down and disabled states. */
const BUTTON_TAGS: ReadonlySet<string> = new Set<string>([
  'BUTTON',
  'PLAYBUTTON',
  'PAUSEBUTTON',
  'STOPBUTTON',
  'REWBUTTON',
  'FFWDBUTTON',
  'NEXTBUTTON',
  'PREVBUTTON',
  'SHUFFLEBUTTON',
  'REPEATBUTTON',
  'MUTEBUTTON',
  'BUTTONELEMENT',
]);

/** Tags rendered as text. */
const TEXT_TAGS: ReadonlySet<string> = new Set<string>([
  'TEXT',
  'CURRENTPOSITIONTEXT',
  'DURATIONTEXT',
  'STATUSTEXT',
  'TRACKNAMETEXT',
]);

/** Tags rendered as a slider. */
const SLIDER_TAGS: ReadonlySet<string> = new Set<string>([
  'SLIDER',
  'SEEKSLIDER',
  'VOLUMESLIDER',
  'BALANCESLIDER',
  'CUSTOMSLIDER',
]);

/**
 * Transport actions implied by an element's tag.
 *
 * WMP's typed buttons carry their behaviour in the tag rather than in an
 * `onclick`, so a skin can write `<STOPBUTTON image="..."/>` and get a working
 * stop button. Elements that also declare an `onclick` run both, matching the
 * original.
 */
const IMPLICIT_ACTIONS: Readonly<Record<string, string>> = {
  PLAYBUTTON: 'play',
  PLAYELEMENT: 'play',
  PAUSEBUTTON: 'pause',
  PAUSEELEMENT: 'pause',
  STOPBUTTON: 'stop',
  STOPELEMENT: 'stop',
  NEXTBUTTON: 'next',
  NEXTELEMENT: 'next',
  PREVBUTTON: 'previous',
  PREVELEMENT: 'previous',
  REWBUTTON: 'previous',
  REWELEMENT: 'previous',
  FFWDBUTTON: 'next',
  FFWDELEMENT: 'next',
  MUTEBUTTON: 'mute',
  SHUFFLEBUTTON: 'shuffle',
  REPEATBUTTON: 'repeat',
};

/** Attributes holding a colour that keys transparency for this element's art. */
const TRANSPARENCY_ATTRIBUTE: string = 'transparencycolor';

/**
 * Everything needed to bring up a skin's runtime.
 *
 * @property skinId - Installed skin identifier, used for asset lookups
 * @property definitionSource - Decoded `.wms` text
 * @property scripts - Decoded script sources, keyed by lower-cased file name
 */
export interface SkinRuntimeSource {
  /** Installed skin identifier */
  readonly skinId: string;
  /** Decoded `.wms` text */
  readonly definitionSource: string;
  /** Decoded script sources, keyed by lower-cased file name */
  readonly scripts: Readonly<Record<string, string>>;
}

/**
 * A live skin: its element tree, its script namespace, and its render output.
 *
 * @example
 * const runtime = new SkinRuntime(source, player, images, () => redraw());
 * runtime.resize(670, 482);
 * const tree = runtime.render();
 */
export class SkinRuntime {
  /** Installed skin identifier, used for asset lookups */
  public readonly skinId: string;

  /** The parsed definition this runtime was built from */
  public readonly definition: SkinDefinition;

  /** Root element, corresponding to the definition's VIEW */
  public readonly root: SkinElement;

  /** Every element in the tree, in document order */
  private readonly elements: SkinElement[] = [];

  /** Named values script sees: the object model plus one entry per element id */
  private readonly bindings: Map<string, unknown> = new Map<string, unknown>();

  /** The script sandbox */
  private readonly engine: SkinExpressionEngine;

  /** The player object model published into the sandbox */
  private readonly model: WmpObjectModel;

  /** Image cache shared with the rest of the application */
  private readonly images: SkinImageService;

  /** Called when a settled layout pass has produced a new render tree */
  private readonly onRendered: () => void;

  /** Reaches the application's visualiser, which EFFECTS elements drive */
  private readonly visualiser: () => SkinVisualiser | null;

  /** The ambient `event` object JScript handlers read modifier keys from */
  private readonly eventState: Record<string, unknown> = {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    keyCode: 0,
    x: 0,
    y: 0,
  };

  /** Elements the pointer is currently over */
  private readonly hovered: Set<SkinElement> = new Set<SkinElement>();

  /** Elements the pointer is currently pressed on */
  private readonly pressed: Set<SkinElement> = new Set<SkinElement>();

  /** Each element's geometry at the skin's design size, keyed by element */
  private readonly designLayout: Map<SkinElement, SkinDesignBox> = new Map<SkinElement, SkinDesignBox>();

  /** Whether the design layout needs recapturing before the next render */
  private designLayoutStale: boolean = true;

  /** The size the skin was drawn for, taken from the VIEW's own markup */
  private readonly designViewSize: SkinImageMetrics;

  /** Asset names already requested, so a missing image is fetched once */
  private readonly requested: Set<string> = new Set<string>();

  /** Current view width in pixels */
  private width: number = 0;

  /** Current view height in pixels */
  private height: number = 0;


  /** Whether a layout pass is pending */
  private dirty: boolean = true;

  /** Handle of the scheduled settle, so repeated invalidation coalesces */
  private scheduled: number | null = null;

  /**
   * Builds and starts a skin runtime.
   *
   * Construction parses the definition, instantiates the tree, runs the skin's
   * scripts, and fires the view's `onload` handler - in that order, because the
   * scripts expect every element id to already resolve.
   *
   * @param source - The skin's identifier and decoded sources
   * @param player - Player service the object model drives
   * @param images - Shared image cache
   * @param onRendered - Called when a new render tree is available
   */
  public constructor(
    source: SkinRuntimeSource,
    player: MediaPlayerService,
    images: SkinImageService,
    onRendered: () => void,
    visualiser: () => SkinVisualiser | null = (): null => null
  ) {
    this.skinId = source.skinId;
    this.images = images;
    this.onRendered = onRendered;
    this.visualiser = visualiser;
    this.definition = parseSkinDefinition(source.definitionSource);
    this.model = new WmpObjectModel(player, (): void => this.invalidate());

    const host: SkinElementHost = {
      evaluate: (self: object, expression: string, context: string): unknown =>
        this.engine.evaluateFor(self, expression, context),
      execute: (self: object, statements: string, context: string): void =>
        this.engine.executeFor(self, statements, context),
      metrics: (assetName: string): SkinImageMetrics | null => this.metricsFor(assetName),
      invalidate: (): void => this.invalidate(),
      method: (element: SkinElement, name: string): ((...args: unknown[]) => unknown) | null =>
        this.elementMethod(element, name),
    };

    this.root = this.instantiate(this.definition.view, null, host);

    // JScript handlers read the ambient `event` object rather than taking a
    // parameter - this skin's visualisation buttons branch on `event.shiftKey`.
    // It has to be a real binding, because browsers define `window.event` and
    // an unclaimed name would resolve to that instead.
    this.bindings.set('event', this.eventState);
    this.designViewSize = {
      width: this.viewAttributeNumber('width'),
      height: this.viewAttributeNumber('height'),
    };
    this.publishModel();

    this.engine = new SkinExpressionEngine(this.bindings, this.orderedScripts(source.scripts));

    const onLoad: SkinAttribute | undefined = this.definition.view.attributes.get('onload');
    if (onLoad !== undefined) {
      this.engine.executeFor(this.root.scope, onLoad.value, 'view onload');
    }
  }

  /**
   * Orders the skin's scripts as the view's `scriptFile` attribute lists them.
   *
   * Order matters: later scripts call into earlier ones at load time. Files the
   * archive contains but the view never lists are appended, since some skins
   * rely on a file being present without declaring it.
   *
   * @param scripts - Decoded sources keyed by lower-cased file name
   * @returns Sources in load order
   */
  private orderedScripts(scripts: Readonly<Record<string, string>>): string[] {
    const remaining: Map<string, string> = new Map<string, string>(Object.entries(scripts));
    const ordered: string[] = [];

    for (const name of this.definition.scriptFiles) {
      const key: string = name.toLowerCase();
      const source: string | undefined = remaining.get(key);
      if (source === undefined) continue;
      ordered.push(source);
      remaining.delete(key);
    }

    // A definition naming `136.js` ships alongside a stray `136..js`; loading
    // the leftovers would define the same globals twice, so they are dropped
    // unless the skin declared no scripts at all.
    if (ordered.length === 0) ordered.push(...remaining.values());

    return ordered;
  }

  /**
   * Recursively instantiates an element and its children.
   *
   * @param node - Parsed node to instantiate
   * @param parent - Parent element, or null for the root
   * @param host - Services to give the new elements
   * @returns The instantiated element
   */
  private instantiate(node: SkinNode, parent: SkinElement | null, host: SkinElementHost): SkinElement {
    const element: SkinElement = new SkinElement(node, parent, host);
    this.elements.push(element);

    if (element.id !== null) {
      this.bindings.set(element.id, element.proxy);
    }

    for (const child of node.children) {
      element.children.push(this.instantiate(child, element, host));
    }

    return element;
  }

  /**
   * Republishes the player object model into the script namespace.
   *
   * The model rebuilds objects whose contents track player state, so this runs
   * at the start of every settle rather than once at construction.
   */
  private publishModel(): void {
    this.model.setViewSize(this.width, this.height);
    for (const [name, value] of this.model.bindings()) {
      this.bindings.set(name, value);
    }
  }

  /**
   * Reports a skin image's natural size, requesting a load if needed.
   *
   * @param assetName - Asset name as written in the definition
   * @returns The natural size, or null until the image has been decoded
   */
  private metricsFor(assetName: string): SkinImageMetrics | null {
    const metrics: SkinImageMetrics | null = this.images.metrics(this.skinId, assetName);
    if (metrics === null) this.request(assetName, null);
    return metrics;
  }

  /**
   * Ensures an asset is loaded, scheduling a re-layout when it arrives.
   *
   * @param assetName - Asset name as written in the definition
   * @param transparencyColour - Colour to key out, as written in the definition
   */
  private request(assetName: string, transparencyColour: string | null): void {
    const key: string = `${assetName.toLowerCase()}|${transparencyColour ?? ''}`;
    if (this.requested.has(key)) return;
    this.requested.add(key);

    void this.images.load(this.skinId, assetName, transparencyColour).then((): void => {
      // Art arriving changes intrinsic sizes, so both the live layout and the
      // design reference it is measured against are now out of date.
      this.designLayoutStale = true;
      this.invalidate();
    });
  }

  /**
   * Resolves an element's image URL, requesting the image if it is not cached.
   *
   * @param element - Element the image belongs to
   * @param assetName - Asset name, or a non-string when the property is unset
   * @returns The object URL, or null until the image has been decoded
   */
  private imageUrl(element: SkinElement, assetName: unknown): string | null {
    if (typeof assetName !== 'string' || assetName.trim() === '') return null;

    const transparency: unknown = this.inheritedTransparency(element);
    const colour: string | null = typeof transparency === 'string' ? transparency : null;
    const cached: SkinImage | null = this.images.cached(this.skinId, assetName, colour);

    if (cached === null) {
      this.request(assetName, colour);
      return null;
    }

    return cached.url;
  }

  /**
   * Finds the transparency colour governing an element's art.
   *
   * Skins routinely set `transparencyColor` once on a container and expect its
   * children's images to be keyed with it, so the lookup walks up the tree.
   *
   * @param element - Element to resolve the colour for
   * @returns The colour as written, or null when no ancestor names one
   */
  private inheritedTransparency(element: SkinElement): unknown {
    let current: SkinElement | null = element;

    while (current !== null) {
      const colour: unknown = current.read(TRANSPARENCY_ATTRIBUTE);
      if (typeof colour === 'string' && colour.trim() !== '') return colour;
      current = current.parent;
    }

    return null;
  }

  /**
   * Records the view's size and settles layout against it.
   *
   * @param width - View width in pixels
   * @param height - View height in pixels
   */
  public resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.invalidate();
  }

  /**
   * The size the definition was authored at, used as the initial window size.
   *
   * @returns Design width and height in pixels
   */
  public get designSize(): SkinImageMetrics {
    return this.designViewSize;
  }

  /**
   * The smallest size the skin's layout supports.
   *
   * Below this a skin's arithmetic starts producing negative widths, so the
   * window should not be allowed to shrink past it. Skins that state no
   * minimum are held at their design size.
   *
   * @returns Minimum width and height in pixels
   */
  public get minimumSize(): SkinImageMetrics {
    return {
      width: this.viewAttributeNumber('minwidth') || this.designViewSize.width,
      height: this.viewAttributeNumber('minheight') || this.designViewSize.height,
    };
  }

  /**
   * Reads a numeric attribute straight off the VIEW element's markup.
   *
   * The view's live `width` and `height` properties track the window, so the
   * size the skin was *drawn* for has to come from the definition rather than
   * from the element.
   *
   * @param name - Lower-cased attribute name
   * @returns The stated number, or 0 when absent or not numeric
   */
  private viewAttributeNumber(name: string): number {
    const attribute: SkinAttribute | undefined = this.definition.view.attributes.get(name);
    if (attribute === undefined) return 0;
    return Number(attribute.value) || 0;
  }

  /**
   * Marks layout stale and schedules a settle on the next frame.
   *
   * Handlers frequently change several properties in a row; coalescing means
   * one settle rather than one per assignment.
   */
  public invalidate(): void {
    this.dirty = true;
    if (this.scheduled !== null) return;

    this.scheduled = requestAnimationFrame((): void => {
      this.scheduled = null;
      this.settle();
      this.onRendered();
    });
  }

  /**
   * Runs layout passes until bindings stop changing.
   *
   * The pass ceiling is a guard against skins whose bindings genuinely
   * oscillate; stopping early leaves the tree at its last state rather than
   * spinning a frame away.
   */
  public settle(): void {
    if (!this.dirty) return;
    this.dirty = false;

    this.publishModel();

    for (let pass: number = 0; pass < MAX_LAYOUT_PASSES; pass++) {
      let changed: boolean = false;

      for (const element of this.elements) {
        if (this.evaluateBindings(element)) changed = true;
      }

      // Layout is part of the fixed point, not something applied afterwards.
      // Alignment changes an element's real width, and the skin reads those
      // widths: `svUpperRightCorner.left` is `jscript:svEntireApp.width-298`.
      // Adjusting only the rendered box would leave every such expression
      // computing against the design size no matter how big the window got.
      if (this.layoutPass(this.root, this.width, this.height)) changed = true;
      if (this.publishVisualiser()) changed = true;

      if (!changed) break;
    }
  }

  /**
   * Applies the alignment model down the tree, writing results into the
   * elements' own properties.
   *
   * Properties the skin computes are left alone: they were recalculated for the
   * current size by the binding pass, and adjusting them again would count the
   * resize twice. This skin states `horizontalAlignment="stretch"` *and*
   * `width="jscript:svEntireApp.width - left - 298"` on one element, so the
   * distinction has to be per property rather than per element.
   *
   * @param element - Element to lay out
   * @param parentWidth - Parent's current inner width
   * @param parentHeight - Parent's current inner height
   * @returns True when any property changed
   */
  private layoutPass(element: SkinElement, parentWidth: number, parentHeight: number): boolean {
    let changed: boolean = false;

    if (element === this.root) {
      // The view's size is the window's, and skins read it as `View1.width`.
      if (element.applyBinding('width', parentWidth)) changed = true;
      if (element.applyBinding('height', parentHeight)) changed = true;
    } else if (this.mappedRegion(element) === null) {
      changed = this.applyAlignment(element, parentWidth, parentHeight) || changed;
    }

    const size: SkinImageMetrics = this.effectiveSize(element);
    for (const child of element.children) {
      if (this.layoutPass(child, size.width, size.height)) changed = true;
    }

    return changed;
  }

  /**
   * Positions and sizes one element against its design box.
   *
   * @param element - Element to align
   * @param parentWidth - Parent's current inner width
   * @param parentHeight - Parent's current inner height
   * @returns True when any property changed
   */
  private applyAlignment(element: SkinElement, parentWidth: number, parentHeight: number): boolean {
    const design: SkinDesignBox | undefined = this.designLayout.get(element);
    if (design === undefined) return false;

    const deltaWidth: number = parentWidth - design.parentWidth;
    const deltaHeight: number = parentHeight - design.parentHeight;
    const horizontal: string = String(element.read('horizontalalignment') ?? 'left').toLowerCase();
    const vertical: string = String(element.read('verticalalignment') ?? 'top').toLowerCase();

    let changed: boolean = false;

    if (!element.isDerived('left')) {
      let left: number = design.left;
      if (horizontal === 'right') left = design.left + deltaWidth;
      else if (horizontal === 'center') left = design.left + deltaWidth / 2;
      if (element.applyBinding('left', left)) changed = true;
    }

    if (horizontal === 'stretch' && !element.isDerived('width')) {
      if (element.applyBinding('width', design.width + deltaWidth)) changed = true;
    }

    if (!element.isDerived('top')) {
      let top: number = design.top;
      if (vertical === 'bottom') top = design.top + deltaHeight;
      else if (vertical === 'center') top = design.top + deltaHeight / 2;
      if (element.applyBinding('top', top)) changed = true;
    }

    if (vertical === 'stretch' && !element.isDerived('height')) {
      if (element.applyBinding('height', design.height + deltaHeight)) changed = true;
    }

    return changed;
  }

  /**
   * The size an element's children are laid out against.
   *
   * An element that states no size takes its art's, which is how most of a
   * skin's containers get their dimensions.
   *
   * @param element - Element to measure
   * @returns The element's effective inner size
   */
  private effectiveSize(element: SkinElement): SkinImageMetrics {
    const stated: SkinImageMetrics = {
      width: Number(element.read('width')) || 0,
      height: Number(element.read('height')) || 0,
    };
    if (stated.width > 0 && stated.height > 0) return stated;

    const metrics: SkinImageMetrics | null = this.artMetrics(element);
    return {
      width: stated.width > 0 ? stated.width : (metrics?.width ?? 0),
      height: stated.height > 0 ? stated.height : (metrics?.height ?? 0),
    };
  }

  /**
   * Re-evaluates every bound attribute on one element.
   *
   * @param element - Element to update
   * @returns True when any property's value changed
   */
  private evaluateBindings(element: SkinElement): boolean {
    let changed: boolean = false;

    for (const [name, attribute] of element.node.attributes) {
      if (attribute.kind !== 'jscript' && attribute.kind !== 'wmpprop') continue;

      // A `wmpprop:` value is a property path, which evaluates identically to
      // the expression it spells - the prefix only marks it as one-way.
      const value: unknown = this.engine.evaluateFor(
        element.scope,
        attribute.value,
        `${element.describe()}.${name}`
      );

      if (value === undefined) continue;
      if (element.applyBinding(name, value)) changed = true;
    }

    return changed;
  }

  /**
   * Classifies an element for rendering.
   *
   * @param element - Element to classify
   * @returns How the element should be drawn
   */
  private kindOf(element: SkinElement): SkinRenderKind {
    if (element.tag === 'BUTTONGROUP') return 'buttongroup';
    if (CONTAINER_TAGS.has(element.tag)) return 'container';
    if (BUTTON_TAGS.has(element.tag) || element.tag.endsWith('ELEMENT')) return 'button';
    if (TEXT_TAGS.has(element.tag)) return 'text';
    if (SLIDER_TAGS.has(element.tag)) return 'slider';
    if (element.tag === 'VIDEO') return 'video';
    if (element.tag === 'EFFECTS') return 'effects';
    return 'unsupported';
  }

  /**
   * Chooses the image an element should currently display.
   *
   * Precedence follows the original: disabled beats pressed, pressed beats
   * hovered, and a sticky button that is down uses its down art even when the
   * pointer is elsewhere.
   *
   * @param element - Element to choose art for
   * @returns Asset name, or a non-string when the element has no art
   */
  private buttonImage(element: SkinElement): unknown {
    const enabled: boolean = element.read('enabled') !== false;
    const down: boolean = element.read('down') === true || this.pressed.has(element);
    const hover: boolean = this.hovered.has(element);

    if (!enabled) {
      const disabled: unknown = element.read('disabledimage');
      if (typeof disabled === 'string' && disabled !== '') return disabled;
    }

    if (down && hover) {
      const hoverDown: unknown = element.read('hoverdownimage');
      if (typeof hoverDown === 'string' && hoverDown !== '') return hoverDown;
    }

    if (down) {
      const downImage: unknown = element.read('downimage');
      if (typeof downImage === 'string' && downImage !== '') return downImage;
    }

    if (hover) {
      const hoverImage: unknown = element.read('hoverimage');
      if (typeof hoverImage === 'string' && hoverImage !== '') return hoverImage;
    }

    return element.read('image');
  }

  /**
   * Resolves the text a text element should display.
   *
   * `res://` references point into Windows resource DLLs this application does
   * not ship, so they resolve to nothing rather than to their own URL. Position
   * and duration elements ignore `value` and report the clock instead.
   *
   * @param element - Element to resolve text for
   * @returns The text to draw
   */
  private textContent(element: SkinElement): string {
    if (element.tag === 'CURRENTPOSITIONTEXT' || element.tag === 'DURATIONTEXT') {
      const path: string =
        element.tag === 'CURRENTPOSITIONTEXT'
          ? 'player.controls.currentPositionString'
          : 'player.currentMedia ? player.currentMedia.durationString : ""';
      const value: unknown = this.engine.evaluate(path, `${element.describe()} clock`);
      return typeof value === 'string' ? value : '';
    }

    const value: unknown = element.read('value');
    if (typeof value !== 'string') return value === undefined || value === null ? '' : String(value);
    if (value.toLowerCase().startsWith('res://')) return '';
    return value;
  }

  /**
   * Builds the text styling for a text element.
   *
   * @param element - Element to style
   * @returns Resolved text style
   */
  private textStyle(element: SkinElement): SkinTextStyle {
    const style: string = String(element.read('fontstyle') ?? '').toLowerCase();
    const colour: number | null = parseSkinColour(String(element.read('foregroundcolor') ?? ''));
    const justification: string = String(element.read('justification') ?? 'left').toLowerCase();

    return {
      content: this.textContent(element),
      colour: colour === null ? DEFAULT_TEXT_COLOUR : toCssColour(colour),
      fontFamily: String(element.read('fontface') ?? 'Tahoma'),
      fontSize: (Number(element.read('fontsize')) || DEFAULT_FONT_SIZE) * POINTS_TO_PIXELS,
      bold: style.includes('bold'),
      italic: style.includes('italic'),
      align: justification === 'right' || justification === 'center' ? justification : 'left',
      wrap: element.read('wordwrap') === true,
    };
  }

  /**
   * Builds the state of a slider element.
   *
   * Typed sliders take their range from what they control rather than from
   * `min`/`max`, which skins omit for them.
   *
   * @param element - Element to resolve
   * @returns Resolved slider state
   */
  private sliderState(element: SkinElement): SkinSliderState {
    const thumbName: unknown = this.hovered.has(element)
      ? (element.read('thumbhoverimage') ?? element.read('thumbimage'))
      : element.read('thumbimage');
    const thumbUrl: string | null = this.imageUrl(element, thumbName);
    const thumbMetrics: SkinImageMetrics | null =
      typeof thumbName === 'string' ? this.images.metrics(this.skinId, thumbName) : null;

    const bounds: {minimum: number; maximum: number; value: number} = this.sliderRange(element);

    return {
      value: bounds.value,
      minimum: bounds.minimum,
      maximum: bounds.maximum,
      horizontal: String(element.read('direction') ?? 'horizontal').toLowerCase() !== 'vertical',
      thumbUrl,
      thumbWidth: thumbMetrics?.width ?? 0,
      thumbHeight: thumbMetrics?.height ?? 0,
    };
  }

  /**
   * Resolves a slider's range and current value.
   *
   * @param element - Slider to resolve
   * @returns Minimum, maximum and current value
   */
  private sliderRange(element: SkinElement): {minimum: number; maximum: number; value: number} {
    if (element.tag === 'SEEKSLIDER') {
      const duration: unknown = this.engine.evaluate('player.currentMedia ? player.currentMedia.duration : 0', 'seek range');
      const position: unknown = this.engine.evaluate('player.controls.currentPosition', 'seek position');
      return {
        minimum: 0,
        maximum: Number(duration) || 0,
        value: Number(position) || 0,
      };
    }

    if (element.tag === 'VOLUMESLIDER') {
      const volume: unknown = this.engine.evaluate('player.settings.volume', 'volume');
      return {minimum: 0, maximum: WMP_VOLUME_MAXIMUM, value: Number(volume) || 0};
    }

    return {
      minimum: Number(element.read('min')) || 0,
      maximum: Number(element.read('max')) || 0,
      value: Number(element.read('value')) || 0,
    };
  }

  /**
   * Reads an element's laid-out box.
   *
   * Alignment has already been applied during settle, into the element's own
   * properties, so this is a read rather than a calculation. The exception is a
   * BUTTONELEMENT, which states no geometry at all: it occupies whichever
   * region of its group's mapping image carries its `mappingColor`.
   *
   * @param element - Element to place
   * @returns The element's box within its parent
   */
  private geometry(element: SkinElement): {left: number; top: number; width: number; height: number} {
    const region: {left: number; top: number; width: number; height: number} | null =
      this.mappedRegion(element);
    if (region !== null) return region;

    return {
      left: Number(element.read('left')) || 0,
      top: Number(element.read('top')) || 0,
      width: Number(element.read('width')) || 0,
      height: Number(element.read('height')) || 0,
    };
  }

  /**
   * Backs a method a skin calls on an element, where the application has one.
   *
   * Only the EFFECTS element has real behaviour: its next and previous drive
   * the application's own visualiser, which is what the skin's visualisation
   * buttons ultimately call. Everything else falls back to an inert method.
   *
   * @param element - Element the method was called on
   * @param name - Method name as script spelled it
   * @returns An implementation, or null to fall back
   */
  private elementMethod(element: SkinElement, name: string): ((...args: unknown[]) => unknown) | null {
    if (element.tag !== 'EFFECTS') return null;

    const visualiser: SkinVisualiser | null = this.visualiser();
    if (visualiser === null) return null;

    // `nextEffect`/`previousEffect` step whole effect plugins rather than
    // presets within one; with a single visualiser they are the same move.
    const lowered: string = name.toLowerCase();
    if (lowered === 'next' || lowered === 'nexteffect') {
      return (): void => {
        visualiser.nextVisualization();
        this.invalidate();
      };
    }
    if (lowered === 'previous' || lowered === 'previouseffect') {
      return (): void => {
        visualiser.previousVisualization();
        this.invalidate();
      };
    }

    return null;
  }

  /**
   * Publishes the current visualisation onto the skin's EFFECTS elements.
   *
   * A skin reads the running effect's name off the element and shows it in its
   * own caption strip, so writing it through the ordinary binding path also
   * fires the `currentPresetTitle_onchange` handler the skin uses to do that.
   *
   * @returns True when anything changed
   */
  private publishVisualiser(): boolean {
    const visualiser: SkinVisualiser | null = this.visualiser();
    if (visualiser === null) return false;

    const title: string = visualiser.visualizationName();
    const category: string = visualiser.visualizationCategory();
    let changed: boolean = false;

    for (const element of this.elements) {
      if (element.tag !== 'EFFECTS') continue;
      if (element.applyBinding('currenteffecttype', category)) changed = true;
      if (element.applyBinding('currentpresettitle', title)) changed = true;
    }

    return changed;
  }

  /**
   * Finds the mapping image a button group hit-tests against.
   *
   * @param group - The button group
   * @returns The mapping image's asset name, or null when it declares none
   */
  private mappingImageOf(group: SkinElement): string | null {
    const mapping: unknown = group.read('mappingimage');
    if (typeof mapping !== 'string' || mapping.trim() === '') return null;

    // Hit testing reads raw pixels, so the mapping image must be decoded even
    // though it is never drawn.
    this.request(mapping, null);
    return mapping;
  }

  /**
   * Resolves the box a mapped button element occupies within its group.
   *
   * @param element - Element that may claim a mapping colour
   * @returns The element's box, or null when it is not a mapped element
   */
  private mappedRegion(
    element: SkinElement
  ): {left: number; top: number; width: number; height: number} | null {
    const group: SkinElement | null = element.parent;
    if (group === null || group.tag !== 'BUTTONGROUP') return null;

    const colour: number | null = parseSkinColour(String(element.read('mappingcolor') ?? ''));
    if (colour === null) return null;

    const mapping: string | null = this.mappingImageOf(group);
    if (mapping === null) return null;

    const bounds: SkinRegionBounds | null = this.images.regionBounds(this.skinId, mapping, colour);
    if (bounds === null) return null;

    return {left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height};
  }

  /**
   * Finds which mapped element of a button group lies under a point.
   *
   * @param group - The button group the pointer is over
   * @param x - Pointer position within the group, in pixels
   * @param y - Pointer position within the group, in pixels
   * @returns The element claiming that pixel's colour, or null when none does
   */
  public hitTest(group: SkinElement, x: number, y: number): SkinElement | null {
    const mapping: string | null = this.mappingImageOf(group);
    if (mapping === null) return null;

    const colour: number | null = this.images.pixelAt(this.skinId, mapping, x, y);
    if (colour === null) return null;

    for (const child of group.children) {
      const claimed: number | null = parseSkinColour(String(child.read('mappingcolor') ?? ''));
      if (claimed !== null && claimed === colour) return child;
    }

    return null;
  }

  /**
   * Builds the render tree for the current state.
   *
   * @returns An immutable snapshot of the whole view
   */
  public render(): SkinRenderNode {
    if (this.designLayoutStale) this.captureDesignLayout();
    return this.renderElement(this.root, this.width, this.height, 0);
  }

  /**
   * Records every element's geometry as it is at the skin's design size.
   *
   * Alignment needs to know where the author put things, and the only way to
   * find that out is to ask the skin at the size it was drawn for: its layout
   * is arbitrary JScript, not something that can be read off the markup. So the
   * view is briefly set to the design size, settled, walked, and set back.
   *
   * Doing it deliberately rather than baselining whichever render happened to
   * come first is what makes resize behave. Art loads asynchronously, and a
   * baseline taken before it arrives captures zeroes; one taken after the user
   * has already resized captures the wrong size. Either way every later offset
   * is wrong by that much, which is what tore this skin's chrome apart.
   */
  private captureDesignLayout(): void {
    const design: SkinImageMetrics = this.designSize;
    if (design.width <= 0 || design.height <= 0) return;

    const actualWidth: number = this.width;
    const actualHeight: number = this.height;

    this.width = design.width;
    this.height = design.height;
    this.dirty = true;
    this.settle();

    this.designLayout.clear();
    this.recordDesignBox(this.root, design.width, design.height);

    this.width = actualWidth;
    this.height = actualHeight;
    this.dirty = true;
    this.settle();

    this.designLayoutStale = false;
  }

  /**
   * Walks the tree recording each element's box at the design size.
   *
   * @param element - Element to record
   * @param parentWidth - Design width of the element's parent
   * @param parentHeight - Design height of the element's parent
   */
  private recordDesignBox(element: SkinElement, parentWidth: number, parentHeight: number): void {
    const isRoot: boolean = element === this.root;
    const left: number = isRoot ? 0 : Number(element.read('left')) || 0;
    const top: number = isRoot ? 0 : Number(element.read('top')) || 0;
    const stated: {width: number; height: number} = {
      width: isRoot ? parentWidth : Number(element.read('width')) || 0,
      height: isRoot ? parentHeight : Number(element.read('height')) || 0,
    };

    const metrics: SkinImageMetrics | null = this.artMetrics(element);
    const width: number = stated.width > 0 ? stated.width : (metrics?.width ?? 0);
    const height: number = stated.height > 0 ? stated.height : (metrics?.height ?? 0);

    this.designLayout.set(element, {parentWidth, parentHeight, left, top, width, height});

    for (const child of element.children) {
      this.recordDesignBox(child, width, height);
    }
  }

  /**
   * Natural size of whichever image currently sizes an element.
   *
   * @param element - Element to measure
   * @returns The art's natural size, or null when it has none loaded
   */
  private artMetrics(element: SkinElement): SkinImageMetrics | null {
    const name: unknown = element.read('backgroundimage') ?? element.read('image');
    if (typeof name !== 'string' || name.trim() === '') return null;
    return this.images.metrics(this.skinId, name);
  }

  /**
   * Builds one render node and its descendants.
   *
   * @param element - Element to snapshot
   * @param parentWidth - Parent's current inner width
   * @param parentHeight - Parent's current inner height
   * @param index - Position among siblings, used to build a stable key
   * @returns The render node
   */
  private renderElement(
    element: SkinElement,
    parentWidth: number,
    parentHeight: number,
    index: number
  ): SkinRenderNode {
    const kind: SkinRenderKind = this.kindOf(element);
    const box: {left: number; top: number; width: number; height: number} =
      element === this.root
        ? {left: 0, top: 0, width: parentWidth, height: parentHeight}
        : this.geometry(element);

    // A button group's visible art is its `image`; its `mappingImage` is never
    // drawn, only sampled for hit testing.
    const backgroundName: unknown =
      kind === 'buttongroup'
        ? (element.read('image') ?? element.read('backgroundimage'))
        : kind === 'button'
          ? this.buttonImage(element)
          : element.read('backgroundimage');
    const backgroundImage: string | null = this.imageUrl(element, backgroundName);

    // VIDEO and EFFECTS are holes for the application's own panes, not things
    // the skin draws. Their declared backgroundColor is what the original
    // painted *behind* live content - the WMP8 skin names yellow - so honouring
    // it here just puts a yellow rectangle where the visualiser should be.
    const isSlot: boolean = kind === 'video' || kind === 'effects';
    const backgroundColour: number | null = isSlot
      ? null
      : parseSkinColour(String(element.read('backgroundcolor') ?? ''));

    // A button whose art is loaded but whose size was never stated takes the
    // art's size, which is how most skin buttons are declared.
    const imageMetrics: SkinImageMetrics | null =
      typeof backgroundName === 'string' ? this.images.metrics(this.skinId, backgroundName) : null;
    const text: SkinTextStyle | null = kind === 'text' ? this.textStyle(element) : null;

    const width: number = box.width > 0 ? box.width : (imageMetrics?.width ?? 0);
    let height: number = box.height > 0 ? box.height : (imageMetrics?.height ?? 0);

    // A label sizes to its font. Skins state a TEXT's position and width and
    // leave the height out - the track name over this skin's visualiser is
    // declared that way - and a zero-height box draws nothing.
    if (height <= 0 && text !== null) {
      height = Math.ceil(text.fontSize * TEXT_LINE_HEIGHT);
    }

    // A node is interactive if it is a control or the skin gave it a handler.
    // Everything else is inert art, and in a frameless window inert art is what
    // drags the window.
    const interactive: boolean =
      kind === 'button' ||
      kind === 'buttongroup' ||
      kind === 'slider' ||
      element.node.attributes.has('onclick') ||
      element.node.attributes.has('ondblclick');

    const alpha: number = Number(element.read('alphablend'));
    const children: SkinRenderNode[] = element.children.map(
      (child: SkinElement, childIndex: number): SkinRenderNode =>
        this.renderElement(child, width, height, childIndex)
    );

    return {
      key: `${element.id ?? element.tag}-${index}`,
      element,
      kind,
      left: box.left,
      top: box.top,
      width,
      height,
      zIndex: Number(element.read('zindex')) || 0,
      opacity: Number.isFinite(alpha) ? alpha / ALPHA_OPAQUE : 1,
      visible: element.read('visible') !== false,
      enabled: element.read('enabled') !== false,
      // A label with no handler must not swallow what is underneath it: skins
      // lay captions over the buttons they describe, and a caption that took
      // the press would leave the button dead and drag the window instead.
      passthrough: element.read('passthrough') === true || (kind === 'text' && !interactive),
      interactive,
      cursor: this.cursorFor(element, kind),
      tooltip: this.tooltipFor(element),
      backgroundColour: backgroundColour === null ? null : toCssColour(backgroundColour),
      backgroundImage,
      tiled: element.read('tiled') === true || element.read('backgroundtiled') === true,
      text,
      slider: kind === 'slider' ? this.sliderState(element) : null,
      children,
    };
  }

  /**
   * Chooses the CSS cursor for an element.
   *
   * @param element - Element to resolve
   * @param kind - How the element is drawn
   * @returns A CSS cursor value
   */
  private cursorFor(element: SkinElement, kind: SkinRenderKind): string {
    const declared: string = String(element.read('cursor') ?? '').toLowerCase();
    if (declared === 'hand' || declared === 'player') return 'pointer';
    if (declared === 'system' || declared === 'arrow') return 'default';
    if (declared !== '') return 'default';
    return kind === 'button' || kind === 'slider' ? 'pointer' : 'default';
  }

  /**
   * Chooses the tooltip text for an element.
   *
   * Sticky buttons carry separate up and down tooltips; unresolvable `res://`
   * references produce no tooltip at all.
   *
   * @param element - Element to resolve
   * @returns Tooltip text, empty when there is none to show
   */
  private tooltipFor(element: SkinElement): string {
    const down: boolean = element.read('down') === true;
    const candidates: readonly unknown[] = [
      down ? element.read('downtooltip') : element.read('uptooltip'),
      element.read('tooltip'),
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.trim() === '') continue;
      if (candidate.toLowerCase().startsWith('res://')) continue;
      return candidate;
    }

    return '';
  }

  /**
   * Records that the pointer entered or left an element.
   *
   * @param element - Element under the pointer
   * @param inside - Whether the pointer is now over it
   */
  public setHovered(element: SkinElement, inside: boolean): void {
    if (inside === this.hovered.has(element)) return;

    if (inside) this.hovered.add(element);
    else this.hovered.delete(element);

    this.invalidate();
  }

  /**
   * Records that the pointer was pressed or released on an element.
   *
   * @param element - Element the pointer is on
   * @param down - Whether the button is now held
   */
  public setPressed(element: SkinElement, down: boolean): void {
    if (down) this.pressed.add(element);
    else this.pressed.delete(element);
    this.invalidate();
  }

  /**
   * Handles a click on an element.
   *
   * A sticky button toggles its own `down` state first, because its `onclick`
   * reads that state - `player.settings.setMode('loop', down)` is the standard
   * idiom and depends on `down` already reflecting the click.
   *
   * @param element - Element that was clicked
   * @param event - The originating pointer event, for the modifier keys
   *                handlers read off the ambient `event` object
   */
  public click(element: SkinElement, event?: Readonly<MouseEvent>): void {
    if (element.read('enabled') === false) return;

    this.eventState['shiftKey'] = event?.shiftKey ?? false;
    this.eventState['ctrlKey'] = event?.ctrlKey ?? false;
    this.eventState['altKey'] = event?.altKey ?? false;
    this.eventState['x'] = event?.offsetX ?? 0;
    this.eventState['y'] = event?.offsetY ?? 0;

    if (element.read('sticky') === true) {
      element.write('down', element.read('down') !== true);
    }

    const action: string | undefined = IMPLICIT_ACTIONS[element.tag];
    if (action !== undefined) this.runImplicitAction(action);

    const handler: SkinAttribute | undefined = element.node.attributes.get('onclick');
    if (handler !== undefined) {
      this.engine.executeFor(element.scope, handler.value, `${element.describe()}.onclick`);
    }

    this.invalidate();
  }

  /**
   * Runs the transport action implied by a typed element's tag.
   *
   * @param action - Action name from the implicit action table
   */
  private runImplicitAction(action: string): void {
    const statements: Readonly<Record<string, string>> = {
      play: 'player.controls.play();',
      pause: 'player.controls.pause();',
      stop: 'player.controls.stop();',
      next: 'player.controls.next();',
      previous: 'player.controls.previous();',
      mute: 'player.settings.mute = !player.settings.mute;',
      shuffle: "player.settings.setMode('shuffle', !player.settings.getMode('shuffle'));",
      repeat: "player.settings.setMode('loop', !player.settings.getMode('loop'));",
    };

    const source: string | undefined = statements[action];
    if (source !== undefined) this.engine.execute(source, `implicit ${action}`);
  }

  /**
   * Applies a new value to a slider the user has dragged.
   *
   * @param element - Slider being dragged
   * @param value - New value in the slider's own range
   */
  public setSliderValue(element: SkinElement, value: number): void {
    if (element.tag === 'SEEKSLIDER') {
      this.engine.execute(`player.controls.currentPosition = ${value};`, 'seek drag');
    } else if (element.tag === 'VOLUMESLIDER') {
      this.engine.execute(`player.settings.volume = ${value};`, 'volume drag');
    } else {
      element.write('value', value);
      const handler: SkinAttribute | undefined = element.node.attributes.get('value_onchange');
      if (handler !== undefined) {
        this.engine.executeFor(element.scope, handler.value, `${element.describe()}.value_onchange`);
      }
    }

    this.invalidate();
  }

  /**
   * Runs the view's `ontimer` handler, if it declares one.
   *
   * Skins use the timer to poll for metadata and transport changes they have no
   * event for; the interval comes from the view's `timerInterval` attribute.
   *
   * @returns The declared interval in milliseconds, or null when there is no timer
   */
  public timerInterval(): number | null {
    if (!this.definition.view.attributes.has('ontimer')) return null;
    const interval: number = Number(this.root.read('timerinterval'));
    return Number.isFinite(interval) && interval > 0 ? interval : null;
  }

  /**
   * Fires the view's timer handler.
   */
  public tick(): void {
    const handler: SkinAttribute | undefined = this.definition.view.attributes.get('ontimer');
    if (handler === undefined) return;
    this.engine.executeFor(this.root.scope, handler.value, 'view ontimer');
    this.invalidate();
  }

  /**
   * Every script failure recorded since the skin loaded.
   *
   * @returns Recorded errors, oldest first
   */
  public get errors(): readonly SkinScriptError[] {
    return this.engine.errors;
  }

  /**
   * Releases the runtime's scheduled work and cached art.
   */
  public destroy(): void {
    if (this.scheduled !== null) {
      cancelAnimationFrame(this.scheduled);
      this.scheduled = null;
    }
    this.images.evict(this.skinId);
  }
}
