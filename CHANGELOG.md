# Changelog

## [0.24.0](https://github.com/anoguez/styr/compare/v0.23.0...v0.24.0) (2026-10-09)


### Features

* fold Auto-run into the Dispatch button and confirm before stopping it ([#116](https://github.com/anoguez/styr/issues/116)) ([492e6fd](https://github.com/anoguez/styr/commit/492e6fda51c3d30d9ab687d3c9c9c291823e4fd3))


### Bug Fixes

* apply Dispatch's Auto-run switch on confirm, not on toggle ([#109](https://github.com/anoguez/styr/issues/109)) ([25e1c42](https://github.com/anoguez/styr/commit/25e1c4258d76a6f156039e9f22b968441ef42a53))
* carry the chosen preset into the Quick add planning run ([#113](https://github.com/anoguez/styr/issues/113)) ([a4134fb](https://github.com/anoguez/styr/commit/a4134fbab2053c3ff9ba449d09c0003e1f84ecc8))
* make the built-in spec template and brief placeholder tool-agnostic ([#112](https://github.com/anoguez/styr/issues/112)) ([6973f0f](https://github.com/anoguez/styr/commit/6973f0f1650afa5a4601fe02ca456485a26c8795))
* reveal the terminal's folder in Finder instead of the 'Open files with' app ([#114](https://github.com/anoguez/styr/issues/114)) ([8b96be2](https://github.com/anoguez/styr/commit/8b96be297d483b392e5fe01bfae0b98abe077cca))
* scale the task dialog with the screen and label the red Delete button ([#110](https://github.com/anoguez/styr/issues/110)) ([cd86af7](https://github.com/anoguez/styr/commit/cd86af7906c8cce66c93f40d52a144a0618f898e))
* show a consistent agent status once a task reaches In Review ([#115](https://github.com/anoguez/styr/issues/115)) ([a3109e8](https://github.com/anoguez/styr/commit/a3109e874f22ff1f5a5d3ef19b203bb73f13fa12))

## [0.23.0](https://github.com/anoguez/styr/compare/v0.22.2...v0.23.0) (2026-10-09)


### Features

* show what other workspaces need from you beside the workspace switcher ([#107](https://github.com/anoguez/styr/issues/107)) ([e58a22b](https://github.com/anoguez/styr/commit/e58a22b6ed44828fc8e94a3a640113cc996d01bb))

## [0.22.2](https://github.com/anoguez/styr/compare/v0.22.1...v0.22.2) (2026-10-09)


### Bug Fixes

* diff a worktree against the branch it was cut from ([#105](https://github.com/anoguez/styr/issues/105)) ([b825d4d](https://github.com/anoguez/styr/commit/b825d4da59f338c94b44d0736adc922311214215))

## [0.22.1](https://github.com/anoguez/styr/compare/v0.22.0...v0.22.1) (2026-10-07)


### Bug Fixes

* make the Quick add planning brief organise the board, not only create tasks ([#101](https://github.com/anoguez/styr/issues/101)) ([c2540e4](https://github.com/anoguez/styr/commit/c2540e4a7b0a0ac8ab8d254d435e211435b88ea1))

## [0.22.0](https://github.com/anoguez/styr/compare/v0.21.0...v0.22.0) (2026-10-07)


### Features

* GitHub sync imports blocked-by, worktree default and ready status ([#97](https://github.com/anoguez/styr/issues/97)) ([dd68aa0](https://github.com/anoguez/styr/commit/dd68aa012712e17b22f5eff598898249add42a48))
* slash presets and ⌘↵ planning run in Quick add ([#99](https://github.com/anoguez/styr/issues/99)) ([750b4c5](https://github.com/anoguez/styr/commit/750b4c54b2b0acf76cf93e01827446425397a9f6))


### Bug Fixes

* focus the neighbouring terminal tab when closing the active one ([#100](https://github.com/anoguez/styr/issues/100)) ([3928510](https://github.com/anoguez/styr/commit/39285104c7cde9306fab692551f624544f3e542e))
* tell the task dialog's Preset and Agent prompt apart ([#95](https://github.com/anoguez/styr/issues/95)) ([3e93b6c](https://github.com/anoguez/styr/commit/3e93b6c725e322a7b80fdb81dac00caac36fd314))


### Documentation

* slim CLAUDE.md to core rules and move area notes to docs/architecture ([#98](https://github.com/anoguez/styr/issues/98)) ([4f75233](https://github.com/anoguez/styr/commit/4f752338cf005eb04eacca0a4b634e9d0b6daaae))

## [0.21.0](https://github.com/anoguez/styr/compare/v0.20.0...v0.21.0) (2026-10-07)


### Features

* Dispatch auto-run with stop (event-driven) ([#91](https://github.com/anoguez/styr/issues/91)) ([13b6d74](https://github.com/anoguez/styr/commit/13b6d74e9a3cfe788e90f462cfb80476866e1245))


### Bug Fixes

* offer only open tasks as blockers and move Blocked by to the sidebar ([#94](https://github.com/anoguez/styr/issues/94)) ([a3cc9c0](https://github.com/anoguez/styr/commit/a3cc9c0d803372b9f659963ffcf1be445ae2f349))
* open task for editing on double-click in the inbox ([#93](https://github.com/anoguez/styr/issues/93)) ([409c85a](https://github.com/anoguez/styr/commit/409c85aa3efae4770c8b537d780a7a57c5a30194))

## [0.20.0](https://github.com/anoguez/styr/compare/v0.19.0...v0.20.0) (2026-10-07)


### Features

* make Styr usable for non-coding tasks ([#90](https://github.com/anoguez/styr/issues/90)) ([bd40ce6](https://github.com/anoguez/styr/commit/bd40ce6616c458751f12dea19b102f34ed463c24))
* match v3 design for terminal tabs, search and status bar ([#87](https://github.com/anoguez/styr/issues/87)) ([c0a7ba3](https://github.com/anoguez/styr/commit/c0a7ba3abac4d23682b937cdd91acd92c6ce74d1))
* rename Orchestrate to Dispatch, add icon and Dispatching state ([#88](https://github.com/anoguez/styr/issues/88)) ([20e8826](https://github.com/anoguez/styr/commit/20e88266eefb0d3f54912240b100d8deff322016))
* show Claude and Codex subscription usage in the terminal bar ([#89](https://github.com/anoguez/styr/issues/89)) ([11ef554](https://github.com/anoguez/styr/commit/11ef5544415dd5d1da385510eab9541e6cbdaa33))
* split the palette into quick open (⌘P) and commands (⇧⌘P) ([#84](https://github.com/anoguez/styr/issues/84)) ([96b9d13](https://github.com/anoguez/styr/commit/96b9d136300b6a62994ea5af5c6512eb2da2efcb))
* task dependencies (blockedBy) ([#80](https://github.com/anoguez/styr/issues/80)) ([3a6e137](https://github.com/anoguez/styr/commit/3a6e137093f7a424611b72c7b0e1770cd098cbb7))
* task presets for the New task dialog ([#86](https://github.com/anoguez/styr/issues/86)) ([f60b6e8](https://github.com/anoguez/styr/commit/f60b6e820bc1281e1f0e9e15c9fb5d03e7d65ede))

## [0.19.0](https://github.com/anoguez/styr/compare/v0.18.1...v0.19.0) (2026-10-06)


### Features

* fixed footer slots on kanban cards (design 1b) ([#83](https://github.com/anoguez/styr/issues/83)) ([4366271](https://github.com/anoguez/styr/commit/4366271a6e6c1adb729adc1c0e5fa3ea852650ce))


### Bug Fixes

* open the changes dialog near full window ([#81](https://github.com/anoguez/styr/issues/81)) ([44fed33](https://github.com/anoguez/styr/commit/44fed332749d467a9d9d5f306c4c3bed7d7b570b))

## [0.18.1](https://github.com/anoguez/styr/compare/v0.18.0...v0.18.1) (2026-10-06)


### Bug Fixes

* label the idle agent state Idle, not Finished ([#78](https://github.com/anoguez/styr/issues/78)) ([40a526a](https://github.com/anoguez/styr/commit/40a526aaf6240c3f8b3c672eb9c30ab34486b743))

## [0.18.0](https://github.com/anoguez/styr/compare/v0.17.1...v0.18.0) (2026-10-06)


### Features

* external sources (GitHub) with a structural read-only guard ([#69](https://github.com/anoguez/styr/issues/69)) ([4d05562](https://github.com/anoguez/styr/commit/4d055627b1fe97808cce6245337989c63913e556))
* order the Done column by completion date, newest first ([#70](https://github.com/anoguez/styr/issues/70)) ([07ef72c](https://github.com/anoguez/styr/commit/07ef72cf7e9a0bebd87038aa025940dc956b253c))
* remove an agent from a task, with confirmation ([#63](https://github.com/anoguez/styr/issues/63)) ([576410d](https://github.com/anoguez/styr/commit/576410db284fed264eca581f5e45e372076a4187))


### Bug Fixes

* focus the terminal when switching to its tab ([#66](https://github.com/anoguez/styr/issues/66)) ([bb6c15e](https://github.com/anoguez/styr/commit/bb6c15e33ab4a71310a595528685b1a138a2ff38))
* leave Done tasks out of the status bar task count ([#68](https://github.com/anoguez/styr/issues/68)) ([9a6397d](https://github.com/anoguez/styr/commit/9a6397db1b9fdb29d992a372ac0d4f6f8e4fc59e))
* let Codex agents reach the network so gh and git push work ([#67](https://github.com/anoguez/styr/issues/67)) ([af63333](https://github.com/anoguez/styr/commit/af6333331732ff3b71920b5e892e3a3ef2309a3a))
* return a specced task to Backlog so Orchestrate can pick it up ([#65](https://github.com/anoguez/styr/issues/65)) ([9a514ab](https://github.com/anoguez/styr/commit/9a514ab81954d94484cfc551392b7f03db7a6793))

## [0.17.1](https://github.com/anoguez/styr/compare/v0.17.0...v0.17.1) (2026-10-06)


### Performance

* stop re-checking landed worktrees on every task write; add Performance panel ([#61](https://github.com/anoguez/styr/issues/61)) ([4cc2daf](https://github.com/anoguez/styr/commit/4cc2daff8914e89847089d8112675958133d6239))

## [0.17.0](https://github.com/anoguez/styr/compare/v0.16.0...v0.17.0) (2026-10-06)


### Features

* ⌘1–⌘9 switch terminal tabs; board and inbox move to ⌃1 and ⌃2 ([#59](https://github.com/anoguez/styr/issues/59)) ([a79991a](https://github.com/anoguez/styr/commit/a79991ab21ccde7d365e8576114a0b9910fdec1b))
* ask agent opens a question prompt and forks the chat in task sessions ([#56](https://github.com/anoguez/styr/issues/56)) ([4c48dcc](https://github.com/anoguez/styr/commit/4c48dcc0e60aaeef2f029ae29dbdc4c161e27aac))
* built-in themes carry a full palette and add light themes ([#58](https://github.com/anoguez/styr/issues/58)) ([ed89e2a](https://github.com/anoguez/styr/commit/ed89e2adf82a1bfe0a4dedf6b546f22b75b453b4))
* double-click empty Backlog space to quick add a task ([#55](https://github.com/anoguez/styr/issues/55)) ([a65cd31](https://github.com/anoguez/styr/commit/a65cd31a8a06e7a3c145c02af3fee7d06ece5006))


### Bug Fixes

* measure landing against the task's base branch and stop repeating cleanup notes ([#60](https://github.com/anoguez/styr/issues/60)) ([483caf4](https://github.com/anoguez/styr/commit/483caf4af39058aac82ed6e54ba09dc699f62a4b))

## [0.16.0](https://github.com/anoguez/styr/compare/v0.15.0...v0.16.0) (2026-10-06)


### Features

* allow folders as task context ([#54](https://github.com/anoguez/styr/issues/54)) ([608f5b1](https://github.com/anoguez/styr/commit/608f5b18882f932151db606e80679fabed052e9e))
* choose the app that opens files; open branch checkout in VS Code ([#53](https://github.com/anoguez/styr/issues/53)) ([fbb6277](https://github.com/anoguez/styr/commit/fbb6277493115255a99d4d3af39401e393af5e5a))


### Bug Fixes

* open terminal links externally and accept dropped files and folders ([#51](https://github.com/anoguez/styr/issues/51)) ([9c25d9c](https://github.com/anoguez/styr/commit/9c25d9c05786505c83602da39dc377723c1267bd))

## [0.15.0](https://github.com/anoguez/styr/compare/v0.14.0...v0.15.0) (2026-10-05)


### Features

* make header version clickable and highlight when an update is available ([#48](https://github.com/anoguez/styr/issues/48)) ([98be34f](https://github.com/anoguez/styr/commit/98be34f0be0b0c8cd09e4be2754dbafccc967133))


### Bug Fixes

* read an Activity heading without the marker as activity ([#50](https://github.com/anoguez/styr/issues/50)) ([1ca88c3](https://github.com/anoguez/styr/commit/1ca88c34912915117ca40ab62785b3b66ef7ecd3))

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
