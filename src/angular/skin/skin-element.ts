/**
 * @fileoverview Runtime instance of a single element in a skin's UI tree.
 *
 * Each node the parser produced becomes one of these. An element owns the
 * resolved value of every property the skin can observe, and exposes them to
 * script through a Proxy so that `svEntireApp.width` reads the current layout
 * and `plDropDown.width = 175` writes it.
 *
 * Property values come from four places, in descending priority:
 *
 * 1. **A script assignment.** Once script writes a property, it stops tracking
 *    its `jscript:` binding. Skins rely on this - a handler that sets a width
 *    expects the width to stay set.
 * 2. **A `jscript:` or `wmpprop:` binding**, re-evaluated on each layout pass.
 * 3. **A literal attribute** from the definition.
 * 4. **An intrinsic value**, most importantly the natural size of a background
 *    or foreground image, which is how an unsized SUBVIEW gets its dimensions.
 *
 * Property names are matched case-insensitively throughout: the markup writes
 * `alphablend` where script writes `alphaBlend`, and the original runtime
 * treated them as one name.
 *
 * @module app/skin/skin-element
 */

import type {SkinAttribute, SkinNode} from './wms-parser';

/** Natural dimensions of a loaded skin image. */
export interface SkinImageMetrics {
  /** Image width in pixels */
  readonly width: number;
  /** Image height in pixels */
  readonly height: number;
}

/**
 * Services an element needs from the runtime that owns it.
 *
 * @property evaluate - Evaluates a `jscript:` expression in the skin's namespace
 * @property execute - Runs a handler's statement list in the skin's namespace
 * @property metrics - Natural size of a named skin image, or null if not loaded
 * @property invalidate - Signals that a property changed and a layout pass is needed
 */
export interface SkinElementHost {
  /** Evaluates an expression in the skin's namespace, scoped to an element */
  readonly evaluate: (self: object, source: string, context: string) => unknown;
  /** Runs a statement list in the skin's namespace, scoped to an element */
  readonly execute: (self: object, source: string, context: string) => void;
  /** Natural size of a named skin image, or null when not yet loaded */
  readonly metrics: (assetName: string) => SkinImageMetrics | null;
  /** Signals that something changed and a layout pass should be scheduled */
  readonly invalidate: () => void;
}

/** Properties whose default value is the natural width of the element's image. */
const IMAGE_SIZED_PROPERTIES: ReadonlySet<string> = new Set<string>(['width', 'height']);

/** Attributes naming an image whose natural size can size the element. */
const SIZING_IMAGE_ATTRIBUTES: readonly string[] = ['backgroundimage', 'image', 'thumbimage'];

/** Fully opaque alpha value, as skins express it. */
const ALPHA_OPAQUE: number = 255;

/** Property defaults applied when the definition and intrinsics supply nothing. */
const PROPERTY_DEFAULTS: Readonly<Record<string, unknown>> = {
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  zindex: 0,
  visible: true,
  enabled: true,
  alphablend: ALPHA_OPAQUE,
  passthrough: false,
  tabstop: true,
  tiled: false,
  backgroundtiled: false,
  sticky: false,
  down: false,
  horizontalalignment: 'left',
  verticalalignment: 'top',
};

/**
 * Methods skins call on elements that this runtime does not model.
 *
 * Most are animation helpers and list mutators belonging to element types the
 * spike does not render. They resolve to no-ops rather than to `undefined`
 * because they are called mid-handler, and a TypeError there would abandon
 * whatever the handler was going on to do.
 */
const INERT_METHODS: readonly string[] = [
  // Animation
  'alphaBlendTo',
  'moveTo',
  'moveToAnimate',
  'cancelAnimation',
  // Focus and window control
  'setFocus',
  'close',
  'minimize',
  'maximize',
  'restore',
  // List and popup contents
  'appendItem',
  'insertItem',
  'deleteItem',
  'removeItem',
  'setItemText',
  'getItemText',
  'findItem',
  'selectItem',
  'clear',
  'show',
  'hide',
];

/**
 * Coerces a skin attribute's literal text into the type its property expects.
 *
 * Skins write booleans as `"true"`/`"false"`, numbers as bare digits, and
 * colours as `#RRGGBB` or a colour name. Anything that is not recognisably a
 * boolean or a number stays a string.
 *
 * @param value - Literal attribute text
 * @returns The coerced value
 */
