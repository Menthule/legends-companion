# Release 1.0 — Windows-side checklist

Work that CANNOT be done from WSL (no webview/GTK toolchain; app/src-tauri does
not compile here). Run all of this on a Windows dev box or in CI. Imperative
steps; check each box before tagging `v1.0.0`.

## A. Auto-updater wiring (tauri-plugin-updater)

The updater is NOT wired yet. Do this end-to-end on Windows:

- [ ] Add the dependency in `app/src-tauri/Cargo.toml`: `tauri-plugin-updater = "2"`
      (match the `"2"` style of the other tauri plugins).
- [ ] Generate a signing keypair:
      `cd app && npm run tauri signer generate -- -w %USERPROFILE%\.tauri\legends-companion.key`
      (writes the private key + prints the public key; keep the password used).
- [ ] Put the PUBLIC key in `app/src-tauri/tauri.conf.json` under
      `plugins.updater.pubkey`, and add an `plugins.updater.endpoints` array
      pointing at the release manifest, e.g.
      `https://github.com/Menthule/legends-companion/releases/latest/download/latest.json`.
- [ ] Register the plugin in `app/src-tauri/src/lib.rs`. It exposes a JS API, so
      it DOES need a capability entry — add `updater:default` to
      `app/src-tauri/capabilities/default.json` `permissions` (unlike
      single-instance, which needs none on Windows).
- [ ] Add an install/dialog flow (check on launch -> prompt -> download+install).
- [ ] In `.github/workflows/release.yml`, export the signing secrets on the
      `build desktop app (NSIS installer)` step:
      `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
      sourced from repo Actions secrets. `npm run tauri build` then emits the
      `.sig` files next to the NSIS installer.
- [ ] Add the `.sig` files to the `publish release` step's `files:` list, and
      publish a `latest.json` update manifest (version, notes, per-target url +
      signature) as a release asset so the `endpoints` URL above resolves.
- [ ] Verify: install an older build, publish a newer tag, confirm the running
      app detects, downloads, signature-checks, and installs the update.

## B. Verify this session's unverifiable src-tauri changes

These compiled clean on TypeScript but the Rust half was never built in WSL.
Build on Windows and confirm no errors:

- [ ] `cd app && npm ci` then `npm run tauri build` — must compile with the
      new `tauri-plugin-single-instance = "2"` dependency.
- [ ] For a faster inner loop: `cd app/src-tauri && cargo build` and
      `cargo clippy --all-targets -- -D warnings`.
- [ ] Confirm the single-instance closure signature matches the installed
      crate version — this session used `|app, _args, _cwd|` with
      `app.get_webview_window("main")` then `unminimize/show/set_focus`. If the
      2.x API differs, fix the closure args here (documented as `|app, argv, cwd|`).
- [ ] Confirm `commands::log_stats` builds and returns `{ sizeBytes }` — the
      Settings "Current size" line and >500 MB amber warning must render.
- [ ] Build with meters.rs healing fields (other agent) present — confirm the
      combined src-tauri tree still compiles.

## C. Real-log desktop verification pass

Run the built app against a real `eqlog_*.txt` while playing/replaying:

- [ ] TTS: a fired Speak trigger is spoken (Windows `tts` backend).
- [ ] Editor discard: unsaved trigger edits raise the NATIVE confirm dialog
      (not `window.confirm`) and Cancel keeps the edits.
- [ ] Sound preview: a missing/invalid custom sound file surfaces the error
      path (amber `.ted-warn`), not silent success.
- [ ] Single instance: launch the app twice — the second launch must focus/show
      the existing window and exit, NOT open a rival that writes config/DB.
- [ ] Overlay click-through: locked overlays ignore the mouse; unlock lets them
      be dragged; re-lock restores click-through.
- [ ] Log-size warning: point at a >500 MB log and confirm the archiving nudge
      shows; point at a small/absent log and confirm it does not.

## D. Tag and ship

- [ ] Bump `version` in `app/src-tauri/Cargo.toml` + `tauri.conf.json` to `1.0.0`.
- [ ] Push tag `v1.0.0` (triggers the `windows` job in release.yml) or run the
      workflow via `workflow_dispatch` with `tag_name: v1.0.0`.
- [ ] Confirm the `publish release` step attached the NSIS `.exe`, `eqlog.exe`,
      and (once A is done) the `.sig` files + `latest.json`.
