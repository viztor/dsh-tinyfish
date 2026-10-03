# Changelog

Notable changes to `dsh-tinyfish`, newest first. Deliberately no version
headings: this describes what the package does, not which release did it.

## Features

- **Plugin name** — the plugins interface shows **Tinyfish**, in both
  locale dictionaries and on the settings card itself.
- **Collapsible settings card** — channel, both credential fields, purpose
  and attempts hide when search and fetch are both off, leaving the two
  switches and the both-off notice as the way back on.
- **Explicit availability** — a switched-off kind stays registered and
  reports unavailable rather than unregistering, so a provider the profile
  still pins fails loudly instead of falling through, and auto-select skips
  the withdrawn provider rather than silently rerouting. _Unavailable_
  conflates three causes — switch, credential, endpoint — which the
  settings card is able to tell apart.

## Fixes

- `purpose` is offered only for fetch, the one request that sends it. It
  used to follow the search switch, which hid it in exactly the state that
  needed it (search off, fetch on). The seam's fetch request carries a URL
  and nothing else, so a single configured sentence applies to every fetch.
- Live-test fixtures realigned with upstream drift: `example.com` now
  extracts to an empty payload, and relative dates ("1 year ago") precede
  absolute ones in search results.
