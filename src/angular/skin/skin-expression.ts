/**
 * @fileoverview Sandbox that evaluates a skin's JScript expressions and handlers.
 *
 * Windows Media Player skins are half markup and half script. Attribute values
 * prefixed `jscript:` are expressions re-evaluated whenever their inputs change,
 * `on*` attributes are statement lists run on events, and the `.js` files listed
 * by the view supply the shared globals both rely on. Every one of these runs
 * against a single flat namespace containing the skin's own globals, the player
 * object model, and one binding per element id.
 *
 * Reproducing that namespace has one hard requirement: the `.js` files declare
 * their globals with `var` and `function`, and expressions evaluated later must
 * see them. A wrapper function cannot expose its own declarations to a
 * separately compiled function, so instead the scripts and the evaluator are
 * compiled *together*: the wrapper runs the scripts and returns closures that
 * call direct `eval`, which inherits the very scope those declarations landed
 * in. That single construction is what makes the rest of the runtime possible.
 *
 * Identifier resolution is a `with` block over a Proxy, which lets unknown
 * names resolve to `undefined` instead of throwing. Skins reference plenty of
 * things this runtime does not implement, and a skin that renders with a few
 * dead properties is far more useful than one that fails to render at all.
 *
 * SECURITY: skin scripts are third-party code executing in the renderer. The
 * proxy shadows the obvious escape hatches (`window`, `document`, `fetch`, the
 * preload bridge), but a determined script can still reach ambient globals this
 * list does not name. Treat installing a skin as running its code, and do not
 * ship this without a stronger boundary - an isolated frame or worker.
 *
 * @module app/skin/skin-expression
 */

/**
 * Globals deliberately hidden from skin script, so that a skin cannot reach the
 * renderer's privileged surface by naming it.
 *
 * This is a mitigation, not a boundary - see the module note.
 */
const SHADOWED_GLOBALS: ReadonlySet<string> = new Set<string>([
  'window',
  'self',
  'globalThis',
  'document',
  'location',
  'navigator',
  'history',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'importScripts',
  'require',
  'process',
  'module',
  'exports',
  'mediaPlayer',
  'electron',
  'ipcRenderer',
  'Function',
  'postMessage',
  'open',
]);

/**
 * Names the sandbox itself needs to resolve lexically rather than through the
 * scope proxy. Trapping these would break the wrapper's own machinery.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set<string>(['eval', 'arguments', 'this']);

/** Prefix reserved for the sandbox's internal bindings. */
const INTERNAL_PREFIX: string = '__wmp';

/**
 * A problem encountered while running skin script.
 *
 * @property source - The expression or statement list that failed
 * @property message - The thrown error's message
 * @property context - Where the failure happened, for diagnostics
 */
export interface SkinScriptError {
  /** The expression or statement list that failed */
  readonly source: string;
  /** The thrown error's message */
  readonly message: string;
  /** Where the failure happened, for diagnostics */
  readonly context: string;
}

/** Closures returned by the compiled wrapper, sharing the scripts' scope. */
interface SandboxHandles {
  /** Evaluates an expression and returns its value */
  readonly evaluate: (source: string) => unknown;
  /** Runs a statement list for its effects */
  readonly execute: (source: string) => void;
  /** Evaluates an expression with an element's own properties in scope */
  readonly evaluateFor: (self: object, source: string) => unknown;
  /** Runs a statement list with an element's own properties in scope */
  readonly executeFor: (self: object, source: string) => void;
}

/**
 * Evaluates skin expressions and handlers against a shared script namespace.
 *
 * The engine is constructed once per loaded skin. Construction runs every
 * script the skin declares; after that, {@link evaluate} and {@link execute}
 * see whatever those scripts defined.
 *
 * @example
 * const engine = new SkinExpressionEngine(bindings, [source]);
 * engine.evaluate('svEntireApp.width - 298', 'width of btnAppFillTop');
 */
export class SkinExpressionEngine {
  /** Named bindings visible to script: element proxies and object-model roots */
  private readonly bindings: Map<string, unknown>;

  /** Closures sharing the compiled scripts' scope */
  private readonly handles: SandboxHandles;

  /** Sources that have failed at least once, so each is reported only once */
  private readonly failed: Set<string> = new Set<string>();

  /** Errors collected during script execution, oldest first */
  private readonly collectedErrors: SkinScriptError[] = [];