export function coerceLiteral(value: string): unknown {
  const trimmed: string = value.trim();

  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;

  if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return value;
}

/**
 * A live element in a skin's UI tree.
 *
 * @example
 * const width = element.read('width');
 * element.write('visible', false);
 */
export class SkinElement {
  /** The parsed node this element was built from */
  public readonly node: SkinNode;

  /** Upper-cased element tag, such as `SUBVIEW` or `BUTTON` */
  public readonly tag: string;

  /** The element's id, or null when the definition gave it none */
  public readonly id: string | null;

  /** Parent element, or null for the view root */
  public readonly parent: SkinElement | null;

  /** Child elements in document order */
  public readonly children: SkinElement[] = [];

  /** Services provided by the owning runtime */
  private readonly host: SkinElementHost;

  /** Currently resolved property values, keyed by lower-cased name */
  private readonly values: Map<string, unknown> = new Map<string, unknown>();

  /** Properties that script has assigned, which no longer track their binding */
  private readonly overridden: Set<string> = new Set<string>();

  /** The object script sees when it names this element's id */
  public readonly proxy: object;

  /** The element as an implicit scope, for expressions declared on it */
  public readonly scope: object;

  /**
   * Builds an element for a parsed node.
   *
   * @param node - Parsed node to instantiate
   * @param parent - Parent element, or null for the root
   * @param host - Services provided by the owning runtime
   */
  public constructor(node: SkinNode, parent: SkinElement | null, host: SkinElementHost) {
    this.node = node;
    this.tag = node.tag;
    this.id = node.id;
    this.parent = parent;
    this.host = host;
    this.proxy = this.createProxy();
    this.scope = this.createScope();

    this.seedLiterals();
  }

  /**
   * Populates the value map from literal attributes and defaults.
   *
   * Bound attributes are left absent until the first layout pass evaluates
   * them, so that a binding failing on the first pass falls back to the
   * default rather than to a stale value from a previous skin.
   */
  private seedLiterals(): void {
    for (const [name, attribute] of this.node.attributes) {
      if (attribute.kind === 'literal') {
        this.values.set(name, coerceLiteral(attribute.value));
      } else if (attribute.kind === 'resource') {
        this.values.set(name, attribute.value);
      }
    }
  }

  /**
   * Reads a property's current value, falling back through intrinsics and
   * defaults.
   *
   * @param name - Property name, matched case-insensitively
   * @returns The current value, or undefined when nothing supplies one
   */
  public read(name: string): unknown {
    const key: string = name.toLowerCase();

    if (this.values.has(key)) return this.values.get(key);

    const intrinsic: unknown = this.intrinsic(key);
    if (intrinsic !== undefined) return intrinsic;

    return PROPERTY_DEFAULTS[key];
  }

  /**
   * Writes a property from script, pinning it against its binding.
   *
   * @param name - Property name, matched case-insensitively
   * @param value - New value
   */
  public write(name: string, value: unknown): void {
    const key: string = name.toLowerCase();
    const previous: unknown = this.read(key);

    this.overridden.add(key);
    this.values.set(key, value);

    if (!Object.is(previous, value)) {
      this.fireChangeHandler(key);
      this.host.invalidate();
    }
  }

  /**
   * Applies a value produced by a binding, unless script has taken the property
   * over.
   *
   * @param name - Lower-cased property name
   * @param value - Value the binding produced
   * @returns True when the value differed from the previous one
   */
  public applyBinding(name: string, value: unknown): boolean {
    if (this.overridden.has(name)) return false;

    // Object.is, not `===`: a binding that evaluates to NaN - which happens
    // whenever a skin derives a size from a resource string this player cannot
    // supply - would otherwise report a change on every pass and stop layout
    // from ever settling.
    const previous: unknown = this.read(name);
    if (Object.is(previous, value)) return false;

    this.values.set(name, value);
    this.fireChangeHandler(name);
    return true;
  }

  /**
   * Runs the `<property>_onchange` handler, if the definition declares one.
   *
   * @param name - Lower-cased property name that changed
   */
  private fireChangeHandler(name: string): void {
    const handler: SkinAttribute | undefined = this.node.attributes.get(`${name}_onchange`);
    if (handler === undefined) return;

    this.host.execute(this.scope, handler.value, `${this.describe()}.${name}_onchange`);
  }

