/**
 * The type guards, tested directly.
 *
 * `src/guard.ts` is 43 lines with no imports and, until now, no tests — and
 * every `unknown` this package reads passes through one of these first. Two
 * mutation probes into it survived:
 *
 *  - dropping the array exclusion from `isRecord`
 *  - accepting a non-callable `get` as a boxed schema node
 *
 * Both are the kind of guard that looks like a formality and is not: an array
 * read as an object yields `{0: …, 1: …}` and quietly passes every field check,
 * and a non-callable `get` is called later as if it were one.
 */

import assert from "node:assert/strict";

import { test } from "vitest";

import { isBoxed, isRecord } from "../src/guard.ts";

test("isRecord accepts plain objects and rejects everything else", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  // Objects with a prototype are records; the guard is about shape, not literals.
  assert.equal(isRecord(new Date(0)), true);
  assert.equal(isRecord(Object.create(null) as object), true);

  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord("string"), false);
  assert.equal(isRecord(0), false);
  assert.equal(isRecord(true), false);
  assert.equal(
    isRecord(() => 0),
    false
  );
});

test("isRecord rejects arrays, which would otherwise index as an object", () => {
  // The exclusion is load-bearing: `Object.entries(["a"])` gives `{0: "a"}`, so
  // an array where an object was expected would satisfy every named-field
  // check and report nonsense as if it were the payload's shape.
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(["a"]), false);
  assert.equal(isRecord([{ url: "https://x" }]), false);
  // The rule is `Array.isArray`, and a typed array is not one by that test, so
  // it is a record. Left alone deliberately: a JSON payload cannot produce a
  // typed array, and widening the predicate to reject them would be a rule the
  // code does not currently claim.
  assert.equal(isRecord(new Uint8Array(1)), true);
});

test("isBoxed requires a callable get, not merely a get property", () => {
  assert.equal(isBoxed({ get: () => "value" }), true);
  // A method on a prototype is still a callable member — the guard reads the
  // property, not the own keys, so a class instance is boxed.
  class Boxed {
    private readonly value = 1;
    get(): unknown {
      return this.value;
    }
  }
  assert.equal(isBoxed(new Boxed()), true);

  // This is the half the mutation removed. A `get` that is not callable is not a
  // schema node, and treating it as one defers the failure to the call — where
  // it surfaces as a TypeError deep inside a field read, naming neither the
  // field nor the payload.
  assert.equal(isBoxed({ get: 42 }), false);
  assert.equal(isBoxed({ get: "value" }), false);
  assert.equal(isBoxed({ get: undefined }), false);

  assert.equal(isBoxed({}), false);
  assert.equal(isBoxed({ value: 1 }), false);
  assert.equal(isBoxed(null), false);
  assert.equal(isBoxed("get"), false);
  assert.equal(isBoxed([]), false);
});

test("a boxed node's value is read through the callable it advertises", () => {
  // `isBoxed` is a type predicate, so it narrows a *variable* rather than
  // handing the node back — which is how `src/index.ts` uses it.
  const candidate: unknown = { get: () => ({ nested: true }) };
  assert.ok(isBoxed(candidate), "a node with a callable get is boxed");
  assert.deepEqual(candidate.get(), { nested: true });
});
