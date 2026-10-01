# Building and packaging

## Scripts

| Script | What it does |
| --- | --- |
| `yarn dev` | Run the app with hot reload — the header shows an amber `DEV` badge |
| `yarn build` | Typecheck both projects, build `out/`, and fail if renderer code pulls in a Node builtin |
| `yarn start` | Run the built app |
| `yarn mcp` | Run the MCP server on stdio (for debugging) |
| `yarn package` | Build a macOS `.app` and `.dmg` into `dist/` |
| `yarn icon` | Regenerate `resources/icon.icns` from `resources/icon.svg` |

`yarn build` is the check to run before committing. There is no separate test suite yet.

After changing dependencies, run `yarn postinstall` to rebuild the native modules (`node-pty`,
`better-sqlite3`) against Electron.

## Installing it as a Mac app

```sh
yarn package
```

That produces `dist/mac-arm64/Styr.app` and `dist/Styr-<version>-arm64.dmg`.
Drag the app into Applications, or:

```sh
cp -R "dist/mac-arm64/Styr.app" /Applications/
```

## Sharing it with someone else

The app is **ad-hoc signed but not notarised** — there is no Apple Developer ID involved. On your
own machine it opens normally, because a locally built app never gets a `com.apple.quarantine` flag.

On anyone else's Mac, Gatekeeper will block it once. Tell them to either:

- right-click the app → **Open** → **Open** again, or
- run `xattr -dr com.apple.quarantine "/Applications/Styr.app"`

If they instead see **"damaged and can't be opened"**, the build was not signed properly — check
`codesign --verify --deep --strict "Styr.app"` is silent and that `mac.identity` is `"-"`
rather than `null` in `electron-builder.yml`. `null` skips signing altogether and leaves the
bundle's resources unsealed, which macOS reports as damage rather than as an unknown developer.

Distributing without that manual step needs a Developer ID certificate and notarisation.

**Re-register the MCP server after packaging.** Use the command Settings shows verbatim, quotes
included — the installed path contains a space. The packaged app runs the MCP server from inside the
bundle, so its path differs from the dev one. Open Settings in the packaged app, copy the command it
shows, and run it — otherwise Claude keeps pointing at `out/` in this repo, which breaks if you move
or clean the checkout.

## The app icon

`resources/icon.svg` is the source; `resources/icon.icns` is generated from it:

```sh
yarn icon
```

That rasterises the SVG at 1024px, produces all ten `.iconset` renditions and runs `iconutil`.
Edit the SVG, re-run it, then `yarn package`. macOS only, and it uses Google Chrome to rasterise.

## Extension points

`externalRef` (`{ provider, id, url }`) is carried through the schema, frontmatter, index and MCP
payloads but nothing writes it yet — it is the hook for syncing tasks from Zendesk, Jira or another
MCP source later.

