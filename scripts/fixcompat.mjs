import { readFileSync, writeFileSync } from "node:fs";

const p = new URL("../test/compat.test.mjs", import.meta.url);
let s = readFileSync(p, "utf8");

const from = `test("a config row from another layer does not break this bundle's row", () => {
  const { search, fetch } = registry();
  plugin.apply(search && fetch ? { web: registry().ctx.web } : {}, plugin.Config({}));
  const { ctx } = registry();
  plugin.apply(ctx, plugin.Config({ channel: "direct", attempts: 5 }));
  const options = ctx.__last?.();
  void options;
  assert.equal(ctx.web.registerSearchProvider instanceof Function, true);
});`;

const to = `test("a settings row from another patch layer still resolves", () => {
  // Patch layers merge by id, so this bundle's row can arrive either as a
  // validated section — boxed schema nodes, read with \`.get()\` — or as a raw
  // object, if another layer wrote the row before the loader validated it. Both
  // have to work, and the difference is invisible until a value silently comes
  // out wrong.
  const validated = plugin.Config({ channel: "direct", attempts: 5 });
  const raw = { channel: "direct", attempts: 5 };

  for (const [label, section] of [
    ["validated", validated],
    ["raw", raw],
  ]) {
    const options = plugin.resolveOptions(section);
    assert.equal(options.channel, "direct", \`\${label}: channel survives\`);
    assert.equal(options.attempts, 5, \`\${label}: attempts survives\`);
    assert.equal(options.apiKeyEnv, "TINYFISH_API_KEY", \`\${label}: the ref default applies\`);
    assert.equal(options.searchBase, "https://api.search.tinyfish.ai");
  }

  assert.deepEqual(
    plugin.resolveOptions(raw).filters,
    plugin.resolveOptions(validated).filters,
    "both shapes produce the same upstream filters",
  );
});

test("an unparseable value in a merged row degrades instead of poisoning it", () => {
  // A typo'd key, or a section object read as a scalar, must not become
  // "[object Object]" in a request URL.
  const options = plugin.resolveOptions({ monidBase: { nested: true }, attempts: 2 });
  assert.equal(options.monidBase, "https://api.monid.ai", "falls back to the default");
  assert.equal(options.attempts, 2);
});`;

if (!s.includes(from)) {
  console.log("MISS: the placeholder test");
  process.exit(1);
}
writeFileSync(p, s.replace(from, to));
console.log("replaced the placeholder with two real tests");