  /**
   * Builds the sandbox and runs the skin's scripts inside it.
   *
   * A script that throws does not prevent the others from running: skins
   * routinely reference player features that are not present, and the failure
   * is recorded rather than propagated.
   *
   * @param bindings - Named values visible to script, mutated by the runtime as elements register
   * @param scripts - Script sources to run at construction, in declaration order
   */
  public constructor(bindings: Map<string, unknown>, scripts: readonly string[]) {
    this.bindings = bindings;

    const scope: object = this.createScopeProxy();
    const body: string = this.buildWrapperBody(scripts);
    const report: (index: number, error: unknown) => void = (index: number, error: unknown): void => {
      this.collectedErrors.push({
        source: `<script ${index}>`,
        message: error instanceof Error ? error.message : String(error),
        context: 'loading skin scripts',
      });
    };

    try {
      const factory: (scopeArgument: object, reportArgument: typeof report) => SandboxHandles =
        new Function(`${INTERNAL_PREFIX}Scope`, `${INTERNAL_PREFIX}Report`, body) as (
          scopeArgument: object,
          reportArgument: typeof report
        ) => SandboxHandles;
      this.handles = factory(scope, report);
    } catch (error: unknown) {
      // A syntax error in one script takes the whole wrapper down, because they
      // share a compilation unit. Fall back to a script-free sandbox so the
      // markup still renders and the failure is visible rather than fatal.
      this.collectedErrors.push({
        source: '<skin scripts>',
        message: error instanceof Error ? error.message : String(error),
        context: 'compiling skin scripts',
      });

      const factory: (scopeArgument: object, reportArgument: typeof report) => SandboxHandles =
        new Function(`${INTERNAL_PREFIX}Scope`, `${INTERNAL_PREFIX}Report`, this.buildWrapperBody([])) as (
          scopeArgument: object,
          reportArgument: typeof report
        ) => SandboxHandles;
      this.handles = factory(scope, report);
    }
  }

  /**
   * Assembles the wrapper source that runs the scripts and returns the
   * evaluator closures.
   *
   * Each script is wrapped in its own `try` so one failing at run time - as
   * opposed to compile time - does not stop the rest.
   *
   * @param scripts - Script sources to embed
   * @returns Body source for the wrapper function
   */
  private buildWrapperBody(scripts: readonly string[]): string {
    const scopeName: string = `${INTERNAL_PREFIX}Scope`;
    const sourceName: string = `${INTERNAL_PREFIX}Source`;
    const errorName: string = `${INTERNAL_PREFIX}Error`;
    const reportName: string = `${INTERNAL_PREFIX}Report`;
    const selfName: string = `${INTERNAL_PREFIX}Self`;

    // Each script gets its own `try` so a failure part-way through one does not
    // stop the next from loading. Anything it had yet to declare stays
    // undefined, which is why the failure is reported rather than swallowed.
    const embedded: string = scripts
      .map(
        (script: string, index: number): string =>
          `try {\n${script}\n} catch (${errorName}) { ${reportName}(${index}, ${errorName}); }`
      )
      .join('\n');

    // The nesting is load-bearing. Script declarations must live in a scope
    // *inside* the `with`, so that a name the scripts define wins over the
    // proxy's catch-all. With the scripts directly in the `with` body, every
    // one of their functions would resolve to the proxy's `undefined` instead -
    // their `var`s would appear to work, because assignment walks the scope
    // chain and lands on the proxy, while their function declarations would
    // not, because those bind in the enclosing variable scope the proxy hides.
    // The `*For` variants add a second, narrow `with` over the element that
    // declared the expression, so its own properties resolve as bare names.
    // That proxy claims only the names the element recognises, which is what
    // keeps it from shadowing the namespace beneath it.
    return `
      with (${scopeName}) {
        return (function () {
          ${embedded}
          return {
            evaluate: function (${sourceName}) { return eval(${sourceName}); },
            execute: function (${sourceName}) { eval(${sourceName}); },
            evaluateFor: function (${selfName}, ${sourceName}) {
              with (${selfName}) { return eval(${sourceName}); }
            },
            executeFor: function (${selfName}, ${sourceName}) {
              with (${selfName}) { eval(${sourceName}); }
            }
          };
        })();
      }
    `;
  }

