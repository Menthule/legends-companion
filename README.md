# Legends Companion

Legends Companion is a free, local-first companion app for **EverQuest
Legends**. It reads the plain-text log file written by the game; it does not
read game memory, inject code, capture packets, or upload player data.

This public repository is the official delivery and player-feedback surface.
It contains installers, signed application updates, signed rolling data
channels, release notes, privacy information, and public issue forms. Current
development source and build automation are maintained separately in a private
repository.

## Install

1. Download the `.exe` installer from the [latest release][latest].
2. Compare its SHA-256 hash with the release's `SHA256SUMS` file.
3. Run the installer. Until the project has an Authenticode certificate,
   Windows SmartScreen may require **More info -> Run anyway**.
4. In EverQuest Legends, enter `/log on`, then select the character's log file
   in Legends Companion.

The application verifies signed updater artifacts before installing them.
Reference data, News, and trigger packs use a separate signed content channel
and retain the last verified generation if an update is incomplete or invalid.

## Help and feedback

- [Report a bug][bug]
- [Suggest an idea][idea]
- [Report a missing trigger][trigger]
- [Read the privacy and network-activity policy](PRIVACY.md)

Issues are public. Remove character names, private paths, unrelated log text,
and anything else you do not want posted publicly.

## Source and licensing

Revisions of Legends Companion that were publicly released as source remain
available to anyone who already obtained or forked them under their applicable
MIT license. Making current development private does not revoke those grants.

Distributed builds include the copyright, license, and third-party attribution
notices required by their components. EverQuest is a trademark of Daybreak
Game Company LLC. Legends Companion is not affiliated with or endorsed by
Daybreak Game Company.

[latest]: https://github.com/Menthule/legends-companion/releases/latest
[bug]: https://github.com/Menthule/legends-companion/issues/new?template=bug.yml
[idea]: https://github.com/Menthule/legends-companion/issues/new?template=idea.yml
[trigger]: https://github.com/Menthule/legends-companion/issues/new?template=missing-trigger.yml
