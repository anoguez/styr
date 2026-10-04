# Changelog

## [0.14.0](https://github.com/anoguez/styr/compare/v0.13.0...v0.14.0) (2026-10-04)


### Features

* inbox view ([#46](https://github.com/anoguez/styr/issues/46)) ([56ea9f6](https://github.com/anoguez/styr/commit/56ea9f68491439beeb002e49843172ab25f03b81))

## [0.13.0](https://github.com/anoguez/styr/compare/v0.12.0...v0.13.0) (2026-10-04)


### Features

* terminal UI — context bar, command blocks and agent actions ([#45](https://github.com/anoguez/styr/issues/45)) ([73839f9](https://github.com/anoguez/styr/commit/73839f9509d0a30d7eba32777dcf9dc9a42807e9))


### Documentation

* align CLAUDE.md with the Codex provider and agentSession ([#43](https://github.com/anoguez/styr/issues/43)) ([367985a](https://github.com/anoguez/styr/commit/367985aca616944e826ee153525a5db4ec1b83be))

## [0.12.0](https://github.com/anoguez/styr/compare/v0.11.0...v0.12.0) (2026-10-04)


### Features

* cap the Done column and add task archiving ([#38](https://github.com/anoguez/styr/issues/38)) ([60c816a](https://github.com/anoguez/styr/commit/60c816a89154f96baf401763dde974ae59d08aba))
* order board columns by priority, then working agents ([#40](https://github.com/anoguez/styr/issues/40)) ([e064da8](https://github.com/anoguez/styr/commit/e064da8346c2ed5451a28bac0792e959c6513a4f))
* read-only Changes (git diff) view for tasks ([#41](https://github.com/anoguez/styr/issues/41)) ([7c3c603](https://github.com/anoguez/styr/commit/7c3c60384040cd30bed96b8f904064e96216d682))


### Bug Fixes

* resume Codex tasks without permission overrides ([#42](https://github.com/anoguez/styr/issues/42)) ([460a77a](https://github.com/anoguez/styr/commit/460a77af1cbb2048ae1cc66bcf61bb99e06664c3))

## [0.11.0](https://github.com/anoguez/styr/compare/v0.10.0...v0.11.0) (2026-10-03)


### Features

* add Claude approval mode setting using --permission-mode auto ([#34](https://github.com/anoguez/styr/issues/34)) ([cf48c69](https://github.com/anoguez/styr/commit/cf48c69e28da600acee60864753faa09b6dcc50f))
* confirm before deleting a task ([#33](https://github.com/anoguez/styr/issues/33)) ([499960f](https://github.com/anoguez/styr/commit/499960f2e0894531e2fb6ad2fc07ac2e413443c1))
* make card priority stripe discoverable with a larger hover target and chip ([#36](https://github.com/anoguez/styr/issues/36)) ([8545ed0](https://github.com/anoguez/styr/commit/8545ed00228ab0b46c06468c6fc48cd7a2ca37be))
* **mcp:** accept baseBranch in create_task and update_task ([#37](https://github.com/anoguez/styr/issues/37)) ([8cf1abb](https://github.com/anoguez/styr/commit/8cf1abb008b95dcbde980dd902868db472f9f829))
* restyle the settings dialog to match the new design ([#31](https://github.com/anoguez/styr/issues/31)) ([e9b3381](https://github.com/anoguez/styr/commit/e9b338198355506bd0e78587dd9bdb5eb8c42cca))


### Bug Fixes

* start worktrees from the latest origin, with a selectable base branch ([#35](https://github.com/anoguez/styr/issues/35)) ([0d300d5](https://github.com/anoguez/styr/commit/0d300d5d6a86310d7067dddc138eb08da975110b))

## [0.10.0](https://github.com/anoguez/styr/compare/v0.9.0...v0.10.0) (2026-10-03)


### Features

* add ⇧⌘N quick-add overlay that files tasks as needs-spec backlog ([#29](https://github.com/anoguez/styr/issues/29)) ([32b7684](https://github.com/anoguez/styr/commit/32b7684429abba9ef416c3e5c90a2d1c0d0fcf44))


### Bug Fixes

* make the task title outline visible and flag a missing title on save ([#30](https://github.com/anoguez/styr/issues/30)) ([0527cf6](https://github.com/anoguez/styr/commit/0527cf6c50d461cad4066d5b36872375d2d624ef))
* stop the task dialog closing when the backdrop is clicked ([#27](https://github.com/anoguez/styr/issues/27)) ([cfafe00](https://github.com/anoguez/styr/commit/cfafe002871815f2736a347547f96cdcccb0df16))

## [0.9.0](https://github.com/anoguez/styr/compare/v0.8.0...v0.9.0) (2026-10-02)


### Features

* keep settings per workspace ([#25](https://github.com/anoguez/styr/issues/25)) ([b054bb5](https://github.com/anoguez/styr/commit/b054bb5d90eed7edaf833fab6fa855cbf1c08a8c))

## [0.8.0](https://github.com/anoguez/styr/compare/v0.7.0...v0.8.0) (2026-10-01)


### Features

* add ⌘W shortcut to close the active terminal tab ([#23](https://github.com/anoguez/styr/issues/23)) ([afe88f1](https://github.com/anoguez/styr/commit/afe88f1489e82e97a10f2116764ae969431c9c4e))
* add Preferences settings tab with new-task defaults ([#19](https://github.com/anoguez/styr/issues/19)) ([c7bba32](https://github.com/anoguez/styr/commit/c7bba32a1099c5590b8501536ed27a15a3fe29aa))
* add workspaces — isolated boards switchable from the navbar ([#24](https://github.com/anoguez/styr/issues/24)) ([394dc70](https://github.com/anoguez/styr/commit/394dc70d4f786a57c3836faf5e49ce0cce6fc82d))
* show a muted app version beside the title bar wordmark ([#22](https://github.com/anoguez/styr/issues/22)) ([fb69489](https://github.com/anoguez/styr/commit/fb69489cd0ec14f17f9f8d1e1517f5f75b6bf6b7))
* show an optional PR link on the task card ([#20](https://github.com/anoguez/styr/issues/20)) ([20f47aa](https://github.com/anoguez/styr/commit/20f47aad1db5dc48d48cc3ddfcdef9956e2aeea7))


### Bug Fixes

* **codex:** drop --sandbox when using --approve-for-me ([#18](https://github.com/anoguez/styr/issues/18)) ([e235ffb](https://github.com/anoguez/styr/commit/e235ffb93e192d533d8068585859fb37434d3457))

## [0.7.0](https://github.com/anoguez/styr/compare/v0.6.0...v0.7.0) (2026-10-01)


### Features

* done means landed; clean up worktree and branches after landing ([#16](https://github.com/anoguez/styr/issues/16)) ([dfb32d2](https://github.com/anoguez/styr/commit/dfb32d2c5e3a1b765de44c423df696f9e3ea8fb4))
* redesign the task dialog with tabs and a details sidebar ([#17](https://github.com/anoguez/styr/issues/17)) ([97c5c2a](https://github.com/anoguez/styr/commit/97c5c2a56fe1e44a06acdf84f09cd8d8b5711e16))


### Bug Fixes

* neutralize bottom bar active colors ([#13](https://github.com/anoguez/styr/issues/13)) ([23204f1](https://github.com/anoguez/styr/commit/23204f14849334d5b0950ab423c90cf5153c9184))
* run Codex preflight checks through the login shell ([#15](https://github.com/anoguez/styr/issues/15)) ([330b11f](https://github.com/anoguez/styr/commit/330b11fcd0ffc61f52a42cd3d3710d736631645e))

## [0.6.0](https://github.com/anoguez/styr/compare/v0.5.0...v0.6.0) (2026-10-01)


### Features

* add Codex as an agent provider ([#11](https://github.com/anoguez/styr/issues/11)) ([7d1426f](https://github.com/anoguez/styr/commit/7d1426fd92897c76675c359bfff933ba81bcc34c))

## [0.5.0](https://github.com/anoguez/styr/compare/v0.4.0...v0.5.0) (2026-10-01)


### Features

* open a new terminal tab with ⌘T ([d3c7019](https://github.com/anoguez/styr/commit/d3c701989db2a635e85076a6d870b75c8bfacdee))


### Bug Fixes

* advertise truecolor to programs in the terminal ([64b9a08](https://github.com/anoguez/styr/commit/64b9a089c8312c1245866b11d8d298dca4ce0705))
* let ⌘T open a terminal tab when the panel has no sessions ([0df8c01](https://github.com/anoguez/styr/commit/0df8c01da8379bce85cd045fe3c78a3e47ed7d71))

## [0.4.0](https://github.com/anoguez/styr/compare/v0.3.0...v0.4.0) (2026-10-01)


### Features

* add the Styr wordmark to the title bar ([0d47df0](https://github.com/anoguez/styr/commit/0d47df021ef95bf9bbaa7cb69969eb7c05be0818))

## [0.3.0](https://github.com/anoguez/styr/compare/v0.2.0...v0.3.0) (2026-10-01)


### Features

* check for, download and install updates ([6bbf9d3](https://github.com/anoguez/styr/commit/6bbf9d391f85446b5c75e293daf6e460e6cf18c0))
* show the Styr rune in the title bar ([a8db2cd](https://github.com/anoguez/styr/commit/a8db2cd5d0974c2c31b4c27a20b769b5c3c6e62b))


### Bug Fixes

* don't pass inherited Claude Code session markers to agents ([5f4ac76](https://github.com/anoguez/styr/commit/5f4ac7697b7a5940acc1be55f60cc392bd1199b6))


### Documentation

* add a Buy Me a Coffee button to the Support section ([8bf5294](https://github.com/anoguez/styr/commit/8bf529473daef1b4e3394078ebac5b5d1dfd721a))
* add a screenshot to the README ([799ed9b](https://github.com/anoguez/styr/commit/799ed9b4ff33268fa5e2fb651e9a7840d0014c83))
* add Buy Me a Coffee to the README and the repo Sponsor button ([c3c9d01](https://github.com/anoguez/styr/commit/c3c9d0187144d9925d27bf448f5d6fe3a355d144))
* license Styr under FSL-1.1-MIT ([a159b94](https://github.com/anoguez/styr/commit/a159b941093a119069c7fb902cd973cc6fe58073))

## [0.2.0](https://github.com/anoguez/styr/compare/v0.1.0...v0.2.0) (2026-10-01)


### Features

* new app and menu bar icon ([351c5f4](https://github.com/anoguez/styr/commit/351c5f4987bbe626450899649a298cadfe70ecc0))


### Documentation

* document signing, releases and checks ([b459fb5](https://github.com/anoguez/styr/commit/b459fb5af43d66cc6e4809ce6a702d3e2c04e041))
