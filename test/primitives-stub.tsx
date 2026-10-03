/**
 * A stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The real package is supplied by the Host in the browser and does not resolve
 * outside it — it imports `*.module.css` and host-only workspace utilities that
 * a consumer does not have. Tests that import the settings page's *source*
 * alias it here, so this file's code is what runs and only the host's UI kit is
 * faked. `test/client-bundle.test.mjs` evaluates the built bundle against an
 * equivalent stub, so the two agree on the contract.
 *
 * `SettingsFormModel` is modelled closely enough to be worth testing against:
 * it stages drafts, `field()` reports the staged text, and `save()` runs each
 * staged secret's writer. That is the whole of the behaviour the card relies on,
 * and reproducing it is what makes the credential-write assertions real rather
 * than a recording of a mock's own return value.
 */

import type { ReactNode } from "react";

interface FieldState {
  text: string;
  overridden: boolean;
  invalid: boolean;
}

/** What a spec's `parse` yields: a staged value, a clear, or nothing. */
type FieldWrite = { kind: "set"; value: string | number } | { kind: "clear" };

/** One conversion spec, as the primitives build them. */
interface FieldSpec {
  field: string;
  format: (value: unknown) => string;
  parse: (text: string) => FieldWrite | undefined;
}

/**
 * The text primitive, reproduced from `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * Trims first; blank clears; anything else stages the trimmed string. The old
 * shared helper compared the raw text, so `"  x  "` staged untrimmed and a
 * whitespace-only draft was a set rather than a clear.
 */
function textField(field: string): FieldSpec {
  return {
    field,
    format: (value: unknown) => (typeof value === "string" ? value : ""),
    parse: (text: string) => {
      const trimmed = text.trim();
      return trimmed === ""
        ? { kind: "clear" as const }
        : { kind: "set" as const, value: trimmed };
    },
  };
}

/**
 * The number primitive, likewise reproduced rather than hand-rolled.
 *
 * The old shared helper handed every draft back as a raw string, so no
 * `attempts` typo could ever be unparseable, `field().invalid` never turned
 * true for a number, and every guard built on that rule read a stub that
 * could not fail it. The real spec trims, clears on blank, stages the parsed
 * number when it is finite, and answers `undefined` otherwise — and
 * `undefined` is what blocks the save.
 */
function numberField(field: string): FieldSpec {
  return {
    field,
    format: (value: unknown) =>
      typeof value === "number" ? String(value) : "",
    parse: (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" as const };
      const parsed = Number(trimmed);
      return Number.isFinite(parsed)
        ? { kind: "set" as const, value: parsed }
        : undefined;
    },
  };
}

export const settingsTextField = (field: string): FieldSpec => textField(field);
export const settingsNumberField = (field: string): FieldSpec =>
  numberField(field);

export interface SecretSpec {
  field: string;
  write: (value: string) => Promise<boolean>;
}

interface FormScope {
  getSnapshot: () => { value?: unknown; user?: unknown; writable: boolean };
}

export class SettingsFormModel {
  private readonly staged = new Map<string, string>();
  private readonly cleared = new Set<string>();
  private readonly secrets: Map<string, SecretSpec>;
  private readonly specs: Map<string, FieldSpec>;
  private readonly value: Record<string, unknown>;
  private readonly user: Record<string, unknown>;
  private readonly scope: FormScope;

  constructor(scope: FormScope, specs: FieldSpec[], secrets: SecretSpec[]) {
    this.scope = scope;
    this.specs = new Map(specs.map((one) => [one.field, one]));
    this.secrets = new Map(secrets.map((one) => [one.field, one]));
    const snapshot = scope.getSnapshot();
    this.value = (snapshot.value ?? {}) as Record<string, unknown>;
    this.user = (snapshot.user ?? {}) as Record<string, unknown>;
  }

  field(field: string): FieldState {
    if (this.secrets.has(field)) {
      return {
        text: this.staged.get(field) ?? "",
        overridden: false,
        invalid: false,
      };
    }
    if (this.cleared.has(field)) {
      return { text: "", overridden: false, invalid: false };
    }
    if (this.staged.has(field)) {
      // A draft the spec cannot parse is invalid, which is what blocks the
      // save. The real model reports it the same way, and it is the only thing
      // standing between a typo and a silently discarded setting.
      const stored = this.specs.get(field);
      const text = this.staged.get(field) ?? "";
      return {
        text,
        overridden: true,
        invalid: stored ? stored.parse(text) === undefined : false,
      };
    }
    const stored = this.specs.get(field);
    if (!stored) throw new Error(`plugin card has no field ${field}`);
    return {
      text: stored.format(this.value[field]),
      overridden: Object.hasOwn(this.user, field),
      invalid: false,
    };
  }

  shell() {
    const snapshot = this.scope.getSnapshot();
    return {
      available: true,
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      invalid: [...this.staged.keys()].some(
        (field) => this.field(field).invalid
      ),
      saving: false,
      failed: false,
    };
  }

  // The real model returns a store that tracks the scope and provides .set();
  // this recomputes on read and supports explicit sets from credential reads.
  // oxlint-disable-next-line class-methods-use-this -- no instance state to touch.
  bind<T>(project: () => T) {
    let current = project();
    const fn = Object.assign(() => current, {
      set: (next: T) => {
        current = next;
      },
    });
    return fn;
  }

  actions() {
    return {
      edit: (field: string, text: string) => {
        this.cleared.delete(field);
        this.staged.set(field, text);
      },
      resetField: (field: string) => {
        this.staged.delete(field);
        this.cleared.add(field);
      },
      save: async (): Promise<boolean> => {
        // A save is refused outright while a draft is invalid, so a typo keeps
        // its text on screen instead of being dropped.
        if (
          [...this.staged.keys()].some((field) => this.field(field).invalid)
        ) {
          return false;
        }
        for (const [field, text] of this.staged) {
          const secret = this.secrets.get(field);
          if (secret) {
            const value = text.trim();
            // Blank means "leave the stored key alone", which is the real
            // primitive's rule and the reason the field's hint says so.
            if (value === "") continue;
            if (!(await secret.write(value))) return false;
            continue;
          }
          this.user[field] = text;
        }
        return true;
      },
      discard: () => {
        this.staged.clear();
        this.cleared.clear();
      },
    };
  }

  dispose(): void {
    this.staged.clear();
    this.cleared.clear();
  }
}

/* The visual kit. Each returns its props so a DOM-free assertion can read the
   structure a test cares about; the real components render them. */

/* The visual kit.
 *
 * Each returns an element-shaped node, which is all a DOM-free assertion needs:
 * the real components render these props, and a test reads the structure
 * without a renderer. They are written out one by one rather than built by a
 * factory because the function *name* is how a test identifies which component
 * rendered, and a factory would hand every one of them the same name.
 */

type KitProps = Record<string, unknown> & { children?: ReactNode };

export function SettingsForm(props: KitProps) {
  return { type: "SettingsForm", props };
}

export function SettingsSecretField(props: KitProps) {
  return { type: "SettingsSecretField", props };
}

export function SettingsValueField(props: KitProps) {
  return { type: "SettingsValueField", props };
}

export function Switch(props: KitProps) {
  return { type: "Switch", props };
}

export function SegmentedControl(props: KitProps) {
  return { type: "SegmentedControl", props };
}

export function Tag(props: KitProps) {
  return { type: "Tag", props };
}
