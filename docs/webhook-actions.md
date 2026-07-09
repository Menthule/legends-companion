# Webhook trigger actions (Discord "batphone")

A trigger can post a message to a user-configured webhook when it fires — the
legitimate, log-only version of the raid batphone / camp-pop notifier that
players otherwise cobble together from grey-area MQ2 scripts or DIY Python.

## Design: named webhooks, URLs stay app-side

The trigger action stores only a **webhook name**, never a URL:

```json
{ "PostWebhook": { "template": "Batphone: ${msg}", "webhook": "raid" } }
```

The actual URL lives in the host app's settings, keyed by that name (`"raid"`
→ `https://discord.com/api/webhooks/…`). `webhook: null`/absent targets the
user's **default** webhook. This matters because triggers are *shareable* (LCS1
strings, `.gtp`, and the planned pack repo): a shared pack that embedded a URL
would leak the author's private endpoint to everyone who imported it. With the
name-only design, a shared trigger says "post to your `raid` webhook" and each
importer's own settings resolve it — or it silently no-ops if they have none.

## What's shipped (WSL-verified)

- `model.rs` — `Action::PostWebhook { template, webhook: Option<String> }`
  (serde-tagged like the other actions; `webhook` skipped when absent).
- `engine.rs` — `ActionSink::post_webhook(name, text)` (default no-op so every
  existing sink keeps compiling) and dispatch in `process_traced`: the template
  is expanded with the same capture/token substitution as `Speak`
  (`${msg}`, `{C}`, `{TS}`, …) and handed to the sink.
- Share/GINA export drops the action (no GINA equivalent).
- `library.rs` — the trigger tree's channel summary gains a `webhook` flag; the
  React `TriggerTreeEntry`/`TriggerAction` types and the plain-English trigger
  editor gain a "Post to webhook" action row (message template + optional
  webhook-name field, with the privacy note inline).
- CLI — `eqlog tail` prints `[WEBHOOK→<name>] <text>` when the action fires, so
  triggers can be exercised from the terminal.
- Tests — `engine_tests::post_webhook_action_expands_template_and_targets_named_webhook`.

## Follow-up: the HTTP send + settings (Windows — not built in WSL)

The engine calls `post_webhook`; nothing sends yet. To finish on Windows:

1. **Settings model** (`app/src-tauri/src/config.rs` + Settings UI): a list of
   `{ name, url }` webhooks and which name is the default. A "Send test" button
   that POSTs a hello message is worth the small effort — webhook setup is
   fiddly and users need the confirmation.
2. **`EmitSink::post_webhook`** (`app/src-tauri/src/tailing.rs`): resolve the
   name → URL from settings; if unknown/empty, drop with a one-line
   `app.log` note (never block the tail thread). POST
   `{ "content": <text> }` (Discord's shape; also fine for generic JSON hooks).
   - **Do the HTTP off the tail/audio threads.** Reuse the audio-thread pattern:
     a small dedicated sender thread with an `mpsc` queue, so a slow or hanging
     endpoint never stalls parsing or TTS. `ureq` (blocking, tiny) on that
     thread is simplest; pin the version in `app/src-tauri/Cargo.toml` (it is
     outside the workspace — no `workspace = true`).
   - **Rate-limit politely.** Discord returns 429 with `retry_after`; honor it,
     and coalesce bursts (a wipe can fire many triggers at once). A per-webhook
     minimum interval (e.g. 1–2 s) with last-message-wins coalescing avoids both
     bans and spam.
3. **Fight-summary embed (X7 part b, separate from the trigger action):** on
   fight end, optionally POST the top-N parse to a chosen webhook — reuse the
   paste-to-chat formatter that already exists for the clipboard export. This is
   a `meters.rs`/`store.rs`-side hook, not a trigger action; wire it once the
   sender thread above exists.

No id/override keys or existing action shapes changed, so this is purely
additive — old profiles and packs load unchanged.
