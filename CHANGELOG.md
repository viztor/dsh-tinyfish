# Changelog

## [0.7.0](https://github.com/viztor/dsh-tinyfish/releases/tag/v0.7.0) (2026-10-03)

Version history restarts here. The commit log was flattened to a single
commit and every earlier tag, release and changelog entry was removed, so
this is the first release this file records. Everything below is present
in 0.7.0.

### Features

* name the plugin **Tinyfish** in the plugins interface — both locale
  dictionaries and the settings card's own title
* collapse the settings card's shared configuration (channel, both
  credential fields, purpose, attempts) when search and fetch are both
  off, leaving the two switches and the both-off notice as the way back on

### Bug Fixes

* gate the `purpose` field on the **fetch** switch — it is the only
  request that sends `purpose`, so the old search gate hid it in exactly
  the state that needed it (search off, fetch on)
* replace the live-test fixtures that upstream drift had invalidated:
  `example.com` now extracts to an empty payload, and relative dates
  ("1 year ago") now precede absolute ones in search results

### Documentation

* record what a switched-off kind actually does — it stays registered and
  reports unavailable, so a provider the profile still pins fails loudly
  instead of falling through
* record that _unavailable_ conflates three causes the settings card can
  tell apart, and that `purpose` is one sentence attached to every fetch
  because the seam's fetch request carries a URL and nothing else
