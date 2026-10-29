# Shadow-OmniTrace

Multi-platform public-profile toolkit for the terminal. **Made by: NullKat Development.**
Single file (`intel.js`), no dependencies, Node.js 18+, designed for Android Termux.

It only uses official or documented sources and says so plainly when a platform has no legitimate lookup.
A blocked request (403, login wall, rate limit, network failure) is **never** reported as "not found".

## Install (Termux)

```bash
pkg update && pkg install nodejs git -y
cd ~/shadow-omnitrace        # folder containing intel.js
node --version               # must be v18 or newer
```

## Run

```bash
node intel.js
```

Other forms: `node intel.js --scan NAME [--platforms github,medium] [--json]`, `--version`, `--help`.
Flags: `--no-color`, `--no-animation`, `--no-clear`. `NO_COLOR=1` also disables color.

## What really works

| Platform | Status | Source |
|---|---|---|
| GitHub | works without a key | GitHub REST API |
| Medium | works without a key | public RSS feed |
| Telegram | works without a key | public t.me preview page (not an official API) |
| Roblox | works without a key | Roblox web APIs |
| YouTube, Twitch, Reddit, X, Instagram, Threads, PUBG | need your own credentials | official APIs (see below) |
| TikTok, Facebook, Pinterest, Snapchat, Discord, LinkedIn | **unavailable** | no legitimate public lookup exists |
| Mobile Legends | **unavailable** | no official public API |

The credentialed adapters were written from the official documentation and tested only against a simulated network.
They have not been run against live accounts. Instagram only sees Business/Creator accounts, Threads only public accounts
with 100+ followers, Reddit requires an app registration, and X may charge per call.

## Credentials

Set environment variables or put them in `~/.shadow-omnitrace/.env` (or `./.env`); see `.env.example`.
Keys are never printed, saved to history or written into reports (a redaction pass also strips them from output).

## Result states

FOUND · NOT FOUND · UNVERIFIED · UNAVAILABLE · RATE LIMITED · ERROR · SKIPPED (invalid username, no request sent).
Results are independent per platform: the same username on two platforms does not mean the same person.

## Data stored

- `~/.shadow-omnitrace/config.json`: settings
- `~/.shadow-omnitrace/history.json`: optional summaries (query, states, URLs, sources, timestamps; no bios or counts)
- Reports: `~/shadow-omnitrace/reports/` (change in Settings). Exports happen only when you confirm.

## Menu

1 Social Media Intelligence · 2 Username Scanner · 3 Profile Analysis · 4 Search History · 5 Export Reports ·
6 Scan Configuration · 7 Source and API Status · 8 Help · 9 About · 10 Clear Terminal · 11 Refresh Data ·
12 Batch Username Check (max 10) · 13 Platform Information · 14 Settings · 15 Credits · 16 Gaming Intelligence · 17 Exit

Ctrl+C cancels a running scan (partial results stay on screen, nothing is saved to history); at a prompt it exits cleanly.

## Limitations

- No bypass of CAPTCHAs, logins, rate limits or anti-bot systems, and no private data.
- Free-tier reality: GitHub allows 60 unauthenticated requests/hour per IP; PUBG developer keys allow 10 requests/minute.
- Platform policies change; check each platform's current terms before relying on a source.