  /**
   * Derives a property value the definition did not state.
   *
   * Only size is derived, and only from an image: an unsized SUBVIEW carrying a
   * `backgroundImage` takes that image's dimensions, which is how most of a
   * skin's layout arithmetic gets its numbers.
   *
   * @param key - Lower-cased property name
   * @returns The derived value, or undefined when nothing derives it
   */
  private intrinsic(key: string): unknown {
    if (!IMAGE_SIZED_PROPERTIES.has(key)) return undefined;

    for (const attribute of SIZING_IMAGE_ATTRIBUTES) {
      const image: unknown = this.values.get(attribute);
      if (typeof image !== 'string' || image === '') continue;

      const metrics: SkinImageMetrics | null = this.host.metrics(image);
      if (metrics === null) continue;

      return key === 'width' ? metrics.width : metrics.height;
    }

    return undefined;
  }

  /**
   * Whether a property's value is produced rather than stated.
   *
   * A property bound to a `jscript:` expression is recomputed whenever the view
   * changes, and a property script has assigned was set deliberately. Either
   * way the value is already correct for the current size, and applying an
   * alignment offset on top of it would count the same resize twice.
   *
   * @param name - Property name, matched case-insensitively
   * @returns True when the value comes from an expression or a script assignment
   */
  public isDerived(name: string): boolean {
    const key: string = name.toLowerCase();
    if (this.overridden.has(key)) return true;

    const attribute: SkinAttribute | undefined = this.node.attributes.get(key);
    return attribute !== undefined && (attribute.kind === 'jscript' || attribute.kind === 'wmpprop');
  }

  /**
   * A human-readable name for this element, used in diagnostics.
   *
   * @returns The element's id when it has one, otherwise its tag
   */
  public describe(): string {
    return this.id ?? `<${this.tag}>`;
  }

  /**
   * Builds the Proxy that script interacts with.
   *
   * Reads and writes are forwarded to the value map; unknown method names
   * resolve to no-ops so that a skin calling an unimplemented animation helper
   * degrades to doing nothing rather than throwing mid-handler.
   *
   * @returns The script-facing proxy for this element
   */
  private createProxy(): object {
    const element: SkinElement = this;

    return new Proxy(Object.create(null) as Record<string, unknown>, {
      get: (_target: Record<string, unknown>, property: string | symbol): unknown => {
        if (typeof property === 'symbol') return undefined;

        if (INERT_METHODS.includes(property)) {
          return (): void => {};
        }

        if (property === 'toString') {
          return (): string => element.describe();
        }

        return element.read(property);
      },

      set: (_target: Record<string, unknown>, property: string | symbol, value: unknown): boolean => {
        if (typeof property === 'string') element.write(property, value);
        return true;
      },

      has: (): boolean => true,
    });
  }

  /**
   * Builds the restricted proxy used as an implicit scope.
   *
   * An expression declared on an element sees that element's own properties as
   * bare names: `width="jscript:svEntireApp.width - left - 298"` means *this*
   * element's `left`, and `onclick="setMode('loop', down)"` means *this*
   * button's `down`. That is only safe if the scope claims exactly the names
   * the element recognises - a catch-all `has` here would shadow `player`,
   * `view` and every function the skin's scripts define.
   *
   * @returns Proxy suitable as the operand of a `with` block
   */
  private createScope(): object {
    const element: SkinElement = this;

    return new Proxy(Object.create(null) as Record<string, unknown>, {
      has: (_target: Record<string, unknown>, property: string | symbol): boolean => {
        if (typeof property !== 'string') return false;
        if (INERT_METHODS.includes(property)) return true;

        // Handlers call an element's own methods and read its own properties as
        // bare names, so both have to be claimed - but nothing else, or this
        // scope would shadow the skin's globals.
        const key: string = property.toLowerCase();
        return element.node.attributes.has(key) || key in PROPERTY_DEFAULTS;
      },

      get: (_target: Record<string, unknown>, property: string | symbol): unknown =>
        typeof property === 'string' ? Reflect.get(element.proxy, property) : undefined,

      set: (_target: Record<string, unknown>, property: string | symbol, value: unknown): boolean => {
        if (typeof property === 'string') element.write(property, value);
        return true;
      },
    });
  }
}
