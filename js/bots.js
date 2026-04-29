// bots.js — Game.Bot class and Game.spawnBots factory.
// Stylized white-and-red mech / sentry. Drop-in replacement for Game.Enemy:
// exposes the same surface (.alive, .position, .mesh, .health, update, takeDamage, respawn)
// so weapons.js / level.js / main.js work without modification.
//
// Design:
//   - Multi-segment legs (thigh + shin + foot) with a hydraulic strut spanning them.
//   - Multi-segment arms (upper + forearm + clawed hand of small box fingers).
//   - Antenna with glowing red orb on the head.
//   - Body panel detail + glowing chest core (per-difficulty intensity).
//   - Visible joint pistons at shoulders/hips.
//   - Three difficulty tiers with cosmetic + behavioural differences.
//   - Spawns gib fragments on death.
window.Game = window.Game || {};

(function () {
  "use strict";

  // ---------- Shared geometries (one allocation, shared across instances) ----------
  // Body
  const TORSO_GEOM         = new THREE.BoxGeometry(0.95, 1.05, 0.65);
  const CHEST_GEOM         = new THREE.BoxGeometry(1.10, 0.32, 0.70); // shoulder yoke
  const FRONT_PANEL_GEOM   = new THREE.BoxGeometry(0.55, 0.55, 0.06);
  const BACK_PANEL_GEOM    = new THREE.BoxGeometry(0.65, 0.55, 0.06);
  const SIDE_PANEL_GEOM    = new THREE.BoxGeometry(0.06, 0.55, 0.40);

  // Head
  const HEAD_GEOM          = new THREE.BoxGeometry(0.55, 0.45, 0.55);
  const VISOR_GEOM         = new THREE.BoxGeometry(0.46, 0.10, 0.02);

  // Eyes
  const EYE_GEOM           = new THREE.SphereGeometry(0.06, 6, 4);

  // Antenna
  const ANTENNA_GEOM       = new THREE.CylinderGeometry(0.015, 0.015, 0.30, 6);
  const ANTENNA_TIP_GEOM   = new THREE.SphereGeometry(0.05, 6, 4);

  // Chest core (glowing disc) — 10 radial segs is plenty for a small disc.
  const CORE_GEOM          = new THREE.CylinderGeometry(0.10, 0.10, 0.04, 10);

  // Shoulders
  const SHOULDER_GEOM      = new THREE.BoxGeometry(0.30, 0.30, 0.30);

  // Pistons (small cylinders at shoulders/hips and as cross-struts on limbs).
  // Low segment counts keep the per-bot tri budget under the ~700 ceiling.
  const PISTON_GEOM        = new THREE.CylinderGeometry(0.05, 0.05, 0.18, 5);
  const HYDRAULIC_GEOM     = new THREE.CylinderGeometry(0.025, 0.025, 0.42, 4);

  // Arm segments
  const ARM_UPPER_GEOM     = new THREE.BoxGeometry(0.22, 0.42, 0.22);
  const ARM_LOWER_GEOM     = new THREE.BoxGeometry(0.20, 0.40, 0.20);
  const HAND_GEOM          = new THREE.BoxGeometry(0.20, 0.14, 0.20);
  const FINGER_GEOM        = new THREE.BoxGeometry(0.05, 0.16, 0.05);

  // Legs
  const LEG_THIGH_GEOM     = new THREE.BoxGeometry(0.26, 0.42, 0.26);
  const LEG_SHIN_GEOM      = new THREE.BoxGeometry(0.24, 0.40, 0.24);
  const FOOT_GEOM          = new THREE.BoxGeometry(0.32, 0.10, 0.40);

  // Accents
  const ACCENT_STRIPE_GEOM = new THREE.BoxGeometry(0.55, 0.10, 0.02);

  // Projectile
  const PROJECTILE_GEOM    = new THREE.SphereGeometry(0.18, 12, 10);

  // Gib geom — single shared box, scaled per gib instance.
  const GIB_GEOM           = new THREE.BoxGeometry(0.18, 0.18, 0.18);

  // Unlit (always-glow) materials
  const EYE_MAT            = new THREE.MeshBasicMaterial({ color: 0xfff060 });
  const VISOR_MAT          = new THREE.MeshBasicMaterial({ color: 0x331a00 });
  const ACCENT_MAT         = new THREE.MeshBasicMaterial({ color: 0xff2020 });
  const PROJECTILE_MAT     = new THREE.MeshBasicMaterial({ color: 0xff3030 });
  const ANTENNA_MAT        = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const ANTENNA_TIP_MAT    = new THREE.MeshBasicMaterial({ color: 0xff2020 });
  const PISTON_MAT         = new THREE.MeshLambertMaterial({ color: 0x444444 });

  // ---------- Tunables ----------
  const BOT_GRAVITY         = 25;
  const BOT_ATTACK_RANGE    = 1.6;
  const BOT_ATTACK_DAMAGE   = 12;
  const BOT_ATTACK_COOLDOWN = 1.0;
  const BOT_HEIGHT          = 1.6;
  const BOT_RADIUS          = 0.42;
  const BOT_EYE_HEIGHT      = 1.45;
  const SOFT_SEPARATION_R   = 1.0;
  const HIT_FLASH_DURATION  = 0.15;
  const DEATH_DURATION      = 0.6;

  // Ranged weapon
  const PROJ_SPEED          = 18;
  const PROJ_DAMAGE         = 15;
  const PROJ_HIT_RADIUS     = 0.45;
  const PROJ_TOTAL_DMG_CAP  = 60;
  const PROJ_RANGE_MIN      = 4;
  const PROJ_RANGE_MAX      = 25;

  // Gibs
  const GIB_COUNT_MIN       = 6;
  const GIB_COUNT_MAX       = 10;
  const GIB_LIFETIME        = 1.6;
  const GIB_GRAVITY         = 22;

  // Per-difficulty config (visual + behavioural).
  // 'coreColor' is the chest emissive disc color; 'coreIntensity' 0..1 (0 = off).
  // 'postureBoost' adds to mesh group y for taller/menacing pose.
  const DIFFICULTIES = {
    easy: {
      health: 50,
      speed: 2,
      ranged: false,
      fireCooldown: 0,
      leadTarget: false,
      bodyColor:    0xd8d8d8,    // dull off-white
      accentColor:  0xaa1818,
      headColor:    0xc8c8c8,
      panelColor:   0x9a9a9a,
      coreColor:    0x888888,
      coreIntensity: 0.0,         // no glow
      postureBoost: 0.0
    },
    medium: {
      health: 75,
      speed: 3,
      ranged: true,
      fireCooldown: 2.2,
      leadTarget: false,
      bodyColor:    0xf2f2f2,
      accentColor:  0xdd2222,
      headColor:    0xdedede,
      panelColor:   0xb8b8b8,
      coreColor:    0x40c8ff,    // faint cyan
      coreIntensity: 0.55,
      postureBoost: 0.0
    },
    hard: {
      health: 110,
      speed: 4,
      ranged: true,
      fireCooldown: 1.2,
      leadTarget: true,
      bodyColor:    0xfafafa,
      accentColor:  0xff1010,
      headColor:    0xeeeeee,
      panelColor:   0xff2020,    // red panels
      coreColor:    0xff2010,    // bright red
      coreIntensity: 1.0,
      postureBoost: 0.08          // taller posture
    }
  };

  // Per-bot materials
  function makeBodyMaterial(color)   { return new THREE.MeshLambertMaterial({ color: color, emissive: 0x000000 }); }
  function makeAccentMaterial(color) { return new THREE.MeshLambertMaterial({ color: color, emissive: 0x000000 }); }
  function makeHeadMaterial(color)   { return new THREE.MeshLambertMaterial({ color: color, emissive: 0x000000 }); }
  function makePanelMaterial(color)  { return new THREE.MeshLambertMaterial({ color: color, emissive: 0x000000 }); }

  // Tag every mesh in a sub-tree with .userData.enemyRef so weapon raycasts find us.
  function tagEnemyRefs(root, ref) {
    root.traverse((m) => {
      if (m.isMesh) m.userData.enemyRef = ref;
    });
  }

  // ---------- Bot ----------
  window.Game.Bot = class {
    constructor(scene, position, difficulty) {
      this.scene = scene;

      const cfg = DIFFICULTIES[difficulty] || DIFFICULTIES.medium;
      this.difficulty = DIFFICULTIES[difficulty] ? difficulty : "medium";
      this._cfg = cfg;

      // Core state
      this.position = position.clone();
      this.position.y = 0;
      this.spawnPos = this.position.clone();

      this.velocity = new THREE.Vector3();
      this.health = cfg.health;
      this.maxHealth = cfg.health;
      this.alive = true;
      this._dead = false;
      this.attackCooldown = 0;
      this.fireCooldown = (cfg.fireCooldown || 0) * (0.4 + Math.random() * 0.4);
      this.walkPhase = 0;
      this.hitFlashT = 0;
      this.deathT = 0;
      this.isMoving = false;

      // In-flight projectiles
      this._projectiles = [];
      // Gib book-keeping
      this._gibs = [];

      // ---------- Build mesh ----------
      const group = new THREE.Group();

      // Per-bot materials
      this._bodyMat   = makeBodyMaterial(cfg.bodyColor);
      this._headMat   = makeHeadMaterial(cfg.headColor);
      this._accentMat = makeAccentMaterial(cfg.accentColor);
      this._panelMat  = makePanelMaterial(cfg.panelColor);
      // Core emissive material — Basic so it always glows. Color modulated by intensity.
      const coreColor = new THREE.Color(cfg.coreColor);
      coreColor.multiplyScalar(Math.max(0.1, cfg.coreIntensity));
      this._coreMat   = new THREE.MeshBasicMaterial({ color: coreColor });
      // antenna tip — modulated by hard accent color
      this._antTipMat = new THREE.MeshBasicMaterial({ color: cfg.accentColor });

      this._allMats   = [this._bodyMat, this._headMat, this._accentMat, this._panelMat];

      // Posture lift (hard bots stand taller)
      group.position.y += 0; // base; final group.position.copy below

      // ----- Torso -----
      const torso = new THREE.Mesh(TORSO_GEOM, this._bodyMat);
      torso.position.set(0, 1.225, 0);
      group.add(torso);
      this._torso = torso;

      // Shoulder yoke (red accent across the upper chest)
      const chest = new THREE.Mesh(CHEST_GEOM, this._accentMat);
      chest.position.set(0, 1.65, 0);
      group.add(chest);

      // Front panel detail
      const frontPanel = new THREE.Mesh(FRONT_PANEL_GEOM, this._panelMat);
      frontPanel.position.set(0, 1.20, 0.336);
      group.add(frontPanel);

      // Glowing chest core (centered on front panel)
      const core = new THREE.Mesh(CORE_GEOM, this._coreMat);
      core.position.set(0, 1.20, 0.37);
      core.rotation.x = Math.PI / 2; // disc faces forward
      group.add(core);
      this._core = core;

      // Vertical accent stripe on the chest panel
      const stripe = new THREE.Mesh(ACCENT_STRIPE_GEOM, ACCENT_MAT);
      stripe.position.set(0, 1.42, 0.37);
      stripe.rotation.z = Math.PI / 2;
      group.add(stripe);

      // Back panel
      const backPanel = new THREE.Mesh(BACK_PANEL_GEOM, this._panelMat);
      backPanel.position.set(0, 1.22, -0.336);
      group.add(backPanel);

      // Side panels
      const sideL = new THREE.Mesh(SIDE_PANEL_GEOM, this._panelMat);
      sideL.position.set(-0.481, 1.22, 0);
      group.add(sideL);
      const sideR = new THREE.Mesh(SIDE_PANEL_GEOM, this._panelMat);
      sideR.position.set(0.481, 1.22, 0);
      group.add(sideR);

      // ----- Head -----
      const head = new THREE.Mesh(HEAD_GEOM, this._headMat);
      head.position.set(0, 2.05, 0);
      group.add(head);
      this._head = head;

      // Visor band
      const visor = new THREE.Mesh(VISOR_GEOM, VISOR_MAT);
      visor.position.set(0, 2.07, 0.281);
      group.add(visor);

      // Glowing yellow eyes
      const eyeL = new THREE.Mesh(EYE_GEOM, EYE_MAT);
      eyeL.position.set(-0.13, 2.07, 0.29);
      group.add(eyeL);
      const eyeR = new THREE.Mesh(EYE_GEOM, EYE_MAT);
      eyeR.position.set(0.13, 2.07, 0.29);
      group.add(eyeR);

      // Antenna mast + glowing tip
      const antenna = new THREE.Mesh(ANTENNA_GEOM, ANTENNA_MAT);
      antenna.position.set(0.18, 2.40, -0.10);
      antenna.rotation.z = -0.10;
      group.add(antenna);
      const antTip = new THREE.Mesh(ANTENNA_TIP_GEOM, this._antTipMat);
      antTip.position.set(0.20, 2.55, -0.11);
      group.add(antTip);

      // Shoulders (small cubes)
      const shL = new THREE.Mesh(SHOULDER_GEOM, this._accentMat);
      shL.position.set(-0.62, 1.70, 0);
      group.add(shL);
      const shR = new THREE.Mesh(SHOULDER_GEOM, this._accentMat);
      shR.position.set(0.62, 1.70, 0);
      group.add(shR);

      // Shoulder pistons (small cylinders behind the shoulders)
      const pShL = new THREE.Mesh(PISTON_GEOM, PISTON_MAT);
      pShL.position.set(-0.45, 1.65, -0.20);
      pShL.rotation.x = Math.PI / 2;
      group.add(pShL);
      const pShR = new THREE.Mesh(PISTON_GEOM, PISTON_MAT);
      pShR.position.set(0.45, 1.65, -0.20);
      pShR.rotation.x = Math.PI / 2;
      group.add(pShR);

      // Hip pistons (small cylinders, link hips to torso bottom)
      const pHipL = new THREE.Mesh(PISTON_GEOM, PISTON_MAT);
      pHipL.position.set(-0.30, 0.78, 0.18);
      group.add(pHipL);
      const pHipR = new THREE.Mesh(PISTON_GEOM, PISTON_MAT);
      pHipR.position.set(0.30, 0.78, 0.18);
      group.add(pHipR);

      // ----- Arms -----
      const armPivotY = 1.55;
      this._armL = this._buildArm(group, -0.62, armPivotY);
      this._armR = this._buildArm(group,  0.62, armPivotY);

      // ----- Legs -----
      const legPivotY = 0.7;
      this._legL = this._buildLeg(group, -0.22, legPivotY);
      this._legR = this._buildLeg(group,  0.22, legPivotY);

      // Apply posture boost (lift the rendered group; foot collision still at y=0)
      group.position.copy(this.position);
      group.position.y += cfg.postureBoost;
      this._postureBoost = cfg.postureBoost;

      // Tag every mesh so weapon raycasts can find this bot.
      tagEnemyRefs(group, this);

      this.mesh = group;
      scene.add(group);

      // Reusable scratch
      this._aabb = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
      this._toPlayer = new THREE.Vector3();
      this._botEye = new THREE.Vector3();
      this._rayDir = new THREE.Vector3();
      this._tmpVec = new THREE.Vector3();
      this._tmpVec2 = new THREE.Vector3();
      this._lastPlayerPos = new THREE.Vector3();
      this._hasLastPlayerPos = false;
    }

    // Build a segmented arm with hydraulic strut and a clawed hand of 3 fingers.
    // Returns the shoulder-pivot Group with `_elbow` ref attached.
    _buildArm(parentGroup, shoulderX, shoulderY) {
      const shoulder = new THREE.Group();
      shoulder.position.set(shoulderX, shoulderY, 0);

      const upper = new THREE.Mesh(ARM_UPPER_GEOM, this._bodyMat);
      upper.position.y = -0.21;
      shoulder.add(upper);

      // Hydraulic strut alongside the upper arm (visible cylinder)
      const strut = new THREE.Mesh(HYDRAULIC_GEOM, PISTON_MAT);
      strut.position.set(0.10, -0.21, -0.05);
      shoulder.add(strut);

      const elbow = new THREE.Group();
      elbow.position.y = -0.42;
      shoulder.add(elbow);

      const lower = new THREE.Mesh(ARM_LOWER_GEOM, this._bodyMat);
      lower.position.y = -0.20;
      elbow.add(lower);

      // Hand
      const hand = new THREE.Mesh(HAND_GEOM, this._accentMat);
      hand.position.y = -0.48;
      elbow.add(hand);

      // 3 finger boxes gripping nothing, splayed slightly
      const f1 = new THREE.Mesh(FINGER_GEOM, this._bodyMat);
      f1.position.set(-0.07, -0.62, 0.03);
      f1.rotation.x = -0.25;
      elbow.add(f1);
      const f2 = new THREE.Mesh(FINGER_GEOM, this._bodyMat);
      f2.position.set(0.00, -0.62, 0.04);
      f2.rotation.x = -0.25;
      elbow.add(f2);
      const f3 = new THREE.Mesh(FINGER_GEOM, this._bodyMat);
      f3.position.set(0.07, -0.62, 0.03);
      f3.rotation.x = -0.25;
      elbow.add(f3);

      parentGroup.add(shoulder);
      shoulder.userData._elbow = elbow;
      return shoulder;
    }

    // Build a segmented leg with hydraulic strut + foot.
    _buildLeg(parentGroup, hipX, hipY) {
      const hip = new THREE.Group();
      hip.position.set(hipX, hipY, 0);

      const thigh = new THREE.Mesh(LEG_THIGH_GEOM, this._bodyMat);
      thigh.position.y = -0.21;
      hip.add(thigh);

      // Hydraulic strut alongside thigh
      const strut = new THREE.Mesh(HYDRAULIC_GEOM, PISTON_MAT);
      strut.position.set(0.13, -0.21, -0.04);
      hip.add(strut);

      const knee = new THREE.Group();
      knee.position.y = -0.42;
      hip.add(knee);

      const shin = new THREE.Mesh(LEG_SHIN_GEOM, this._bodyMat);
      shin.position.y = -0.20;
      knee.add(shin);

      const foot = new THREE.Mesh(FOOT_GEOM, this._accentMat);
      foot.position.set(0, -0.45, 0.06);
      knee.add(foot);

      parentGroup.add(hip);
      hip.userData._knee = knee;
      return hip;
    }

    _buildAABB(pos) {
      this._aabb.min.set(pos.x - BOT_RADIUS, pos.y, pos.z - BOT_RADIUS);
      this._aabb.max.set(pos.x + BOT_RADIUS, pos.y + BOT_HEIGHT, pos.z + BOT_RADIUS);
      return this._aabb;
    }

    update(dt, ctx) {
      // Always tick gibs so they continue after death.
      this._updateGibs(dt);

      // ---------------- Death animation ----------------
      if (!this.alive) {
        if (this.deathT < DEATH_DURATION) {
          this.deathT = Math.min(DEATH_DURATION, this.deathT + dt);
          const t = this.deathT / DEATH_DURATION;
          this.mesh.rotation.x = THREE.MathUtils.lerp(0, Math.PI / 2, t);
          this.mesh.position.y = THREE.MathUtils.lerp(
            this.spawnPos.y + this._postureBoost,
            this.spawnPos.y - 0.1,
            t
          );
        }
        if (this.hitFlashT > 0) {
          this.hitFlashT = Math.max(0, this.hitFlashT - dt);
          this._applyHitFlash();
        }
        // Let in-flight projectiles continue.
        this._updateProjectiles(dt, ctx);
        return;
      }

      const player = ctx && ctx.player;
      const level  = ctx && ctx.level;
      if (!player || !level) {
        return;
      }

      // Hit flash decay
      if (this.hitFlashT > 0) {
        this.hitFlashT = Math.max(0, this.hitFlashT - dt);
        this._applyHitFlash();
      }

      // Distance & line of sight
      const playerFootY = player.position.y - 1.7;
      this._toPlayer.set(
        player.position.x - this.position.x,
        playerFootY - this.position.y,
        player.position.z - this.position.z
      );
      const dxh = this._toPlayer.x;
      const dzh = this._toPlayer.z;
      const horizDist = Math.sqrt(dxh * dxh + dzh * dzh);

      this._botEye.set(this.position.x, this.position.y + BOT_EYE_HEIGHT, this.position.z);
      this._rayDir.set(
        player.position.x - this._botEye.x,
        player.position.y - this._botEye.y,
        player.position.z - this._botEye.z
      );
      const rayLen = this._rayDir.length();
      let hasLOS = true;
      if (rayLen > 1e-4 && typeof level.raycastWalls === "function") {
        this._rayDir.multiplyScalar(1 / rayLen);
        const hit = level.raycastWalls(this._botEye, this._rayDir, rayLen);
        if (hit && hit.distance < rayLen - 0.05) {
          hasLOS = false;
        }
      }

      // Decide movement
      let desiredX = 0;
      let desiredZ = 0;
      this.isMoving = false;

      if (hasLOS && horizDist > 0.001) {
        if (horizDist > BOT_ATTACK_RANGE * 0.8) {
          const inv = 1 / Math.max(horizDist, 1e-4);
          desiredX = (dxh * inv) * this._cfg.speed;
          desiredZ = (dzh * inv) * this._cfg.speed;
          this.isMoving = true;
        }
      }

      this.velocity.x = desiredX;
      this.velocity.z = desiredZ;

      // Gravity
      this.velocity.y -= BOT_GRAVITY * dt;

      // Collision (axis-separated)
      this.position.x += this.velocity.x * dt;
      if (typeof level.resolveAABB === "function") {
        this._buildAABB(this.position);
        const pushX = level.resolveAABB(this._aabb);
        if (pushX && pushX.x !== 0) {
          this.position.x += pushX.x;
          this.velocity.x = 0;
        }
      }
      this.position.z += this.velocity.z * dt;
      if (typeof level.resolveAABB === "function") {
        this._buildAABB(this.position);
        const pushZ = level.resolveAABB(this._aabb);
        if (pushZ && pushZ.z !== 0) {
          this.position.z += pushZ.z;
          this.velocity.z = 0;
        }
      }
      this.position.y += this.velocity.y * dt;
      if (typeof level.resolveAABB === "function") {
        this._buildAABB(this.position);
        const pushY = level.resolveAABB(this._aabb);
        if (pushY && pushY.y !== 0) {
          this.position.y += pushY.y;
          this.velocity.y = 0;
        }
      }
      if (this.position.y < 0) {
        this.position.y = 0;
        if (this.velocity.y < 0) this.velocity.y = 0;
      }

      // Soft separation
      const others = ctx.enemies;
      if (others && others.length > 1) {
        for (let i = 0; i < others.length; i++) {
          const o = others[i];
          if (o === this || !o.alive || o._dead) continue;
          if (!o.position) continue;
          const ox = o.position.x - this.position.x;
          const oz = o.position.z - this.position.z;
          const d2 = ox * ox + oz * oz;
          if (d2 > 1e-6 && d2 < SOFT_SEPARATION_R * SOFT_SEPARATION_R) {
            const d = Math.sqrt(d2);
            const overlap = SOFT_SEPARATION_R - d;
            const push = overlap * 0.5;
            const nx = ox / d;
            const nz = oz / d;
            this.position.x -= nx * push;
            this.position.z -= nz * push;
          }
        }
      }

      // Face the player (yaw only)
      if (Math.abs(dxh) + Math.abs(dzh) > 1e-4) {
        const yaw = Math.atan2(dxh, dzh);
        this.mesh.rotation.y = yaw;
      }

      // Walk cycle (animates segmented joints)
      if (this.isMoving) {
        this.walkPhase += dt * 8;
      } else {
        this.walkPhase *= Math.max(0, 1 - dt * 6);
      }
      const swing = Math.sin(this.walkPhase) * 0.55;
      this._legL.rotation.x =  swing;
      this._legR.rotation.x = -swing;
      // Knee bend on segmented leg
      const kneeBendL = Math.max(0, Math.sin(this.walkPhase + Math.PI * 0.5)) * 0.5;
      const kneeBendR = Math.max(0, Math.sin(this.walkPhase + Math.PI * 1.5)) * 0.5;
      if (this._legL.userData._knee) this._legL.userData._knee.rotation.x = -kneeBendL;
      if (this._legR.userData._knee) this._legR.userData._knee.rotation.x = -kneeBendR;

      const armSwing = swing * 0.6;
      this._armL.rotation.x = -armSwing;
      this._armR.rotation.x =  armSwing;
      // Subtle elbow bend
      const elbowL = this._armL.userData._elbow;
      const elbowR = this._armR.userData._elbow;
      if (elbowL) elbowL.rotation.x = -Math.max(0, Math.sin(this.walkPhase + Math.PI)) * 0.3;
      if (elbowR) elbowR.rotation.x = -Math.max(0, Math.sin(this.walkPhase)) * 0.3;

      // Melee
      if (this.attackCooldown > 0) {
        this.attackCooldown = Math.max(0, this.attackCooldown - dt);
      }
      if (hasLOS && horizDist < BOT_ATTACK_RANGE && this.attackCooldown <= 0 && !player.dead) {
        if (typeof player.takeDamage === "function") {
          player.takeDamage(BOT_ATTACK_DAMAGE);
        }
        this.attackCooldown = BOT_ATTACK_COOLDOWN;
      }

      // Ranged
      if (this.fireCooldown > 0) {
        this.fireCooldown = Math.max(0, this.fireCooldown - dt);
      }
      if (this._cfg.ranged
          && hasLOS
          && !player.dead
          && this.fireCooldown <= 0
          && horizDist >= PROJ_RANGE_MIN
          && horizDist <= PROJ_RANGE_MAX) {
        this._fireProjectile(player, dt);
        this.fireCooldown = this._cfg.fireCooldown * (0.85 + Math.random() * 0.3);
      }

      // Projectiles
      this._updateProjectiles(dt, ctx);

      // Track player pos for lead estimation
      this._tmpVec.copy(player.position);
      this._lastPlayerPos.copy(this._tmpVec);
      this._hasLastPlayerPos = true;

      // Sync mesh (apply posture boost so hard bots stand taller)
      this.mesh.position.copy(this.position);
      this.mesh.position.y += this._postureBoost;
    }

    _fireProjectile(player, dt) {
      const origin = new THREE.Vector3(
        this.position.x,
        this.position.y + 1.3,
        this.position.z
      );
      const aim = new THREE.Vector3(
        player.position.x,
        player.position.y - 0.85,
        player.position.z
      );

      if (this._cfg.leadTarget && this._hasLastPlayerPos && dt > 1e-4) {
        const vx = (player.position.x - this._lastPlayerPos.x) / dt;
        const vz = (player.position.z - this._lastPlayerPos.z) / dt;
        const playerVel = Math.sqrt(vx * vx + vz * vz);
        if (playerVel > 0.5) {
          const dx = aim.x - origin.x;
          const dy = aim.y - origin.y;
          const dz = aim.z - origin.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const tFlight = dist / PROJ_SPEED;
          const leadT = Math.min(tFlight, 0.6);
          aim.x += vx * leadT;
          aim.z += vz * leadT;
        }
      }

      const dir = new THREE.Vector3().subVectors(aim, origin);
      const dlen = dir.length();
      if (dlen < 1e-4) return;
      dir.multiplyScalar(1 / dlen);

      const projMesh = new THREE.Mesh(PROJECTILE_GEOM, PROJECTILE_MAT);
      projMesh.position.copy(origin);
      projMesh.userData.isProjectile = true;
      this.scene.add(projMesh);

      let light = null;
      try {
        light = new THREE.PointLight(0xff3030, 0.8, 4);
        projMesh.add(light);
      } catch (e) { /* ignore */ }

      this._projectiles.push({
        mesh: projMesh,
        light: light,
        pos: origin.clone(),
        dir: dir.clone(),
        speed: PROJ_SPEED,
        damageBudget: PROJ_TOTAL_DMG_CAP,
        damaged: false,
        ttl: PROJ_RANGE_MAX / PROJ_SPEED + 2.0
      });
    }

    _updateProjectiles(dt, ctx) {
      if (!this._projectiles.length) return;
      const level = ctx && ctx.level;
      const player = ctx && ctx.player;

      for (let i = this._projectiles.length - 1; i >= 0; i--) {
        const p = this._projectiles[i];
        p.ttl -= dt;
        if (p.ttl <= 0 || p.damageBudget <= 0) {
          this._destroyProjectile(p);
          this._projectiles.splice(i, 1);
          continue;
        }

        const stepDist = p.speed * dt;

        let blocked = false;
        if (level && typeof level.raycastWalls === "function") {
          const hit = level.raycastWalls(p.pos, p.dir, stepDist + 0.1);
          if (hit && hit.distance <= stepDist + 0.05) {
            p.pos.x += p.dir.x * hit.distance;
            p.pos.y += p.dir.y * hit.distance;
            p.pos.z += p.dir.z * hit.distance;
            p.mesh.position.copy(p.pos);
            this._destroyProjectile(p);
            this._projectiles.splice(i, 1);
            blocked = true;
          }
        }
        if (blocked) continue;

        p.pos.x += p.dir.x * stepDist;
        p.pos.y += p.dir.y * stepDist;
        p.pos.z += p.dir.z * stepDist;
        p.mesh.position.copy(p.pos);
        p.damageBudget -= PROJ_DAMAGE * dt;

        if (player && !player.dead && !p.damaged) {
          const px = player.position.x - p.pos.x;
          const py = (player.position.y - 0.85) - p.pos.y;
          const pz = player.position.z - p.pos.z;
          const d2 = px * px + py * py + pz * pz;
          if (d2 < PROJ_HIT_RADIUS * PROJ_HIT_RADIUS) {
            if (typeof player.takeDamage === "function") {
              try { player.takeDamage(PROJ_DAMAGE); } catch (e) { /* ignore */ }
            }
            p.damaged = true;
            this._destroyProjectile(p);
            this._projectiles.splice(i, 1);
          }
        }
      }
    }

    _destroyProjectile(p) {
      if (!p || !p.mesh) return;
      try {
        if (p.light && p.mesh.remove) p.mesh.remove(p.light);
      } catch (e) { /* ignore */ }
      try {
        if (this.scene && this.scene.remove) this.scene.remove(p.mesh);
      } catch (e) { /* ignore */ }
      p.mesh = null;
      p.light = null;
    }

    _applyHitFlash() {
      const t = this.hitFlashT / HIT_FLASH_DURATION;
      const v = Math.max(0, Math.min(1, t));
      const r = Math.round(0xff * v);
      const hex = (r << 16) | 0;
      for (let i = 0; i < this._allMats.length; i++) {
        const m = this._allMats[i];
        if (m && m.emissive) {
          m.emissive.setHex(hex);
        }
      }
    }

    // ---------- Gibs ----------
    _spawnGibs() {
      const cx = this.position.x;
      const cy = this.position.y + 1.1;
      const cz = this.position.z;

      const count = GIB_COUNT_MIN + Math.floor(Math.random() * (GIB_COUNT_MAX - GIB_COUNT_MIN + 1));
      const bodyHex = this._bodyMat.color.getHex();

      for (let i = 0; i < count; i++) {
        const mat = new THREE.MeshLambertMaterial({
          color: bodyHex,
          transparent: true,
          opacity: 1.0
        });
        const mesh = new THREE.Mesh(GIB_GEOM, mat);
        const s = 0.5 + Math.random() * 0.7;
        mesh.scale.set(s, s, s);
        mesh.position.set(
          cx + (Math.random() - 0.5) * 0.4,
          cy + (Math.random() - 0.5) * 0.3,
          cz + (Math.random() - 0.5) * 0.4
        );
        mesh.rotation.set(
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2
        );
        // Skip raycasts (matches existing weapons.js convention)
        mesh.userData.isProjectile = true;
        mesh.userData.isGib = true;
        this.scene.add(mesh);

        const g = {
          mesh: mesh,
          mat: mat,
          vel: new THREE.Vector3(
            (Math.random() - 0.5) * 6,
            3 + Math.random() * 4,
            (Math.random() - 0.5) * 6
          ),
          spin: new THREE.Vector3(
            (Math.random() - 0.5) * 12,
            (Math.random() - 0.5) * 12,
            (Math.random() - 0.5) * 12
          ),
          age: 0,
          life: GIB_LIFETIME
        };
        this._gibs.push(g);
        if (this._gibs.length > 10) {
          const old = this._gibs.shift();
          this._destroyGib(old);
        }
      }
    }

    _updateGibs(dt) {
      if (!this._gibs.length) return;
      for (let i = this._gibs.length - 1; i >= 0; i--) {
        const g = this._gibs[i];
        g.age += dt;
        if (g.age >= g.life) {
          this._destroyGib(g);
          this._gibs.splice(i, 1);
          continue;
        }
        g.vel.y -= GIB_GRAVITY * dt;
        g.mesh.position.x += g.vel.x * dt;
        g.mesh.position.y += g.vel.y * dt;
        g.mesh.position.z += g.vel.z * dt;
        if (g.mesh.position.y < 0.05) {
          g.mesh.position.y = 0.05;
          if (g.vel.y < 0) {
            g.vel.y *= -0.35;
            g.vel.x *= 0.6;
            g.vel.z *= 0.6;
            g.spin.x *= 0.6;
            g.spin.y *= 0.6;
            g.spin.z *= 0.6;
          }
        }
        g.mesh.rotation.x += g.spin.x * dt;
        g.mesh.rotation.y += g.spin.y * dt;
        g.mesh.rotation.z += g.spin.z * dt;
        const k = 1 - (g.age / g.life);
        g.mat.opacity = Math.max(0, k);
      }
    }

    _destroyGib(g) {
      if (!g) return;
      try {
        if (g.mesh && g.mesh.parent) g.mesh.parent.remove(g.mesh);
      } catch (e) { /* ignore */ }
      // GIB_GEOM is shared — do NOT dispose. Material is per-gib, dispose it.
      try {
        if (g.mat && g.mat.dispose) g.mat.dispose();
      } catch (e) { /* ignore */ }
      g.mesh = null;
      g.mat = null;
    }

    takeDamage(amount, hitPoint) {
      if (!this.alive) return;
      if (!(amount > 0)) return;

      this.health -= amount;
      this.hitFlashT = HIT_FLASH_DURATION;
      this._applyHitFlash();

      if (this.health <= 0) {
        this.health = 0;
        this.alive = false;
        this._dead = true;
        this.deathT = 0;
        this.velocity.set(0, 0, 0);
        if (this._legL) {
          this._legL.rotation.x = 0;
          if (this._legL.userData._knee) this._legL.userData._knee.rotation.x = 0;
        }
        if (this._legR) {
          this._legR.rotation.x = 0;
          if (this._legR.userData._knee) this._legR.userData._knee.rotation.x = 0;
        }
        if (this._armL) {
          this._armL.rotation.x = 0;
          if (this._armL.userData._elbow) this._armL.userData._elbow.rotation.x = 0;
        }
        if (this._armR) {
          this._armR.rotation.x = 0;
          if (this._armR.userData._elbow) this._armR.userData._elbow.rotation.x = 0;
        }
        // Spawn gibs at impact
        this._spawnGibs();
      }
    }

    respawn() {
      this.health = this.maxHealth;
      this.alive = true;
      this._dead = false;
      this.deathT = 0;
      this.hitFlashT = 0;
      this.attackCooldown = 0;
      this.fireCooldown = (this._cfg.fireCooldown || 0) * (0.4 + Math.random() * 0.4);
      this.walkPhase = 0;
      this.velocity.set(0, 0, 0);
      this.position.copy(this.spawnPos);

      for (let i = 0; i < this._allMats.length; i++) {
        const m = this._allMats[i];
        if (m && m.emissive) m.emissive.setHex(0x000000);
      }

      this.mesh.position.copy(this.position);
      this.mesh.position.y += this._postureBoost;
      this.mesh.rotation.set(0, 0, 0);
      this.mesh.visible = true;

      if (this._legL) {
        this._legL.rotation.x = 0;
        if (this._legL.userData._knee) this._legL.userData._knee.rotation.x = 0;
      }
      if (this._legR) {
        this._legR.rotation.x = 0;
        if (this._legR.userData._knee) this._legR.userData._knee.rotation.x = 0;
      }
      if (this._armL) {
        this._armL.rotation.x = 0;
        if (this._armL.userData._elbow) this._armL.userData._elbow.rotation.x = 0;
      }
      if (this._armR) {
        this._armR.rotation.x = 0;
        if (this._armR.userData._elbow) this._armR.userData._elbow.rotation.x = 0;
      }

      // Clear projectiles
      for (let i = 0; i < this._projectiles.length; i++) {
        this._destroyProjectile(this._projectiles[i]);
      }
      this._projectiles.length = 0;

      // Clear gibs
      for (let i = 0; i < this._gibs.length; i++) {
        this._destroyGib(this._gibs[i]);
      }
      this._gibs.length = 0;
    }
  };

  // ---------- Factory ----------
  window.Game.spawnBots = function (scene, level, count, difficulty) {
    const result = [];
    if (!level || !Array.isArray(level.enemySpawns) || level.enemySpawns.length === 0) {
      return result;
    }
    const spawns = level.enemySpawns;
    const n = (typeof count === "number" && count > 0)
      ? Math.floor(count)
      : spawns.length;
    const diff = (typeof difficulty === "string") ? difficulty : "medium";

    for (let i = 0; i < n; i++) {
      const sp = spawns[i % spawns.length];
      if (!sp) continue;
      const bot = new window.Game.Bot(scene, sp, diff);
      result.push(bot);
    }
    return result;
  };
})();
