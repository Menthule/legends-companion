# Overlay modules

Overlays are registered modules, not branches in the app entry point. The
frontend catalog is `app/src/overlay/modules.tsx`; the backend window catalog is
`app/src-tauri/src/commands.rs::OVERLAYS`.

## Responsibilities

An overlay module owns:

- a stable action id such as `alerts` or `impact`;
- its webview route and Tauri window label;
- its React renderer and player-facing name/description;
- optional trigger-action fields and presentation controls;
- optional preview events for Settings.

The trigger engine does not know overlay-specific fields. It expands every
string in `Overlay.fields`, preserves `Overlay.config`, attaches trigger
identity, and emits `trigger-overlay`. The destination renderer validates and
interprets that payload.

## Adding an overlay

1. Add the React renderer under `app/src/overlay/`.
2. Register its id, route, window label, component, and description in
   `overlay/modules.tsx`. This automatically participates in entry-point
   routing and Settings visibility/arrange controls.
3. If triggers may target it, add its field/config descriptors and payload
   adapter to `app/src/lib/overlayRegistry.ts`. The trigger editor will render
   those controls without a destination-specific editor branch.
4. Add the matching backend descriptor to `commands.rs::OVERLAYS` and the
   static window/capability entries in `tauri.conf.json` and
   `capabilities/default.json`.
5. Extend the catalog integrity tests. Run the Rust workspace tests, Vitest,
   TypeScript check, and frontend production build.

Repeated Overlay actions are intentional fan-out. Each action has one
destination so its fields and presentation configuration remain independent:

```json
{
  "actions": [
    { "Speak": { "template": "root broke" } },
    {
      "Overlay": {
        "overlay": "alerts",
        "fields": { "text": "Root broke on ${1}" },
        "config": { "severity": "alarm", "durationMs": 8000 }
      }
    },
    {
      "Overlay": {
        "overlay": "raid-calls",
        "fields": { "target": "${1}", "effect": "root" },
        "config": { "priority": 2 }
      }
    }
  ]
}
```

Legacy `DisplayText` and `Impact` actions remain readable. Opening and saving
them in the editor migrates them to `Overlay` actions targeting `alerts` and
`impact` respectively.
