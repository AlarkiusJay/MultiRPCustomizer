# MultiRP

> Multi-profile Discord Rich Presence manager. Up to 5 profiles, each with its own Client ID. Toggle one active at a time.

Inspired by [CustomRP](https://www.customrp.xyz) — reimagined with **profile tabs**, **system tray + auto-start**, and **drop-in compatibility with your existing CustomRP `.crp` presets**. Switch between presences with a single click. No accounts, no telemetry, fully local.

## ✨ Flagship Features

### 🔁 CustomRP File Compatibility
MultiRP reads and writes **CustomRP's native `.crp` format** — drag your existing presets straight in, no conversion step. Export back to `.crp` and hand them to friends still on CustomRP. Also supports **`.json`** (MultiRP native), **`.csv`**, **`.md`**, and **`.txt`** — with smart format detection by both file extension *and* content sniffing, so renamed files still work.

### 🗂️ Multi-Profile Tabs
Up to **5 profiles**, each with its own Discord Application Client ID. Toggle which one is live with a single click — perfect for creators juggling multiple personas, projects, or moods.

### 🚀 Auto-Start & System Tray
Launch with your OS, start minimized to the tray, and right-click the tray icon to activate/deactivate any profile without opening the window. Behaves like a real desktop app, not a tab you forgot about.

### 🎨 Live Editing
Live preview while you type, live push to Discord without disconnecting, and live character counters that respect Discord's hard 128-char and 32-char-button limits.

## Full Feature List

- **5 profile tabs**, each with its own Discord Application Client ID
- **Toggle any profile live** — only one runs at a time, instant switch
- **Live preview** + **live update** — change fields and push to Discord without disconnecting
- **CustomRP `.crp` import/export** — full two-way compat with existing CustomRP presets
- **Multi-format profile transfer** — `.crp`, `.json`, `.csv`, `.md`, `.txt` with auto-detection
- **System tray** with right-click activate/deactivate per profile
- **Auto-start at login** + **start minimized** (togglable, opt-in)
- **Close-to-tray** instead of quitting (togglable)
- **128-char limits with live counters** on Details, State, and tooltip fields
- **2 buttons per profile** with URL validation — clickable for other users on Discord
- **Activity types**: Playing / Listening to / Watching / Competing in
- **Timestamps**: none / elapsed (auto-start) / custom start / custom range
- **Image keys** for Large + Small images (uploaded to Discord Dev Portal)
- **Party size** indicator
- **In-app update logs** with auto-update from GitHub Releases
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