  /**
   * Creates the Proxy backing the `with` block's identifier resolution.
   *
   * The `has` trap decides, for every identifier the wrapper mentions, whether
   * it resolves against the skin namespace or falls through to the real global
   * scope. Returning true for unknown names is what turns a missing global into
   * `undefined` rather than a ReferenceError.
   *
   * @returns Proxy suitable as the operand of a `with` block
   */
  private createScopeProxy(): object {
    const bindings: Map<string, unknown> = this.bindings;

    return new Proxy(Object.create(null) as object, {
      has: (_target: object, property: string | symbol): boolean => {
        if (property === Symbol.unscopables) return false;
        if (typeof property === 'symbol') return false;
        if (property.startsWith(INTERNAL_PREFIX)) return false;
        if (RESERVED_NAMES.has(property)) return false;
        if (bindings.has(property)) return true;
        if (SHADOWED_GLOBALS.has(property)) return true;

        // Anything the host genuinely provides - Math, Date, parseInt - is left
        // to resolve normally. Everything else is claimed so it reads as
        // undefined instead of throwing.
        return !(property in globalThis);
      },

      get: (_target: object, property: string | symbol): unknown => {
        if (typeof property === 'symbol') return undefined;
        if (SHADOWED_GLOBALS.has(property)) return undefined;
        return bindings.get(property);
      },

      set: (_target: object, property: string | symbol, value: unknown): boolean => {
        if (typeof property === 'symbol') return true;
        bindings.set(property, value);
        return true;
      },

      deleteProperty: (_target: object, property: string | symbol): boolean => {
        if (typeof property === 'string') bindings.delete(property);
        return true;
      },
    });
  }

  /**
   * Evaluates an expression and returns its value.
   *
   * A failure yields `undefined`, which leaves the bound property at its
   * previous value - nearly always closer to correct than tearing down the
   * view. Expressions are retried on every pass rather than being disabled on
   * first failure: `player.currentMedia.name` throws whenever nothing is
   * loaded and must start working again the moment something is.
   *
   * @param source - Expression source, without any `jscript:` prefix
   * @param context - Description of where the expression came from, for diagnostics
   * @returns The expression's value, or undefined when it failed
   */
  public evaluate(source: string, context: string): unknown {
    try {
      return this.handles.evaluate(source);
    } catch (error: unknown) {
      this.recordFailure(source, error, context);
      return undefined;
    }
  }

  /**
   * Evaluates an expression with an element's own properties in scope.
   *
   * This is how a skin's layout arithmetic reads: `svEntireApp.width - left -
   * 298` means the declaring element's `left`, not a global of that name.
   *
   * @param self - Scope proxy of the element the expression is declared on
   * @param source - Expression source, without any `jscript:` prefix
   * @param context - Description of where the expression came from, for diagnostics
   * @returns The expression's value, or undefined when it failed
   */
  public evaluateFor(self: object, source: string, context: string): unknown {
    try {
      return this.handles.evaluateFor(self, source);
    } catch (error: unknown) {
      this.recordFailure(source, error, context);
      return undefined;
    }
  }

  /**
   * Runs a statement list with an element's own properties in scope.
   *
   * Event handlers depend on this as much as expressions do:
   * `onclick="player.settings.setMode('loop', down)"` reads the clicked
   * button's own `down` state.
   *
   * @param self - Scope proxy of the element the handler is declared on
   * @param source - Statement list source
   * @param context - Description of where the statements came from, for diagnostics
   */
  public executeFor(self: object, source: string, context: string): void {
    try {
      this.handles.executeFor(self, source);
    } catch (error: unknown) {
      this.recordFailure(source, error, context);
    }
  }

  /**
   * Whether an expression has ever failed.
   *
   * @param source - Expression source to check
   * @returns True when the source has thrown at least once
   */
  public hasFailed(source: string): boolean {
    return this.failed.has(source);
  }

  /**
   * Runs a statement list for its effects.
   *
   * @param source - Statement list source
   * @param context - Description of where the statements came from, for diagnostics
   */
  public execute(source: string, context: string): void {
    try {
      this.handles.execute(source);
    } catch (error: unknown) {
      this.recordFailure(source, error, context);
    }
  }

  /**
   * Records a script failure, reporting each distinct source only once.
   *
   * @param source - The source that failed
   * @param error - The thrown value
   * @param context - Description of where the source came from
   */
  private recordFailure(source: string, error: unknown, context: string): void {
    // The set doubles as the reported-already check, so a binding that throws
    // on every pass costs one set lookup rather than a growing error log.
    if (this.failed.has(source)) return;
    this.failed.add(source);

    this.collectedErrors.push({
      source,
      message: error instanceof Error ? error.message : String(error),
      context,
    });
  }

  /**
   * Every script failure recorded so far.
   *
   * @returns Recorded errors, oldest first
   */
  public get errors(): readonly SkinScriptError[] {
    return this.collectedErrors;
  }
}
