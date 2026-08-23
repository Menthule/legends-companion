# Privacy and network activity

Legends Companion is local-first. It reads the EverQuest Legends text log and
files that the player explicitly selects or imports. It does not read game
memory, inject code, capture packets, or upload logs, character names, chat,
combat history, inventory, settings, or diagnostics.

## Data kept on the computer

The app stores settings, per-character profiles, user triggers, overlay
positions, inventory snapshots, career/session history, watches, and a rotating
diagnostic log under its application data directory. Portable mode stores the
same data in the writable `data/` directory beside the executable. Uninstalling
the application may leave this user data in place so a reinstall can recover
it; remove that directory manually when permanent deletion is intended.

Diagnostic logs are local, rotate at approximately 2 MB, and are never sent
automatically. A player may choose to paste selected diagnostics into a GitHub
issue. The in-app feedback helper excludes raw logs, character names, profile
data, and local file paths from its generated report.

## Automatic network requests

The desktop app makes HTTPS requests to GitHub-hosted release endpoints to:

- check for signed application updates;
- check and download signed reference-data, trigger, and News generations; and
- open a feedback form only after the player selects it.

GitHub receives ordinary request metadata such as the source IP address, time,
user agent, and requested asset. Legends Companion has no analytics SDK,
advertising identifier, telemetry service, crash uploader, account system, or
background upload of player content. It does not connect to EverQuest game
servers. External links open in the system browser and are then governed by the
destination site's privacy terms.

## Build-time research services

Private build automation fetches public documentation and, when an owner has
configured a bot, exact allowlisted Discord announcement channels. That worker
runs in GitHub Actions, not on player computers. It strips attachment URLs and
credential-like values, publishes announcements as observed evidence only, and
does not ingest private messages or arbitrary servers or channels.

Report a privacy or security concern privately to the maintainer before
including sensitive logs or personal information in a public issue.
