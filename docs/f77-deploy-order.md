# F77 dashboard deploy order

```text
Merge PR to main
      │
      ▼
build-ui.yml on the merge SHA (wait for GREEN)
      │
      ▼
ui-dist release: ui-dist-<merge-sha>.zip + .sha256
      │  confirm the exact asset is attached
      ▼
Dispatch main.yml on that same main SHA
      │  fails closed if the exact asset is still missing
      ▼
Runner stages the verified single-file UI
      │
      ▼
Open the NEW ghrdp-* dashboard → hard-reload → verify ui: <sha7>
```

## Operator checklist

1. Merge the PR using GitHub's web UI.
2. Wait for `build-ui.yml` on `main` to finish GREEN; do not dispatch `main.yml` early.
3. In Releases, confirm `ui-dist-<merge-sha>.zip` and its `.sha256` sidecar exist on the `ui-dist` release.
4. Stop the old `ghrdp-*` session (close WEB DESKTOP and let it idle out), then dispatch a fresh `main.yml` run.
5. Open the new dashboard URL, hard-reload once (`Ctrl+Shift+R`), and confirm `ui: <merge-sha-7-chars>` in the footer and Search directly below Overview.

`main.yml` pins the release asset name to its `GITHUB_SHA`, waits up to 180 seconds for the matching `build-ui.yml` run, and then fails with an operator message if the asset is absent. It never silently substitutes a bundle from another SHA. `build-ui.yml` currently uses `push` and `workflow_dispatch` triggers; deployment remains an explicit operator dispatch so the dashboard runner is started only after the release is verified.
