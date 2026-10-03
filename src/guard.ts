/**
 * Type guards both halves of the package need to read an `unknown` honestly.
 *
 * Zero imports, deliberately. This module is pulled into `lib/client.js` as
 * well as `lib/index.mjs`, and the client bundle must not reach into host code
 * or `node:*` — a `Buffer` or a `ctx` type leaking in here would either bloat
 * the browser bundle or make it unloadable.
 *
 * They are guards rather than assertions because that is what the lint is
 * pointing at. `(value as Record<string, unknown>)` tells the compiler to stop
 * asking, at exactly the point where the answer matters: an upstream payload
 * or a host-provided section. A predicate answers the question, and the
 * compiler then narrows for free.
 *
 * @module dsh-tinyfish/guard
 */

/**
 * A non-null, non-array object that named fields can be read off.
 *
 * Arrays are excluded because a payload field that arrives as a list where an
 * object was expected is a malformed answer, not a shape worth indexing into.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A boxed schema node: the `default(...).volatile()` field shape that hands
 * its value back through `.get()`.
 *
 * `src/index.ts` reads one section that mixes these with bare values, because a
 * `union` of consts resolves to a value while a boxed field stays a node. The
 * box is detected by *behaviour* — does it expose a callable `get` — rather
 * than by `instanceof`, which cannot see across a second copy of the schema
 * package. The member is read as `unknown` and then checked, so nothing is
 * asserted into a callable before it is known to be one.
 */
export function isBoxed(value: unknown): value is { get: () => unknown } {
  if (!isRecord(value)) return false;
  const member: unknown = Reflect.get(value, "get");
  return typeof member === "function";
}
