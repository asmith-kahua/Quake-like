// Local-network multiplayer relay server for the Three.js Quake clone.
// Pure relay: clients are authoritative over their own state and damage events.

'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 8080;
// Set HOST=127.0.0.1 to refuse all non-localhost connections (single-machine testing).
// Default 0.0.0.0 allows LAN clients (no auth - relies on your firewall).
const HOST = process.env.HOST || '0.0.0.0';
const TICK_HZ = 20;
const TICK_MS = Math.round(1000 / TICK_HZ);
const HEARTBEAT_TIMEOUT_MS = 5000;
const MAX_NAME_LEN = 24;

// Map<id, { id, ws, name, x, y, z, yaw, pitch, weapon, hp, lastSeen }>
const clients = new Map();

// Currently chosen map index (set by the first client that joins / picks).
// Reset when the last client disconnects so the next "first" can pick again.
let currentMapIndex = null;

function makeId() {
  // 6-char base36 random id
  return Math.random().toString(36).slice(2, 8);
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampName(raw) {
  if (typeof raw !== 'string') {
    return 'PLAYER';
  }
  // Strip control chars, limit length.
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) {
    return 'PLAYER';
  }
  return cleaned.length > MAX_NAME_LEN ? cleaned.slice(0, MAX_NAME_LEN) : cleaned;
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    // Swallow — failed sends will surface via close handler.
  }
}

function publicState(c) {
  return {
    id: c.id,
    name: c.name,
    x: c.x,
    y: c.y,
    z: c.z,
    yaw: c.yaw,
    pitch: c.pitch,
    weapon: c.weapon,
    hp: c.hp
  };
}

function broadcastExcept(excludeId, obj) {
  const payload = JSON.stringify(obj);
  for (const c of clients.values()) {
    if (c.id === excludeId) continue;
    if (c.ws.readyState !== c.ws.OPEN) continue;
    try { c.ws.send(payload); } catch (_) { /* ignore */ }
  }
}

function handleHello(client, msg) {
  client.name = clampName(msg && msg.name);

  // Send welcome with current peers (excluding self) and the active map (or null).
  const peers = [];
  for (const c of clients.values()) {
    if (c.id !== client.id) peers.push(publicState(c));
  }
  const isFirst = peers.length === 0 && currentMapIndex === null;
  safeSend(client.ws, {
    type: 'welcome',
    id: client.id,
    peers,
    map: currentMapIndex,   // null = no map chosen yet -> client should show map-select
    isFirst
  });

  console.log(`[${new Date().toISOString()}] hello id=${client.id} name="${client.name}" peers=${peers.length} map=${currentMapIndex} first=${isFirst}`);
}

function handleSetMap(client, msg) {
  if (!msg) return;
  const idx = isFiniteNum(msg.map) ? Math.floor(msg.map) : null;
  if (idx === null || idx < 0 || idx > 4) return;
  currentMapIndex = idx;
  console.log(`[${new Date().toISOString()}] setMap by id=${client.id} -> ${idx}`);
  // Broadcast to everyone (including the picker, so the local load goes through the same path).
  const payload = { type: 'mapChange', map: idx, by: client.id };
  for (const c of clients.values()) {
    if (c.ws.readyState !== c.ws.OPEN) continue;
    try { c.ws.send(JSON.stringify(payload)); } catch (_) { /* ignore */ }
  }
}

function handleState(client, msg) {
  if (!msg) return;
  if (isFiniteNum(msg.x)) client.x = msg.x;
  if (isFiniteNum(msg.y)) client.y = msg.y;
  if (isFiniteNum(msg.z)) client.z = msg.z;
  if (isFiniteNum(msg.yaw)) client.yaw = msg.yaw;
  if (isFiniteNum(msg.pitch)) client.pitch = msg.pitch;
  if (typeof msg.weapon === 'string' || isFiniteNum(msg.weapon)) {
    client.weapon = msg.weapon;
  }
  if (isFiniteNum(msg.hp)) client.hp = msg.hp;
  client.lastSeen = Date.now();
}

function validVec3(v) {
  return Array.isArray(v) && v.length === 3 && isFiniteNum(v[0]) && isFiniteNum(v[1]) && isFiniteNum(v[2]);
}

