// Game.Weapon - unified first-person weapon module.
//
// Hosts two weapons:
//   1. Rifle  - fast hitscan chaingun-feel rifle (existing behaviour preserved).
//   2. Rocket - bazooka with travel-time projectile, splash, knockback (new).
//
// Public contract (kept compatible with main.js & enemies.js):
//   constructor(scene, camera, ui)
//   update(dt, ctx)              ctx = { player, level, enemies, weapon, ui }
//   fire(ctx)
//   ammo                          (getter)  -> ammo of currently-selected weapon
//   ammoRifle, ammoRocket         per-weapon counts
//   maxAmmo, fireRate, firing
//   switchTo('rifle' | 'rocket')
//   current                       string, current weapon name
//   cameraShake                   { intensity, duration }, decays in update()
window.Game = window.Game || {};

window.Game.Weapon = class
{
  constructor(scene, camera, ui)
  {
    this.scene = scene;
    this.camera = camera;
    this.ui = ui;

    // ---- Per-weapon state ------------------------------------------------
    // Rifle stats (preserved exactly)
    this.rifle = {
      ammo: 50,
      maxAmmo: 200,
      fireRate: 0.12,
      damage: 20,
      spread: 0.005,
      maxRange: 200,
      fireTimer: 0,
      kick: 0,
      kickDecay: 8,
      flashT: 0,
    };

    // Rocket stats (new)
    this.rocket = {
      ammo: 10,
      maxAmmo: 30,
      fireRate: 0.7,
      damage: 90,             // direct hit
      splashRadius: 5,
      splashDamage: 90,       // peak splash damage at centre
      selfDamageScale: 0.5,   // self-damage gets scaled (rocket-jumping is survivable)
      projectileSpeed: 25,
      projectileMaxDist: 100,
      proximityDetonate: 0.4, // detonate within this distance to an enemy mesh
      fireTimer: 0,
      kick: 0,
      kickDecay: 6,
      flashT: 0,
    };

    // Active weapon name & generic state
    this.current = 'rifle';
    this.firing = false;

    // Camera shake (read by main.js)
    this.cameraShake = { intensity: 0, duration: 0 };

    // Sway / time
    this._bobPhase = 0;
    this._time = 0;

    // ---- Effects pool (all transient meshes: impacts, blood, tracers,
    //                   explosions, smoke, light flashes) ------------------
    this.effects = [];
    this.maxEffects = 40;

    // In-flight rockets
    this.rockets = [];
    this._smokeTimer = 0;

    // ---- Pre-allocate scratch math objects -------------------------------
    this.raycaster = new THREE.Raycaster();
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();

    // ---- Pre-built textures ----------------------------------------------
    this._flashTexture     = this._makeFlashTexture();
    this._impactTexture    = this._makeImpactTexture();
    this._bloodTexture     = this._makeBloodTexture();
    this._explosionTexture = this._makeExplosionTexture();
    this._smokeTexture     = this._makeSmokeTexture();
    this._sparkTexture     = this._makeSparkTexture();

    // ---- Build viewmodels (parented to camera) ---------------------------
    // Rifle viewmodel
    this.rifleView = new THREE.Group();
    this.rifleView.name = 'RifleViewmodel';
    this._rifleRest = new THREE.Vector3(0.25, -0.22, -0.55);
    this.rifleView.position.copy(this._rifleRest);
    this._buildRifleViewmodel();
    this._buildRifleMuzzleFlash();

    // Rocket viewmodel
    this.rocketView = new THREE.Group();
    this.rocketView.name = 'RocketViewmodel';
    this._rocketRest = new THREE.Vector3(0.22, -0.24, -0.55);
    this.rocketView.position.copy(this._rocketRest);
    this._buildRocketViewmodel();
    this._buildRocketMuzzleFlash();

    // BACK-COMPAT: legacy code may inspect `viewmodel`; expose the active one.
    this.viewmodel = this.rifleView;

    camera.add(this.rifleView);
    camera.add(this.rocketView);
    if (!camera.parent)
    {
      scene.add(camera);
    }

    // Show rifle by default
    this.rocketView.visible = false;
    this.rifleView.visible  = true;

    // ---- Input ------------------------------------------------------------
    this._onMouseDown = (e) =>
    {
      if (e.button !== 0) return;
      if (!document.pointerLockElement) return;
      this.firing = true;
    };
    this._onMouseUp = (e) =>
    {
      if (e.button !== 0) return;
      this.firing = false;
    };
    this._onKeyDown = (e) =>
    {
      if (!document.pointerLockElement) return;
      if (e.code === 'Digit1')      this.switchTo('rifle');
      else if (e.code === 'Digit2') this.switchTo('rocket');
    };
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('keydown', this._onKeyDown);
  }

  // -------------------------------------------------------------------------
  // Compatibility getters / setters
  // -------------------------------------------------------------------------

  // `ammo` reflects the active weapon (so existing UI code keeps working).
  get ammo()
  {
    return this.current === 'rocket' ? this.rocket.ammo : this.rifle.ammo;
  }
  // main.js does `weapon.ammo = 50` on respawn -> we route to active weapon.
  set ammo(v)
  {
    if (this.current === 'rocket') this.rocket.ammo = v;
    else                            this.rifle.ammo = v;
  }

  get maxAmmo()
  {
    return this.current === 'rocket' ? this.rocket.maxAmmo : this.rifle.maxAmmo;
  }

  get fireRate()
  {
    return this.current === 'rocket' ? this.rocket.fireRate : this.rifle.fireRate;
  }

  // Convenience per-weapon ammo accessors
  get ammoRifle()  { return this.rifle.ammo;  }
  set ammoRifle(v) { this.rifle.ammo = v; }
  get ammoRocket()  { return this.rocket.ammo;  }
  set ammoRocket(v) { this.rocket.ammo = v; }

  // -------------------------------------------------------------------------
  // Texture builders (one-time)
  // -------------------------------------------------------------------------

  _makeFlashTexture()
  {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    grad.addColorStop(0.0,  'rgba(255,255,230,1)');
    grad.addColorStop(0.15, 'rgba(255,220,140,1)');
    grad.addColorStop(0.4,  'rgba(255,140,40,0.85)');
    grad.addColorStop(0.75, 'rgba(180,60,10,0.25)');
    grad.addColorStop(1.0,  'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,220,140,0.6)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 8; i++)
    {
      const a = (i / 8) * Math.PI * 2 + Math.random() * 0.2;
      const r1 = 6;
      const r2 = (size / 2) * (0.7 + Math.random() * 0.3);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  _makeImpactTexture()
  {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    grad.addColorStop(0.0, 'rgba(255,240,200,1)');
    grad.addColorStop(0.3, 'rgba(255,180,80,0.9)');
    grad.addColorStop(0.7, 'rgba(120,80,30,0.3)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,220,160,0.85)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 6; i++)
    {
      const a = Math.random() * Math.PI * 2;
      const r1 = 2;
      const r2 = 6 + Math.random() * (size / 2 - 6);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  _makeBloodTexture()
  {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    grad.addColorStop(0.0, 'rgba(255,80,60,1)');
    grad.addColorStop(0.4, 'rgba(180,20,15,0.8)');
    grad.addColorStop(0.8, 'rgba(80,5,5,0.25)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 14; i++)
    {
      const a = Math.random() * Math.PI * 2;
      const r = 6 + Math.random() * (size / 2 - 6);
      const dotR = 1 + Math.random() * 2.5;
      ctx.fillStyle = `rgba(${140 + Math.random()*60|0},${20 + Math.random()*30|0},${15 + Math.random()*20|0},${0.6 + Math.random()*0.3})`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  _makeExplosionTexture()
  {
    // Like the muzzle flash but bigger / hotter. Used additively.
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    grad.addColorStop(0.0,  'rgba(255,255,240,1)');
    grad.addColorStop(0.12, 'rgba(255,230,170,1)');
    grad.addColorStop(0.30, 'rgba(255,160,60,0.95)');
    grad.addColorStop(0.55, 'rgba(220,80,20,0.7)');
    grad.addColorStop(0.80, 'rgba(80,30,10,0.25)');
    grad.addColorStop(1.0,  'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Hot rays
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,220,160,0.55)';
    ctx.lineWidth = 4;
    for (let i = 0; i < 14; i++)
    {
      const a = Math.random() * Math.PI * 2;
      const r1 = 8;
      const r2 = (size / 2) * (0.6 + Math.random() * 0.4);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  _makeSmokeTexture()
  {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    grad.addColorStop(0.0, 'rgba(255,200,140,0.55)');
    grad.addColorStop(0.4, 'rgba(180,140,110,0.35)');
    grad.addColorStop(0.8, 'rgba(80,70,60,0.18)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  _makeSparkTexture()
  {
    const size = 32;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    grad.addColorStop(0.0, 'rgba(255,250,210,1)');
    grad.addColorStop(0.4, 'rgba(255,160,60,0.85)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // -------------------------------------------------------------------------
  // Viewmodel construction - rifle (preserved)
  // -------------------------------------------------------------------------

  _buildRifleViewmodel()
  {
    const metalMat  = new THREE.MeshBasicMaterial({ color: 0x2a2a2c });
    const woodMat   = new THREE.MeshBasicMaterial({ color: 0x5a3a22 });
    const accentMat = new THREE.MeshBasicMaterial({ color: 0x8a6a30 });
    const sightMat  = new THREE.MeshBasicMaterial({ color: 0x111114 });

    const receiverGeom = new THREE.BoxGeometry(0.18, 0.16, 0.3);
    this._receiver = new THREE.Mesh(receiverGeom, woodMat);
    this._receiver.position.set(0, 0, 0);
    this.rifleView.add(this._receiver);

    const barrelGeom = new THREE.BoxGeometry(0.08, 0.08, 0.6);
    this._barrel = new THREE.Mesh(barrelGeom, metalMat);
    this._barrel.position.set(0, 0.02, -0.42);
    this.rifleView.add(this._barrel);

    const muzzleGeom = new THREE.BoxGeometry(0.10, 0.10, 0.06);
    const muzzle = new THREE.Mesh(muzzleGeom, metalMat);
    muzzle.position.set(0, 0.02, -0.74);
    this.rifleView.add(muzzle);
    this._muzzleEnd = muzzle;

    const sightGeom = new THREE.BoxGeometry(0.02, 0.04, 0.04);
    const sight = new THREE.Mesh(sightGeom, sightMat);
    sight.position.set(0, 0.09, -0.6);
    this.rifleView.add(sight);

    const rearGeom = new THREE.BoxGeometry(0.04, 0.03, 0.03);
    const rear = new THREE.Mesh(rearGeom, sightMat);
    rear.position.set(0, 0.10, -0.05);
    this.rifleView.add(rear);

    const accentGeom = new THREE.BoxGeometry(0.16, 0.03, 0.06);
    const accent = new THREE.Mesh(accentGeom, accentMat);
    accent.position.set(0, -0.085, 0.05);
    this.rifleView.add(accent);

    const gripGeom = new THREE.BoxGeometry(0.07, 0.22, 0.08);
    const grip = new THREE.Mesh(gripGeom, woodMat);
    grip.position.set(0, -0.18, 0.10);
    grip.rotation.x = THREE.MathUtils.degToRad(25);
    this.rifleView.add(grip);

    this.rifleView.traverse((m) =>
    {
      if (m.isMesh && m.material)
      {
        m.material.depthTest = false;
        m.material.depthWrite = false;
        m.material.transparent = false;
        m.renderOrder = 999;
      }
    });
  }

  _buildRifleMuzzleFlash()
  {
    const mat = new THREE.MeshBasicMaterial({
      map: this._flashTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(0.45, 0.45);
    this._muzzleFlash = new THREE.Mesh(geom, mat);
    this._muzzleFlash.position.set(0, 0.02, -0.78);
    this._muzzleFlash.visible = false;
    this._muzzleFlash.renderOrder = 1000;
    this.rifleView.add(this._muzzleFlash);
  }

  // -------------------------------------------------------------------------
  // Viewmodel construction - rocket launcher (new)
  // -------------------------------------------------------------------------

  _buildRocketViewmodel()
  {
    const tubeMat   = new THREE.MeshBasicMaterial({ color: 0x3a3a3e });
    const accentMat = new THREE.MeshBasicMaterial({ color: 0x6a3a18 });
    const stockMat  = new THREE.MeshBasicMaterial({ color: 0x222226 });
    const ringMat   = new THREE.MeshBasicMaterial({ color: 0x111114 });
    const sightMat  = new THREE.MeshBasicMaterial({ color: 0x1a1a1c });

    // Main barrel - thick tube
    const barrelGeom = new THREE.BoxGeometry(0.16, 0.16, 0.9);
    const barrel = new THREE.Mesh(barrelGeom, tubeMat);
    barrel.position.set(0, 0.02, -0.42);
    this.rocketView.add(barrel);

    // Tube ring near the muzzle (a slightly larger box around the barrel)
    const ringGeom = new THREE.BoxGeometry(0.20, 0.20, 0.06);
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.position.set(0, 0.02, -0.78);
    this.rocketView.add(ring);

    // Forward muzzle plate - the actual end of the barrel
    const muzzleGeom = new THREE.BoxGeometry(0.18, 0.18, 0.04);
    const muzzle = new THREE.Mesh(muzzleGeom, tubeMat);
    muzzle.position.set(0, 0.02, -0.84);
    this.rocketView.add(muzzle);
    this._rocketMuzzle = muzzle;

    // Top sight (accent block on the barrel)
    const sightGeom = new THREE.BoxGeometry(0.04, 0.05, 0.07);
    const sight = new THREE.Mesh(sightGeom, sightMat);
    sight.position.set(0, 0.13, -0.4);
    this.rocketView.add(sight);

    // Mid accent band (warning stripe)
    const accentGeom = new THREE.BoxGeometry(0.17, 0.17, 0.05);
    const accent = new THREE.Mesh(accentGeom, accentMat);
    accent.position.set(0, 0.02, -0.18);
    this.rocketView.add(accent);

    // Shoulder stock at the rear
    const stockGeom = new THREE.BoxGeometry(0.10, 0.18, 0.22);
    const stock = new THREE.Mesh(stockGeom, stockMat);
    stock.position.set(0, -0.04, 0.18);
    this.rocketView.add(stock);

    // Grip below the body
    const gripGeom = new THREE.BoxGeometry(0.06, 0.18, 0.07);
    const grip = new THREE.Mesh(gripGeom, stockMat);
    grip.position.set(0, -0.16, 0.04);
    grip.rotation.x = THREE.MathUtils.degToRad(15);
    this.rocketView.add(grip);

    // Apply depthTest off + high renderOrder so weapon never gets clipped
    this.rocketView.traverse((m) =>
    {
      if (m.isMesh && m.material)
      {
        m.material.depthTest = false;
        m.material.depthWrite = false;
        m.material.transparent = false;
        m.renderOrder = 999;
      }
    });
  }

  _buildRocketMuzzleFlash()
  {
    const mat = new THREE.MeshBasicMaterial({
      map: this._flashTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(0.7, 0.7);
    this._rocketFlash = new THREE.Mesh(geom, mat);
    this._rocketFlash.position.set(0, 0.02, -0.9);
    this._rocketFlash.visible = false;
    this._rocketFlash.renderOrder = 1000;
    this.rocketView.add(this._rocketFlash);
  }

  // -------------------------------------------------------------------------
  // Weapon switching
  // -------------------------------------------------------------------------

  switchTo(name)
  {
    if (name !== 'rifle' && name !== 'rocket') return;
    if (this.current === name) return;

    this.current = name;

    // Stop holding fire so we don't immediately blast on switch
    this.firing = false;

    // Visibility
    this.rifleView.visible  = (name === 'rifle');
    this.rocketView.visible = (name === 'rocket');
    this.viewmodel = (name === 'rifle') ? this.rifleView : this.rocketView;

    // HUD updates
    if (this.ui)
    {
      if (typeof this.ui.setAmmo === 'function')
      {
        this.ui.setAmmo(this.ammo);
      }
      if (typeof this.ui.message === 'function')
      {
        const label = name === 'rifle' ? 'RIFLE' : 'ROCKET LAUNCHER';
        this.ui.message(label, 1200);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(dt, ctx)
  {
    this._time += dt;

    // 1. Decrement per-weapon fire timers
    if (this.rifle.fireTimer  > 0) { this.rifle.fireTimer  = Math.max(0, this.rifle.fireTimer  - dt); }
    if (this.rocket.fireTimer > 0) { this.rocket.fireTimer = Math.max(0, this.rocket.fireTimer - dt); }

    // 2. Decay muzzle flashes
    this._tickFlash(this.rifle, this._muzzleFlash, dt);
    this._tickFlash(this.rocket, this._rocketFlash, dt);

    // 3. Sway / kick on the active viewmodel
    let bobX = 0, bobY = 0;
    if (ctx && ctx.player)
    {
      const player = ctx.player;
      const speed = player.velocity ? Math.sqrt(player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z) : 0;
      const moving = speed > 0.1 && player.onGround && !player.dead;
      if (moving)
      {
        this._bobPhase += dt * 9;
        bobY = Math.sin(this._time * 9) * 0.012;
        bobX = Math.cos(this._time * 4.5) * 0.008;
      }
      else
      {
        bobY = Math.sin(this._time * 1.6) * 0.0025;
        bobX = Math.cos(this._time * 1.2) * 0.0015;
      }
    }

    // Decay kick on both weapons (so a switch mid-recoil settles too)
    this._decayKick(this.rifle, dt);
    this._decayKick(this.rocket, dt);

    // Apply pose to active viewmodel
    if (this.current === 'rifle')
    {
      this._applyPose(this.rifleView, this._rifleRest, this.rifle.kick, bobX, bobY);
    }
    else
    {
      // Rocket has chunkier recoil feel
      this._applyPose(this.rocketView, this._rocketRest, this.rocket.kick, bobX, bobY, 0.10, 0.03, 0.25);
    }

    // 4. Update lingering effects (impacts, blood, tracers, explosions, smoke, lights)
    this._updateEffects(dt);

    // 5. Simulate in-flight rockets
    this._updateRockets(dt, ctx);

    // 6. Decay camera shake
    if (this.cameraShake.duration > 0)
    {
      this.cameraShake.duration -= dt;
      if (this.cameraShake.duration <= 0)
      {
        this.cameraShake.duration = 0;
        this.cameraShake.intensity = 0;
      }
      else
      {
        // Linear decay of intensity over remaining duration looks fine
        this.cameraShake.intensity *= Math.max(0, 1 - dt * 2.5);
      }
    }

    // 7. Auto-fire while held
    if (this.firing)
    {
      const w = this.current === 'rocket' ? this.rocket : this.rifle;
      if (w.fireTimer <= 0 && w.ammo > 0)
      {
        this.fire(ctx);
      }
    }
  }

  _decayKick(w, dt)
  {
    if (w.kick > 0)
    {
      w.kick -= w.kickDecay * dt * w.kick;
      if (w.kick < 0.0005) w.kick = 0;
    }
  }

  _applyPose(view, rest, kick, bobX, bobY, kickBackS, kickDownS, kickRotS)
  {
    const kBack = kick * (kickBackS != null ? kickBackS : 0.06);
    const kDown = kick * (kickDownS != null ? kickDownS : 0.02);
    const kRot  = kick * (kickRotS  != null ? kickRotS  : 0.18);
    view.position.set(
      rest.x + bobX,
      rest.y + bobY - kDown,
      rest.z + kBack
    );
    view.rotation.set(kRot, 0, 0);
  }

  _tickFlash(w, mesh, dt)
  {
    if (w.flashT > 0)
    {
      w.flashT -= dt;
      if (w.flashT > 0)
      {
        const f = w.flashT / 0.07;
        mesh.visible = true;
        const s = 0.7 + f * 0.6 + (Math.random() * 0.1 - 0.05);
        mesh.scale.set(s, s, s);
        mesh.material.opacity = f;
      }
      else
      {
        w.flashT = 0;
        mesh.visible = false;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Effects pool
  // -------------------------------------------------------------------------

  _updateEffects(dt)
  {
    for (let i = this.effects.length - 1; i >= 0; i--)
    {
      const fx = this.effects[i];
      fx.t += dt;
      const k = 1 - (fx.t / fx.ttl);

      if (fx.t >= fx.ttl)
      {
        this._disposeFx(fx);
        this.effects.splice(i, 1);
        continue;
      }

      // Per-kind animation
      if (fx.kind === 'impact')
      {
        fx.mesh.material.opacity = Math.max(0, k);
        const s = fx.startScale * (1 + (1 - k) * 0.6);
        fx.mesh.scale.set(s, s, s);
      }
      else if (fx.kind === 'blood')
      {
        fx.mesh.material.opacity = Math.max(0, k);
        const s = fx.startScale * (1 + (1 - k) * 0.8);
        fx.mesh.scale.set(s, s, s);
      }
      else if (fx.kind === 'tracer')
      {
        fx.mesh.material.opacity = Math.max(0, k * 0.85);
      }
      else if (fx.kind === 'explosion')
      {
        // Grow from 0.5 -> 4 over the first 0.3s then fade.
        const tNorm = fx.t / fx.ttl;
        const growT = Math.min(1, fx.t / 0.3);
        const radius = 0.5 + (4 - 0.5) * growT;
        fx.mesh.scale.set(radius, radius, radius);
        // Fade after the growth window
        const fade = Math.max(0, 1 - tNorm);
        fx.mesh.material.opacity = fade;
        // Always face camera-ish
        fx.mesh.lookAt(this.camera.getWorldPosition(this._tmpVec));
      }
      else if (fx.kind === 'spark')
      {
        // Particle: integrate with simple gravity-ish drag
        fx.vel.y -= 4 * dt;
        fx.mesh.position.x += fx.vel.x * dt;
        fx.mesh.position.y += fx.vel.y * dt;
        fx.mesh.position.z += fx.vel.z * dt;
        fx.vel.multiplyScalar(Math.max(0, 1 - dt * 2.0));
        fx.mesh.material.opacity = Math.max(0, k);
        const s = fx.startScale * (0.7 + (1 - k) * 0.6);
        fx.mesh.scale.set(s, s, s);
        fx.mesh.lookAt(this.camera.getWorldPosition(this._tmpVec));
      }
      else if (fx.kind === 'smoke')
      {
        fx.mesh.position.y += dt * 0.5;
        fx.mesh.material.opacity = Math.max(0, k * 0.6);
        const s = fx.startScale * (1 + (1 - k) * 1.2);
        fx.mesh.scale.set(s, s, s);
        fx.mesh.lookAt(this.camera.getWorldPosition(this._tmpVec));
      }
      else if (fx.kind === 'light')
      {
        const fade = Math.max(0, k);
        fx.mesh.intensity = fx.startIntensity * fade;
      }
    }
  }

  _addEffect(fx)
  {
    while (this.effects.length >= this.maxEffects)
    {
      const old = this.effects.shift();
      this._disposeFx(old);
    }
    this.effects.push(fx);
  }

  _disposeFx(fx)
  {
    if (!fx) return;
    if (fx.mesh && fx.mesh.parent)
    {
      fx.mesh.parent.remove(fx.mesh);
    }
    if (fx.mesh && fx.mesh.material && fx.mesh.material.dispose)
    {
      fx.mesh.material.dispose();
    }
    if (fx.mesh && fx.mesh.geometry && fx.mesh.geometry.dispose)
    {
      fx.mesh.geometry.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Fire (delegates to active weapon)
  // -------------------------------------------------------------------------

  fire(ctx)
  {
    if (this.current === 'rocket')
    {
      this._fireRocket(ctx);
    }
    else
    {
      this._fireRifle(ctx);
    }
  }

  // -------------------------------------------------------------------------
  // Rifle - hitscan (preserved)
  // -------------------------------------------------------------------------

  _fireRifle(ctx)
  {
    if (this.rifle.ammo <= 0) return;

    this.rifle.fireTimer = this.rifle.fireRate;
    this.rifle.ammo--;

    this.camera.getWorldPosition(this._origin);
    this._dir.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    if (this.rifle.spread > 0)
    {
      this._dir.x += (Math.random() - 0.5) * 2 * this.rifle.spread;
      this._dir.y += (Math.random() - 0.5) * 2 * this.rifle.spread;
      this._dir.z += (Math.random() - 0.5) * 2 * this.rifle.spread;
      this._dir.normalize();
    }

    const targets = this._gatherTargets(ctx);

    this.raycaster.set(this._origin, this._dir);
    this.raycaster.near = 0;
    this.raycaster.far = this.rifle.maxRange;

    const hits = this.raycaster.intersectObjects(targets, false);

    let hitPoint = null;

    if (hits.length > 0)
    {
      const h = hits[0];
      hitPoint = h.point;
      const ud = h.object && h.object.userData ? h.object.userData : null;
      const enemyRef = ud ? ud.enemyRef : null;
      const peerId   = ud ? ud.peerId   : null;

      if (enemyRef && enemyRef.alive && typeof enemyRef.takeDamage === 'function')
      {
        try { enemyRef.takeDamage(this.rifle.damage, h.point); } catch (e) { /* ignore */ }
        this._spawnBlood(h.point);
      }
      else if (peerId && ctx && ctx.network && typeof ctx.network.sendHit === 'function')
      {
        try { ctx.network.sendHit(peerId, this.rifle.damage); } catch (e) { /* ignore */ }
        this._spawnBlood(h.point);
      }
      else
      {
        this._spawnImpact(h.point, h.face ? h.face.normal : null, h.object);
      }
    }

    const tracerEnd = hitPoint
      ? hitPoint.clone()
      : this._origin.clone().add(this._dir.clone().multiplyScalar(this.rifle.maxRange));
    this._spawnTracer(tracerEnd);

    this.rifle.flashT = 0.07;
    this._muzzleFlash.rotation.z = Math.random() * Math.PI * 2;
    this.rifle.kick = 1;

    this._setHudAmmo(ctx);
  }

  _gatherTargets(ctx)
  {
    const targets = [];
    if (ctx && ctx.level && ctx.level.collidableMeshes)
    {
      for (let i = 0; i < ctx.level.collidableMeshes.length; i++)
      {
        targets.push(ctx.level.collidableMeshes[i]);
      }
    }
    if (ctx && ctx.enemies)
    {
      for (let i = 0; i < ctx.enemies.length; i++)
      {
        const e = ctx.enemies[i];
        if (!e || !e.alive || !e.mesh) continue;
        e.mesh.traverse((m) =>
        {
          if (m.isMesh) targets.push(m);
        });
      }
    }
    // Remote players (PvP). Each mesh has userData.peerId.
    if (ctx && ctx.network && typeof ctx.network.getRemoteMeshes === 'function')
    {
      const rm = ctx.network.getRemoteMeshes();
      for (let i = 0; i < rm.length; i++) targets.push(rm[i]);
    }
    return targets;
  }

  // -------------------------------------------------------------------------
  // Rocket - projectile
  // -------------------------------------------------------------------------

  _fireRocket(ctx)
  {
    if (this.rocket.ammo <= 0) return;

    this.rocket.fireTimer = this.rocket.fireRate;
    this.rocket.ammo--;

    // Spawn position: rocket muzzle world-space.
    const spawn = new THREE.Vector3();
    this._rocketMuzzle.getWorldPosition(spawn);

    // Direction: camera forward.
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    // Build projectile mesh - tiny cylinder with a cone tip.
    const projGroup = new THREE.Group();

    const bodyGeom = new THREE.CylinderGeometry(0.07, 0.07, 0.28, 10);
    const bodyMat  = new THREE.MeshBasicMaterial({ color: 0x222226 });
    const body     = new THREE.Mesh(bodyGeom, bodyMat);
    // Cylinder is along Y by default; we'll orient the group along world dir below.
    body.rotation.x = Math.PI / 2;
    projGroup.add(body);

    const tipGeom = new THREE.ConeGeometry(0.07, 0.16, 10);
    const tipMat  = new THREE.MeshBasicMaterial({ color: 0xff7822, emissive: 0xff5500 });
    // MeshBasicMaterial doesn't really do emissive, but we keep colour bright.
    const tip = new THREE.Mesh(tipGeom, tipMat);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = -0.20;
    projGroup.add(tip);

    // Glow plug at the back (visual flame)
    const flameGeom = new THREE.PlaneGeometry(0.25, 0.25);
    const flameMat  = new THREE.MeshBasicMaterial({
      map: this._flashTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const flame = new THREE.Mesh(flameGeom, flameMat);
    flame.position.z = 0.18;
    projGroup.add(flame);

    projGroup.position.copy(spawn);
    // Orient: look along dir (lookAt point ahead of spawn).
    projGroup.lookAt(spawn.clone().add(dir));
    projGroup.userData.isProjectile = true;
    projGroup.traverse((m) =>
    {
      if (m.isMesh) m.userData.isProjectile = true;
    });

    this.scene.add(projGroup);

    this.rockets.push({
      mesh: projGroup,
      flame: flame,
      pos: spawn.clone(),
      prevPos: spawn.clone(),
      dir: dir.clone(),
      vel: dir.clone().multiplyScalar(this.rocket.projectileSpeed),
      distance: 0,
      smokeTimer: 0,
      alive: true,
    });

    // Muzzle flash + kick
    this.rocket.flashT = 0.10;
    this._rocketFlash.rotation.z = Math.random() * Math.PI * 2;
    this.rocket.kick = 1;

    this._setHudAmmo(ctx);
  }

  _updateRockets(dt, ctx)
  {
    if (this.rockets.length === 0) return;

    for (let i = this.rockets.length - 1; i >= 0; i--)
    {
      const r = this.rockets[i];
      if (!r.alive)
      {
        // dispose
        if (r.mesh && r.mesh.parent) r.mesh.parent.remove(r.mesh);
        r.mesh && r.mesh.traverse && r.mesh.traverse((m) =>
        {
          if (m.isMesh)
          {
            if (m.material && m.material.dispose) m.material.dispose();
            if (m.geometry && m.geometry.dispose) m.geometry.dispose();
          }
        });
        this.rockets.splice(i, 1);
        continue;
      }

      // Advance
      r.prevPos.copy(r.pos);
      r.pos.x += r.vel.x * dt;
      r.pos.y += r.vel.y * dt;
      r.pos.z += r.vel.z * dt;
      const stepLen = r.prevPos.distanceTo(r.pos);
      r.distance += stepLen;

      // Apply to mesh
      r.mesh.position.copy(r.pos);
      r.mesh.lookAt(r.pos.clone().add(r.dir));

      // Smoke trail every few frames (rate-limited by accumulator)
      r.smokeTimer -= dt;
      if (r.smokeTimer <= 0)
      {
        r.smokeTimer = 0.04;  // ~25 puffs/sec, but capped by maxEffects pool
        this._spawnSmokePuff(r.pos);
      }

      // Collision: raycast prev->new against level + alive enemy meshes + remote players
      let detonateAt = null;
      let hitEnemy = null;
      let hitPeerId = null;

      if (stepLen > 1e-6)
      {
        const targets = this._gatherTargets(ctx);
        const segDir = this._tmpVec.copy(r.pos).sub(r.prevPos).normalize();
        this.raycaster.set(r.prevPos, segDir);
        this.raycaster.near = 0;
        this.raycaster.far = stepLen + 0.001;
        const hits = this.raycaster.intersectObjects(targets, false);
        if (hits.length > 0)
        {
          // ignore hits on our own projectile mesh (defence-in-depth)
          for (let h = 0; h < hits.length; h++)
          {
            const ud = hits[h].object && hits[h].object.userData ? hits[h].object.userData : null;
            if (ud && ud.isProjectile) continue;
            detonateAt = hits[h].point.clone();
            const enemyRef = ud ? ud.enemyRef : null;
            if (enemyRef && enemyRef.alive)
            {
              hitEnemy = enemyRef;
            }
            else if (ud && ud.peerId)
            {
              hitPeerId = ud.peerId;
            }
            break;
          }
        }
      }

      // Proximity fuse to alive enemies (so direct hits feel chunky)
      if (!detonateAt && ctx && ctx.enemies)
      {
        const proxSq = this.rocket.proximityDetonate * this.rocket.proximityDetonate;
        for (let e = 0; e < ctx.enemies.length; e++)
        {
          const en = ctx.enemies[e];
          if (!en || !en.alive || !en.position) continue;
          // Use enemy mid-height for distance
          const ex = en.position.x - r.pos.x;
          const ey = (en.position.y + 0.9) - r.pos.y;
          const ez = en.position.z - r.pos.z;
          const d2 = ex*ex + ey*ey + ez*ez;
          if (d2 < proxSq + 0.5)   // a bit of leeway
          {
            detonateAt = r.pos.clone();
            hitEnemy = en;
            break;
          }
        }
      }

      // Max range
      if (!detonateAt && r.distance > this.rocket.projectileMaxDist)
      {
        detonateAt = r.pos.clone();
      }

      if (detonateAt)
      {
        // Direct hit damage to the enemy struck by the ray
        if (hitEnemy && hitEnemy.alive && typeof hitEnemy.takeDamage === 'function')
        {
          try { hitEnemy.takeDamage(this.rocket.damage, detonateAt); } catch (e) { /* ignore */ }
          this._spawnBlood(detonateAt);
        }
        // Direct hit on a remote player -> route through network
        else if (hitPeerId && ctx && ctx.network && typeof ctx.network.sendHit === 'function')
        {
          try { ctx.network.sendHit(hitPeerId, this.rocket.damage); } catch (e) { /* ignore */ }
          this._spawnBlood(detonateAt);
        }

        this._detonateRocket(detonateAt, ctx, hitEnemy, hitPeerId);
        r.alive = false;
      }
    }
  }

  _detonateRocket(point, ctx, directHitEnemy, directHitPeerId)
  {
    const radius = this.rocket.splashRadius;
    const radiusSq = radius * radius;

    // ---- Splash damage to remote players (PvP) ---------------------------
    if (ctx && ctx.network && ctx.network.remotes && typeof ctx.network.sendHit === 'function')
    {
      ctx.network.remotes.forEach((remote, peerId) => {
        if (!remote || (remote.hp != null && remote.hp <= 0)) return;
        const t = remote.target;
        if (!t) return;
        // Body centre roughly 0.9m above feet
        const ex = t.x - point.x;
        const ey = (t.y + 0.9) - point.y;
        const ez = t.z - point.z;
        const d2 = ex*ex + ey*ey + ez*ez;
        if (d2 > radiusSq) return;
        const d = Math.sqrt(Math.max(0, d2));
        const falloff = 1 - (d / radius);
        let dmg = this.rocket.splashDamage * falloff;
        if (peerId === directHitPeerId) dmg *= 0.25;
        if (dmg > 0) {
          try { ctx.network.sendHit(peerId, dmg); } catch (e) { /* ignore */ }
        }
      });
    }

    // ---- Splash damage to enemies ----------------------------------------
    if (ctx && ctx.enemies)
    {
      for (let i = 0; i < ctx.enemies.length; i++)
      {
        const en = ctx.enemies[i];
        if (!en || !en.alive || !en.position) continue;

        // Use mid-body for the distance check
        const ex = en.position.x - point.x;
        const ey = (en.position.y + 0.9) - point.y;
        const ez = en.position.z - point.z;
        const d2 = ex*ex + ey*ey + ez*ez;
        if (d2 > radiusSq) continue;

        const d = Math.sqrt(Math.max(0, d2));
        const falloff = 1 - (d / radius);
        let dmg = this.rocket.splashDamage * falloff;
        // Don't double-damage the directly-hit enemy on top of the 90 direct.
        // We already applied direct damage above; reduce splash on them.
        if (en === directHitEnemy)
        {
          dmg *= 0.25;
        }
        if (dmg > 0 && typeof en.takeDamage === 'function')
        {
          try { en.takeDamage(dmg, point); } catch (e) { /* ignore */ }
        }

        // Knock enemies outward (impulse on velocity if available)
        if (en.velocity)
        {
          const inv = d > 1e-4 ? 1 / d : 0;
          const nx = ex * inv;
          const ny = ey * inv;
          const nz = ez * inv;
          // Negative because (ex,ey,ez) goes from explosion -> enemy already.
          // Wait - that's already outward. So push along (nx,ny,nz).
          const impulse = 8 * falloff;
          en.velocity.x += nx * impulse;
          en.velocity.y += Math.max(2, ny * impulse + 3);  // a little vertical pop
          en.velocity.z += nz * impulse;
        }
      }
    }

    // ---- Splash damage + impulse to player -------------------------------
    if (ctx && ctx.player && !ctx.player.dead)
    {
      const p = ctx.player;
      // Player eye is at p.position; account for body height (feet ~ p.position.y - 1.7).
      // Use a body centre roughly 0.85 below eye.
      const cx = p.position.x;
      const cy = p.position.y - 0.85;
      const cz = p.position.z;

      const ex = cx - point.x;
      const ey = cy - point.y;
      const ez = cz - point.z;
      const d2 = ex*ex + ey*ey + ez*ez;

      if (d2 < radiusSq)
      {
        const d = Math.sqrt(Math.max(0.0001, d2));
        const falloff = 1 - (d / radius);

        // Self damage scaled so rocket-jumping is survivable
        const dmg = this.rocket.splashDamage * falloff * this.rocket.selfDamageScale;
        if (dmg > 0 && typeof p.takeDamage === 'function')
        {
          try { p.takeDamage(dmg); } catch (e) { /* ignore */ }
        }

        // Knockback impulse - separate vertical kick + horizontal push.
        if (p.velocity)
        {
          // Horizontal direction (normalized in XZ plane).
          let hx = ex, hz = ez;
          const hLen = Math.sqrt(hx*hx + hz*hz);
          if (hLen > 1e-4)
          {
            hx /= hLen;
            hz /= hLen;
          }
          else
          {
            hx = 0; hz = 0;
          }

          // Tuned for ~3x jump height when firing at the floor while jumping.
          // Player jumpImpulse=8, gravity=25 -> normal jump apex ~1.28m.
          // 3x apex ~3.84m -> need v ~ sqrt(2*g*h) ~ sqrt(192) ~ 13.86 -> impulseY ~14.
          // Add to existing velocity so a jump+rocket stacks.
          const impulseY    = 14 * falloff;
          const impulseHoriz = 9 * falloff;

          // Bias the vertical component up a little even if explosion is below.
          // If the explosion is below the player (point.y < cy), ey>0 -> up boost natural.
          // If above, we still give *some* up kick (clamped) so floor-rockets always pop you.
          const upKick = Math.max(impulseY * 0.85, impulseY * (ey > 0 ? 1 : 0.5));

          p.velocity.y += upKick;
          p.velocity.x += hx * impulseHoriz;
          p.velocity.z += hz * impulseHoriz;

          // Player is no longer grounded after a rocket jump
          p.onGround = false;
        }

        // Stronger camera shake when close
        const proximity = 1 - (d / radius);  // 1 at centre, 0 at edge
        this._addShake(0.25 + 0.55 * proximity, 0.4 + 0.2 * proximity);
      }
      else
      {
        // Distant explosion - smaller shake
        const dist = Math.sqrt(d2);
        const farFactor = Math.max(0, 1 - (dist - radius) / 15);
        if (farFactor > 0)
        {
          this._addShake(0.08 * farFactor, 0.25);
        }
      }
    }

    // ---- Visual: explosion sprite, particles, light, smoke ---------------
    this._spawnExplosionSprite(point);
    this._spawnExplosionParticles(point);
    this._spawnExplosionLight(point);

    // HUD ammo refresh (in case ammo display matters here)
    this._setHudAmmo(ctx);
  }

  _addShake(intensity, duration)
  {
    // Stack: take the strongest shake currently active.
    if (intensity > this.cameraShake.intensity)
    {
      this.cameraShake.intensity = intensity;
    }
    if (duration > this.cameraShake.duration)
    {
      this.cameraShake.duration = duration;
    }
  }

  // -------------------------------------------------------------------------
  // Effect spawners (rifle + rocket)
  // -------------------------------------------------------------------------

  _spawnImpact(point, faceNormal, hitObject)
  {
    const mat = new THREE.MeshBasicMaterial({
      map: this._impactTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 1,
    });
    const geom = new THREE.PlaneGeometry(0.35, 0.35);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 800;

    let worldNormal = null;
    if (faceNormal && hitObject)
    {
      worldNormal = faceNormal.clone();
      const nm = new THREE.Matrix3().getNormalMatrix(hitObject.matrixWorld);
      worldNormal.applyMatrix3(nm).normalize();
    }
    else
    {
      worldNormal = this._dir.clone().multiplyScalar(-1);
    }

    mesh.position.copy(point).add(worldNormal.clone().multiplyScalar(0.02));
    const lookTarget = mesh.position.clone().add(worldNormal);
    mesh.lookAt(lookTarget);
    mesh.rotation.z = Math.random() * Math.PI * 2;

    this.scene.add(mesh);
    this._addEffect({ mesh, t: 0, ttl: 0.5, kind: 'impact', startScale: 1 });
  }

  _spawnBlood(point)
  {
    const mat = new THREE.MeshBasicMaterial({
      map: this._bloodTexture,
      transparent: true,
      blending: THREE.NormalBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 1,
      color: 0xff6655,
    });
    const geom = new THREE.PlaneGeometry(0.4, 0.4);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 800;
    mesh.position.copy(point);
    const camPos = this.camera.getWorldPosition(this._tmpVec).clone();
    mesh.lookAt(camPos);
    mesh.rotation.z = Math.random() * Math.PI * 2;

    this.scene.add(mesh);
    this._addEffect({ mesh, t: 0, ttl: 0.4, kind: 'blood', startScale: 1 });
  }

  _spawnTracer(endPoint)
  {
    const muzzlePos = new THREE.Vector3();
    this._muzzleEnd.getWorldPosition(muzzlePos);

    const positions = new Float32Array([
      muzzlePos.x, muzzlePos.y, muzzlePos.z,
      endPoint.x,  endPoint.y,  endPoint.z,
    ]);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
      color: 0xfff0c0,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
    });
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 800;
    this.scene.add(line);
    this._addEffect({ mesh: line, t: 0, ttl: 0.06, kind: 'tracer' });
  }

  _spawnExplosionSprite(point)
  {
    const mat = new THREE.MeshBasicMaterial({
      map: this._explosionTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 1,
    });
    // Use a unit plane and scale it via update.
    const geom = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 850;
    mesh.position.copy(point);
    mesh.scale.setScalar(0.5);

    this.scene.add(mesh);
    this._addEffect({ mesh, t: 0, ttl: 0.55, kind: 'explosion' });
  }

  _spawnExplosionParticles(point)
  {
    const count = 25;
    for (let i = 0; i < count; i++)
    {
      const mat = new THREE.MeshBasicMaterial({
        map: this._sparkTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 1,
        color: i < count * 0.6 ? 0xffaa44 : 0xffe080,
      });
      const size = 0.15 + Math.random() * 0.15;
      const geom = new THREE.PlaneGeometry(size, size);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 850;
      mesh.position.copy(point);

      // Random outward direction
      const phi   = Math.random() * Math.PI * 2;
      const theta = Math.acos(2 * Math.random() - 1);
      const sp = 4 + Math.random() * 4;
      const vx = sp * Math.sin(theta) * Math.cos(phi);
      const vy = sp * Math.cos(theta) + 2;     // bias upward
      const vz = sp * Math.sin(theta) * Math.sin(phi);

      this.scene.add(mesh);
      this._addEffect({
        mesh,
        t: 0,
        ttl: 0.45 + Math.random() * 0.2,
        kind: 'spark',
        startScale: 1,
        vel: new THREE.Vector3(vx, vy, vz),
      });
    }
  }

  _spawnExplosionLight(point)
  {
    const light = new THREE.PointLight(0xff7733, 5, 12, 2);
    light.position.copy(point);
    this.scene.add(light);
    this._addEffect({
      mesh: light,
      t: 0,
      ttl: 0.25,
      kind: 'light',
      startIntensity: 5,
    });
  }

  _spawnSmokePuff(pos)
  {
    const mat = new THREE.MeshBasicMaterial({
      map: this._smokeTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 0.6,
      color: 0xffaa66,
    });
    const size = 0.25 + Math.random() * 0.15;
    const geom = new THREE.PlaneGeometry(size, size);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 820;
    mesh.position.copy(pos);
    mesh.position.x += (Math.random() - 0.5) * 0.05;
    mesh.position.y += (Math.random() - 0.5) * 0.05;
    mesh.position.z += (Math.random() - 0.5) * 0.05;

    this.scene.add(mesh);
    this._addEffect({
      mesh,
      t: 0,
      ttl: 0.45,
      kind: 'smoke',
      startScale: 1,
    });
  }

  // -------------------------------------------------------------------------
  // Misc helpers
  // -------------------------------------------------------------------------

  _setHudAmmo(ctx)
  {
    const ammo = this.ammo;
    if (ctx && ctx.ui && typeof ctx.ui.setAmmo === 'function')
    {
      ctx.ui.setAmmo(ammo);
    }
    else if (this.ui && typeof this.ui.setAmmo === 'function')
    {
      this.ui.setAmmo(ammo);
    }
  }
};
