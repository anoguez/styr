A profile as an earlier release left it, for `e2e/stability.e2e.ts`: `config.json` with the legacy
`workspaceDir` key (`__HOME__` becomes the throwaway HOME) and two task files. Refresh it when a
release changes what is on disk in a way the app must still read.