function handleShoot(client, msg) {
  if (!msg || !validVec3(msg.origin) || !validVec3(msg.dir)) return;
  broadcastExcept(client.id, {
    type: 'fx',
    fx: 'shoot',
    from: client.id,
    weapon: msg.weapon,
    origin: msg.origin,
    dir: msg.dir
  });
}

function handleRocket(client, msg) {
  if (!msg || !validVec3(msg.origin) || !validVec3(msg.dir)) return;
  broadcastExcept(client.id, {
    type: 'fx',
    fx: 'rocket',
    from: client.id,
    origin: msg.origin,
    dir: msg.dir
  });
}

function handleExplosion(client, msg) {
  if (!msg || !validVec3(msg.at)) return;
  broadcastExcept(client.id, {
    type: 'fx',
    fx: 'explosion',
    from: client.id,
    at: msg.at
  });
}

function handleHit(client, msg) {
  if (!msg) return;
  const targetId = typeof msg.targetId === 'string' ? msg.targetId : null;
  if (!targetId) return;
  const dmg = isFiniteNum(msg.dmg) ? msg.dmg : 0;
  const target = clients.get(targetId);
  if (!target) return;
  safeSend(target.ws, {
    type: 'hit',
    from: client.id,
    dmg
  });
}

function dispatch(client, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'hello': handleHello(client, msg); break;
    case 'state': handleState(client, msg); break;
    case 'shoot': handleShoot(client, msg); break;
    case 'rocket': handleRocket(client, msg); break;
    case 'explosion': handleExplosion(client, msg); break;
    case 'hit': handleHit(client, msg); break;
    case 'setMap': handleSetMap(client, msg); break;
    default: break;
  }
}

// ----- Server setup -----

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('quake-mp-server: WebSocket relay on /\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const id = makeId();
  const remote = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  const client = {
    id,
    ws,
    name: 'PLAYER',
    x: 0, y: 0, z: 0,
    yaw: 0, pitch: 0,
    weapon: 0,
    hp: 100,
    lastSeen: Date.now()
  };
  clients.set(id, client);
  console.log(`[${new Date().toISOString()}] connect id=${id} from=${remote} total=${clients.size}`);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    client.lastSeen = Date.now();
    dispatch(client, msg);
  });

  ws.on('close', () => {
    if (clients.delete(id)) {
      console.log(`[${new Date().toISOString()}] disconnect id=${id} total=${clients.size}`);
      broadcastExcept(id, { type: 'leave', id });
      // When the last player leaves, clear the map so the next "first" can pick.
      if (clients.size === 0) {
        currentMapIndex = null;
        console.log(`[${new Date().toISOString()}] map cleared (no players)`);
      }
    }
  });

  ws.on('error', (err) => {
    console.warn(`[${new Date().toISOString()}] socket error id=${id}: ${err && err.message}`);
  });
});

// 20Hz tick: send each client the latest state of every other peer.
setInterval(() => {
  if (clients.size === 0) return;
  const now = Date.now();

  // Reap stale clients.
  for (const c of clients.values()) {
    if (now - c.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[${new Date().toISOString()}] timeout id=${c.id}`);
      try { c.ws.terminate(); } catch (_) { /* ignore */ }
      clients.delete(c.id);
      broadcastExcept(c.id, { type: 'leave', id: c.id });
    }
  }

  if (clients.size === 0) return;

  // Build per-recipient peer lists (everyone except recipient).
  const all = [];
  for (const c of clients.values()) all.push(publicState(c));

  for (const c of clients.values()) {
    if (c.ws.readyState !== c.ws.OPEN) continue;
    const players = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i].id !== c.id) players.push(all[i]);
    }
    safeSend(c.ws, { type: 'peers', players });
  }
}, TICK_MS);

httpServer.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] quake-mp-server listening on ws://${HOST}:${PORT}`);
  console.log('  - Same machine: ws://localhost:' + PORT);
  console.log('  - LAN clients:  ws://<your-LAN-ip>:' + PORT + '  (find via `ipconfig`)');
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const c of clients.values()) {
    try { c.ws.close(); } catch (_) { /* ignore */ }
  }
  httpServer.close(() => process.exit(0));
});
