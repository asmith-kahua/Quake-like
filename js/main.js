// main.js — boots the game, owns the render loop, wires modules together.
// Integrates: 4 levels with progression, pickups, weapon switching, camera shake,
// procedural sound, minimap, optional LAN multiplayer.
(function () {
  "use strict";

  const TOTAL_LEVELS = 4;        // solo progression cap (levels 0..3)
  const MP_DEFAULT_MAP = 3;      // "Palace of Fire" — current default map for MP
  const MP_NEW_ARENA   = 4;      // multi-route deathmatch arena (added by subagent)
  const MAX_MAP_INDEX  = 4;

  const MAP_OPTIONS = [
    { idx: 0, name: "SLIPGATE COMPLEX", desc: "small, original starter level" },
    { idx: 1, name: "THE ARMORY",       desc: "rotunda + 3 alcoves, mid-size" },
    { idx: 2, name: "DEEP HALLS",       desc: "snaking chambers, mid-size" },
    { idx: 3, name: "PALACE OF FIRE",   desc: "grand hall, big — current default" },
    { idx: 4, name: "THE SLAUGHTERHOUSE", desc: "large multi-route arena, catwalks" }
  ];

  // ---------- Renderer / scene / camera ----------
  // Perf-tuned: pixelRatio=1 halves fragment shader cost on retina displays;
  // far plane tightened from 400 to 120 (largest map is 60x60, generous);
  // antialias on for quality — disable to "false" if still slow.
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0a08);
  scene.fog = new THREE.Fog(0x0b0a08, 6, 55);

  const camera = new THREE.PerspectiveCamera(
    78, window.innerWidth / window.innerHeight, 0.05, 120
  );

  // ---------- HUD ----------
  const ui = {
    healthEl: document.getElementById("health"),
    armorEl: document.getElementById("armor"),
    ammoEl: document.getElementById("ammo"),
    weaponEl: document.getElementById("weapon-name"),
    killsEl: document.getElementById("kills"),
    levelEl: document.getElementById("level-name"),
    netEl: document.getElementById("net-status"),
    msgEl: document.getElementById("message"),
    flashEl: document.getElementById("damage-flash"),
    pickupEl: document.getElementById("pickup-flash"),

    setHealth(h) {
      this.healthEl.textContent = Math.max(0, Math.round(h));
      this.healthEl.classList.toggle("low", h < 35);
    },
    setArmor(a) { this.armorEl.textContent = Math.max(0, Math.round(a)); },
    setAmmo(a)  { this.ammoEl.textContent  = Math.max(0, Math.round(a)); },
    setWeapon(name) { this.weaponEl.textContent = name; },
    setKills(k, total) { this.killsEl.textContent = k + " / " + total; },
    setLevelName(n) { this.levelEl.textContent = n; },
    setNetStatus(text, online) {
      this.netEl.textContent = text;
      this.netEl.classList.toggle("off", !online);
    },
    flash(intensity) {
      const i = intensity == null ? 0.45 : intensity;
      this.flashEl.style.background = "rgba(255,0,0," + i + ")";
      clearTimeout(this._flashT);
      this._flashT = setTimeout(() => (this.flashEl.style.background = "rgba(255,0,0,0)"), 120);
    },
    pickupFlash() {
      this.pickupEl.style.background = "rgba(80,255,120,0.35)";
      clearTimeout(this._pickT);
      this._pickT = setTimeout(() => (this.pickupEl.style.background = "rgba(80,255,120,0)"), 200);
    },
    message(text, ms) {
      const dur = ms == null ? 2200 : ms;
      this.msgEl.textContent = text;
      this.msgEl.style.opacity = 1;
      clearTimeout(this._msgT);
      if (dur > 0) {
        this._msgT = setTimeout(() => (this.msgEl.style.opacity = 0), dur);
      }
    }
  };
  window.GameUI = ui;

  if (!window.Game) {
    console.error("Game modules failed to load.");
    return;
  }
  const Game = window.Game;

  // ---------- Sound ----------
  const sound = new Game.Sound();
  window.GameSound = sound;

  // ---------- World state (mutable across level transitions) ----------
  let currentLevelIndex = 0;
  let level   = new Game.Level(scene, currentLevelIndex);
  let player  = new Game.Player(scene, camera, level, ui, renderer.domElement);

  // Solo: spawn bots scaled by level. Difficulty: easy 0-1, medium 2-3, hard 4.
  // Enemies within SPAWN_SAFE_RADIUS of the player's spawn are filtered out so
  // the player isn't immediately attacked at level start.
  const SPAWN_SAFE_RADIUS = 8;
  function spawnSoloOpponents(scene_, lvl) {
    if (!Game.spawnBots) return Game.spawnEnemies(scene_, lvl);
    const idx = (lvl && typeof lvl.levelIndex === "number") ? lvl.levelIndex : 0;
    const difficulty = idx <= 1 ? "easy" : (idx <= 3 ? "medium" : "hard");
    const sp = lvl.spawnPoint;
    const r2 = SPAWN_SAFE_RADIUS * SPAWN_SAFE_RADIUS;
    const safe = (lvl.enemySpawns || []).filter((p) => {
      const dx = p.x - sp.x, dz = p.z - sp.z;
      return dx * dx + dz * dz >= r2;
    });
    if (safe.length === 0) {
      // Fallback: use the original list if filtering removed everything.
      const count = (lvl.enemySpawns && lvl.enemySpawns.length) || 4;
      return Game.spawnBots(scene_, lvl, count, difficulty);
    }
    // Pass a level proxy with the filtered spawns so spawnBots picks safely.
    const wrapped = Object.create(lvl);
    wrapped.enemySpawns = safe;
    return Game.spawnBots(scene_, wrapped, safe.length, difficulty);
  }
  let enemies = spawnSoloOpponents(scene, level);
  let weapon  = new Game.Weapon(scene, camera, ui);

  ui.setHealth(player.health);
  ui.setArmor(player.armor);
  ui.setAmmo(weapon.ammo);
  ui.setWeapon("RIFLE");
  ui.setKills(0, enemies.length);
  ui.setLevelName(level.levelName || "SLIPGATE COMPLEX");

  // ---------- Minimap ----------
  const minimap = new Game.Minimap(level);
  minimap.attachTo(document.body);

  // ---------- Kill feed + scoreboard ----------
  const killFeed   = (Game.KillFeed   ? new Game.KillFeed()   : null);
  const scoreboard = (Game.Scoreboard ? new Game.Scoreboard() : null);
  if (killFeed)   killFeed.attachTo(document.body);
  if (scoreboard) scoreboard.attachTo(document.body);

  // ---------- In-game chat ----------
  const chat = (Game.Chat ? new Game.Chat() : null);
  if (chat) {
    chat.attachTo(document.body);
    // Local name is set when multiplayer starts (so [YOU] prefixing works).
    chat.setLocalName(null);
  }
  // Track whether the pointer was locked when chat opened so we can re-acquire on close.
  let chatWasPointerLocked = false;
  // Suppress the next pointerlockchange-triggered pause overlay, because chat
  // intentionally exits pointer lock.
  let chatSuppressOverlay = false;

  // Death attribution: track who damaged us most recently (peerId).
  let lastDamagedBy = null;
  let lastDamagedAt = 0;
  const DAMAGE_ATTRIBUTION_WINDOW = 6; // seconds

  function refreshScoreboard() {
    if (!scoreboard || !network) return;
    const players = [];
    // Local player
    players.push({
      id: network.id || "me",
      name: (network.name || "PLAYER") + " (YOU)",
      frags: (network.scores && network.scores.get(network.id)) || 0,
      deaths: 0,
      team: network.myTeam || null,
      isMe: true,
      isHost: !!network.amHost && network.amHost()
    });
    // Remote peers
    network.remotes.forEach((r, peerId) => {
      players.push({
        id: peerId,
        name: r.currentName || "PLAYER",
        frags: (network.scores && network.scores.get(peerId)) || 0,
        deaths: 0,
        team: r.team || null,
        isMe: false,
        isHost: peerId === network.hostId
      });
    });
    scoreboard.update({ mode: network.gameMode || "ffa", players });
  }

  function recolorRemotesByTeam() {
    if (!network) return;
    const TEAM_RED  = new THREE.Color(0xc8482a);
    const TEAM_BLUE = new THREE.Color(0x2a6ec8);
    network.remotes.forEach((r) => {
      const tint = r.team === "red" ? TEAM_RED : (r.team === "blue" ? TEAM_BLUE : null);
      r.group.traverse((m) => {
        if (m.isMesh && m.material && m.material.color && tint) {
          // Blend toward team color for clarity (don't fully overwrite hue)
          m.material.color.copy(tint);
        }
      });
    });
  }

  function refreshHostControls() {
    const hc = document.getElementById("host-controls");
    if (!hc) return;
    const showHost = !!(multiplayerMode && network && network.amHost && network.amHost() && started);
    hc.style.display = showHost ? "block" : "none";
  }

  // ---------- Multiplayer (lazy: only initialized if user joins) ----------
  let network = null;
  let multiplayerMode = false; // PvP-only: no mobs, no level-clear gating
  const remoteEffects = []; // { mesh, t, ttl }

  // ---------- Pickup respawning ----------
  const PICKUP_RESPAWN_S = {
    health: 18,        // health crystals
    rocketLauncher: 22, // MP scattered rocket pickup + level 0 built-in
    soloRifle: 15,     // periodic rifle-ammo crates in solo
    soloRocket: 40,    // periodic rocket pickup in solo (longer cycle)
    soloShotgun: 25,   // periodic shotgun pickup in solo
    mpShotgun: 22      // PvP shotgun pickup
  };
  const mpRocketPickups = [];     // PvP-only scattered rocket
  const mpShotgunPickups = [];    // PvP-only scattered shotgun
  const soloRiflePickups = [];    // solo: rifle-ammo crates
  const soloRocketPickups = [];   // solo: rocket pickup (one per level)
  const soloShotgunPickups = [];  // solo: shotgun pickup (one per level)

  function makeRocketPickupMesh() {
    const g = new THREE.Group();
    g.userData.isPickup = true;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 0.55, 12),
      new THREE.MeshStandardMaterial({
        color: 0xff6620, emissive: 0xff7a30, emissiveIntensity: 1.1, roughness: 0.5
      })
    );
    body.position.y = 0.55;
    g.add(body);
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.15, 0.25, 12),
      new THREE.MeshStandardMaterial({
        color: 0xffaa55, emissive: 0xff8030, emissiveIntensity: 1.4, roughness: 0.4
      })
    );
    tip.position.y = 0.95;
    g.add(tip);
    const ped = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.36, 0.1, 12),
      new THREE.MeshStandardMaterial({ color: 0x4a3020, roughness: 0.85 })
    );
    ped.position.y = 0.05;
    g.add(ped);
    // No per-pickup PointLight — each scene-light contributes per-fragment
    // shader cost; with 5+ pickups + 6 torches + explosion lights, we'd
    // blow past r128's MeshPhong sweet spot. Emissive materials carry the
    // visual weight instead.
    return g;
  }

  // Distinctive shotgun pickup — twin parallel barrels on a wood receiver
  // floating over a brass-rimmed pedestal.
  function makeShotgunPickupMesh() {
    const g = new THREE.Group();
    g.userData.isPickup = true;
    // Twin barrels (cylinders, side by side, slightly tilted up)
    const barrelGeom = new THREE.CylinderGeometry(0.045, 0.045, 0.65, 8);
    const barrelMat = new THREE.MeshStandardMaterial({
      color: 0x202024, emissive: 0x0c0c10, emissiveIntensity: 0.4, roughness: 0.4, metalness: 0.7
    });
    const barrelL = new THREE.Mesh(barrelGeom, barrelMat);
    barrelL.rotation.z = Math.PI / 2;
    barrelL.position.set(0, 0.55, -0.05);
    g.add(barrelL);
    const barrelR = new THREE.Mesh(barrelGeom, barrelMat);
    barrelR.rotation.z = Math.PI / 2;
    barrelR.position.set(0, 0.55, 0.05);
    g.add(barrelR);
    // Wooden receiver/stock block
    const stockMat = new THREE.MeshStandardMaterial({
      color: 0x5a3a22, emissive: 0x1a0e06, emissiveIntensity: 0.3, roughness: 0.65
    });
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.14, 0.18), stockMat);
    stock.position.set(0.30, 0.55, 0);
    g.add(stock);
    // Brass receiver detail
    const brass = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.06, 0.20),
      new THREE.MeshStandardMaterial({ color: 0xb08840, emissive: 0x442200, emissiveIntensity: 0.45, roughness: 0.4 })
    );
    brass.position.set(0.18, 0.58, 0);
    g.add(brass);
    // Pedestal
    const ped = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.38, 0.1, 12),
      new THREE.MeshStandardMaterial({ color: 0x4a3020, roughness: 0.85 })
    );
    ped.position.y = 0.05;
    g.add(ped);
    // No per-pickup PointLight (see makeRocketPickupMesh comment).
    return g;
  }

  // Khaki ammo crate (rifle ammo).
  function makeRifleAmmoMesh() {
    const g = new THREE.Group();
    g.userData.isPickup = true;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.28, 0.32),
      new THREE.MeshStandardMaterial({
        color: 0x6a7038, emissive: 0x222a10, emissiveIntensity: 0.35, roughness: 0.7
      })
    );
    box.position.y = 0.18;
    g.add(box);
    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(0.50, 0.08, 0.06),
      new THREE.MeshStandardMaterial({
        color: 0xb08840, emissive: 0x442200, emissiveIntensity: 0.3, roughness: 0.4
      })
    );
    strap.position.set(0, 0.18, 0.19);
    g.add(strap);
    // No per-pickup PointLight (see makeRocketPickupMesh comment).
    return g;
  }

  function clearMpPickups() {
    for (const arr of [mpRocketPickups, mpShotgunPickups]) {
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
      }
      arr.length = 0;
    }
  }
  // Back-compat alias (in case anything still calls the old name).
  const clearMpRocketPickups = clearMpPickups;

  function clearSoloPickups() {
    for (const arr of [soloRiflePickups, soloRocketPickups, soloShotgunPickups]) {
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
      }
      arr.length = 0;
    }
  }

  // Scatter periodic rifle + rocket ammo pickups across solo levels.
  // Uses enemySpawns as candidate slots, filtered to be at least
  // SPAWN_SAFE_RADIUS from the player spawn so the player isn't immediately
  // overwhelmed AND the pickups don't sit on top of the player.
  function scatterSoloPickups() {
    clearSoloPickups();
    if (multiplayerMode) return;
    const slots = level.enemySpawns;
    if (!slots || slots.length === 0) return;
    const sp = level.spawnPoint;
    const r2 = (SPAWN_SAFE_RADIUS - 1) * (SPAWN_SAFE_RADIUS - 1); // 7m: pickups can be slightly closer than enemies
    const farSlots = slots.filter((p) => {
      const dx = p.x - sp.x, dz = p.z - sp.z;
      return dx * dx + dz * dz >= r2;
    });
    const idx = farSlots.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
    }
    // 3 rifle crates + 1 shotgun + 1 rocket per level (rocket suppressed if
    // the level builder already places one — e.g. level 0's side chamber).
    const target = farSlots.length;
    const rifleCount   = Math.min(3, target);
    const hasBuiltInRocket = !!(level.rocketPickup);
    const rocketCount  = (!hasBuiltInRocket && target - rifleCount > 0) ? 1 : 0;
    const shotgunCount = (target - rifleCount - rocketCount > 0) ? 1 : 0;
    let cursor = 0;
    for (let k = 0; k < rifleCount; k++, cursor++) {
      const slot = farSlots[idx[cursor]];
      const mesh = makeRifleAmmoMesh();
      mesh.position.set(slot.x, 0, slot.z);
      scene.add(mesh);
      soloRiflePickups.push({
        position: new THREE.Vector3(slot.x, 0.3, slot.z),
        mesh, picked: false, _respawnAt: 0
      });
    }
    for (let k = 0; k < rocketCount; k++, cursor++) {
      const slot = farSlots[idx[cursor]];
      const mesh = makeRocketPickupMesh();
      mesh.position.set(slot.x, 0, slot.z);
      scene.add(mesh);
      soloRocketPickups.push({
        position: new THREE.Vector3(slot.x, 0.6, slot.z),
        mesh, picked: false, _respawnAt: 0
      });
    }
    for (let k = 0; k < shotgunCount; k++, cursor++) {
      const slot = farSlots[idx[cursor]];
      const mesh = makeShotgunPickupMesh();
      mesh.position.set(slot.x, 0, slot.z);
      scene.add(mesh);
      soloShotgunPickups.push({
        position: new THREE.Vector3(slot.x, 0.55, slot.z),
        mesh, picked: false, _respawnAt: 0
      });
    }
  }

  function scatterMpRocketPickups() {
    clearMpPickups();
    if (!multiplayerMode) return;
    const slots = level.enemySpawns;
    if (!slots || slots.length === 0) return;
    // Shuffle a copy, take 1 rocket + 1 shotgun
    const idx = slots.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
    }
    if (idx.length >= 1) {
      const sp = slots[idx[0]];
      const mesh = makeRocketPickupMesh();
      mesh.position.set(sp.x, 0, sp.z);
      scene.add(mesh);
      mpRocketPickups.push({
        position: new THREE.Vector3(sp.x, 0.6, sp.z),
        mesh, picked: false, _respawnAt: 0
      });
    }
    if (idx.length >= 2) {
      const sp = slots[idx[1]];
      const mesh = makeShotgunPickupMesh();
      mesh.position.set(sp.x, 0, sp.z);
      scene.add(mesh);
      mpShotgunPickups.push({
        position: new THREE.Vector3(sp.x, 0.55, sp.z),
        mesh, picked: false, _respawnAt: 0
      });
    }
  }

  function tickPickupRespawns(now) {
    if (level.healthPickups) {
      for (let i = 0; i < level.healthPickups.length; i++) {
        const p = level.healthPickups[i];
        if (p.picked && p._respawnAt && now >= p._respawnAt) {
          p.picked = false; p._respawnAt = 0;
          if (p.mesh) p.mesh.visible = true;
        }
      }
    }
    if (level.rocketPickup && level.rocketPickup.picked && level.rocketPickup._respawnAt && now >= level.rocketPickup._respawnAt) {
      level.rocketPickup.picked = false;
      level.rocketPickup._respawnAt = 0;
      if (level.rocketPickup.mesh) level.rocketPickup.mesh.visible = true;
    }
    for (let i = 0; i < mpRocketPickups.length; i++) {
      const p = mpRocketPickups[i];
      if (p.picked && p._respawnAt && now >= p._respawnAt) {
        p.picked = false; p._respawnAt = 0;
        if (p.mesh) p.mesh.visible = true;
      }
    }
    for (let i = 0; i < soloRiflePickups.length; i++) {
      const p = soloRiflePickups[i];
      if (p.picked && p._respawnAt && now >= p._respawnAt) {
        p.picked = false; p._respawnAt = 0;
        if (p.mesh) p.mesh.visible = true;
      }
    }
    for (let i = 0; i < soloRocketPickups.length; i++) {
      const p = soloRocketPickups[i];
      if (p.picked && p._respawnAt && now >= p._respawnAt) {
        p.picked = false; p._respawnAt = 0;
        if (p.mesh) p.mesh.visible = true;
      }
    }
    for (let i = 0; i < soloShotgunPickups.length; i++) {
      const p = soloShotgunPickups[i];
      if (p.picked && p._respawnAt && now >= p._respawnAt) {
        p.picked = false; p._respawnAt = 0;
        if (p.mesh) p.mesh.visible = true;
      }
    }
    for (let i = 0; i < mpShotgunPickups.length; i++) {
      const p = mpShotgunPickups[i];
      if (p.picked && p._respawnAt && now >= p._respawnAt) {
        p.picked = false; p._respawnAt = 0;
        if (p.mesh) p.mesh.visible = true;
      }
    }
  }

  // Scatter ammo on the INITIAL level (loadLevel only fires on transitions).
  // multiplayerMode is still false at this point so this only seeds solo play.
  scatterSoloPickups();

  // Pool of 2-vertex line geometries reused across remote tracers (same
  // pattern as weapons.js _tracerPool — avoids a new BufferGeometry alloc
  // per remote shot). Marked _shared so tickRemoteEffects skips disposal.
  const REMOTE_TRACER_POOL_SIZE = 16;
  const remoteTracerPool = [];
  let   remoteTracerPoolIdx = 0;
  for (let i = 0; i < REMOTE_TRACER_POOL_SIZE; i++) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    remoteTracerPool.push(g);
  }

  function spawnRemoteShoot(payload) {
    const o = payload.origin, d = payload.dir;
    if (!o || !d) return;
    const sx = o[0], sy = o[1], sz = o[2];
    const ex = sx + d[0] * 40, ey = sy + d[1] * 40, ez = sz + d[2] * 40;
    const geom = remoteTracerPool[remoteTracerPoolIdx];
    remoteTracerPoolIdx = (remoteTracerPoolIdx + 1) % REMOTE_TRACER_POOL_SIZE;
    const arr = geom.attributes.position.array;
    arr[0] = sx; arr[1] = sy; arr[2] = sz;
    arr[3] = ex; arr[4] = ey; arr[5] = ez;
    geom.attributes.position.needsUpdate = true;
    const mat = new THREE.LineBasicMaterial({
      color: 0xfff0c0, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthTest: true, depthWrite: false
    });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false; // shared pool geom — bounds not updated
    scene.add(line);
    remoteEffects.push({ mesh: line, t: 0, ttl: 0.08, _sharedGeom: true });
    sound.play("rifleShot", { volume: 0.6, position: [sx, sy, sz] });
  }

  function spawnRemoteExplosion(payload) {
    const at = payload.at;
    if (!at) return;
    const pos = new THREE.Vector3(at[0], at[1], at[2]);
    const light = new THREE.PointLight(0xff7733, 5, 14, 2);
    light.position.copy(pos);
    scene.add(light);
    remoteEffects.push({ mesh: light, t: 0, ttl: 0.3, kind: "light", initial: 5 });
    sound.play("explosion", { volume: 0.9, position: [pos.x, pos.y, pos.z] });
    // Camera shake based on proximity
    const dist = pos.distanceTo(player.position);
    if (dist < 18) {
      const inten = THREE.MathUtils.clamp(1.0 - dist / 18, 0, 1) * 0.6;
      if (weapon.cameraShake) {
        if (inten > weapon.cameraShake.intensity) weapon.cameraShake.intensity = inten;
        if (0.4 > weapon.cameraShake.duration)  weapon.cameraShake.duration = 0.4;
      }
    }
  }

  function tickRemoteEffects(dt) {
    for (let i = remoteEffects.length - 1; i >= 0; i--) {
      const fx = remoteEffects[i];
      fx.t += dt;
      const k = 1 - fx.t / fx.ttl;
      if (fx.t >= fx.ttl) {
        if (fx.mesh.parent) fx.mesh.parent.remove(fx.mesh);
        if (fx.mesh.material) fx.mesh.material.dispose && fx.mesh.material.dispose();
        // Skip geometry disposal for pooled (shared) tracer geometries.
        if (!fx._sharedGeom && fx.mesh.geometry) fx.mesh.geometry.dispose && fx.mesh.geometry.dispose();
        remoteEffects.splice(i, 1);
        continue;
      }
      if (fx.kind === "light") {
        fx.mesh.intensity = fx.initial * Math.max(0, k);
      } else if (fx.mesh.material) {
        fx.mesh.material.opacity = Math.max(0, k * 0.85);
      }
    }
  }

  function getLocalState() {
    // player.position is at eye height (~1.7); peers expect foot-y.
    return {
      x: player.position.x,
      y: player.position.y - 1.7,
      z: player.position.z,
      yaw: player.yaw, pitch: player.pitch,
      weapon: weapon.current === "rocket" ? 1 : 0,
      hp: player.health
    };
  }

  function startMultiplayer(serverUrl, name) {
    if (network) return;
    network = new Game.Network(scene, {
      url: serverUrl,
      name: name,
      getLocalState: getLocalState,
      onRemoteShoot: spawnRemoteShoot,
      onRemoteRocket: spawnRemoteShoot,
      onRemoteExplosion: spawnRemoteExplosion,
      onWelcome: (info) => {
        // First player sees a map-select; subsequent players load whatever the host chose.
        if (info.isFirst) {
          showMapSelect(MP_DEFAULT_MAP);
        } else if (info.map !== null && info.map !== undefined) {
          loadMpMap(info.map);
        } else {
          // Edge case: not first but server hasn't decided yet — wait for mapChange.
          ui.message("WAITING FOR HOST TO PICK MAP", 0);
        }
      },
      onMapChange: (mapIdx) => {
        loadMpMap(mapIdx);
      },
      onModeChange: (mode, teamsObj) => {
        // Apply incoming team data to remote records (server is authoritative).
        if (network && teamsObj) {
          network.remotes.forEach((r, id) => {
            r.team = teamsObj[id] || null;
          });
        }
        recolorRemotesByTeam();
        refreshScoreboard();
        ui.message((mode === "tdm" ? "TEAM DEATHMATCH" : "FREE-FOR-ALL"), 1800);
      },
      onScoreUpdate: (scoresObj) => {
        refreshScoreboard();
      },
      onScoreReset: () => {
        if (killFeed && killFeed.clear) killFeed.clear();
        refreshScoreboard();
        ui.message("MATCH RESET", 1800);
      },
      onHostChange: (hostId) => {
        refreshHostControls();
        refreshScoreboard();
      }
    });
    // Wire chat plumbing now that network exists.
    if (chat) {
      chat.setLocalName(network.name || name || null);
      chat.setSendHandler((text) => {
        if (network && typeof network.sendChat === "function") {
          network.sendChat(text);
        }
      });
      network.onChat = ({ from, name: fromName, text }) => {
        chat.push(fromName || "PLAYER", text);
      };
    }
    // Inbound damage from another player.
    network.onHit = (info) => {
      if (!info || !info.dmg || player.dead) return;
      const dmg = Math.max(0, Math.min(200, +info.dmg || 0));
      if (dmg > 0) {
        // Track attacker for death-attribution.
        if (info.from) {
          lastDamagedBy = info.from;
          lastDamagedAt = clock.elapsedTime;
        }
        player.takeDamage(dmg);
      }
    };
    network.connect();
    multiplayerMode = true;
    ui.message("CONNECTING...", 0);
  }

  // Load an arbitrary map index in PvP mode and (re)lock the pointer.
  function loadMpMap(mapIdx) {
    const idx = THREE.MathUtils.clamp(mapIdx | 0, 0, MAX_MAP_INDEX);
    hideMapSelect();
    if (currentLevelIndex !== idx) {
      loadLevel(idx);
    } else {
      // Same map - just clear mobs + scatter pickups (no full reload).
      for (let i = 0; i < enemies.length; i++) {
        const m = enemies[i].mesh;
        if (m && m.parent) m.parent.remove(m);
      }
      enemies = [];
      prevAlive = [];
      killsCount = 0;
      ui.setKills(0, 0);
      scatterMpRocketPickups();
    }
    const opt = MAP_OPTIONS[idx];
    ui.message("PVP DEATHMATCH — " + (opt ? opt.name : "MAP " + idx), 2600);
    refreshHostControls();
    refreshScoreboard();
    recolorRemotesByTeam();
    // Acquire pointer if we're not yet locked.
    if (document.pointerLockElement !== renderer.domElement) {
      try { renderer.domElement.requestPointerLock(); } catch (_) { /* ignore */ }
    }
  }

  // ---------- Map-select dialog ----------
  const mapSelectEl = document.getElementById("map-select");
  const mapGridEl   = document.getElementById("map-grid");
  const mapConfirmEl = document.getElementById("map-confirm");
  let pendingMapChoice = MP_DEFAULT_MAP;

  function buildMapSelectGrid(defaultIdx) {
    mapGridEl.innerHTML = "";
    pendingMapChoice = defaultIdx;
    MAP_OPTIONS.forEach((opt) => {
      const div = document.createElement("div");
      div.className = "opt" + (opt.idx === defaultIdx ? " selected" : "");
      const isDefault = opt.idx === MP_DEFAULT_MAP;
      div.innerHTML =
        '<div class="name">' + opt.name + '</div>' +
        '<div class="desc">' + opt.desc + '</div>' +
        (isDefault ? '<div class="default-tag">DEFAULT</div>' : '');
      div.addEventListener("click", () => {
        pendingMapChoice = opt.idx;
        Array.from(mapGridEl.children).forEach((c) => c.classList.remove("selected"));
        div.classList.add("selected");
      });
      mapGridEl.appendChild(div);
    });
  }

  function showMapSelect(defaultIdx) {
    buildMapSelectGrid(defaultIdx);
    mapSelectEl.style.display = "flex";
  }
  function hideMapSelect() {
    mapSelectEl.style.display = "none";
  }

  mapConfirmEl.addEventListener("click", () => {
    const modeRadio = document.querySelector('input[name="gm"]:checked');
    const chosenMode = modeRadio ? modeRadio.value : "ffa";
    if (network && network.isConnected()) {
      network.sendMapChoice(pendingMapChoice, chosenMode);
      // Server will reply with mapChange + modeChange, which triggers loadMpMap.
    } else {
      // Network failed - fall back to local single-player on the chosen map.
      hideMapSelect();
      multiplayerMode = false;
      loadLevel(pendingMapChoice);
      try { renderer.domElement.requestPointerLock(); } catch (_) { /* ignore */ }
    }
  });

  // Reset-match button (host only, visibility controlled by refreshHostControls)
  const resetBtn = document.getElementById("reset-match");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (network && network.amHost && network.amHost() && network.sendResetMatch) {
        network.sendResetMatch();
      }
    });
  }

  // ---------- Level transitions ----------
  let levelTransitionT = 0;
  let levelComplete = false;

  function loadLevel(index) {
    // Defensive sweep: remove ANY level root left in scene.children.
    // Catches edge cases where a prior dispose was racy or partial.
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const child = scene.children[i];
      if (child && typeof child.name === "string" && child.name.indexOf("Level") === 0) {
        scene.remove(child);
        child.traverse((obj) => {
          if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => m && m.dispose && m.dispose());
          }
        });
      }
    }

    if (level && typeof level.dispose === "function") {
      level.dispose();
    }

    // Despawn existing enemies
    for (let i = 0; i < enemies.length; i++) {
      const m = enemies[i].mesh;
      if (m && m.parent) m.parent.remove(m);
    }

    currentLevelIndex = THREE.MathUtils.clamp(index, 0, MAX_MAP_INDEX);
    level = new Game.Level(scene, currentLevelIndex);
    // PvP mode: don't spawn mobs - it's a deathmatch arena.
    enemies = multiplayerMode ? [] : spawnSoloOpponents(scene, level);

    // Re-anchor the player
    player.level = level;
    player.position.copy(level.spawnPoint);
    player.velocity.set(0, 0, 0);
    player.dead = false;
    player.health = player.maxHealth;
    player.armor = 0;
    player.onGround = false;
    camera.position.copy(player.position);

    // Refill some ammo on level start
    weapon.rifle.ammo  = Math.min(weapon.rifle.maxAmmo,  weapon.rifle.ammo  + 30);
    weapon.rocket.ammo = Math.min(weapon.rocket.maxAmmo, weapon.rocket.ammo + 4);
    weapon.firing = false;

    // HUD
    ui.setLevelName(level.levelName || "LEVEL " + (currentLevelIndex + 1));
    ui.setHealth(player.health);
    ui.setArmor(player.armor);
    ui.setAmmo(weapon.ammo);
    ui.setKills(0, enemies.length);
    ui.message("LEVEL " + (currentLevelIndex + 1) + " — " + (level.levelName || ""), 2400);

    // Sweep up in-flight rockets, weapon effects, remote effects from the prior level
    if (weapon.rockets) {
      for (let i = 0; i < weapon.rockets.length; i++) {
        const r = weapon.rockets[i];
        if (r && r.mesh && r.mesh.parent) r.mesh.parent.remove(r.mesh);
      }
      weapon.rockets.length = 0;
    }
    if (weapon.effects) {
      for (let i = 0; i < weapon.effects.length; i++) {
        const fx = weapon.effects[i];
        if (fx && fx.mesh && fx.mesh.parent) fx.mesh.parent.remove(fx.mesh);
      }
      weapon.effects.length = 0;
    }
    for (let i = 0; i < remoteEffects.length; i++) {
      const fx = remoteEffects[i];
      if (fx.mesh && fx.mesh.parent) fx.mesh.parent.remove(fx.mesh);
    }
    remoteEffects.length = 0;

    // Reset event trackers
    prevAlive = enemies.map(e => e.alive);
    prevHealth = player.health;
    prevAmmoRifle = weapon.rifle.ammo;
    prevAmmoRocket = weapon.rocket.ammo;
    prevShakeIntensity = 0;

    minimap.setLevel(level);
    scatterMpRocketPickups();
    scatterSoloPickups();
    sound.play("levelStart", { volume: 0.7 });
    levelComplete = false;
    levelTransitionT = 0;
    killsCount = 0;
  }

  function checkLevelExit() {
    if (levelComplete) return;
    if (!level.exitTrigger) return;
    // PvP: no level progression — single-map deathmatch.
    if (multiplayerMode) return;
    const aliveCount = enemies.filter(e => e.alive).length;
    const requiredKills = Math.ceil(enemies.length * 0.7);
    const killedSoFar = enemies.length - aliveCount;
    // build a tiny player AABB for trigger overlap
    const px = player.position.x, py = player.position.y, pz = player.position.z;
    const t = level.exitTrigger;
    const inside = px >= t.min.x - 0.4 && px <= t.max.x + 0.4 &&
                   pz >= t.min.z - 0.4 && pz <= t.max.z + 0.4 &&
                   py - 1.7 < t.max.y + 0.5;
    if (inside) {
      if (killedSoFar < requiredKills) {
        ui.message("ELIMINATE MORE HOSTILES (" + killedSoFar + " / " + requiredKills + ")", 1500);
        return;
      }
      levelComplete = true;
      sound.play("levelComplete", { volume: 0.9 });
      if (currentLevelIndex >= TOTAL_LEVELS - 1) {
        ui.message("VICTORY — ALL LEVELS COMPLETE", 0);
        showVictoryOverlay();
      } else {
        ui.message("LEVEL CLEAR — ENTERING " + (currentLevelIndex + 2), 2200);
        setTimeout(() => loadLevel(currentLevelIndex + 1), 1700);
      }
    }
  }

  function showVictoryOverlay() {
    const overlay = document.getElementById("overlay");
    overlay.style.display = "flex";
    overlay.querySelector("h1").textContent = "VICTORY";
    overlay.querySelector("h2").textContent = "FOUR LEVELS CLEARED";
    paused = true;
    if (document.exitPointerLock) document.exitPointerLock();
  }

  function pulseExitPad(t) {
    if (!level.exitMesh) return;
    // Hide the exit pad in PvP — it's meaningless in deathmatch.
    if (multiplayerMode) {
      level.exitMesh.visible = false;
      return;
    }
    level.exitMesh.visible = true;
    if (level.exitMesh.material) {
      const m = level.exitMesh.material;
      const pulse = 0.6 + 0.4 * Math.sin(t * 4);
      if (m.opacity != null) m.opacity = pulse;
      if (m.emissiveIntensity != null) m.emissiveIntensity = pulse * 1.5;
    }
  }

  // ---------- Pickups ----------
  function checkPickups() {
    const nowSec = clock.elapsedTime;
    const px = player.position.x, py = player.position.y - 0.85, pz = player.position.z;

    // Health crystals (respawn after PICKUP_RESPAWN_S.health)
    if (level.healthPickups) {
      for (let i = 0; i < level.healthPickups.length; i++) {
        const p = level.healthPickups[i];
        if (p.picked) continue;
        const dx = p.position.x - px, dy = p.position.y - py, dz = p.position.z - pz;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 < 1.6 * 1.6) {
          if (player.health >= player.maxHealth) continue;
          p.picked = true;
          p._respawnAt = nowSec + PICKUP_RESPAWN_S.health;
          if (p.mesh) p.mesh.visible = false;
          player.health = Math.min(player.maxHealth, player.health + (p.amount || 25));
          ui.setHealth(player.health);
          ui.pickupFlash();
          ui.message("+" + (p.amount || 25) + " HEALTH", 900);
          sound.play("pickupHealth", { volume: 0.8 });
        } else if (p.mesh) {
          p.mesh.rotation.y += 0.02;
        }
      }
    }

    // Level-defined rocket launcher pickup (level 0)
    if (level.rocketPickup && !level.rocketPickup.picked) {
      const p = level.rocketPickup;
      const dx = p.position.x - px, dy = p.position.y - py, dz = p.position.z - pz;
      if (dx*dx + dy*dy + dz*dz < 1.8 * 1.8) {
        p.picked = true;
        p._respawnAt = nowSec + PICKUP_RESPAWN_S.rocketLauncher;
        if (p.mesh) p.mesh.visible = false;
        weapon.rocket.ammo = Math.min(weapon.rocket.maxAmmo, weapon.rocket.ammo + 8);
        ui.pickupFlash();
        ui.message("ROCKET LAUNCHER +8 AMMO — PRESS 2", 2400);
        sound.play("pickupAmmo", { volume: 0.9 });
      } else if (p.mesh) {
        p.mesh.rotation.y += 0.025;
      }
    }

    // Scattered MP rocket pickups (PvP)
    for (let i = 0; i < mpRocketPickups.length; i++) {
      const p = mpRocketPickups[i];
      if (p.picked) continue;
      const dx = p.position.x - px, dy = p.position.y - py, dz = p.position.z - pz;
      if (dx*dx + dy*dy + dz*dz < 1.8 * 1.8) {
        p.picked = true;
        p._respawnAt = nowSec + PICKUP_RESPAWN_S.rocketLauncher;
        if (p.mesh) p.mesh.visible = false;
        weapon.rocket.ammo = Math.min(weapon.rocket.maxAmmo, weapon.rocket.ammo + 5);
        ui.pickupFlash();
        ui.message("ROCKETS +5", 1500);
        sound.play("pickupAmmo", { volume: 0.85 });
      } else if (p.mesh) {
        p.mesh.rotation.y += 0.025;
      }
    }

    // Solo rifle ammo crates
    for (let i = 0; i < soloRiflePickups.length; i++) {
      const p = soloRiflePickups[i];
      if (p.picked) continue;
      const dx = p.position.x - px, dy = p.position.y - py, dz = p.position.z - pz;
      if (dx*dx + dy*dy + dz*dz < 1.6 * 1.6) {
        if (weapon.rifle.ammo >= weapon.rifle.maxAmmo) continue;
        p.picked = true;
        p._respawnAt = nowSec + PICKUP_RESPAWN_S.soloRifle;
        if (p.mesh) p.mesh.visible = false;
        weapon.rifle.ammo = Math.min(weapon.rifle.maxAmmo, weapon.rifle.ammo + 25);
        ui.setAmmo(weapon.ammo);
        ui.pickupFlash();
        ui.message("RIFLE AMMO +25", 1300);
        sound.play("pickupAmmo", { volume: 0.85 });
      } else if (p.mesh) {
        p.mesh.rotation.y += 0.018;
      }
    }

    // Solo rocket ammo pickups (longer respawn)
    for (let i = 0; i < soloRocketPickups.length; i++) {
      const p = soloRocketPickups[i];
      if (p.picked) continue;
      const dx = p.position.x - px, dy = p.position.y - py, dz = p.position.z - pz;
      if (dx*dx + dy*dy + dz*dz < 1.8 * 1.8) {
        if (weapon.rocket.ammo >= weapon.rocket.maxAmmo) continue;
        p.picked = true;
        p._respawnAt = nowSec + PICKUP_RESPAWN_S.soloRocket;
        if (p.mesh) p.mesh.visible = false;
        weapon.rocket.ammo = Math.min(weapon.rocket.maxAmmo, weapon.rocket.ammo + 4);
        ui.setAmmo(weapon.ammo);
        ui.pickupFlash();
        ui.message("ROCKETS +4", 1300);
        sound.play("pickupAmmo", { volume: 0.9 });
      } else if (p.mesh) {
        p.mesh.rotation.y += 0.025;
      }
    }

    // Solo shotgun pickup
    for (let i = 0; i < soloShotgunPickups.length; i++) {
      const p = soloShotgunPickups[i];
      if (p.picked) continue;
      const dx = p.position.x - px, dy = p.position.y - py, dz = p.position.z - pz;
      if (dx*dx + dy*dy + dz*dz < 1.8 * 1.8) {
        if (weapon.shotgun && weapon.shotgun.ammo >= weapon.shotgun.maxAmmo) continue;
        p.picked = true;
        p._respawnAt = nowSec + PICKUP_RESPAWN_S.soloShotgun;
        if (p.mesh) p.mesh.visible = false;
        if (weapon.shotgun) {
          weapon.shotgun.ammo = Math.min(weapon.shotgun.maxAmmo, weapon.shotgun.ammo + 12);
        }
        ui.setAmmo(weapon.ammo);
        ui.pickupFlash();
        ui.message("SHOTGUN +12 SHELLS — PRESS 3", 1700);
        sound.play("pickupAmmo", { volume: 0.85 });
      } else if (p.mesh) {
        p.mesh.rotation.y += 0.022;
      }
    }

    // MP shotgun pickup
    for (let i = 0; i < mpShotgunPickups.length; i++) {
      const p = mpShotgunPickups[i];
      if (p.picked) continue;
      const dx = p.position.x - px, dy = p.position.y - py, dz = p.position.z - pz;
      if (dx*dx + dy*dy + dz*dz < 1.8 * 1.8) {
        if (weapon.shotgun && weapon.shotgun.ammo >= weapon.shotgun.maxAmmo) continue;
        p.picked = true;
        p._respawnAt = nowSec + PICKUP_RESPAWN_S.mpShotgun;
        if (p.mesh) p.mesh.visible = false;
        if (weapon.shotgun) {
          weapon.shotgun.ammo = Math.min(weapon.shotgun.maxAmmo, weapon.shotgun.ammo + 12);
        }
        ui.setAmmo(weapon.ammo);
        ui.pickupFlash();
        ui.message("SHOTGUN +12 SHELLS", 1500);
        sound.play("pickupAmmo", { volume: 0.85 });
      } else if (p.mesh) {
        p.mesh.rotation.y += 0.022;
      }
    }

    tickPickupRespawns(nowSec);
  }

  // ---------- Pointer-lock startup overlay ----------
  const overlay = document.getElementById("overlay");
  let started = false;
  let paused = true;

  function beginGame(useNetwork) {
    sound.init();
    if (useNetwork) {
      const url = (document.getElementById("server-url").value || "ws://localhost:8080").trim();
      const name = (document.getElementById("player-name").value || "").trim();
      // Hide the start overlay; map-select dialog (if first) or loadMpMap will take over.
      overlay.style.display = "none";
      startMultiplayer(url, name || undefined);
      // Pointer-lock is acquired in loadMpMap(), AFTER the map is chosen.
    } else {
      renderer.domElement.requestPointerLock();
    }
  }

  document.getElementById("btn-solo").addEventListener("click", () => beginGame(false));
  document.getElementById("btn-mp").addEventListener("click",   () => beginGame(true));

  const pauseMenu = document.getElementById("pause-menu");

  document.addEventListener("pointerlockchange", () => {
    const locked = document.pointerLockElement === renderer.domElement;
    if (locked) {
      overlay.style.display = "none";
      if (pauseMenu) pauseMenu.style.display = "none";
      paused = false;
      if (!started) {
        started = true;
        ui.message("LEVEL 1 — " + level.levelName, 2400);
        sound.play("levelStart", { volume: 0.6 });
      }
    } else {
      // Chat intentionally exits pointer lock — don't pause / show overlay in that case.
      if (chatSuppressOverlay || (chat && chat.isOpen())) {
        chatSuppressOverlay = false;
        return;
      }
      paused = true;
      if (weapon) weapon.firing = false;
      // If the game has started, show the pause menu (Resume / Quit).
      // Otherwise (very first load) show the start overlay.
      if (started && (!levelComplete || currentLevelIndex < TOTAL_LEVELS - 1)) {
        if (pauseMenu) {
          // Show "RESPAWN" instead of "RESUME" when dead.
          const titleEl = pauseMenu.querySelector("h1");
          if (titleEl) titleEl.textContent = player.dead ? "YOU DIED" : "PAUSED";
          if (btnResume) btnResume.textContent = player.dead ? "RESPAWN" : "RESUME";
          pauseMenu.style.display = "flex";
        }
      } else if (!started) {
        overlay.style.display = "flex";
      }
    }
  });

  // Pause menu buttons
  const btnResume = document.getElementById("btn-resume");
  const btnQuit   = document.getElementById("btn-quit");
  if (btnResume) {
    btnResume.addEventListener("click", () => {
      // If dead, respawn first (same path as pressing R).
      if (player.dead) {
        player.respawn(level);
        enemies.forEach(en => en.respawn && en.respawn());
        weapon.rifle.ammo = 50;
        weapon.rocket.ammo = 5;
        ui.setAmmo(weapon.ammo);
        ui.setHealth(player.health);
        ui.message("RESPAWNED", 1600);
        prevAlive = enemies.map(en => en.alive);
        prevDead = false;
        killsCount = 0;
      }
      if (pauseMenu) pauseMenu.style.display = "none";
      try { renderer.domElement.requestPointerLock(); } catch (_) { /* ignore */ }
    });
  }
  if (btnQuit) {
    btnQuit.addEventListener("click", () => {
      // Reload — cleanest way to get back to a fresh main menu (disconnects MP, resets all state).
      window.location.reload();
    });
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- Stat trackers ----------
  let killsCount = 0;
  let prevHealth = player.health;
  let prevDead = player.dead;
  let prevAlive = enemies.map(e => e.alive);
  let prevOnGround = player.onGround;
  let prevWeapon = weapon.current;
  let prevAmmoRifle = weapon.rifle.ammo;
  let prevAmmoRocket = weapon.rocket.ammo;
  let prevShakeIntensity = 0;

  function syncEvents() {
    // Kill counter + enemy death sounds
    let killedNow = 0;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const was = prevAlive[i];
      if (was && !e.alive) {
        sound.play("enemyDie", { volume: 0.7, position: [e.position.x, e.position.y + 1, e.position.z] });
      }
      prevAlive[i] = e.alive;
      if (!e.alive) killedNow++;
    }
    if (killedNow !== killsCount) {
      killsCount = killedNow;
      ui.setKills(killsCount, enemies.length);
    }
    // In multiplayer, override the kill counter with frag totals.
    if (multiplayerMode && network && network.isConnected()) {
      const myFrags = (network.scores && network.scores.get(network.id)) || 0;
      let totalFrags = 0;
      if (network.scores) network.scores.forEach((v) => { totalFrags += v; });
      ui.setKills(myFrags, totalFrags);
    }

    // Health drop -> hurt sound
    if (player.health < prevHealth - 0.5) {
      sound.play("playerHurt", { volume: 0.8 });
    }
    prevHealth = player.health;

    // Death transition: report kill attribution to the server.
    if (!prevDead && player.dead) {
      if (network && network.isConnected() && typeof network.sendDeath === "function") {
        const stillFresh = (clock.elapsedTime - lastDamagedAt) <= DAMAGE_ATTRIBUTION_WINDOW;
        const killer = (lastDamagedBy && stillFresh) ? lastDamagedBy : (network.id || null);
        network.sendDeath(killer);
        // Local kill-feed entry
        if (killFeed) {
          const killerName = killer === network.id ? "(self)" :
            (network.peerNames && network.peerNames.get(killer)) ||
            (network.remotes.get(killer) && network.remotes.get(killer).currentName) ||
            "PLAYER";
          killFeed.push(killerName, network.name || "YOU", weapon.current || "rifle");
        }
      }
      lastDamagedBy = null;
    }
    prevDead = player.dead;
    // Don't auto-release pointer on death — that triggered an infinite
    // pause-menu loop. Player can press R to respawn while pointer-locked,
    // or hit Esc to access the pause menu (which now shows RESPAWN button).

    // Jump sound on takeoff
    if (prevOnGround && !player.onGround && player.velocity.y > 4) {
      sound.play("jump", { volume: 0.5 });
    }
    prevOnGround = player.onGround;

    // Weapon switch sound + HUD
    if (weapon.current !== prevWeapon) {
      sound.play("weaponSwitch", { volume: 0.7 });
      ui.setWeapon(weapon.current === "rocket" ? "ROCKET" : "RIFLE");
      prevWeapon = weapon.current;
    }
    ui.setAmmo(weapon.ammo);

    // Fire sounds — detect ammo decrement
    if (weapon.rifle.ammo < prevAmmoRifle) {
      const shots = prevAmmoRifle - weapon.rifle.ammo;
      for (let s = 0; s < Math.min(shots, 2); s++) sound.play("rifleShot", { volume: 0.55 });
      // Network broadcast
      if (network && network.isConnected()) {
        const dir = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
        network.sendShoot(0, [camera.position.x, camera.position.y, camera.position.z],
                              [dir.x, dir.y, dir.z]);
      }
    }
    prevAmmoRifle = weapon.rifle.ammo;

    if (weapon.rocket.ammo < prevAmmoRocket) {
      sound.play("rocketFire", { volume: 0.85 });
      if (network && network.isConnected()) {
        const dir = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
        network.sendRocket([camera.position.x, camera.position.y, camera.position.z],
                           [dir.x, dir.y, dir.z]);
      }
    }
    prevAmmoRocket = weapon.rocket.ammo;

    // Explosion detection — camera shake intensity rising = a blast just happened
    const shake = weapon.cameraShake ? weapon.cameraShake.intensity : 0;
    if (shake > prevShakeIntensity + 0.05 && shake > 0.15) {
      sound.play("explosion", { volume: 1.0 });
      if (network && network.isConnected()) {
        // Best-effort: broadcast at player position (we don't have the exact blast point)
        network.sendExplosion([player.position.x, player.position.y - 1, player.position.z]);
      }
    }
    prevShakeIntensity = shake;

    // Network status
    if (network) {
      if (network.isConnected()) {
        ui.setNetStatus("ONLINE — " + network.peerCount + " PEER" + (network.peerCount === 1 ? "" : "S"), true);
      } else {
        ui.setNetStatus(network.getStatus ? network.getStatus().toUpperCase() : "CONNECTING", false);
      }
    }
  }

  // ---------- Camera shake ----------
  // _shakeOffset is the *current* shake offset applied to camera.position; it
  // smoothly chases _shakeTarget (a fresh random per-frame target) so we don't
  // strobe a raw random offset at 60Hz (which produces a visible camera jitter
  // / "jump" feel even at low intensities). Lerp factor 0.5 settles toward the
  // new target in ~2-3 frames while still feeling sharp.
  const _shakeOffset = new THREE.Vector3();
  const _shakeTarget = new THREE.Vector3();
  function applyCameraShake(dt) {
    const cs = weapon.cameraShake;
    if (!cs || cs.intensity <= 0.001) {
      // Reset offset so we start from zero on the next active shake (no carry-over).
      _shakeOffset.set(0, 0, 0);
      return;
    }
    const i = cs.intensity * 0.18;
    _shakeTarget.set(
      (Math.random() - 0.5) * i,
      (Math.random() - 0.5) * i,
      (Math.random() - 0.5) * i * 0.5
    );
    _shakeOffset.lerp(_shakeTarget, 0.5);
    camera.position.add(_shakeOffset);
  }

  // ---------- Respawn ----------
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyR" && player.dead) {
      player.respawn(level);
      enemies.forEach(en => en.respawn && en.respawn());
      weapon.rifle.ammo = 50;
      weapon.rocket.ammo = 5;
      ui.setAmmo(weapon.ammo);
      ui.setHealth(player.health);
      ui.message("RESPAWNED", 1600);
      prevAlive = enemies.map(en => en.alive);
      killsCount = 0;
    }
  });

  // ---------- Chat open key (T, Quake-style) ----------
  // Use capture phase so we run before player.js / weapons.js keydown handlers.
  window.addEventListener("keydown", (e) => {
    if (!chat) return;
    if (chat.isOpen()) return;
    if (e.code !== "KeyT") return;
    // Don't open if a non-chat input is currently focused.
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) {
      return;
    }
    if (player.dead) return;
    if (paused) return;
    e.preventDefault();
    e.stopPropagation();
    chatWasPointerLocked = (document.pointerLockElement === renderer.domElement);
    if (chatWasPointerLocked) {
      // Suppress the pause overlay that the unlock would otherwise trigger.
      chatSuppressOverlay = true;
      try { document.exitPointerLock(); } catch (_) { /* ignore */ }
    }
    // Clear any held movement keys so the player doesn't keep walking while typing.
    if (player && player.input) {
      player.input.forward = false;
      player.input.back = false;
      player.input.left = false;
      player.input.right = false;
      player.input.jump = false;
      player.input.sprint = false;
    }
    chat.open();
  }, true);

  // When chat closes (after submit or Esc), re-acquire pointer lock if we had it.
  // We don't have a chat-close callback API; instead poll on a focusout event.
  if (chat && chat.inputEl) {
    chat.inputEl.addEventListener("focusout", () => {
      // Defer: open() may also momentarily change focus.
      setTimeout(() => {
        if (chat.isOpen()) return;
        if (chatWasPointerLocked && document.pointerLockElement !== renderer.domElement) {
          try { renderer.domElement.requestPointerLock(); } catch (_) { /* ignore */ }
        }
        chatWasPointerLocked = false;
      }, 0);
    });
  }

  // ---------- Game loop ----------
  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t  = clock.elapsedTime;

    if (!paused) {
      if (!player.dead) {
        player.update(dt, { player, level, enemies, weapon, ui, network });
        weapon.update(dt, { player, level, enemies, weapon, ui, network });
      }
      for (let i = 0; i < enemies.length; i++) {
        enemies[i].update(dt, { player, level, enemies, weapon, ui, network });
      }

      checkPickups();
      checkLevelExit();
      pulseExitPad(t);
      tickRemoteEffects(dt);
      syncEvents();
      applyCameraShake(dt);

      // Listener position for sound attenuation
      sound.setListenerPosition([player.position.x, player.position.y, player.position.z]);

      // Network: send local state, render remote players
      if (network) {
        network.update(dt);
      }

      // Minimap
      const remotes = (network && network.remotes)
        ? Array.from(network.remotes.values()).map(r => ({
            x: r.target.x, y: r.target.y, z: r.target.z, color: "#ffffff"
          }))
        : null;
      minimap.update(player, enemies, { remotePlayers: remotes, exitTrigger: level.exitTrigger });
    }

    renderer.render(scene, camera);
  }

  animate();

  // Debug handle
  window.__game = { scene, camera, renderer, get player(){return player;}, get level(){return level;},
                    get enemies(){return enemies;}, weapon, sound, minimap,
                    get network(){return network;}, loadLevel };
})();
