# quake-mp-server

Local-network multiplayer relay for the Three.js Quake clone.

## Run

```
cd server
npm install
npm start
```

The server listens on port `8080` (override with `PORT=...`).

## Connect

- Same machine: `ws://localhost:8080`
- Other machines on the LAN: `ws://<host-LAN-ip>:8080`

To find your LAN IP on Windows, run `ipconfig` and look for the IPv4 address on your active adapter (e.g. `192.168.1.42`). Other players on the same network point their client at that address.
