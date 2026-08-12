# Changelog

## [0.3.0](https://github.com/hcrosse/opencode-pr-tracker/compare/v0.2.0...v0.3.0) (2026-08-12)


### Features

* accept schemeless pull request URLs ([#67](https://github.com/hcrosse/opencode-pr-tracker/issues/67)) ([c770cff](https://github.com/hcrosse/opencode-pr-tracker/commit/c770cff894c6ddebf9eeb5fc241856a93489f8da)), closes [#64](https://github.com/hcrosse/opencode-pr-tracker/issues/64)
* add guided feedback command ([#79](https://github.com/hcrosse/opencode-pr-tracker/issues/79)) ([0b1e091](https://github.com/hcrosse/opencode-pr-tracker/commit/0b1e0915cd3307b1378ab50dae1c472601920781))
* add session pull request listing ([#61](https://github.com/hcrosse/opencode-pr-tracker/issues/61)) ([1c62e01](https://github.com/hcrosse/opencode-pr-tracker/commit/1c62e01096d1d57bc991fdd41e89e46c261d1c13))
* collapse pull request sidebar section ([#74](https://github.com/hcrosse/opencode-pr-tracker/issues/74)) ([56b61b3](https://github.com/hcrosse/opencode-pr-tracker/commit/56b61b326b8dfe0d863c19fd011a6cdca45d3d65)), closes [#71](https://github.com/hcrosse/opencode-pr-tracker/issues/71)
* surface plugin updates ([#62](https://github.com/hcrosse/opencode-pr-tracker/issues/62)) ([de13438](https://github.com/hcrosse/opencode-pr-tracker/commit/de13438bef50b59ac1c8fc9ca8a0d79c6dd49d13))
* surface policy-required branch updates ([#63](https://github.com/hcrosse/opencode-pr-tracker/issues/63)) ([2f39b72](https://github.com/hcrosse/opencode-pr-tracker/commit/2f39b7273002a8b35594e9da8cee1fbc05205c81))


### Bug Fixes

* accept schema-valid status rollups ([#54](https://github.com/hcrosse/opencode-pr-tracker/issues/54)) ([25ae53b](https://github.com/hcrosse/opencode-pr-tracker/commit/25ae53b2302d9c4b7d8ddd7850164f46b53e2a85))
* cancel dialogs when plugin lifecycle ends ([#57](https://github.com/hcrosse/opencode-pr-tracker/issues/57)) ([e10f0a2](https://github.com/hcrosse/opencode-pr-tracker/commit/e10f0a26dce1853d54722a55fee4f746fb29849c))
* ignore superseded cancelled checks ([#75](https://github.com/hcrosse/opencode-pr-tracker/issues/75)) ([d1f63ad](https://github.com/hcrosse/opencode-pr-tracker/commit/d1f63add45e012dafccee424ca0529f6bf3f77de))
* preserve attachment invocation order ([#73](https://github.com/hcrosse/opencode-pr-tracker/issues/73)) ([dd5e12d](https://github.com/hcrosse/opencode-pr-tracker/commit/dd5e12dc807062a066c4da374c3d65cfbfa54a9e))
* reject unresolved pull request attachments ([#77](https://github.com/hcrosse/opencode-pr-tracker/issues/77)) ([4243e3d](https://github.com/hcrosse/opencode-pr-tracker/commit/4243e3dff8b701775c28722f69122c7612a9360c))

## [0.2.0](https://github.com/hcrosse/opencode-pr-tracker/compare/v0.1.0...v0.2.0) (2026-08-11)


### Features

* add manual pull request status sync ([#44](https://github.com/hcrosse/opencode-pr-tracker/issues/44)) ([3f9f986](https://github.com/hcrosse/opencode-pr-tracker/commit/3f9f986d49b7178e0e88bcbb598adcb636307182))


### Bug Fixes

* dispose TUI event subscriptions ([#46](https://github.com/hcrosse/opencode-pr-tracker/issues/46)) ([0ef55f8](https://github.com/hcrosse/opencode-pr-tracker/commit/0ef55f89618d199bd7f11467473686475af77784))
* normalize pull request identity casing ([#48](https://github.com/hcrosse/opencode-pr-tracker/issues/48)) ([e7be8b0](https://github.com/hcrosse/opencode-pr-tracker/commit/e7be8b0da1aab3f0e39ec42905213325d1abd117))
* reject backslashes in pull request URLs ([#45](https://github.com/hcrosse/opencode-pr-tracker/issues/45)) ([740d888](https://github.com/hcrosse/opencode-pr-tracker/commit/740d8881771db4d1fe8db08cd70d7019149129e6))

## 0.1.0 (2026-08-11)


### Features

* add sidebar PR tracker ([0390c8e](https://github.com/hcrosse/opencode-pr-tracker/commit/0390c8ea367430ae478349fbec2b48f6b3090fe9))
* add sidebar PR tracker ([c194b69](https://github.com/hcrosse/opencode-pr-tracker/commit/c194b6914cc6dcd5c90114db5bb48120f720fcfc))
* attach pull requests by number ([#32](https://github.com/hcrosse/opencode-pr-tracker/issues/32)) ([c44b769](https://github.com/hcrosse/opencode-pr-tracker/commit/c44b769c9e7621203e0a21fc4cf9abda97d9dbc5))
* clean up deleted session state ([#31](https://github.com/hcrosse/opencode-pr-tracker/issues/31)) ([9b6a538](https://github.com/hcrosse/opencode-pr-tracker/commit/9b6a5388f3ed77c0f41523df22c746813a16a3c0))
* detach pull requests by number ([#30](https://github.com/hcrosse/opencode-pr-tracker/issues/30)) ([5e58c14](https://github.com/hcrosse/opencode-pr-tracker/commit/5e58c14774f76b6ce37c58cb8d3b002f351eaa68))
* display merge conflicts in sidebar ([#29](https://github.com/hcrosse/opencode-pr-tracker/issues/29)) ([14553c0](https://github.com/hcrosse/opencode-pr-tracker/commit/14553c0f1e65c9b6e0c23139bcb4a9d4148c521a))
* surface actionable GitHub CLI diagnostics ([#33](https://github.com/hcrosse/opencode-pr-tracker/issues/33)) ([4b87029](https://github.com/hcrosse/opencode-pr-tracker/commit/4b87029d601efe885fa2e9ac080ef7511f6db07c))


### Bug Fixes

* detect reopened pull requests ([#22](https://github.com/hcrosse/opencode-pr-tracker/issues/22)) ([e17bbe4](https://github.com/hcrosse/opencode-pr-tracker/commit/e17bbe47835d04cc0e9e1fe094f0e4374b987733))
* prevent polling restart after stop ([#21](https://github.com/hcrosse/opencode-pr-tracker/issues/21)) ([0f5b85c](https://github.com/hcrosse/opencode-pr-tracker/commit/0f5b85c4cd290b0167d0591e216ee4ff36446167))
