# Changelog

Notable changes to `dsh-tinyfish`, newest first. Deliberately no version
headings: this describes what the package does, not which release did it.

- Name the plugin **Tinyfish** in the plugins interface — both locale
  dictionaries and the settings card's own title.
- Collapse the settings card's shared configuration (channel, both
  credential fields, purpose, attempts) when search and fetch are both
  off, leaving the two switches and the both-off notice as the way back on.
- Gate the `purpose` field on the **fetch** switch, the only request that
  sends it; the old search gate hid it in exactly the state that needed it
  (search off, fetch on).
- Keep a switched-off kind registered but unavailable, so a provider the
  profile still pins fails loudly instead of falling through — and a
  withdrawn provider is skipped in auto-select rather than silently
  rerouting.
- Record that _unavailable_ conflates three causes the settings card can
  tell apart, and that `purpose` is one sentence attached to every fetch
  because the seam's fetch request carries a URL and nothing else.
- Update the live-test fixtures for upstream drift: `example.com` now
  extracts to an empty payload, and relative dates ("1 year ago") precede
  absolute ones in search results.
