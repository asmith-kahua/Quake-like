// Game.Weapon - unified first-person weapon module.
//
// Hosts four weapons:
//   1. Rifle    - fast hitscan chaingun-feel rifle (existing behaviour preserved).
//   2. Rocket   - bazooka with travel-time projectile, splash, knockback.
//   3. Shotgun  - hitscan multi-pellet cone (8 pellets per shell).
//   4. Grenade  - arcing lobbed projectile that bounces and detonates with splash.
//
// Public contract (kept compatible with main.js & enemies.js):
//   constructor(scene, camera, ui)
//   update(dt, ctx)              ctx = { player, level, enemies, weapon, ui }
//   fire(ctx)
//   ammo                          (getter)  -> ammo of currently-selected weapon
//   ammoRifle, ammoRocket, ammoShotgun, ammoGrenade   per-weapon counts
//   maxAmmo, fireRate, firing
//   switchTo('rifle' | 'rocket' | 'shotgun' | 'grenade')
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

    // Shotgun stats (new) - hitscan, 8 pellets per shell
    this.shotgun = {
      ammo: 24,               // shells
      maxAmmo: 60,
      fireRate: 0.85,
      damage: 12,             // per pellet
      pellets: 8,
      spread: 0.06,           // cone half-angle in radians
      maxRange: 80,
      fireTimer: 0,
      kick: 0,
      kickDecay: 5,
      flashT: 0,
    };

    // Grenade launcher stats (new) - arcing projectile, bounces, splash
    this.grenade = {
      ammo: 6,
      maxAmmo: 20,
      fireRate: 0.85,
      damage: 60,             // direct contact damage (mob/peer)
      splashRadius: 5,
      splashDamage: 80,       // peak splash damage at centre
      selfDamageScale: 0.5,
      projectileSpeed: 22,    // initial muzzle velocity
      gravity: 18,             // m/s^2
      maxBounces: 2,
      bounceLoss: 0.45,       // velocity scale on bounce
      maxLifetime: 4.0,       // seconds before forced detonation
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
    //                   explosions, smoke, light flashes, debris, rings) ---
    this.effects = [];
    this.maxEffects = 80;

    // In-flight rockets
    this.rockets = [];
    this._smokeTimer = 0;

    // In-flight grenades
    this.grenades = [];

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
    this._woodTexture      = this._makeWoodTexture();
    this._debrisTexture    = this._makeDebrisTexture();

    // ---- Shared geometries (re-used across viewmodels via mesh.scale) ----
    this._barrelBandGeom   = new THREE.CylinderGeometry(0.055, 0.055, 0.018, 6);
    this._slingLoopGeom    = new THREE.TorusGeometry(0.018, 0.005, 4, 8);
    this._sightEarGeom     = new THREE.BoxGeometry(0.012, 0.05, 0.04);
    this._triggerGeom      = new THREE.BoxGeometry(0.012, 0.04, 0.018);
    this._coolingSlatGeom  = new THREE.BoxGeometry(0.22, 0.018, 0.025);
    this._smallAccentGeom  = new THREE.BoxGeometry(0.02, 0.025, 0.025);
    this._drumBoreGeom     = new THREE.CylinderGeometry(0.022, 0.022, 0.04, 8);

    // Projectile geometries (rocket missile + grenade)
    this._rocketBodyGeom   = new THREE.CylinderGeometry(0.07, 0.07, 0.28, 12);
    this._rocketTipGeom    = new THREE.ConeGeometry(0.07, 0.16, 12);
    this._rocketFinGeom    = new THREE.BoxGeometry(0.012, 0.075, 0.10);
    this._grenadeBodyGeom  = new THREE.IcosahedronGeometry(0.10, 1);
    this._grenadeLeverGeom = new THREE.BoxGeometry(0.025, 0.012, 0.06);
    this._grenadePinGeom   = new THREE.TorusGeometry(0.018, 0.004, 4, 10);

    // Effect geometries (created once - shared by transient instances)
    this._shockRingGeom    = new THREE.TorusGeometry(0.5, 0.06, 8, 24);
    this._chunkDebrisGeom  = new THREE.BoxGeometry(0.12, 0.08, 0.10);

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

    // Shotgun viewmodel
    this.shotgunView = new THREE.Group();
    this.shotgunView.name = 'ShotgunViewmodel';
    this._shotgunRest = new THREE.Vector3(0.24, -0.23, -0.55);
    this.shotgunView.position.copy(this._shotgunRest);
    this._buildShotgunViewmodel();
    this._buildShotgunMuzzleFlash();

    // Grenade launcher viewmodel
    this.grenadeView = new THREE.Group();
    this.grenadeView.name = 'GrenadeViewmodel';
    this._grenadeRest = new THREE.Vector3(0.23, -0.24, -0.55);
    this.grenadeView.position.copy(this._grenadeRest);
    this._buildGrenadeViewmodel();
    this._buildGrenadeMuzzleFlash();

    // BACK-COMPAT: legacy code may inspect `viewmodel`; expose the active one.
    this.viewmodel = this.rifleView;

    camera.add(this.rifleView);
    camera.add(this.rocketView);
    camera.add(this.shotgunView);
    camera.add(this.grenadeView);
    if (!camera.parent)
    {
      scene.add(camera);
    }

    // Show rifle by default
    this.rocketView.visible  = false;
    this.shotgunView.visible = false;
    this.grenadeView.visible = false;
    this.rifleView.visible   = true;

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
      else if (e.code === 'Digit3') this.switchTo('shotgun');
      else if (e.code === 'Digit4') this.switchTo('grenade');
    };
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('keydown', this._onKeyDown);
  }

  // -------------------------------------------------------------------------
  // Compatibility getters / setters
  // -------------------------------------------------------------------------

  // Returns the active weapon's stats block.
  _activeWeapon()
  {
    if (this.current === 'rocket')  return this.rocket;
    if (this.current === 'shotgun') return this.shotgun;
    if (this.current === 'grenade') return this.grenade;
    return this.rifle;
  }

  // `ammo` reflects the active weapon (so existing UI code keeps working).
  get ammo()
  {
    return this._activeWeapon().ammo;
  }
  // main.js does `weapon.ammo = 50` on respawn -> we route to active weapon.
  set ammo(v)
  {
    this._activeWeapon().ammo = v;
  }

  get maxAmmo()
  {
    return this._activeWeapon().maxAmmo;
  }

  get fireRate()
  {
    return this._activeWeapon().fireRate;
  }

  // Convenience per-weapon ammo accessors
  get ammoRifle()  { return this.rifle.ammo;  }
  set ammoRifle(v) { this.rifle.ammo = v; }
  get ammoRocket()  { return this.rocket.ammo;  }
  set ammoRocket(v) { this.rocket.ammo = v; }
  get ammoShotgun()  { return this.shotgun.ammo;  }
  set ammoShotgun(v) { this.shotgun.ammo = v; }
  get ammoGrenade()  { return this.grenade.ammo;  }
  set ammoGrenade(v) { this.grenade.ammo = v; }

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

  // Procedural canvas-style wood with checkering grid - used on shotgun grip.
  _makeWoodTexture()
  {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#5a3418';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 40; i++)
    {
      const y = Math.random() * size;
      const w = 0.5 + Math.random() * 1.2;
      ctx.strokeStyle = `rgba(${30 + Math.random()*40|0},${15 + Math.random()*20|0},${5 + Math.random()*10|0},${0.4 + Math.random()*0.4})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(size * 0.3, y + (Math.random() - 0.5) * 8, size * 0.7, y + (Math.random() - 0.5) * 8, size, y + (Math.random() - 0.5) * 6);
      ctx.stroke();
    }

    // Checkering diamond pattern (typical hardwood grip)
    ctx.strokeStyle = 'rgba(20,10,4,0.55)';
    ctx.lineWidth = 1;
    const step = 8;
    for (let x = -size; x < size * 2; x += step)
    {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + size, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, size);
      ctx.lineTo(x + size, 0);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  // Tiny dark fragment texture for impact/explosion debris.
  _makeDebrisTexture()
  {
    const size = 32;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(35,28,20,0.95)';
    ctx.beginPath();
    ctx.moveTo(8, 6);
    ctx.lineTo(26, 4);
    ctx.lineTo(28, 14);
    ctx.lineTo(22, 28);
    ctx.lineTo(6, 24);
    ctx.lineTo(4, 12);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(120,90,60,0.45)';
    ctx.fillRect(10, 8, 4, 2);
    ctx.fillRect(18, 14, 3, 2);

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
    const darkMetal = new THREE.MeshBasicMaterial({ color: 0x14141a });
    const woodMat   = new THREE.MeshBasicMaterial({ color: 0x5a3a22 });
    const accentMat = new THREE.MeshBasicMaterial({ color: 0x8a6a30 });
    const brassMat  = new THREE.MeshBasicMaterial({ color: 0xb08840 });
    const sightMat  = new THREE.MeshBasicMaterial({ color: 0x111114 });

    // Wooden receiver / stock body
    const receiverGeom = new THREE.BoxGeometry(0.18, 0.16, 0.3);
    this._receiver = new THREE.Mesh(receiverGeom, woodMat);
    this._receiver.position.set(0, 0, 0);
    this.rifleView.add(this._receiver);

    // Metal sub-receiver block (sits inside wood, holds bolt)
    const subReceiverGeom = new THREE.BoxGeometry(0.16, 0.10, 0.28);
    const subReceiver = new THREE.Mesh(subReceiverGeom, darkMetal);
    subReceiver.position.set(0, 0.04, 0);
    this.rifleView.add(subReceiver);

    // Main barrel
    const barrelGeom = new THREE.BoxGeometry(0.08, 0.08, 0.6);
    this._barrel = new THREE.Mesh(barrelGeom, metalMat);
    this._barrel.position.set(0, 0.02, -0.42);
    this.rifleView.add(this._barrel);

    // Barrel ribbing - 6 thin cylindrical bands along the barrel
    const bandCount = 6;
    for (let i = 0; i < bandCount; i++)
    {
      const band = new THREE.Mesh(this._barrelBandGeom, darkMetal);
      band.rotation.x = Math.PI / 2;     // align cylinder axis along Z
      const t = i / (bandCount - 1);
      band.position.set(0, 0.02, -0.18 - t * 0.52);
      band.scale.set(0.85, 1, 0.85);
      this.rifleView.add(band);
    }

    // Muzzle plate
    const muzzleGeom = new THREE.BoxGeometry(0.10, 0.10, 0.06);
    const muzzle = new THREE.Mesh(muzzleGeom, metalMat);
    muzzle.position.set(0, 0.02, -0.74);
    this.rifleView.add(muzzle);
    this._muzzleEnd = muzzle;

    // Front sight post + protective ears (two thin blocks framing the post)
    const sightGeom = new THREE.BoxGeometry(0.02, 0.05, 0.04);
    const sight = new THREE.Mesh(sightGeom, sightMat);
    sight.position.set(0, 0.095, -0.62);
    this.rifleView.add(sight);
    const earL = new THREE.Mesh(this._sightEarGeom, darkMetal);
    earL.position.set(-0.022, 0.10, -0.62);
    this.rifleView.add(earL);
    const earR = new THREE.Mesh(this._sightEarGeom, darkMetal);
    earR.position.set( 0.022, 0.10, -0.62);
    this.rifleView.add(earR);

    // Rear iron sight - a notched aperture (block with a small hole gap)
    const rearGeom = new THREE.BoxGeometry(0.05, 0.04, 0.025);
    const rear = new THREE.Mesh(rearGeom, sightMat);
    rear.position.set(0, 0.105, -0.05);
    this.rifleView.add(rear);
    // The aperture left-half + right-half (creates a "U" silhouette)
    const apHalfGeom = new THREE.BoxGeometry(0.018, 0.025, 0.026);
    const apL = new THREE.Mesh(apHalfGeom, darkMetal);
    apL.position.set(-0.016, 0.115, -0.05);
    this.rifleView.add(apL);
    const apR = new THREE.Mesh(apHalfGeom, darkMetal);
    apR.position.set( 0.016, 0.115, -0.05);
    this.rifleView.add(apR);

    // Magazine sticking down from the receiver
    const magGeom = new THREE.BoxGeometry(0.06, 0.16, 0.10);
    const mag = new THREE.Mesh(magGeom, darkMetal);
    mag.position.set(0, -0.16, -0.02);
    mag.rotation.x = THREE.MathUtils.degToRad(-5);
    this.rifleView.add(mag);
    // Mag baseplate
    const magBaseGeom = new THREE.BoxGeometry(0.07, 0.022, 0.11);
    const magBase = new THREE.Mesh(magBaseGeom, metalMat);
    magBase.position.set(0, -0.245, -0.025);
    this.rifleView.add(magBase);

    // Bolt / charging handle on the side of the receiver
    const boltGeom = new THREE.BoxGeometry(0.02, 0.024, 0.10);
    const bolt = new THREE.Mesh(boltGeom, metalMat);
    bolt.position.set(0.10, 0.05, -0.02);
    this.rifleView.add(bolt);
    // Charging handle knob (small cylinder)
    const knobGeom = new THREE.CylinderGeometry(0.016, 0.016, 0.025, 8);
    const knob = new THREE.Mesh(knobGeom, darkMetal);
    knob.rotation.z = Math.PI / 2;
    knob.position.set(0.118, 0.05, -0.02);
    this.rifleView.add(knob);

    // Sling-mount loops (two small toruses)
    const slingFront = new THREE.Mesh(this._slingLoopGeom, darkMetal);
    slingFront.rotation.y = Math.PI / 2;
    slingFront.position.set(0, -0.04, -0.62);
    this.rifleView.add(slingFront);
    const slingRear = new THREE.Mesh(this._slingLoopGeom, darkMetal);
    slingRear.rotation.y = Math.PI / 2;
    slingRear.position.set(0, -0.085, 0.13);
    this.rifleView.add(slingRear);

    // Trigger guard (3 sides) with visible trigger inside
    const guardOuterGeom = new THREE.BoxGeometry(0.06, 0.012, 0.085);
    const guardBottom = new THREE.Mesh(guardOuterGeom, darkMetal);
    guardBottom.position.set(0, -0.112, 0.02);
    this.rifleView.add(guardBottom);
    const guardSideGeom = new THREE.BoxGeometry(0.012, 0.05, 0.012);
    const guardF = new THREE.Mesh(guardSideGeom, darkMetal);
    guardF.position.set(0, -0.092, -0.018);
    this.rifleView.add(guardF);
    const guardR = new THREE.Mesh(guardSideGeom, darkMetal);
    guardR.position.set(0, -0.092, 0.058);
    this.rifleView.add(guardR);
    const trigger = new THREE.Mesh(this._triggerGeom, brassMat);
    trigger.position.set(0, -0.092, 0.025);
    this.rifleView.add(trigger);

    // Lower brass accent plate
    const accentGeom = new THREE.BoxGeometry(0.16, 0.03, 0.06);
    const accent = new THREE.Mesh(accentGeom, accentMat);
    accent.position.set(0, -0.085, 0.05);
    this.rifleView.add(accent);

    // Wood pistol grip
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
    const tubeMat    = new THREE.MeshBasicMaterial({ color: 0x3a3a3e });
    const accentMat  = new THREE.MeshBasicMaterial({ color: 0x6a3a18 });
    const stockMat   = new THREE.MeshBasicMaterial({ color: 0x222226 });
    const ringMat    = new THREE.MeshBasicMaterial({ color: 0x111114 });
    const sightMat   = new THREE.MeshBasicMaterial({ color: 0x1a1a1c });
    const stockPadMat= new THREE.MeshBasicMaterial({ color: 0x3a2618 });
    const switchMat  = new THREE.MeshBasicMaterial({ color: 0x882200 });

    // Main barrel - thicker tube
    const barrelGeom = new THREE.BoxGeometry(0.18, 0.18, 0.9);
    const barrel = new THREE.Mesh(barrelGeom, tubeMat);
    barrel.position.set(0, 0.02, -0.42);
    this.rocketView.add(barrel);

    // Barrel cap with cooling slats (5 thin horizontal slats wrapping cap)
    const capGeom = new THREE.BoxGeometry(0.22, 0.22, 0.10);
    const cap = new THREE.Mesh(capGeom, tubeMat);
    cap.position.set(0, 0.02, -0.80);
    this.rocketView.add(cap);
    for (let i = 0; i < 5; i++)
    {
      const slatTop = new THREE.Mesh(this._coolingSlatGeom, ringMat);
      slatTop.position.set(0, 0.13, -0.84 + i * 0.018);
      this.rocketView.add(slatTop);
      const slatBot = new THREE.Mesh(this._coolingSlatGeom, ringMat);
      slatBot.position.set(0, -0.09, -0.84 + i * 0.018);
      this.rocketView.add(slatBot);
    }

    // Forward muzzle plate
    const muzzleGeom = new THREE.BoxGeometry(0.20, 0.20, 0.04);
    const muzzle = new THREE.Mesh(muzzleGeom, tubeMat);
    muzzle.position.set(0, 0.02, -0.86);
    this.rocketView.add(muzzle);
    this._rocketMuzzle = muzzle;

    // Optical sight on top - a small box scope with end caps
    const scopeGeom = new THREE.BoxGeometry(0.06, 0.06, 0.18);
    const scope = new THREE.Mesh(scopeGeom, sightMat);
    scope.position.set(0, 0.16, -0.30);
    this.rocketView.add(scope);
    const scopeEndGeom = new THREE.CylinderGeometry(0.034, 0.034, 0.02, 10);
    const scopeFront = new THREE.Mesh(scopeEndGeom, ringMat);
    scopeFront.rotation.x = Math.PI / 2;
    scopeFront.position.set(0, 0.16, -0.40);
    this.rocketView.add(scopeFront);
    const scopeRear = new THREE.Mesh(scopeEndGeom, ringMat);
    scopeRear.rotation.x = Math.PI / 2;
    scopeRear.position.set(0, 0.16, -0.20);
    this.rocketView.add(scopeRear);
    // Scope mount block
    const scopeMountGeom = new THREE.BoxGeometry(0.04, 0.05, 0.10);
    const scopeMount = new THREE.Mesh(scopeMountGeom, sightMat);
    scopeMount.position.set(0, 0.10, -0.30);
    this.rocketView.add(scopeMount);

    // Mid accent band (warning stripe)
    const accentGeom = new THREE.BoxGeometry(0.19, 0.19, 0.05);
    const accent = new THREE.Mesh(accentGeom, accentMat);
    accent.position.set(0, 0.02, -0.18);
    this.rocketView.add(accent);

    // Front grip handle below the barrel
    const fgGeom = new THREE.BoxGeometry(0.05, 0.16, 0.06);
    const foregrip = new THREE.Mesh(fgGeom, stockMat);
    foregrip.position.set(0, -0.13, -0.30);
    foregrip.rotation.x = THREE.MathUtils.degToRad(8);
    this.rocketView.add(foregrip);

    // Shoulder stock + dedicated stock pad behind it
    const stockGeom = new THREE.BoxGeometry(0.10, 0.18, 0.22);
    const stock = new THREE.Mesh(stockGeom, stockMat);
    stock.position.set(0, -0.04, 0.18);
    this.rocketView.add(stock);
    const stockPadGeom = new THREE.BoxGeometry(0.11, 0.20, 0.04);
    const stockPad = new THREE.Mesh(stockPadGeom, stockPadMat);
    stockPad.position.set(0, -0.04, 0.31);
    this.rocketView.add(stockPad);

    // Pistol grip (rear)
    const gripGeom = new THREE.BoxGeometry(0.06, 0.18, 0.07);
    const grip = new THREE.Mesh(gripGeom, stockMat);
    grip.position.set(0, -0.16, 0.04);
    grip.rotation.x = THREE.MathUtils.degToRad(15);
    this.rocketView.add(grip);

    // Back-blast vent slats at the rear of the barrel (4 slats around)
    for (let i = 0; i < 4; i++)
    {
      const ventTop = new THREE.Mesh(this._coolingSlatGeom, ringMat);
      ventTop.scale.set(0.7, 1, 1);
      ventTop.position.set(0, 0.13, 0.005 + i * 0.022);
      this.rocketView.add(ventTop);
      const ventBot = new THREE.Mesh(this._coolingSlatGeom, ringMat);
      ventBot.scale.set(0.7, 1, 1);
      ventBot.position.set(0, -0.09, 0.005 + i * 0.022);
      this.rocketView.add(ventBot);
    }

    // Fire-mode selector switch (small red box) on the side of the receiver
    const selector = new THREE.Mesh(this._smallAccentGeom, switchMat);
    selector.position.set(0.10, -0.03, 0.06);
    this.rocketView.add(selector);

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
  // Viewmodel construction - shotgun (new): chunky double-barrel
  // -------------------------------------------------------------------------

  _buildShotgunViewmodel()
  {
    const metalMat   = new THREE.MeshBasicMaterial({ color: 0x33333a });
    const darkMetal  = new THREE.MeshBasicMaterial({ color: 0x18181c });
    const wood2Mat   = new THREE.MeshBasicMaterial({ color: 0x4d2d16 });
    const accentMat  = new THREE.MeshBasicMaterial({ color: 0xa67838 });
    const brassDeep  = new THREE.MeshBasicMaterial({ color: 0x7a5520 });
    const sightMat   = new THREE.MeshBasicMaterial({ color: 0x111114 });
    // Hardwood-checkered material (canvas texture) for the grip + stock.
    const woodCheckMat = new THREE.MeshBasicMaterial({ map: this._woodTexture });

    // Wider receiver (chunkier than the rifle)
    const receiverGeom = new THREE.BoxGeometry(0.22, 0.18, 0.32);
    const receiver = new THREE.Mesh(receiverGeom, wood2Mat);
    receiver.position.set(0, 0, 0);
    this.shotgunView.add(receiver);

    // Brass receiver accent plates (sides of the receiver)
    const brassPlateGeom = new THREE.BoxGeometry(0.012, 0.08, 0.18);
    const brassL = new THREE.Mesh(brassPlateGeom, accentMat);
    brassL.position.set(-0.115, 0.01, -0.02);
    this.shotgunView.add(brassL);
    const brassR = new THREE.Mesh(brassPlateGeom, accentMat);
    brassR.position.set( 0.115, 0.01, -0.02);
    this.shotgunView.add(brassR);
    // Brass top tang (a thin connector from receiver to stock)
    const tangGeom = new THREE.BoxGeometry(0.05, 0.012, 0.10);
    const tang = new THREE.Mesh(tangGeom, brassDeep);
    tang.position.set(0, 0.10, 0.10);
    this.shotgunView.add(tang);

    // Two parallel barrels (side-by-side double barrel) - cylinders for roundness
    const barrelGeomCyl = new THREE.CylinderGeometry(0.038, 0.038, 0.7, 14);
    const barrelL = new THREE.Mesh(barrelGeomCyl, metalMat);
    barrelL.rotation.x = Math.PI / 2;
    barrelL.position.set(-0.05, 0.025, -0.46);
    this.shotgunView.add(barrelL);
    const barrelR = new THREE.Mesh(barrelGeomCyl, metalMat);
    barrelR.rotation.x = Math.PI / 2;
    barrelR.position.set( 0.05, 0.025, -0.46);
    this.shotgunView.add(barrelR);

    // Top rib joining the two barrels
    const ribGeom = new THREE.BoxGeometry(0.14, 0.018, 0.7);
    const rib = new THREE.Mesh(ribGeom, darkMetal);
    rib.position.set(0, 0.065, -0.46);
    this.shotgunView.add(rib);
    // Bottom rib (smaller connector under the barrels)
    const ribBotGeom = new THREE.BoxGeometry(0.13, 0.015, 0.6);
    const ribBot = new THREE.Mesh(ribBotGeom, darkMetal);
    ribBot.position.set(0, -0.018, -0.42);
    this.shotgunView.add(ribBot);

    // Twin muzzle plates (round caps)
    const muzzleCapGeom = new THREE.CylinderGeometry(0.043, 0.043, 0.04, 12);
    const muzzleL = new THREE.Mesh(muzzleCapGeom, darkMetal);
    muzzleL.rotation.x = Math.PI / 2;
    muzzleL.position.set(-0.05, 0.025, -0.83);
    this.shotgunView.add(muzzleL);
    const muzzleR = new THREE.Mesh(muzzleCapGeom, darkMetal);
    muzzleR.rotation.x = Math.PI / 2;
    muzzleR.position.set( 0.05, 0.025, -0.83);
    this.shotgunView.add(muzzleR);
    // Use the centre between the two as the tracer origin
    this._shotgunMuzzle = new THREE.Object3D();
    this._shotgunMuzzle.position.set(0, 0.025, -0.86);
    this.shotgunView.add(this._shotgunMuzzle);

    // Front bead sight (small ball atop the rib)
    const beadGeom = new THREE.SphereGeometry(0.012, 8, 6);
    const bead = new THREE.Mesh(beadGeom, accentMat);
    bead.position.set(0, 0.082, -0.78);
    this.shotgunView.add(bead);
    // Sight base block under the bead
    const sightGeom = new THREE.BoxGeometry(0.018, 0.02, 0.04);
    const sight = new THREE.Mesh(sightGeom, sightMat);
    sight.position.set(0, 0.072, -0.78);
    this.shotgunView.add(sight);

    // Two exposed hammers on the receiver (small angled blocks)
    const hammerGeom = new THREE.BoxGeometry(0.022, 0.05, 0.022);
    const hammerL = new THREE.Mesh(hammerGeom, darkMetal);
    hammerL.position.set(-0.045, 0.10, 0.05);
    hammerL.rotation.x = THREE.MathUtils.degToRad(-25);
    this.shotgunView.add(hammerL);
    const hammerR = new THREE.Mesh(hammerGeom, darkMetal);
    hammerR.position.set( 0.045, 0.10, 0.05);
    hammerR.rotation.x = THREE.MathUtils.degToRad(-25);
    this.shotgunView.add(hammerR);
    // Hammer spurs (thumb pieces)
    const spurGeom = new THREE.BoxGeometry(0.026, 0.012, 0.018);
    const spurL = new THREE.Mesh(spurGeom, accentMat);
    spurL.position.set(-0.045, 0.13, 0.06);
    this.shotgunView.add(spurL);
    const spurR = new THREE.Mesh(spurGeom, accentMat);
    spurR.position.set( 0.045, 0.13, 0.06);
    this.shotgunView.add(spurR);

    // Hardwood stock at the rear (chunky) - now wood-textured
    const stockGeom = new THREE.BoxGeometry(0.08, 0.16, 0.26);
    const stock = new THREE.Mesh(stockGeom, woodCheckMat);
    stock.position.set(0, -0.04, 0.22);
    this.shotgunView.add(stock);
    // Stock buttplate
    const buttGeom = new THREE.BoxGeometry(0.085, 0.18, 0.022);
    const butt = new THREE.Mesh(buttGeom, darkMetal);
    butt.position.set(0, -0.04, 0.36);
    this.shotgunView.add(butt);

    // Brass-coloured trigger guard accent
    const accentGeom = new THREE.BoxGeometry(0.18, 0.03, 0.07);
    const accent = new THREE.Mesh(accentGeom, accentMat);
    accent.position.set(0, -0.10, 0.05);
    this.shotgunView.add(accent);
    // Twin triggers visible inside the guard
    const triggerL = new THREE.Mesh(this._triggerGeom, brassDeep);
    triggerL.position.set(-0.018, -0.092, 0.04);
    this.shotgunView.add(triggerL);
    const triggerR = new THREE.Mesh(this._triggerGeom, brassDeep);
    triggerR.position.set( 0.018, -0.092, 0.06);
    this.shotgunView.add(triggerR);

    // Pistol grip - hardwood checkered
    const gripGeom = new THREE.BoxGeometry(0.07, 0.20, 0.08);
    const grip = new THREE.Mesh(gripGeom, woodCheckMat);
    grip.position.set(0, -0.18, 0.10);
    grip.rotation.x = THREE.MathUtils.degToRad(20);
    this.shotgunView.add(grip);

    this.shotgunView.traverse((m) =>
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

  _buildShotgunMuzzleFlash()
  {
    const mat = new THREE.MeshBasicMaterial({
      map: this._flashTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // Bigger than rifle flash
    const geom = new THREE.PlaneGeometry(0.65, 0.65);
    this._shotgunFlash = new THREE.Mesh(geom, mat);
    this._shotgunFlash.position.set(0, 0.025, -0.88);
    this._shotgunFlash.visible = false;
    this._shotgunFlash.renderOrder = 1000;
    this.shotgunView.add(this._shotgunFlash);
  }

  // -------------------------------------------------------------------------
  // Viewmodel construction - grenade launcher (new): fat tube + drum mag
  // -------------------------------------------------------------------------

  _buildGrenadeViewmodel()
  {
    const tubeMat   = new THREE.MeshBasicMaterial({ color: 0x2a3528 });
    const drumMat   = new THREE.MeshBasicMaterial({ color: 0x1f2a1d });
    const accentMat = new THREE.MeshBasicMaterial({ color: 0x5a4a18 });
    const stockMat  = new THREE.MeshBasicMaterial({ color: 0x222226 });
    const sightMat  = new THREE.MeshBasicMaterial({ color: 0x1a1a1c });
    const leverMat  = new THREE.MeshBasicMaterial({ color: 0x9a8030 });

    // Fat barrel (wider/shorter than rocket)
    const barrelGeom = new THREE.BoxGeometry(0.20, 0.20, 0.7);
    const barrel = new THREE.Mesh(barrelGeom, tubeMat);
    barrel.position.set(0, 0.04, -0.34);
    this.grenadeView.add(barrel);

    // Heavy muzzle ring at the front
    const ringGeom = new THREE.BoxGeometry(0.24, 0.24, 0.06);
    const ring = new THREE.Mesh(ringGeom, sightMat);
    ring.position.set(0, 0.04, -0.66);
    this.grenadeView.add(ring);

    // Forward muzzle plate
    const muzzleGeom = new THREE.BoxGeometry(0.22, 0.22, 0.04);
    const muzzle = new THREE.Mesh(muzzleGeom, tubeMat);
    muzzle.position.set(0, 0.04, -0.71);
    this.grenadeView.add(muzzle);
    this._grenadeMuzzle = muzzle;

    // Revolver-style drum magazine - short cylinder visible from the front
    const drumGeom = new THREE.CylinderGeometry(0.13, 0.13, 0.16, 18);
    const drum = new THREE.Mesh(drumGeom, drumMat);
    drum.rotation.z = Math.PI / 2;     // axis along X -> drum face shows from front
    drum.position.set(0, -0.09, -0.05);
    this.grenadeView.add(drum);

    // Inner drum-face plate detail (a darker bored hub)
    const drumFaceGeom = new THREE.CylinderGeometry(0.05, 0.05, 0.18, 12);
    const drumFace = new THREE.Mesh(drumFaceGeom, accentMat);
    drumFace.rotation.z = Math.PI / 2;
    drumFace.position.set(0, -0.09, -0.05);
    this.grenadeView.add(drumFace);

    // 6 visible bores around the drum face (loaded grenade rounds look).
    for (let i = 0; i < 6; i++)
    {
      const angle = (i / 6) * Math.PI * 2;
      const bx = Math.cos(angle) * 0.085;
      const by = Math.sin(angle) * 0.085;
      const bore = new THREE.Mesh(this._drumBoreGeom, sightMat);
      bore.rotation.z = Math.PI / 2;     // bore-axis along X (matches drum)
      bore.position.set(0.08, -0.09 + by, -0.05 + bx);
      this.grenadeView.add(bore);
      // Mirror on the rear face so both sides look populated
      const boreBack = new THREE.Mesh(this._drumBoreGeom, sightMat);
      boreBack.rotation.z = Math.PI / 2;
      boreBack.position.set(-0.08, -0.09 + by, -0.05 + bx);
      this.grenadeView.add(boreBack);
    }

    // Drum locking lever (a small protrusion on top of the drum)
    const lockArmGeom = new THREE.BoxGeometry(0.05, 0.014, 0.022);
    const lockArm = new THREE.Mesh(lockArmGeom, leverMat);
    lockArm.position.set(0, 0.02, -0.05);
    this.grenadeView.add(lockArm);
    const lockLever = new THREE.Mesh(this._smallAccentGeom, leverMat);
    lockLever.position.set(0.06, 0.04, -0.05);
    this.grenadeView.add(lockLever);

    // Top sight
    const sightGeom = new THREE.BoxGeometry(0.04, 0.05, 0.07);
    const sight = new THREE.Mesh(sightGeom, sightMat);
    sight.position.set(0, 0.16, -0.32);
    this.grenadeView.add(sight);
    // Front sight ear pair (protective wings)
    const fEarL = new THREE.Mesh(this._sightEarGeom, sightMat);
    fEarL.scale.set(1, 0.9, 1);
    fEarL.position.set(-0.018, 0.16, -0.32);
    this.grenadeView.add(fEarL);
    const fEarR = new THREE.Mesh(this._sightEarGeom, sightMat);
    fEarR.scale.set(1, 0.9, 1);
    fEarR.position.set( 0.018, 0.16, -0.32);
    this.grenadeView.add(fEarR);

    // Front foregrip ahead of the trigger (vertical wooden grip)
    const foregripGeom = new THREE.BoxGeometry(0.05, 0.14, 0.06);
    const foregrip = new THREE.Mesh(foregripGeom, accentMat);
    foregrip.position.set(0, -0.13, -0.30);
    this.grenadeView.add(foregrip);

    // Folding stock at the rear - main stock plank
    const stockGeom = new THREE.BoxGeometry(0.10, 0.18, 0.22);
    const stock = new THREE.Mesh(stockGeom, stockMat);
    stock.position.set(0, -0.02, 0.20);
    this.grenadeView.add(stock);
    // Folding-stock connector arms (left and right) - visual cue this is a folder
    const armGeom = new THREE.BoxGeometry(0.012, 0.022, 0.20);
    const armL = new THREE.Mesh(armGeom, sightMat);
    armL.position.set(-0.05, 0.04, 0.22);
    this.grenadeView.add(armL);
    const armR = new THREE.Mesh(armGeom, sightMat);
    armR.position.set( 0.05, 0.04, 0.22);
    this.grenadeView.add(armR);
    // Pivot pins (toruses) where the arms meet the receiver
    const pivotL = new THREE.Mesh(this._slingLoopGeom, leverMat);
    pivotL.rotation.y = Math.PI / 2;
    pivotL.position.set(-0.05, 0.04, 0.10);
    this.grenadeView.add(pivotL);
    const pivotR = new THREE.Mesh(this._slingLoopGeom, leverMat);
    pivotR.rotation.y = Math.PI / 2;
    pivotR.position.set( 0.05, 0.04, 0.10);
    this.grenadeView.add(pivotR);

    // Pistol grip below the receiver
    const gripGeom = new THREE.BoxGeometry(0.06, 0.18, 0.07);
    const grip = new THREE.Mesh(gripGeom, stockMat);
    grip.position.set(0, -0.18, 0.06);
    grip.rotation.x = THREE.MathUtils.degToRad(15);
    this.grenadeView.add(grip);
    // Trigger guard + trigger
    const ggGeom = new THREE.BoxGeometry(0.06, 0.012, 0.085);
    const ggBottom = new THREE.Mesh(ggGeom, sightMat);
    ggBottom.position.set(0, -0.13, 0.04);
    this.grenadeView.add(ggBottom);
    const trigger = new THREE.Mesh(this._triggerGeom, leverMat);
    trigger.position.set(0, -0.115, 0.05);
    this.grenadeView.add(trigger);

    this.grenadeView.traverse((m) =>
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

  _buildGrenadeMuzzleFlash()
  {
    const mat = new THREE.MeshBasicMaterial({
      map: this._flashTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(0.6, 0.6);
    this._grenadeFlash = new THREE.Mesh(geom, mat);
    this._grenadeFlash.position.set(0, 0.04, -0.76);
    this._grenadeFlash.visible = false;
    this._grenadeFlash.renderOrder = 1000;
    this.grenadeView.add(this._grenadeFlash);
  }

  // -------------------------------------------------------------------------
  // Weapon switching
  // -------------------------------------------------------------------------

  switchTo(name)
  {
    if (name !== 'rifle' && name !== 'rocket' && name !== 'shotgun' && name !== 'grenade') return;
    if (this.current === name) return;

    this.current = name;

    // Stop holding fire so we don't immediately blast on switch
    this.firing = false;

    // Visibility
    this.rifleView.visible   = (name === 'rifle');
    this.rocketView.visible  = (name === 'rocket');
    this.shotgunView.visible = (name === 'shotgun');
    this.grenadeView.visible = (name === 'grenade');
    if      (name === 'rifle')   this.viewmodel = this.rifleView;
    else if (name === 'rocket')  this.viewmodel = this.rocketView;
    else if (name === 'shotgun') this.viewmodel = this.shotgunView;
    else                          this.viewmodel = this.grenadeView;

    // HUD updates
    if (this.ui)
    {
      if (typeof this.ui.setAmmo === 'function')
      {
        this.ui.setAmmo(this.ammo);
      }
      if (typeof this.ui.message === 'function')
      {
        const label =
          name === 'rifle'   ? 'RIFLE' :
          name === 'rocket'  ? 'ROCKET LAUNCHER' :
          name === 'shotgun' ? 'SHOTGUN' :
                                'GRENADE LAUNCHER';
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
    if (this.rifle.fireTimer   > 0) { this.rifle.fireTimer   = Math.max(0, this.rifle.fireTimer   - dt); }
    if (this.rocket.fireTimer  > 0) { this.rocket.fireTimer  = Math.max(0, this.rocket.fireTimer  - dt); }
    if (this.shotgun.fireTimer > 0) { this.shotgun.fireTimer = Math.max(0, this.shotgun.fireTimer - dt); }
    if (this.grenade.fireTimer > 0) { this.grenade.fireTimer = Math.max(0, this.grenade.fireTimer - dt); }

    // 2. Decay muzzle flashes
    this._tickFlash(this.rifle,   this._muzzleFlash,  dt);
    this._tickFlash(this.rocket,  this._rocketFlash,  dt);
    this._tickFlash(this.shotgun, this._shotgunFlash, dt);
    this._tickFlash(this.grenade, this._grenadeFlash, dt);

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

    // Decay kick on all weapons (so a switch mid-recoil settles too)
    this._decayKick(this.rifle, dt);
    this._decayKick(this.rocket, dt);
    this._decayKick(this.shotgun, dt);
    this._decayKick(this.grenade, dt);

    // Apply pose to active viewmodel
    if (this.current === 'rifle')
    {
      this._applyPose(this.rifleView, this._rifleRest, this.rifle.kick, bobX, bobY);
    }
    else if (this.current === 'rocket')
    {
      // Rocket has chunkier recoil feel
      this._applyPose(this.rocketView, this._rocketRest, this.rocket.kick, bobX, bobY, 0.10, 0.03, 0.25);
    }
    else if (this.current === 'shotgun')
    {
      // Shotgun: heavy kick (a bit more back than rifle)
      this._applyPose(this.shotgunView, this._shotgunRest, this.shotgun.kick, bobX, bobY, 0.09, 0.025, 0.22);
    }
    else
    {
      // Grenade launcher: chunky like rocket but a touch less
      this._applyPose(this.grenadeView, this._grenadeRest, this.grenade.kick, bobX, bobY, 0.09, 0.025, 0.22);
    }

    // 4. Update lingering effects (impacts, blood, tracers, explosions, smoke, lights)
    this._updateEffects(dt);

    // 5. Simulate in-flight rockets and grenades
    this._updateRockets(dt, ctx);
    this._updateGrenades(dt, ctx);

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
      const w = this._activeWeapon();
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
      else if (fx.kind === 'debris')
      {
        // Tiny dark fragment plane that flies outward and fades fast.
        fx.vel.y -= 9 * dt;
        fx.mesh.position.x += fx.vel.x * dt;
        fx.mesh.position.y += fx.vel.y * dt;
        fx.mesh.position.z += fx.vel.z * dt;
        fx.vel.multiplyScalar(Math.max(0, 1 - dt * 1.5));
        fx.mesh.rotation.z += fx.spinRate * dt;
        fx.mesh.material.opacity = Math.max(0, k);
        fx.mesh.lookAt(this.camera.getWorldPosition(this._tmpVec));
      }
      else if (fx.kind === 'chunk')
      {
        // Heavier 3D chunky debris piece (used by explosion).
        fx.vel.y -= 14 * dt;
        fx.mesh.position.x += fx.vel.x * dt;
        fx.mesh.position.y += fx.vel.y * dt;
        fx.mesh.position.z += fx.vel.z * dt;
        fx.vel.multiplyScalar(Math.max(0, 1 - dt * 1.2));
        fx.mesh.rotation.x += fx.spinX * dt;
        fx.mesh.rotation.y += fx.spinY * dt;
        fx.mesh.rotation.z += fx.spinZ * dt;
      }
      else if (fx.kind === 'shockring')
      {
        // Flat torus that expands outward + fades over its TTL.
        const tNorm = fx.t / fx.ttl;
        const radius = fx.startScale + (fx.endScale - fx.startScale) * Math.min(1, tNorm * 1.4);
        fx.mesh.scale.set(radius, radius, radius * 0.5);
        const fade = Math.max(0, 1 - tNorm);
        fx.mesh.material.opacity = fade;
      }
      else if (fx.kind === 'muzzlespike')
      {
        // Brief volumetric spike at the muzzle: extends forward then fades.
        const tNorm = fx.t / fx.ttl;
        const stretch = 1 + tNorm * 0.4;
        fx.mesh.scale.set(1 - tNorm * 0.3, 1 - tNorm * 0.3, stretch);
        fx.mesh.material.opacity = Math.max(0, 1 - tNorm * 1.4);
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
    if      (this.current === 'rocket')  this._fireRocket(ctx);
    else if (this.current === 'shotgun') this._fireShotgun(ctx);
    else if (this.current === 'grenade') this._fireGrenade(ctx);
    else                                  this._fireRifle(ctx);
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
    // Brief volumetric muzzle spike attached to the rifle viewmodel.
    this._spawnMuzzleSpike(this.rifleView, new THREE.Vector3(0, 0.02, -0.78), 1.0);

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

    // Build projectile mesh - detailed mini-missile (warhead cone + body
    // cylinder + 4 fold-out tail fins + exhaust glow).
    const projGroup = new THREE.Group();

    const bodyMat  = new THREE.MeshBasicMaterial({ color: 0x2a2a2e });
    const tipMat   = new THREE.MeshBasicMaterial({ color: 0xff7822 });
    const finMat   = new THREE.MeshBasicMaterial({ color: 0x18181c });

    // Body cylinder (cylinder is along Y by default)
    const body = new THREE.Mesh(this._rocketBodyGeom, bodyMat);
    body.rotation.x = Math.PI / 2;
    projGroup.add(body);

    // Warhead cone (front)
    const tip = new THREE.Mesh(this._rocketTipGeom, tipMat);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = -0.20;
    projGroup.add(tip);

    // Tail fins - 4 thin boxes radiating from the rear of the body
    for (let i = 0; i < 4; i++)
    {
      const fin = new THREE.Mesh(this._rocketFinGeom, finMat);
      const ang = (i / 4) * Math.PI * 2;
      fin.position.set(Math.cos(ang) * 0.07, Math.sin(ang) * 0.07, 0.10);
      fin.rotation.z = ang;
      projGroup.add(fin);
    }

    // Exhaust glow plug at the back
    const flameGeom = new THREE.PlaneGeometry(0.30, 0.30);
    const flameMat  = new THREE.MeshBasicMaterial({
      map: this._flashTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const flame = new THREE.Mesh(flameGeom, flameMat);
    flame.position.z = 0.20;
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
    // Beefier volumetric muzzle spike for the rocket launcher.
    this._spawnMuzzleSpike(this.rocketView, new THREE.Vector3(0, 0.02, -0.92), 1.6);

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

  // Wrapper kept for backwards compat - calls the generic splash with rocket stats.
  _detonateRocket(point, ctx, directHitEnemy, directHitPeerId)
  {
    this._detonateSplash(point, ctx, directHitEnemy, directHitPeerId, this.rocket);
  }

  // Generic explosion: splashes all entities within stats.splashRadius using
  // stats.splashDamage and stats.selfDamageScale.  Used by rockets and grenades.
  _detonateSplash(point, ctx, directHitEnemy, directHitPeerId, stats)
  {
    const radius = stats.splashRadius;
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
        let dmg = stats.splashDamage * falloff;
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
        let dmg = stats.splashDamage * falloff;
        // Don't double-damage the directly-hit enemy on top of the direct.
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
      // Player eye is at p.position; body centre roughly 0.85 below eye.
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

        // Self damage scaled so self-jumping is survivable
        const dmg = stats.splashDamage * falloff * stats.selfDamageScale;
        if (dmg > 0 && typeof p.takeDamage === 'function')
        {
          try { p.takeDamage(dmg); } catch (e) { /* ignore */ }
        }

        // Knockback impulse - separate vertical kick + horizontal push.
        if (p.velocity)
        {
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

          const impulseY    = 14 * falloff;
          const impulseHoriz = 9 * falloff;

          const upKick = Math.max(impulseY * 0.85, impulseY * (ey > 0 ? 1 : 0.5));

          p.velocity.y += upKick;
          p.velocity.x += hx * impulseHoriz;
          p.velocity.z += hz * impulseHoriz;

          // Player is no longer grounded after a splash jump
          p.onGround = false;
        }

        // Stronger camera shake when close
        const proximity = 1 - (d / radius);
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

    // ---- Visual: explosion sprite, shock ring, particles, chunks, light --
    this._spawnExplosionSprite(point);
    this._spawnExplosionShockRing(point);
    this._spawnExplosionParticles(point);
    this._spawnExplosionChunks(point);
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

    // Spawn 4-6 short-lived debris particles flying outward from the hit.
    this._spawnImpactDebris(point, worldNormal);
  }

  _spawnImpactDebris(point, worldNormal)
  {
    const count = 4 + (Math.random() * 3 | 0);     // 4..6
    // Build a tangent basis around worldNormal so debris flies into the upper
    // hemisphere relative to the hit surface.
    const n = worldNormal.clone().normalize();
    const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const tx = new THREE.Vector3().crossVectors(n, up).normalize();
    const ty = new THREE.Vector3().crossVectors(n, tx).normalize();

    for (let i = 0; i < count; i++)
    {
      const mat = new THREE.MeshBasicMaterial({
        map: this._debrisTexture,
        transparent: true,
        blending: THREE.NormalBlending,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 1,
      });
      const size = 0.045 + Math.random() * 0.035;
      const geom = new THREE.PlaneGeometry(size, size);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 800;
      mesh.position.copy(point).add(n.clone().multiplyScalar(0.02));

      // Velocity: mostly along normal, with some tangent spread + slight up bias
      const sp = 1.5 + Math.random() * 2.5;
      const ang = Math.random() * Math.PI * 2;
      const tilt = Math.random() * 0.7;
      const vx = (n.x * (1 - tilt) + tx.x * Math.cos(ang) * tilt + ty.x * Math.sin(ang) * tilt) * sp;
      const vy = (n.y * (1 - tilt) + tx.y * Math.cos(ang) * tilt + ty.y * Math.sin(ang) * tilt) * sp + 0.6;
      const vz = (n.z * (1 - tilt) + tx.z * Math.cos(ang) * tilt + ty.z * Math.sin(ang) * tilt) * sp;

      this.scene.add(mesh);
      this._addEffect({
        mesh,
        t: 0,
        ttl: 0.4,
        kind: 'debris',
        vel: new THREE.Vector3(vx, vy, vz),
        spinRate: (Math.random() - 0.5) * 12,
      });
    }
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

  // Flat torus that expands outward over ~0.3s while fading.
  _spawnExplosionShockRing(point)
  {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffc070,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(this._shockRingGeom, mat);
    mesh.renderOrder = 850;
    mesh.position.copy(point);
    // Lay the ring flat on the world XZ plane (looks like a ground-level shockwave).
    mesh.rotation.x = Math.PI / 2;
    mesh.scale.set(0.4, 0.4, 0.2);

    this.scene.add(mesh);
    this._addEffect({
      mesh,
      t: 0,
      ttl: 0.3,
      kind: 'shockring',
      startScale: 0.4,
      endScale: 4.5,
    });
  }

  // ~10 chunky debris pieces that tumble + fly outward (used by explosion).
  _spawnExplosionChunks(point)
  {
    const count = 10;
    for (let i = 0; i < count; i++)
    {
      const mat = new THREE.MeshBasicMaterial({ color: 0x3a2818 });
      // Each chunk gets its own material (so we can dispose individually);
      // shape is the shared chunk geometry, just scaled per-instance.
      const mesh = new THREE.Mesh(this._chunkDebrisGeom, mat);
      mesh.renderOrder = 850;
      const s = 0.4 + Math.random() * 0.7;
      mesh.scale.set(s, s, s);
      mesh.position.copy(point);

      // Random outward direction biased upward
      const phi   = Math.random() * Math.PI * 2;
      const theta = Math.acos(2 * Math.random() - 1);
      const sp = 5 + Math.random() * 6;
      const vx = sp * Math.sin(theta) * Math.cos(phi);
      const vy = sp * Math.cos(theta) + 4;
      const vz = sp * Math.sin(theta) * Math.sin(phi);

      this.scene.add(mesh);
      this._addEffect({
        mesh,
        t: 0,
        ttl: 0.6 + Math.random() * 0.3,
        kind: 'chunk',
        vel: new THREE.Vector3(vx, vy, vz),
        spinX: (Math.random() - 0.5) * 14,
        spinY: (Math.random() - 0.5) * 14,
        spinZ: (Math.random() - 0.5) * 14,
      });
    }
  }

  // A brief volumetric "spike" cone in front of the muzzle for ~0.05s.
  // Attached to the supplied viewmodel group so it inherits the camera/viewmodel
  // transform and stays glued to the weapon.
  _spawnMuzzleSpike(parent, localPos, scale)
  {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffeec0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 1,
    });
    const geom = new THREE.ConeGeometry(0.05 * scale, 0.30 * scale, 6);
    const mesh = new THREE.Mesh(geom, mat);
    // Cone points along +Y by default; rotate so its tip points forward (-Z).
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(localPos);
    // Offset the cone forward so its base sits at the muzzle.
    mesh.position.z -= 0.15 * scale;
    mesh.renderOrder = 1001;
    parent.add(mesh);
    this._addEffect({ mesh, t: 0, ttl: 0.05, kind: 'muzzlespike' });
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
  // Shotgun - hitscan, multi-pellet cone
  // -------------------------------------------------------------------------

  _fireShotgun(ctx)
  {
    if (this.shotgun.ammo <= 0) return;

    this.shotgun.fireTimer = this.shotgun.fireRate;
    this.shotgun.ammo--;   // one shell consumed (regardless of pellet count)

    this.camera.getWorldPosition(this._origin);
    const baseDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    // Build an orthonormal basis from the camera so we can offset within the cone.
    // Pick an arbitrary up that isn't colinear with baseDir.
    const upRef = Math.abs(baseDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(baseDir, upRef).normalize();
    const up    = new THREE.Vector3().crossVectors(right, baseDir).normalize();

    const targets = this._gatherTargets(ctx);
    const muzzlePos = new THREE.Vector3();
    this._shotgunMuzzle.getWorldPosition(muzzlePos);

    const spread = this.shotgun.spread;
    const pellets = this.shotgun.pellets;

    for (let i = 0; i < pellets; i++)
    {
      // Random offset in a disk -> approximate cone direction.
      const r  = Math.sqrt(Math.random()) * spread;
      const th = Math.random() * Math.PI * 2;
      const ox = Math.cos(th) * r;
      const oy = Math.sin(th) * r;

      const dir = baseDir.clone()
        .add(right.clone().multiplyScalar(ox))
        .add(up.clone().multiplyScalar(oy))
        .normalize();

      this.raycaster.set(this._origin, dir);
      this.raycaster.near = 0;
      this.raycaster.far = this.shotgun.maxRange;
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
          try { enemyRef.takeDamage(this.shotgun.damage, h.point); } catch (e) { /* ignore */ }
          this._spawnBlood(h.point);
        }
        else if (peerId && ctx && ctx.network && typeof ctx.network.sendHit === 'function')
        {
          try { ctx.network.sendHit(peerId, this.shotgun.damage); } catch (e) { /* ignore */ }
          this._spawnBlood(h.point);
        }
        else
        {
          this._spawnImpact(h.point, h.face ? h.face.normal : null, h.object);
        }
      }

      const tracerEnd = hitPoint
        ? hitPoint.clone()
        : this._origin.clone().add(dir.clone().multiplyScalar(this.shotgun.maxRange));
      this._spawnPelletTracer(muzzlePos, tracerEnd);
    }

    this.shotgun.flashT = 0.09;
    this._shotgunFlash.rotation.z = Math.random() * Math.PI * 2;
    this.shotgun.kick = 1;
    // Two muzzle spikes - one for each barrel.
    this._spawnMuzzleSpike(this.shotgunView, new THREE.Vector3(-0.05, 0.025, -0.86), 1.3);
    this._spawnMuzzleSpike(this.shotgunView, new THREE.Vector3( 0.05, 0.025, -0.86), 1.3);

    this._setHudAmmo(ctx);
  }

  // Thin tracer line from muzzle to (per-pellet) end point.
  _spawnPelletTracer(muzzlePos, endPoint)
  {
    const positions = new Float32Array([
      muzzlePos.x, muzzlePos.y, muzzlePos.z,
      endPoint.x,  endPoint.y,  endPoint.z,
    ]);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
      color: 0xffe6a0,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
    });
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 800;
    this.scene.add(line);
    this._addEffect({ mesh: line, t: 0, ttl: 0.06, kind: 'tracer' });
  }

  // -------------------------------------------------------------------------
  // Grenade launcher - arcing projectile, bounces, splash detonates
  // -------------------------------------------------------------------------

  _fireGrenade(ctx)
  {
    if (this.grenade.ammo <= 0) return;

    this.grenade.fireTimer = this.grenade.fireRate;
    this.grenade.ammo--;

    // Spawn position: grenade muzzle world-space.
    const spawn = new THREE.Vector3();
    this._grenadeMuzzle.getWorldPosition(spawn);

    // Direction: camera forward.
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    // Build the projectile mesh - ribbed grenade body (icosahedron for the
    // facetted/ribbed look) + lever flange + pin loop + outer halo.
    const projGroup = new THREE.Group();

    const bodyMat  = new THREE.MeshBasicMaterial({ color: 0x4a8a3a });
    const body     = new THREE.Mesh(this._grenadeBodyGeom, bodyMat);
    projGroup.add(body);

    // Spoon/lever flange along one side
    const leverMat = new THREE.MeshBasicMaterial({ color: 0x9a8030 });
    const lever = new THREE.Mesh(this._grenadeLeverGeom, leverMat);
    lever.position.set(0.06, 0.05, 0);
    lever.rotation.z = THREE.MathUtils.degToRad(20);
    projGroup.add(lever);

    // Pin loop (small torus) at the top
    const pin = new THREE.Mesh(this._grenadePinGeom, leverMat);
    pin.rotation.x = Math.PI / 2;
    pin.position.set(0, 0.10, 0);
    projGroup.add(pin);

    // Outer glow halo (camera-facing plane)
    const haloGeom = new THREE.PlaneGeometry(0.36, 0.36);
    const haloMat  = new THREE.MeshBasicMaterial({
      map: this._sparkTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      color: 0x66ff88,
      opacity: 0.55,
    });
    const halo = new THREE.Mesh(haloGeom, haloMat);
    projGroup.add(halo);

    projGroup.position.copy(spawn);
    projGroup.userData.isProjectile = true;
    projGroup.traverse((m) =>
    {
      if (m.isMesh) m.userData.isProjectile = true;
    });

    this.scene.add(projGroup);

    this.grenades.push({
      mesh: projGroup,
      halo: halo,
      pos: spawn.clone(),
      prevPos: spawn.clone(),
      vel: dir.clone().multiplyScalar(this.grenade.projectileSpeed),
      bouncesLeft: this.grenade.maxBounces,
      lifetime: 0,
      smokeTimer: 0,
      alive: true,
    });

    // Muzzle flash + kick
    this.grenade.flashT = 0.09;
    this._grenadeFlash.rotation.z = Math.random() * Math.PI * 2;
    this.grenade.kick = 1;
    // Big volumetric muzzle spike for the grenade launcher.
    this._spawnMuzzleSpike(this.grenadeView, new THREE.Vector3(0, 0.04, -0.78), 1.5);

    this._setHudAmmo(ctx);
  }

  _updateGrenades(dt, ctx)
  {
    if (this.grenades.length === 0) return;

    const gStats = this.grenade;

    for (let i = this.grenades.length - 1; i >= 0; i--)
    {
      const g = this.grenades[i];
      if (!g.alive)
      {
        // dispose
        if (g.mesh && g.mesh.parent) g.mesh.parent.remove(g.mesh);
        g.mesh && g.mesh.traverse && g.mesh.traverse((m) =>
        {
          if (m.isMesh)
          {
            if (m.material && m.material.dispose) m.material.dispose();
            if (m.geometry && m.geometry.dispose) m.geometry.dispose();
          }
        });
        this.grenades.splice(i, 1);
        continue;
      }

      // Apply gravity
      g.vel.y -= gStats.gravity * dt;

      // Advance
      g.prevPos.copy(g.pos);
      g.pos.x += g.vel.x * dt;
      g.pos.y += g.vel.y * dt;
      g.pos.z += g.vel.z * dt;
      const stepLen = g.prevPos.distanceTo(g.pos);
      g.lifetime += dt;

      // Apply to mesh
      g.mesh.position.copy(g.pos);
      // Make the halo face the camera for a nice glow.
      if (g.halo)
      {
        const camPos = this.camera.getWorldPosition(this._tmpVec);
        g.halo.lookAt(camPos);
      }

      // Smoke trail
      g.smokeTimer -= dt;
      if (g.smokeTimer <= 0)
      {
        g.smokeTimer = 0.05;
        this._spawnSmokePuff(g.pos);
      }

      // Collision: raycast prev->new against level + alive enemy meshes + remote players
      let detonateAt = null;
      let bounceAt   = null;
      let bounceNormal = null;
      let hitEnemy = null;
      let hitPeerId = null;

      if (stepLen > 1e-6)
      {
        const targets = this._gatherTargets(ctx);
        const segDir = this._tmpVec.copy(g.pos).sub(g.prevPos).normalize();
        this.raycaster.set(g.prevPos, segDir);
        this.raycaster.near = 0;
        this.raycaster.far = stepLen + 0.001;
        const hits = this.raycaster.intersectObjects(targets, false);
        for (let h = 0; h < hits.length; h++)
        {
          const ud = hits[h].object && hits[h].object.userData ? hits[h].object.userData : null;
          if (ud && ud.isProjectile) continue;

          const enemyRef = ud ? ud.enemyRef : null;
          const peerId   = ud ? ud.peerId   : null;

          if (enemyRef && enemyRef.alive)
          {
            // Direct contact with enemy -> detonate immediately
            detonateAt = hits[h].point.clone();
            hitEnemy = enemyRef;
          }
          else if (peerId)
          {
            // Direct contact with remote player -> detonate immediately
            detonateAt = hits[h].point.clone();
            hitPeerId = peerId;
          }
          else
          {
            // Wall/floor -> bounce (or detonate if bounces exhausted)
            bounceAt = hits[h].point.clone();
            // Compute world-space normal from face normal
            if (hits[h].face && hits[h].object)
            {
              bounceNormal = hits[h].face.normal.clone();
              const nm = new THREE.Matrix3().getNormalMatrix(hits[h].object.matrixWorld);
              bounceNormal.applyMatrix3(nm).normalize();
            }
            else
            {
              bounceNormal = segDir.clone().multiplyScalar(-1);
            }
          }
          break;
        }
      }

      // Force detonation if lifetime exceeded
      if (!detonateAt && !bounceAt && g.lifetime > gStats.maxLifetime)
      {
        detonateAt = g.pos.clone();
      }

      if (detonateAt)
      {
        // Direct hit damage to enemy/peer struck
        if (hitEnemy && hitEnemy.alive && typeof hitEnemy.takeDamage === 'function')
        {
          try { hitEnemy.takeDamage(gStats.damage, detonateAt); } catch (e) { /* ignore */ }
          this._spawnBlood(detonateAt);
        }
        else if (hitPeerId && ctx && ctx.network && typeof ctx.network.sendHit === 'function')
        {
          try { ctx.network.sendHit(hitPeerId, gStats.damage); } catch (e) { /* ignore */ }
          this._spawnBlood(detonateAt);
        }

        this._detonateSplash(detonateAt, ctx, hitEnemy, hitPeerId, gStats);
        g.alive = false;
        continue;
      }

      if (bounceAt)
      {
        if (g.bouncesLeft <= 0)
        {
          // Out of bounces -> detonate at the contact point
          this._detonateSplash(bounceAt, ctx, null, null, gStats);
          g.alive = false;
          continue;
        }

        // Reflect velocity off the surface normal and apply lossy scale.
        // r = v - 2*(v.n)*n
        const v = g.vel;
        const n = bounceNormal;
        const dot = v.x * n.x + v.y * n.y + v.z * n.z;
        v.x = (v.x - 2 * dot * n.x) * gStats.bounceLoss;
        v.y = (v.y - 2 * dot * n.y) * gStats.bounceLoss;
        v.z = (v.z - 2 * dot * n.z) * gStats.bounceLoss;

        // Place the grenade just off the surface so it doesn't immediately re-hit.
        g.pos.copy(bounceAt).add(n.clone().multiplyScalar(0.05));
        g.mesh.position.copy(g.pos);
        g.bouncesLeft--;
      }
    }
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
