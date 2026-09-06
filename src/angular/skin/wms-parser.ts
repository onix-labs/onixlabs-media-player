/**
 * @fileoverview Lenient parser for Windows Media Player skin definitions (.wms).
 *
 * A `.wms` file looks like XML but is not: the original runtime accepted
 * documents no conforming parser will touch. Real skins in the wild contain
 * duplicate attributes on a single element, comment bodies carrying raw
 * control characters left over from a DOS-era box-drawing header, and
 * unescaped `&` in script attributes. `DOMParser` rejects all of these outright
 * and yields nothing usable, so this module scans the document by hand and
 * recovers from the malformations skins actually exhibit rather than failing.
 *
 * The parser's only job is structure. It classifies each attribute by its
 * binding prefix - `jscript:`, `wmpprop:`, `res://` or none - but never
 * evaluates anything; that belongs to the expression engine.
 *
 * Two deliberate leniencies:
 *
 * - **Duplicate attributes: last wins.** Skins use this as an override
 *   mechanism, restating a constant as a `jscript:` expression further along
 *   the same tag.
 * - **Mismatched close tags unwind rather than throw.** A stray `</SUBVIEW>`
 *   closes the nearest matching ancestor if there is one and is discarded
 *   otherwise, which keeps the rest of the tree intact.
 *
 * @module app/skin/wms-parser
 */

/**
 * How an attribute's value should be interpreted at runtime.
 *
 * - literal: the value is used as written
 * - jscript: the value is a JScript expression, re-evaluated when dependencies change
 * - wmpprop: the value is a property path bound one-way to another element or object
 * - resource: the value is a `res://` reference into a Windows resource DLL
 * - handler: the value is a JScript statement list run in response to an event
 */
export type SkinBindingKind = 'literal' | 'jscript' | 'wmpprop' | 'resource' | 'handler';

/** Prefix marking an attribute value as a JScript expression. */
const PREFIX_JSCRIPT: string = 'jscript:';

/** Prefix marking an attribute value as a one-way property binding. */
const PREFIX_WMPPROP: string = 'wmpprop:';

/** Prefix marking an attribute value as a Windows resource reference. */
const PREFIX_RESOURCE: string = 'res://';

/**
 * A parsed attribute, with its binding kind resolved from any prefix.
 *
 * @property name - Attribute name, lower-cased
 * @property kind - How the value should be interpreted
 * @property value - Value with any binding prefix removed
 * @property raw - Value exactly as written in the document
 */
export interface SkinAttribute {
  /** Attribute name, lower-cased */
  readonly name: string;
  /** How the value should be interpreted */
  readonly kind: SkinBindingKind;
  /** Value with any binding prefix removed */
  readonly value: string;
  /** Value exactly as written in the document */
  readonly raw: string;
}

/**
 * A node in the parsed skin tree.
 *
 * @property tag - Element name, upper-cased
 * @property id - Value of the element's `id` attribute, or null when unnamed
 * @property attributes - Parsed attributes keyed by lower-cased name
 * @property children - Child elements in document order
 */
export interface SkinNode {
  /** Element name, upper-cased */
  readonly tag: string;
  /** Value of the `id` attribute, or null when unnamed */
  readonly id: string | null;
  /** Parsed attributes keyed by lower-cased name */
  readonly attributes: ReadonlyMap<string, SkinAttribute>;
  /** Child elements in document order */
  readonly children: readonly SkinNode[];
}

/**
 * A fully parsed skin definition.
 *
 * @property title - Skin title from the THEME element
 * @property author - Author credited by the THEME element
 * @property version - Version string from the THEME element
 * @property theme - The THEME element itself
 * @property view - The primary VIEW element, which is what gets rendered
 * @property scriptFiles - Script file names listed by the view's `scriptFile` attribute
 * @property warnings - Recoverable problems encountered while parsing
 */
export interface SkinDefinition {
  /** Skin title from the THEME element */
  readonly title: string;
  /** Author credited by the THEME element */
  readonly author: string;
  /** Version string from the THEME element */
  readonly version: string;
  /** The THEME element */
  readonly theme: SkinNode;
  /** The primary VIEW element */
  readonly view: SkinNode;
  /** Script file names the view asks to load, in order */
  readonly scriptFiles: readonly string[];
  /** Recoverable problems encountered while parsing */
  readonly warnings: readonly string[];
}

