# Security Policy

## Supported versions

This is a solo, actively-developed project — only the latest release gets
security fixes. There's no LTS branch and no backporting to older
versions; if you're on an old build, update first.

## Reporting a vulnerability

**Please don't open a public issue for a security vulnerability.**

Use GitHub's private reporting instead: go to the
[Security tab](https://github.com/BearddOddity/StatusForge.io/security)
→ **Report a vulnerability**. That opens a private advisory only the
maintainer (and anyone you add) can see, so the issue isn't public before
there's a fix.

If you'd rather not use that flow, a
[GitHub issue](https://github.com/BearddOddity/StatusForge.io/issues) is
fine for anything that isn't actively exploitable info (e.g. "this
dependency has a known CVE") — for anything that could let someone attack
a user before a fix ships, use the private route above.

This is a solo project with no dedicated security team, so response time
is best-effort — but reports get taken seriously and I'll acknowledge
what I can, when I can.

## Scope

**In scope**: StatusForge itself, the Blipy and Joystick Companion
apps, the update mechanism (signing, delivery), and how credentials are
stored/handled locally.

**Out of scope**: vulnerabilities in third-party platforms this project
integrates with (Twitch, Kick, Joystick.tv, Steam, GOG, RAWG, IGDB,
SteamGridDB, TheGamesDB, Streamer.bot) — report those to the platform
itself, not here.

## Relevant context for reports

- Update artifacts are signed with minisign; the app verifies signatures
  against a public key baked into the build before installing anything.
- OAuth tokens are stored in the OS's own credential store (Keychain,
  Credential Manager, etc.), never in plaintext config.
- The app doesn't collect telemetry or run its own backend — see the
  [Disclosure](https://bearddoddity.github.io/disclosure.html) and
  [Privacy Policy](https://bearddoddity.github.io/privacy.html) pages
  for the full picture of what it does and doesn't do.

## Good faith

Security research done in good faith — without exfiltrating user data,
degrading service for others, or accessing accounts you don't own — won't
be treated as an attack. Just report what you find instead of exploiting
it further.
