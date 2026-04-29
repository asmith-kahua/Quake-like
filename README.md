# Quake Clone (Three.js)

A browser-based Quake-style first-person shooter built with Three.js r128. Single-file static client plus an optional Node.js relay server for LAN multiplayer.

## Features

- Four levels: Slipgate Complex, Armory, Deep Halls, Palace of Fire
- Two weapons: rifle and rocket launcher (rocket-jumping supported)
- Procedural sound effects (no audio assets required)
- Top-down minimap
- Optional LAN multiplayer via a small Node.js relay server

## Run the client

Open `index.html` in a modern browser, or serve the directory with any static file server. No build step.

## Run the multiplayer server (optional)

```
cd server
npm install
npm start
```

The relay rebroadcasts player state to other clients on the LAN. Configure the client to point at the server's address from the in-game menu.

## Controls

| Input | Action |
|-------|--------|
| WASD | Move |
| Mouse | Look |
| LMB | Fire |
| 1 / 2 | Switch weapon |
| Shift | Sprint |
| Space | Jump |
| M | Toggle minimap |
| R | Respawn |
| Esc | Release pointer |

## Layout

- `index.html` - entry point
- `js/` - client modules (level, player, weapons, enemies, sound, minimap, network, main)
- `server/` - Node.js multiplayer relay