/** Attribute names whose values are always statement lists, whatever their prefix. */
const HANDLER_ATTRIBUTE_PATTERN: RegExp = /^on[a-z]|_onchange$/;

/** Named XML entities a skin definition may use. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Radix of a hexadecimal numeric character reference. */
const HEX_RADIX: number = 16;

/**
 * Mutable node used while building the tree, before it is frozen into a
 * {@link SkinNode}.
 */
interface MutableNode {
  tag: string;
  attributes: Map<string, SkinAttribute>;
  children: MutableNode[];
}

/**
 * Decodes XML entity references in an attribute value.
 *
 * Unknown references are left as written rather than dropped: skins contain
 * bare `&` in script expressions such as `a&&b`, and mangling those would break
 * the expression.
 *
 * @param value - Raw attribute text
 * @returns Text with recognised entities replaced
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match: string, body: string): string => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code: number = parseInt(body.slice(2), HEX_RADIX);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }

    if (body.startsWith('#')) {
      const code: number = parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }

    const named: string | undefined = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Classifies an attribute value by its binding prefix.
 *
 * Event handlers are recognised by name first: `onclick="doThing()"` carries no
 * prefix but is still script, and `value_onchange` follows the same rule.
 *
 * @param name - Lower-cased attribute name
 * @param raw - Attribute value with entities already decoded
 * @returns The parsed attribute
 */
function classifyAttribute(name: string, raw: string): SkinAttribute {
  const trimmed: string = raw.trim();

  if (HANDLER_ATTRIBUTE_PATTERN.test(name)) {
    const body: string = trimmed.toLowerCase().startsWith(PREFIX_JSCRIPT)
      ? trimmed.slice(PREFIX_JSCRIPT.length)
      : trimmed;
    return {name, kind: 'handler', value: body, raw};
  }

  if (trimmed.toLowerCase().startsWith(PREFIX_JSCRIPT)) {
    return {name, kind: 'jscript', value: trimmed.slice(PREFIX_JSCRIPT.length).trim(), raw};
  }

  if (trimmed.toLowerCase().startsWith(PREFIX_WMPPROP)) {
    return {name, kind: 'wmpprop', value: trimmed.slice(PREFIX_WMPPROP.length).trim(), raw};
  }

  if (trimmed.toLowerCase().startsWith(PREFIX_RESOURCE)) {
    return {name, kind: 'resource', value: trimmed, raw};
  }

  return {name, kind: 'literal', value: raw, raw};
}

/**
 * Reads the attribute list of a start tag.
 *
 * Values may be double-quoted, single-quoted, or bare. Duplicates overwrite
 * earlier occurrences, which is how skins express an override.
 *
 * @param source - Full document text
 * @param start - Offset of the first character after the tag name
 * @param end - Offset just past the tag's closing angle bracket
 * @returns Attributes keyed by lower-cased name
 */
function parseAttributes(source: string, start: number, end: number): Map<string, SkinAttribute> {
  const attributes: Map<string, SkinAttribute> = new Map<string, SkinAttribute>();
  const pattern: RegExp = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  const segment: string = source.slice(start, end);

  let match: RegExpExecArray | null = pattern.exec(segment);
  while (match !== null) {
    const name: string = match[1].toLowerCase();
    const raw: string = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    attributes.set(name, classifyAttribute(name, raw));
    match = pattern.exec(segment);
  }

  return attributes;
}

/**
 * Finds the offset just past a start tag's closing angle bracket.
 *
 * Angle brackets inside quoted attribute values do not close the tag, so the
 * scan tracks quoting rather than searching for the next `>`.
 *
 * @param source - Full document text
 * @param from - Offset of the tag's opening angle bracket
 * @returns Offset just past `>`, or the document length when unterminated
 */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;

  for (let index: number = from; index < source.length; index++) {
    const character: string = source[index];

    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '>') return index + 1;
  }

  return source.length;
}

/**
 * Freezes the mutable build tree into the public node shape.
 *
 * @param node - Mutable node produced by the scanner
 * @returns Immutable equivalent
 */
function finalise(node: MutableNode): SkinNode {
  const id: SkinAttribute | undefined = node.attributes.get('id');

  return {
    tag: node.tag,
    id: id === undefined || id.value.trim() === '' ? null : id.value.trim(),
    attributes: node.attributes,
    children: node.children.map(finalise),
  };
}

/**
 * Parses a `.wms` document into a node tree.
 *
 * @param source - Decoded definition text
 * @returns Root nodes in document order, and any recoverable problems found
 */
