# Optional native modules

`styr-terminal/` is created here by `scripts/fetch-native-terminal.mjs` in the protected release
job (or by hand for local testing) and copied into the app's resources by electron-builder. It is
git-ignored and absent in a normal checkout, which is expected: Styr runs with xterm.js only.

For local development against a build of the private engine, point `STYR_TERMINAL_PATH` at its
package directory instead (dev builds only), or copy that directory here.
