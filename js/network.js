// Multiplayer client networking module.
// Attaches to window.Game.Network. Pure relay protocol — see /server/server.js.

(function () {
  'use strict';

  window.Game = window.Game || {};

  const SEND_INTERVAL = 0.05; // 20 Hz
  const LERP_RATE = 12;       // higher = snappier
  const MAX_REMOTE_PLAYERS = 8;
  const RECONNECT_DELAY_MS = 2000;
  const DEFAULT_URL = 'ws://localhost:8080';

  // -------- Utility: deterministic hue from id --------
  function hashHue(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = (h * 31 + id.charCodeAt(i)) | 0;
    }
    // map to 0..1
    return ((h % 360) + 360) % 360 / 360;
  }

  function isFiniteNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  // -------- Name sprite --------
  function buildNameSprite(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.strokeText(name, canvas.width / 2, canvas.height / 2);
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.0, 0.5, 1);
    return sprite;
  }

  // -------- Remote player mesh --------
  // Tags every mesh in the group with userData.peerId so weapon raycasts
  // can resolve a hit back to the peer that owns the mesh.
  function tagRemoteMeshes(group, peerId) {
    group.traverse((m) => {
      if (m.isMesh) {
        m.userData.peerId = peerId;
        m.userData.isRemotePlayer = true;
      }
    });
  }

  // Shared geometries across all remote players (perf): all peers reuse the
  // same Box3 buffers — only their per-peer materials (HSL-tinted) are
  // cloned. Disposal of remote players (_disposeRemote) skips these.
  const SHARED_TORSO_GEOM = new THREE.BoxGeometry(0.6, 1.0, 0.35);
  const SHARED_HEAD_GEOM  = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  const SHARED_ARM_GEOM   = new THREE.BoxGeometry(0.18, 0.9, 0.18);
  const SHARED_LEG_GEOM   = new THREE.BoxGeometry(0.22, 0.85, 0.25);

  function buildRemotePlayerMesh(id, name) {
    const group = new THREE.Group();
    group.name = 'remote-player-' + id;

    const hue = hashHue(id);
    const baseColor = new THREE.Color().setHSL(hue, 0.75, 0.55);
    const accent = new THREE.Color().setHSL((hue + 0.5) % 1, 0.65, 0.5);

    const torsoMat = new THREE.MeshLambertMaterial({ color: baseColor });
    const headMat = new THREE.MeshLambertMaterial({ color: accent });
    const armMat = new THREE.MeshLambertMaterial({ color: baseColor });

    // Torso (centered roughly at chest height ~0.9m above feet)
    const torso = new THREE.Mesh(SHARED_TORSO_GEOM, torsoMat);
    torso.position.set(0, 0.9, 0);
    group.add(torso);

    // Head
    const head = new THREE.Mesh(SHARED_HEAD_GEOM, headMat);
    head.position.set(0, 1.65, 0);
    group.add(head);

    // Arms
    const leftArm = new THREE.Mesh(SHARED_ARM_GEOM, armMat);
    leftArm.position.set(-0.4, 0.9, 0);
    group.add(leftArm);
    const rightArm = new THREE.Mesh(SHARED_ARM_GEOM, armMat);
    rightArm.position.set(0.4, 0.9, 0);
    group.add(rightArm);

    // Legs (simple)
    const leftLeg = new THREE.Mesh(SHARED_LEG_GEOM, armMat);
    leftLeg.position.set(-0.16, 0.0, 0);
    group.add(leftLeg);
    const rightLeg = new THREE.Mesh(SHARED_LEG_GEOM, armMat);
    rightLeg.position.set(0.16, 0.0, 0);
    group.add(rightLeg);

    // Name sprite above head
    const nameSprite = buildNameSprite(name || 'PLAYER');
    nameSprite.position.set(0, 2.25, 0);
    group.add(nameSprite);

    tagRemoteMeshes(group, id);

    return {
      group,
      head,
      nameSprite,
      peerId: id,
      currentName: name || 'PLAYER',
      // Interpolation state
      target: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
      hp: 100,
      weapon: 0
    };
  }

  function updateNameSprite(remote, newName) {
    if (remote.currentName === newName) return;
    remote.currentName = newName;
    // Replace sprite texture
    const old = remote.nameSprite;
    const replacement = buildNameSprite(newName);
    replacement.position.copy(old.position);
    remote.group.remove(old);
    if (old.material) {
      if (old.material.map) old.material.map.dispose();
      old.material.dispose();
    }
    remote.group.add(replacement);
    remote.nameSprite = replacement;
  }

  // -------- Network class --------
  window.Game.Network = class {
    constructor(scene, opts) {
      opts = opts || {};
      this.scene = scene;
      this.url = opts.url || DEFAULT_URL;
      this.name = opts.name || ('PLAYER-' + Math.floor(1000 + Math.random() * 9000));
      this.getLocalState = typeof opts.getLocalState === 'function' ? opts.getLocalState : null;
      this.onRemoteShoot = typeof opts.onRemoteShoot === 'function' ? opts.onRemoteShoot : null;
      this.onRemoteRocket = typeof opts.onRemoteRocket === 'function' ? opts.onRemoteRocket : null;
      this.onRemoteExplosion = typeof opts.onRemoteExplosion === 'function' ? opts.onRemoteExplosion : null;
      // Map-select hooks
      this.onWelcome = typeof opts.onWelcome === 'function' ? opts.onWelcome : null;     // ({map, isFirst, peers}) - server's initial response
      this.onMapChange = typeof opts.onMapChange === 'function' ? opts.onMapChange : null; // (mapIdx) - someone (incl. us) chose a map
      // Chat hook: invoked with ({from, name, text, at}) when the server relays a chat message.
      this.onChat = typeof opts.onChat === 'function' ? opts.onChat : null;

      this.ws = null;
      this.connected = false;
      this.id = null;
      this.status = 'disconnected';

      this._sendAccum = 0;
      this._reconnectTimer = 0;
      this._wantReconnect = true;
      this._triedReconnect = false;

      // Map<peerId, remoteRecord>
      this.remotes = new Map();

      // Scratch
      this._scratchVec = new THREE.Vector3();
      this._scratchEuler = new THREE.Euler();

      // Pre-built outbound message objects (re-used to reduce GC pressure;
      // JSON.stringify still allocates the wire string).
      this._stateMsg = { type: 'state', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, weapon: 0, hp: 100 };
    }

    get peerCount() {
      return this.remotes.size;
    }

    isConnected() {
      return this.connected;
    }

    // Returns a flat array of THREE.Mesh objects representing every alive
    // remote player. Each mesh has userData.peerId set so a raycast hit can
    // be attributed back to a peer.
    getRemoteMeshes() {
      const out = [];
      this.remotes.forEach((remote) => {
        if (!remote || !remote.group) return;
        if (remote.hp != null && remote.hp <= 0) return;
        remote.group.traverse((m) => {
          if (m.isMesh && !m.isSprite) out.push(m);
        });
      });
      return out;
    }

    // Look up a peer record by id (or null).
    getPeer(peerId) {
      return this.remotes.get(peerId) || null;
    }

    getStatus() {
      return this.status;
    }

    connect() {
      this._wantReconnect = true;
      this._open();
    }

    _open() {
      if (this.ws) {
        try { this.ws.close(); } catch (_) { /* ignore */ }
      }
      this.status = 'connecting';
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        this.status = 'error';
        this._scheduleReconnect();
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.status = 'connected';
        this._triedReconnect = false;
        try {
          ws.send(JSON.stringify({ type: 'hello', name: this.name }));
        } catch (_) { /* ignore */ }
      };

      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch (_) { return; }
        this._handleMessage(msg);
      };

      ws.onerror = () => {
        this.status = 'error';
      };

      ws.onclose = () => {
        this.connected = false;
        this.status = 'disconnected';
        this._clearAllRemotes();
        if (this._wantReconnect && !this._triedReconnect) {
          this._scheduleReconnect();
        }
      };
    }

    _scheduleReconnect() {
      if (this._reconnectTimer) return;
      this._triedReconnect = true;
      this.status = 'reconnecting';
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = 0;
        if (this._wantReconnect) this._open();
      }, RECONNECT_DELAY_MS);
    }

    disconnect() {
      this._wantReconnect = false;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = 0;
      }
      if (this.ws) {
        try { this.ws.close(); } catch (_) { /* ignore */ }
      }
      this.ws = null;
      this.connected = false;
      this.status = 'disconnected';
      this._clearAllRemotes();
    }

    _clearAllRemotes() {
      for (const remote of this.remotes.values()) {
        this._disposeRemote(remote);
      }
      this.remotes.clear();
    }

    _disposeRemote(remote) {
      if (!remote || !remote.group) return;
      this.scene.remove(remote.group);
      remote.group.traverse((obj) => {
        if (obj.isMesh) {
          // Skip shared body geometries (re-used across all remote players).
          if (obj.geometry &&
              obj.geometry !== SHARED_TORSO_GEOM &&
              obj.geometry !== SHARED_HEAD_GEOM &&
              obj.geometry !== SHARED_ARM_GEOM &&
              obj.geometry !== SHARED_LEG_GEOM) {
            obj.geometry.dispose();
          }
          if (obj.material) {
            if (obj.material.map) obj.material.map.dispose();
            obj.material.dispose();
          }
        } else if (obj.isSprite) {
          if (obj.material) {
            if (obj.material.map) obj.material.map.dispose();
            obj.material.dispose();
          }
        }
      });
    }

    _ensureRemote(peer) {
      if (!peer || typeof peer.id !== 'string') return null;
      let remote = this.remotes.get(peer.id);
      if (!remote) {
        if (this.remotes.size >= MAX_REMOTE_PLAYERS) return null;
        remote = buildRemotePlayerMesh(peer.id, peer.name || 'PLAYER');
        // Initial pose
        if (isFiniteNum(peer.x) && isFiniteNum(peer.y) && isFiniteNum(peer.z)) {
          remote.group.position.set(peer.x, peer.y, peer.z);
          remote.target.x = peer.x;
          remote.target.y = peer.y;
          remote.target.z = peer.z;
        }
        if (isFiniteNum(peer.yaw)) {
          remote.group.rotation.y = peer.yaw;
          remote.target.yaw = peer.yaw;
        }
        if (isFiniteNum(peer.pitch)) {
          remote.target.pitch = peer.pitch;
        }
        this.scene.add(remote.group);
        this.remotes.set(peer.id, remote);
      } else if (peer.name && peer.name !== remote.currentName) {
        updateNameSprite(remote, peer.name);
      }
      return remote;
    }

    _handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'welcome':
          if (typeof msg.id === 'string') this.id = msg.id;
          if (Array.isArray(msg.peers)) {
            for (let i = 0; i < msg.peers.length; i++) {
              this._ensureRemote(msg.peers[i]);
            }
          }
          this.serverMap = isFiniteNum(msg.map) ? Math.floor(msg.map) : null;
          this.isFirstPlayer = !!msg.isFirst;
          if (this.onWelcome) {
            this.onWelcome({ map: this.serverMap, isFirst: this.isFirstPlayer, peers: msg.peers || [] });
          }
          break;

        case 'mapChange':
          if (isFiniteNum(msg.map)) {
            const m = Math.floor(msg.map);
            this.serverMap = m;
            if (this.onMapChange) this.onMapChange(m, msg.by || null);
          }
          break;

        case 'peers':
          if (!Array.isArray(msg.players)) return;
          {
            const seen = new Set();
            for (let i = 0; i < msg.players.length; i++) {
              const p = msg.players[i];
              if (!p || typeof p.id !== 'string') continue;
              seen.add(p.id);
              const remote = this._ensureRemote(p);
              if (!remote) continue;
              if (isFiniteNum(p.x)) remote.target.x = p.x;
              if (isFiniteNum(p.y)) remote.target.y = p.y;
              if (isFiniteNum(p.z)) remote.target.z = p.z;
              if (isFiniteNum(p.yaw)) remote.target.yaw = p.yaw;
              if (isFiniteNum(p.pitch)) remote.target.pitch = p.pitch;
              if (isFiniteNum(p.hp)) remote.hp = p.hp;
              if (typeof p.weapon !== 'undefined') remote.weapon = p.weapon;
              if (typeof p.name === 'string' && p.name !== remote.currentName) {
                updateNameSprite(remote, p.name);
              }
            }
            // Remove peers no longer present.
            for (const peerId of Array.from(this.remotes.keys())) {
              if (!seen.has(peerId)) {
                const r = this.remotes.get(peerId);
                this._disposeRemote(r);
                this.remotes.delete(peerId);
              }
            }
          }
          break;

        case 'leave':
          if (typeof msg.id === 'string') {
            const r = this.remotes.get(msg.id);
            if (r) {
              this._disposeRemote(r);
              this.remotes.delete(msg.id);
            }
          }
          break;

        case 'fx': {
          const origin = Array.isArray(msg.origin) && msg.origin.length === 3 &&
            isFiniteNum(msg.origin[0]) && isFiniteNum(msg.origin[1]) && isFiniteNum(msg.origin[2])
            ? msg.origin : null;
          const dir = Array.isArray(msg.dir) && msg.dir.length === 3 &&
            isFiniteNum(msg.dir[0]) && isFiniteNum(msg.dir[1]) && isFiniteNum(msg.dir[2])
            ? msg.dir : null;
          const at = Array.isArray(msg.at) && msg.at.length === 3 &&
            isFiniteNum(msg.at[0]) && isFiniteNum(msg.at[1]) && isFiniteNum(msg.at[2])
            ? msg.at : null;

          if (msg.fx === 'shoot' && origin && dir && this.onRemoteShoot) {
            this.onRemoteShoot({ from: msg.from, weapon: msg.weapon, origin, dir });
          } else if (msg.fx === 'rocket' && origin && dir && this.onRemoteRocket) {
            this.onRemoteRocket({ from: msg.from, origin, dir });
          } else if (msg.fx === 'explosion' && at && this.onRemoteExplosion) {
            this.onRemoteExplosion({ from: msg.from, at });
          }
          break;
        }

        case 'hit':
          // Server says someone hit us. Surface to the local game via callback if provided.
          // (main.js may register a custom handler later; for now expose on the instance.)
          if (typeof this.onHit === 'function') {
            this.onHit({ from: msg.from, dmg: isFiniteNum(msg.dmg) ? msg.dmg : 0 });
          }
          break;

        case 'chat':
          if (typeof this.onChat === 'function') {
            const text = typeof msg.text === 'string' ? msg.text : '';
            const name = typeof msg.name === 'string' ? msg.name : 'PLAYER';
            const from = typeof msg.from === 'string' ? msg.from : null;
            const at = isFiniteNum(msg.at) ? msg.at : Date.now();
            if (text) {
              this.onChat({ from, name, text, at });
            }
          }
          break;

        default:
          break;
      }
    }

    update(dt) {
      if (!isFiniteNum(dt) || dt <= 0) dt = 0;

      // Smooth remote players toward their target poses.
      const k = 1 - Math.exp(-LERP_RATE * dt);
      for (const remote of this.remotes.values()) {
        const g = remote.group;
        g.position.x += (remote.target.x - g.position.x) * k;
        g.position.y += (remote.target.y - g.position.y) * k;
        g.position.z += (remote.target.z - g.position.z) * k;

        // Yaw (shortest-arc lerp)
        let dy = remote.target.yaw - g.rotation.y;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        g.rotation.y += dy * k;

        // Pitch the head only (so torso stays upright)
        if (remote.head) {
          let dp = remote.target.pitch - remote.head.rotation.x;
          // pitch shouldn't wrap, but clamp interpolation regardless
          remote.head.rotation.x += dp * k;
        }
      }

      // Send local state at 20Hz.
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
      this._sendAccum += dt;
      if (this._sendAccum < SEND_INTERVAL) return;
      this._sendAccum = 0;

      if (!this.getLocalState) return;
      const s = this.getLocalState();
      if (!s) return;

      const msg = this._stateMsg;
      msg.x = isFiniteNum(s.x) ? s.x : 0;
      msg.y = isFiniteNum(s.y) ? s.y : 0;
      msg.z = isFiniteNum(s.z) ? s.z : 0;
      msg.yaw = isFiniteNum(s.yaw) ? s.yaw : 0;
      msg.pitch = isFiniteNum(s.pitch) ? s.pitch : 0;
      msg.weapon = (typeof s.weapon !== 'undefined') ? s.weapon : 0;
      msg.hp = isFiniteNum(s.hp) ? s.hp : 100;

      try {
        this.ws.send(JSON.stringify(msg));
      } catch (_) { /* ignore */ }
    }

    // ---- Public helpers for main.js to report local events ----

    sendShoot(weapon, origin, dir) {
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(JSON.stringify({
          type: 'shoot',
          weapon: weapon,
          origin: [origin.x, origin.y, origin.z],
          dir: [dir.x, dir.y, dir.z]
        }));
      } catch (_) { /* ignore */ }
    }

    sendRocket(origin, dir) {
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(JSON.stringify({
          type: 'rocket',
          origin: [origin.x, origin.y, origin.z],
          dir: [dir.x, dir.y, dir.z]
        }));
      } catch (_) { /* ignore */ }
    }

    sendExplosion(at) {
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(JSON.stringify({
          type: 'explosion',
          at: [at.x, at.y, at.z]
        }));
      } catch (_) { /* ignore */ }
    }

    sendHit(targetId, dmg) {
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
      if (typeof targetId !== 'string') return;
      try {
        this.ws.send(JSON.stringify({
          type: 'hit',
          targetId: targetId,
          dmg: isFiniteNum(dmg) ? dmg : 0
        }));
      } catch (_) { /* ignore */ }
    }

    // Send a chat line to the server, which will broadcast it to all clients (including us).
    // Validates: non-empty after trim, <=200 chars after trim, only sends when connected.
    sendChat(text) {
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
      if (typeof text !== 'string') return;
      const cleaned = text.replace(/[\x00-\x1F\x7F]/g, '').trim();
      if (!cleaned) return;
      if (cleaned.length > 200) return;
      try {
        this.ws.send(JSON.stringify({ type: 'chat', text: cleaned }));
      } catch (_) { /* ignore */ }
    }

    // First player picks a map index; server stores it and broadcasts mapChange to everyone.
    sendMapChoice(mapIdx) {
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
      if (!isFiniteNum(mapIdx)) return;
      try {
        this.ws.send(JSON.stringify({ type: 'setMap', map: Math.floor(mapIdx) }));
      } catch (_) { /* ignore */ }
    }
  };
})();