export function parseWmsNodes(source: string): {roots: SkinNode[]; warnings: string[]} {
  const warnings: string[] = [];
  const root: MutableNode = {tag: '#document', attributes: new Map<string, SkinAttribute>(), children: []};
  const stack: MutableNode[] = [root];

  let cursor: number = 0;

  while (cursor < source.length) {
    const open: number = source.indexOf('<', cursor);
    if (open === -1) break;

    // Comments, processing instructions and doctypes carry no structure worth
    // keeping, and skin comments in particular contain characters that would
    // confuse the tag scanner.
    if (source.startsWith('<!--', open)) {
      const close: number = source.indexOf('-->', open);
      cursor = close === -1 ? source.length : close + '-->'.length;
      continue;
    }

    if (source.startsWith('<?', open) || source.startsWith('<!', open)) {
      cursor = findTagEnd(source, open);
      continue;
    }

    if (source.startsWith('</', open)) {
      const close: number = findTagEnd(source, open);
      const tag: string = source.slice(open + '</'.length, close - 1).trim().toUpperCase();
      const depth: number = stack.findLastIndex((node: MutableNode): boolean => node.tag === tag);

      if (depth <= 0) {
        warnings.push(`Ignored unmatched closing tag </${tag}>`);
      } else {
        if (depth < stack.length - 1) {
          warnings.push(`Auto-closed ${stack.length - 1 - depth} element(s) before </${tag}>`);
        }
        stack.length = depth;
      }

      cursor = close;
      continue;
    }

    const nameMatch: RegExpMatchArray | null = source.slice(open + 1).match(/^[A-Za-z_][\w.-]*/);
    if (nameMatch === null) {
      // A bare `<` that is not markup; skip it rather than resynchronising.
      cursor = open + 1;
      continue;
    }

    const close: number = findTagEnd(source, open);
    const tag: string = nameMatch[0].toUpperCase();
    const nameEnd: number = open + 1 + nameMatch[0].length;
    const selfClosing: boolean = source.slice(nameEnd, close - 1).trimEnd().endsWith('/');
    const node: MutableNode = {
      tag,
      attributes: parseAttributes(source, nameEnd, close - 1),
      children: [],
    };

    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);

    cursor = close;
  }

  if (stack.length > 1) {
    warnings.push(`Document ended with ${stack.length - 1} unclosed element(s)`);
  }

  return {roots: root.children.map(finalise), warnings};
}

/**
 * Depth-first search for the first descendant with the given tag.
 *
 * @param node - Node to search beneath, inclusive of itself
 * @param tag - Upper-cased tag name to find
 * @returns The matching node, or null when absent
 */
export function findNodeByTag(node: SkinNode, tag: string): SkinNode | null {
  if (node.tag === tag) return node;

  for (const child of node.children) {
    const found: SkinNode | null = findNodeByTag(child, tag);
    if (found !== null) return found;
  }

  return null;
}

/**
 * Reads an attribute's value as plain text, ignoring its binding kind.
 *
 * @param node - Node to read from
 * @param name - Lower-cased attribute name
 * @returns The value, or an empty string when the attribute is absent
 */
function attributeText(node: SkinNode, name: string): string {
  return node.attributes.get(name)?.value ?? '';
}

/**
 * Parses a complete skin definition, locating its theme and primary view.
 *
 * @param source - Decoded `.wms` text
 * @returns The parsed definition
 * @throws If the document contains no THEME element with a VIEW inside it
 */
export function parseSkinDefinition(source: string): SkinDefinition {
  const {roots, warnings}: {roots: SkinNode[]; warnings: string[]} = parseWmsNodes(source);

  let theme: SkinNode | null = null;
  for (const root of roots) {
    theme = findNodeByTag(root, 'THEME');
    if (theme !== null) break;
  }

  if (theme === null) {
    throw new Error('Skin definition contains no THEME element');
  }

  const view: SkinNode | null = findNodeByTag(theme, 'VIEW');
  if (view === null) {
    throw new Error('Skin definition contains no VIEW element');
  }

  const scriptFiles: string[] = attributeText(view, 'scriptfile')
    .split(';')
    .map((name: string): string => name.trim())
    .filter((name: string): boolean => name.length > 0);

  return {
    title: attributeText(theme, 'title'),
    author: attributeText(theme, 'author'),
    version: attributeText(theme, 'version'),
    theme,
    view,
    scriptFiles,
    warnings,
  };
}
