# Changelog

## [0.6.4](https://github.com/viztor/dsh-tinyfish/compare/v0.6.3...v0.6.4) (2026-10-02)


### Bug Fixes

* **settings-page:** call the switches Provide and put them first ([d6b55ad](https://github.com/viztor/dsh-tinyfish/commit/d6b55ad1f61ef0aca8d355f44b6c043b77002b50))
* **settings-page:** show both channel keys and pair the switches ([2a2ca42](https://github.com/viztor/dsh-tinyfish/commit/2a2ca42fad21ae1af7c5a949a96060838a8ad281))
* **settings-page:** stop stating the credential's status twice ([dd10e6b](https://github.com/viztor/dsh-tinyfish/commit/dd10e6b439ccd716234034d0ee8268b37e3da838))

## [0.6.3](https://github.com/viztor/dsh-tinyfish/compare/v0.6.2...v0.6.3) (2026-10-02)


### Bug Fixes

* **client:** poll async fetch runs, cleanup abort listeners, and test describe invalidations ([482f874](https://github.com/viztor/dsh-tinyfish/commit/482f8746ab81110ceec3ee15b42e91cb42053a62))
* **settings:** persist and badge API key state via credentials.describe ([cf8ddc8](https://github.com/viztor/dsh-tinyfish/commit/cf8ddc84ec2022710bd130510574e8b98c690f00))

## [0.6.2](https://github.com/viztor/dsh-tinyfish/compare/v0.6.1...v0.6.2) (2026-10-02)


### Bug Fixes

* **ui:** adopt host typography tokens and standard field layout ([010c555](https://github.com/viztor/dsh-tinyfish/commit/010c55506f95cb17deb89ebbf4eef09136b813e8))

## [0.6.1](https://github.com/viztor/dsh-tinyfish/compare/v0.6.0...v0.6.1) (2026-10-01)


### Bug Fixes

* publish safely, register every published name, and ship plugin metadata ([7623b1f](https://github.com/viztor/dsh-tinyfish/commit/7623b1f12f1c8f13667fe40f358c769c0bd98d06))

## [0.6.0](https://github.com/viztor/dsh-tinyfish/compare/v0.5.0...v0.6.0) (2026-10-01)


### Features

* recommend installing directly via DSH Web UI ([d17bc3b](https://github.com/viztor/dsh-tinyfish/commit/d17bc3b7ec4cae81216d6a2f7c00e6ebf5d21a58))
* rewrite cordis.patch.yml plugin name for scoped package ([ac616d4](https://github.com/viztor/dsh-tinyfish/commit/ac616d45f3dae915f02bc6f7311be691350a491f))


### Code Quality & Refactoring

* align Vite+ lint configuration and code quality gates with dsh-opencode ([1358d72](https://github.com/viztor/dsh-tinyfish/commit/1358d7293eb08ad01e912443a9b1c7dc789178ad))
* add non-blocking scoped publishing resilience on npmjs.org


## [0.5.0](https://github.com/viztor/dsh-tinyfish/compare/v0.4.1...v0.5.0) (2026-10-01)


### Features

* declare the package icon the harness actually renders ([eb6ebcb](https://github.com/viztor/dsh-tinyfish/commit/eb6ebcb55e45d2bfa9145ef6cb76fdd3b085d798))


### Bug Fixes

* align locale.register return type with effect disposer signature ([2e64b29](https://github.com/viztor/dsh-tinyfish/commit/2e64b29c144fc6392a67bf45122942ece753daad))
* align settings namespace and row ID from web-tinyfish to dsh-tinyfish ([6cfa4ca](https://github.com/viztor/dsh-tinyfish/commit/6cfa4caf6b9bdcace99917d78b472a068a7e55f0))

## [0.4.1](https://github.com/viztor/dsh-tinyfish/compare/v0.4.0...v0.4.1) (2026-10-01)


### Bug Fixes

* mirror only the scoped name to GitHub Packages ([9270bba](https://github.com/viztor/dsh-tinyfish/commit/9270bba28e9837367ad55d18916f8233ddeb9d43))

## [0.4.0](https://github.com/viztor/dsh-tinyfish/compare/v0.3.0...v0.4.0) (2026-10-01)


### Features

* mirror both names to GitHub Packages ([8efd747](https://github.com/viztor/dsh-tinyfish/commit/8efd7472fc98854931601d3244b5e69be0103ff0))
* publish with a pasted token, no OTP round-trip ([5d21ab5](https://github.com/viztor/dsh-tinyfish/commit/5d21ab561da8ed1d83615d597ea61f14924cab5f))
* show both keys' status, and say where filters live ([6d7778c](https://github.com/viztor/dsh-tinyfish/commit/6d7778c664a8df3dbe75c863de570dd201b67cbd))
* social preview image for the repository ([4ce1064](https://github.com/viztor/dsh-tinyfish/commit/4ce1064c4e033ead53896d21cb6631e9a9270ba8))


### Bug Fixes

* accept a one-time password for the local scoped publish ([67a5016](https://github.com/viztor/dsh-tinyfish/commit/67a5016d699f24b0e688dc656962eb4382d2553d))
* dot notation for environment reads in the publish script ([7bd9b65](https://github.com/viztor/dsh-tinyfish/commit/7bd9b656de9250aa11dc35d55d5db4b53ef60905))
* provenance only where OIDC exists, and level the unscoped trust ([14f8905](https://github.com/viztor/dsh-tinyfish/commit/14f8905709171870f07ff4438280d0250e19420e))
* the settings page survives a missing key entry instead of crashing ([7e6ac38](https://github.com/viztor/dsh-tinyfish/commit/7e6ac387d4998dca2f2e6f0b48988630afb30d0e))

## [0.3.0](https://github.com/viztor/dsh-tinyfish/compare/v0.2.0...v0.3.0) (2026-10-01)


### Features

* a logo for the package ([2b5f24c](https://github.com/viztor/dsh-tinyfish/commit/2b5f24c950c865308320bcc71beea8e46eb354ad))
* restyle the logo into the Harness icon family ([89ea136](https://github.com/viztor/dsh-tinyfish/commit/89ea136fbeb26c2cb6032ed0b2fdaa1d78c4640e))


### Bug Fixes

* exempt the bot-owned changelog from the formatter ([e3219a5](https://github.com/viztor/dsh-tinyfish/commit/e3219a5648606c949c370c10fba1a8830fcbc7eb))
