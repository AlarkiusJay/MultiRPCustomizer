# MultiRP

> Multi-Rich Presence Customizer for your Discord Presence. Up to 5 profiles, each with its own Client ID. Toggle one active at a time.

Like [CustomRP](https://www.customrp.xyz), but with **profile tabs** so you can save multiple presence configs and switch between them with a click.

## Features

- **5 profile tabs**, each with its own Discord Application Client ID
- **Toggle any profile live** — only one runs at a time, instant switch
- **Live preview** while you edit
- **Live update** — change fields and push to Discord without disconnecting
- **128-char limits with live counters** on Details, State, and tooltip fields (Discord's hard cap)
- **2 buttons per profile** with URL validation — clickable for other users on Discord
- **Activity types**: Playing / Listening to / Watching / Competing in
- **Timestamps**: none / elapsed (auto-start) / custom start / custom range
- **Image keys** for Large + Small images (uploaded to Discord Dev Portal)
- **Party size** indicator
- **Per-profile JSON import/export**
- **Dark grey UI**, no telemetry, no accounts, fully local
- Auto-saves all profiles to disk

## Quick Start

1. **Install Discord** (the regular desktop client) and have it running.
2. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and create one application per profile you want.
3. (Optional) Upload images under **Rich Presence → Art Assets** in each app. The asset name is your "image key".
4. Copy each application's **Application ID** (Client ID) into a MultiRP profile.
5. Fill in Details / State / images / buttons. Click **Activate**.

Buttons appear clickable to **other users** viewing your profile, not yourself — that's a Discord platform limit, not a bug.

## Build From Source

```bash
npm install
npm start         # dev run
npm run build:win   # Windows .exe installer
npm run build:mac   # macOS .dmg
npm run build:linux # AppImage + .deb
```

Outputs go into `dist/`.

## Auto-Build & Release via GitHub Actions

This repo includes `.github/workflows/build.yml` which builds installers for **Windows, macOS, and Linux** in parallel whenever you push a tag like `v1.0.0`. Installers are attached to the GitHub Release automatically.

```bash
git tag v1.0.0
git push --tags
```

## Tech

- Electron 31 (main + preload + renderer with context isolation)
- [`discord-rpc`](https://www.npmjs.com/package/discord-rpc) for the Discord IPC handshake
- Plain HTML/CSS/JS renderer (no build step)
- Profiles persisted to your OS user-data folder

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright © 2026 Alarkius Elvya Jay.


You may use, modify, and redistribute MultiRP — including in commercial projects — provided you keep the `LICENSE` and `NOTICE` files intact and clearly mark any modifications. The Apache 2.0 license also includes an explicit patent grant: contributors cannot sue downstream users over patent claims on their contributions.

## Donations are Welcomed!
[AlarkiusEJ's Ko-Fi](https://ko-fi.com/AlarkiusEJ)

Donating at least a dollar or so can help this project stay alive! You also be helping the author out with different things and creative works. Fuel the dragon's caffeine addiction 🐉