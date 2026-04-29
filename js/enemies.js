// enemies.js — Game.Enemy class and Game.spawnEnemies factory.
// Stylized "fiend" creature: squat brown-red horned brute with glowing red eyes,
// segmented limbs, claws, and shoulder/back spikes. Walks toward the player and
// melee attacks. Spawns gib fragments on death.
window.Game = window.Game || {};

(function () {
  "use strict";

  // ---------- Shared geometries (one allocation, shared across instances) ----------
  // Body
  const TORSO_GEOM        = new THREE.BoxGeometry(0.85, 1.00, 0.62);
  const CHEST_PLATE_GEOM  = new THREE.BoxGeometry(0.72, 0.55, 0.10);
  const BACK_PLATE_GEOM   = new THREE.BoxGeometry(0.72, 0.55, 0.10);

  // Head & jaw
  const HEAD_GEOM         = new THREE.BoxGeometry(0.52, 0.42, 0.50);
  const JAW_GEOM          = new THREE.BoxGeometry(0.42, 0.18, 0.40);

  // Eyes (low-poly so 2 spheres stay cheap)
  const EYE_GEOM          = new THREE.SphereGeometry(0.07, 6, 4);

  // Limb segments — re-used L/R
  const ARM_UPPER_GEOM    = new THREE.BoxGeometry(0.20, 0.42, 0.20);
  const ARM_LOWER_GEOM    = new THREE.BoxGeometry(0.18, 0.40, 0.18);
  const HAND_GEOM         = new THREE.BoxGeometry(0.22, 0.18, 0.22);

  const LEG_THIGH_GEOM    = new THREE.BoxGeometry(0.24, 0.42, 0.24);
  const LEG_SHIN_GEOM     = new THREE.BoxGeometry(0.22, 0.40, 0.22);
  const FOOT_GEOM         = new THREE.BoxGeometry(0.28, 0.14, 0.40);

  // Spikes / horns / claws (low segment counts to stay under tri budget)
  const HORN_GEOM         = new THREE.ConeGeometry(0.07, 0.30, 6);
  const SPIKE_GEOM        = new THREE.ConeGeometry(0.07, 0.28, 5);
  const CLAW_GEOM         = new THREE.ConeGeometry(0.04, 0.12, 4);

  // Eye halo plane (billboarded by main render orientation; we just face +Z which the
  // group-yaw aligns roughly with the view because enemy turns to face the player).
  const HALO_GEOM         = new THREE.PlaneGeometry(0.32, 0.32);

  // Gib geometry — single shared box, scaled per gib instance.
  const GIB_GEOM          = new THREE.BoxGeometry(0.18, 0.18, 0.18);

  // Eyes are unlit basic so they always glow regardless of scene lighting.
  const EYE_MAT           = new THREE.MeshBasicMaterial({ color: 0xff2200 });
  const HALO_MAT          = new THREE.MeshBasicMaterial({
    color: 0xff2200,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  // ---------- Tunables ----------
  const ENEMY_SPEED         = 3.5;
  const ENEMY_GRAVITY       = 25;
  const ENEMY_ATTACK_RANGE  = 1.6;
  const ENEMY_ATTACK_DAMAGE = 12;
  const ENEMY_ATTACK_COOLDOWN = 1.0;
  const ENEMY_HEIGHT        = 1.6;
  const ENEMY_RADIUS        = 0.4;
  const ENEMY_EYE_HEIGHT    = 1.4;
  const SOFT_SEPARATION_R   = 1.0;
  const HIT_FLASH_DURATION  = 0.15;
  const DEATH_DURATION      = 0.6;

  // Halo visibility distance (capped so halos don't bloom up close).
  const HALO_FADE_NEAR      = 3.0;
  const HALO_FADE_FAR       = 18.0;

  // Gibs
  const GIB_COUNT_MIN       = 6;
  const GIB_COUNT_MAX       = 10;
  const GIB_LIFETIME        = 1.6;
  const GIB_GRAVITY         = 22;

  // Per-instance materials so hit-flash emissive doesn't bleed between mobs.
  function makeBodyMaterial() {
    return new THREE.MeshLambertMaterial({ color: 0x4a2418, emissive: 0x000000 });
  }
  function makeHeadMaterial() {
    return new THREE.MeshLambertMaterial({ color: 0x301a10, emissive: 0x000000 });
  }
  function makeLimbMaterial() {
    return new THREE.MeshLambertMaterial({ color: 0x3a1d12, emissive: 0x000000 });
  }
  // Plating reads as darker scarred hide / armor.
  function makePlateMaterial() {
    return new THREE.MeshLambertMaterial({ color: 0x231009, emissive: 0x000000 });
  }
  // Horns / spikes / claws — bone / chitin
  function makeBoneMaterial() {
    return new THREE.MeshLambertMaterial({ color: 0x1a0d07, emissive: 0x000000 });
  }

  // Tag every mesh in a sub-tree with .userData.enemyRef so weapon raycasts find us.
  function tagEnemyRefs(root, ref) {
    root.traverse((m) => {
      if (m.isMesh) m.userData.enemyRef = ref;
    });
  }

  window.Game.Enemy = class {
    constructor(scene, position) {
      this.scene = scene;

      // Core state
      this.position = position.clone();
      this.position.y = 0;
      this.spawnPos = this.position.clone();

      this.velocity = new THREE.Vector3();
      this.health = 50;
      this.maxHealth = 50;
      this.alive = true;
      this._dead = false;
      this.attackCooldown = 0;
      this.walkPhase = 0;
      this.hitFlashT = 0;
      this.deathT = 0;
      this.isMoving = false;

      // Gib book-keeping. Gibs persist across alive/dead state.
      this._gibs = [];

      // ---------- Build mesh group ----------
      const group = new THREE.Group();

      // Per-enemy materials (cloned-equivalents created fresh).
      this._bodyMat  = makeBodyMaterial();
      this._headMat  = makeHeadMaterial();
      this._limbMat  = makeLimbMaterial();
      this._plateMat = makePlateMaterial();
      this._boneMat  = makeBoneMaterial();
      this._allMats  = [
        this._bodyMat, this._headMat, this._limbMat,
        this._plateMat, this._boneMat
      ];

      // ----- Torso -----
      const torso = new THREE.Mesh(TORSO_GEOM, this._bodyMat);
      torso.position.set(0, 1.2, 0);
      group.add(torso);
      this._torso = torso;

      // Chest plate (slightly proud of the torso, looks like armor / scarred hide)
      const chestPlate = new THREE.Mesh(CHEST_PLATE_GEOM, this._plateMat);
      chestPlate.position.set(0, 1.18, 0.32);
      group.add(chestPlate);

      // Back plate
      const backPlate = new THREE.Mesh(BACK_PLATE_GEOM, this._plateMat);
      backPlate.position.set(0, 1.22, -0.32);
      group.add(backPlate);

      // Two back spikes (jutting up & back)
      const backSpike1 = new THREE.Mesh(SPIKE_GEOM, this._boneMat);
      backSpike1.position.set(-0.18, 1.55, -0.32);
      backSpike1.rotation.x = -0.45;
      group.add(backSpike1);
      const backSpike2 = new THREE.Mesh(SPIKE_GEOM, this._boneMat);
      backSpike2.position.set(0.18, 1.55, -0.32);
      backSpike2.rotation.x = -0.45;
      group.add(backSpike2);

      // ----- Head -----
      const head = new THREE.Mesh(HEAD_GEOM, this._headMat);
      head.position.set(0, 1.95, 0);
      group.add(head);
      this._head = head;

      // Jaw — small jutting underside suggesting fangs
      const jaw = new THREE.Mesh(JAW_GEOM, this._headMat);
      jaw.position.set(0, 1.78, 0.06);
      group.add(jaw);

      // Two horns (curling up & slightly outward)
      const hornL = new THREE.Mesh(HORN_GEOM, this._boneMat);
      hornL.position.set(-0.16, 2.18, -0.06);
      hornL.rotation.z = 0.35;
      group.add(hornL);
      const hornR = new THREE.Mesh(HORN_GEOM, this._boneMat);
      hornR.position.set(0.16, 2.18, -0.06);
      hornR.rotation.z = -0.35;
      group.add(hornR);

      // Eyes — slight forward (+Z is forward in local frame)
      const eyeL = new THREE.Mesh(EYE_GEOM, EYE_MAT);
      eyeL.position.set(-0.12, 1.98, 0.26);
      group.add(eyeL);
      const eyeR = new THREE.Mesh(EYE_GEOM, EYE_MAT);
      eyeR.position.set(0.12, 1.98, 0.26);
      group.add(eyeR);

      // Eye halos — additive billboard quads (clone material so opacity can be
      // animated per-enemy by distance without bleeding across mobs).
      this._haloMat = HALO_MAT.clone();
      const haloL = new THREE.Mesh(HALO_GEOM, this._haloMat);
      haloL.position.set(-0.12, 1.98, 0.27);
      group.add(haloL);
      const haloR = new THREE.Mesh(HALO_GEOM, this._haloMat);
      haloR.position.set(0.12, 1.98, 0.27);
      group.add(haloR);
      this._haloL = haloL;
      this._haloR = haloR;

      // Shoulder spikes
      const shoulderSpikeL = new THREE.Mesh(SPIKE_GEOM, this._boneMat);
      shoulderSpikeL.position.set(-0.62, 1.72, 0);
      shoulderSpikeL.rotation.z = 0.45;
      group.add(shoulderSpikeL);
      const shoulderSpikeR = new THREE.Mesh(SPIKE_GEOM, this._boneMat);
      shoulderSpikeR.position.set(0.62, 1.72, 0);
      shoulderSpikeR.rotation.z = -0.45;
      group.add(shoulderSpikeR);

      // ----- Arms (2 segments + hand + claws) -----
      // Each arm is a chain: shoulder pivot -> upper -> elbow pivot -> lower -> hand
      const armPivotY = 1.6;
      this._armL = this._buildArm(group, -0.55, armPivotY, "L");
      this._armR = this._buildArm(group,  0.55, armPivotY, "R");

      // ----- Legs (2 segments + foot + toe claw) -----
      const legPivotY = 0.7;
      this._legL = this._buildLeg(group, -0.2, legPivotY, "L");
      this._legR = this._buildLeg(group,  0.2, legPivotY, "R");

      // Position the group at feet
      group.position.copy(this.position);

      // Tag every mesh so weapon raycasts can find this enemy.
      tagEnemyRefs(group, this);

      this.mesh = group;
      scene.add(group);

      // ---------- Reusable scratch ----------
      this._aabb = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
      this._toPlayer = new THREE.Vector3();
      this._enemyEye = new THREE.Vector3();
      this._rayDir = new THREE.Vector3();
      this._tmpVec = new THREE.Vector3();
    }

    // Build a segmented arm. Returns the shoulder-pivot Group with `_lower` ref attached.
    _buildArm(parentGroup, shoulderX, shoulderY /*, side */) {
      const shoulder = new THREE.Group();
      shoulder.position.set(shoulderX, shoulderY, 0);
      // Upper arm — hangs down from shoulder, geom centered at -0.21 so its top is at 0.
      const upper = new THREE.Mesh(ARM_UPPER_GEOM, this._limbMat);
      upper.position.y = -0.21;
      shoulder.add(upper);

      // Elbow pivot at the bottom of the upper arm (y = -0.42)
      const elbow = new THREE.Group();
      elbow.position.y = -0.42;
      shoulder.add(elbow);

      const lower = new THREE.Mesh(ARM_LOWER_GEOM, this._limbMat);
      lower.position.y = -0.20; // shin half-length below elbow
      elbow.add(lower);

      // Hand at end of forearm
      const hand = new THREE.Mesh(HAND_GEOM, this._limbMat);
      hand.position.y = -0.48;
      elbow.add(hand);

      // 3 claws on the hand (forward-pointing)
      const c1 = new THREE.Mesh(CLAW_GEOM, this._boneMat);
      c1.position.set(-0.07, -0.55, 0.10);
      c1.rotation.x = Math.PI; // tip down/forward
      elbow.add(c1);
      const c2 = new THREE.Mesh(CLAW_GEOM, this._boneMat);
      c2.position.set(0.00, -0.55, 0.12);
      c2.rotation.x = Math.PI;
      elbow.add(c2);
      const c3 = new THREE.Mesh(CLAW_GEOM, this._boneMat);
      c3.position.set(0.07, -0.55, 0.10);
      c3.rotation.x = Math.PI;
      elbow.add(c3);

      parentGroup.add(shoulder);
      shoulder.userData._elbow = elbow; // for walk cycle to bend the elbow
      return shoulder;
    }

    // Build a segmented leg. Returns the hip-pivot Group with `_knee` ref attached.
    _buildLeg(parentGroup, hipX, hipY /*, side */) {
      const hip = new THREE.Group();
      hip.position.set(hipX, hipY, 0);

      const thigh = new THREE.Mesh(LEG_THIGH_GEOM, this._limbMat);
      thigh.position.y = -0.21;
      hip.add(thigh);

      const knee = new THREE.Group();
      knee.position.y = -0.42;
      hip.add(knee);

      const shin = new THREE.Mesh(LEG_SHIN_GEOM, this._limbMat);
      shin.position.y = -0.20;
      knee.add(shin);

      const foot = new THREE.Mesh(FOOT_GEOM, this._plateMat);
      foot.position.set(0, -0.45, 0.06);
      knee.add(foot);

      // Toe claw
      const toeClaw = new THREE.Mesh(CLAW_GEOM, this._boneMat);
      toeClaw.position.set(0, -0.46, 0.26);
      toeClaw.rotation.x = Math.PI / 2;
      knee.add(toeClaw);

      parentGroup.add(hip);
      hip.userData._knee = knee;
      return hip;
    }

    _buildAABB(pos) {
      this._aabb.min.set(pos.x - ENEMY_RADIUS, pos.y, pos.z - ENEMY_RADIUS);
      this._aabb.max.set(pos.x + ENEMY_RADIUS, pos.y + ENEMY_HEIGHT, pos.z + ENEMY_RADIUS);
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
          this.mesh.position.y = THREE.MathUtils.lerp(this.spawnPos.y, this.spawnPos.y - 0.1, t);
        }
        if (this.hitFlashT > 0) {
          this.hitFlashT = Math.max(0, this.hitFlashT - dt);
          this._applyHitFlash();
        }
        return;
      }

      const player = ctx && ctx.player;
      const level  = ctx && ctx.level;
      if (!player || !level) {
        return;
      }

      // ---------------- Hit flash decay ----------------
      if (this.hitFlashT > 0) {
        this.hitFlashT = Math.max(0, this.hitFlashT - dt);
        this._applyHitFlash();
      }

      // ---------------- Distance & line of sight ----------------
      const playerFootY = player.position.y - 1.7;
      this._toPlayer.set(
        player.position.x - this.position.x,
        playerFootY - this.position.y,
        player.position.z - this.position.z
      );
      const dxh = this._toPlayer.x;
      const dzh = this._toPlayer.z;
      const horizDist = Math.sqrt(dxh * dxh + dzh * dzh);

      this._enemyEye.set(this.position.x, this.position.y + ENEMY_EYE_HEIGHT, this.position.z);
      this._rayDir.set(
        player.position.x - this._enemyEye.x,
        player.position.y - this._enemyEye.y,
        player.position.z - this._enemyEye.z
      );
      const rayLen = this._rayDir.length();
      let hasLOS = true;
      if (rayLen > 1e-4 && typeof level.raycastWalls === "function") {
        this._rayDir.multiplyScalar(1 / rayLen);
        const hit = level.raycastWalls(this._enemyEye, this._rayDir, rayLen);
        if (hit && hit.distance < rayLen - 0.05) {
          hasLOS = false;
        }
      }

      // ---------------- Decide movement ----------------
      let desiredX = 0;
      let desiredZ = 0;
      this.isMoving = false;

      if (hasLOS && horizDist > 0.001) {
        if (horizDist > ENEMY_ATTACK_RANGE * 0.8) {
          const inv = 1 / Math.max(horizDist, 1e-4);
          desiredX = (dxh * inv) * ENEMY_SPEED;
          desiredZ = (dzh * inv) * ENEMY_SPEED;
          this.isMoving = true;
        }
      }

      this.velocity.x = desiredX;
      this.velocity.z = desiredZ;

      // Gravity
      this.velocity.y -= ENEMY_GRAVITY * dt;

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

      // Soft enemy <-> enemy separation
      const others = ctx.enemies;
      if (others && others.length > 1) {
        for (let i = 0; i < others.length; i++) {
          const o = others[i];
          if (o === this || !o.alive || o._dead) continue;
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

      // ---------------- Walk cycle (animates joints) ----------------
      if (this.isMoving) {
        this.walkPhase += dt * 8;
      } else {
        this.walkPhase *= Math.max(0, 1 - dt * 6);
      }
      const swing = Math.sin(this.walkPhase) * 0.6;
      // Hip swing
      this._legL.rotation.x =  swing;
      this._legR.rotation.x = -swing;
      // Knee bend — kicks back on forward swing (adds segmented look)
      const kneeBend = Math.max(0, Math.sin(this.walkPhase + Math.PI * 0.5)) * 0.55;
      const kneeBendOpp = Math.max(0, Math.sin(this.walkPhase + Math.PI * 1.5)) * 0.55;
      if (this._legL.userData._knee) this._legL.userData._knee.rotation.x = -kneeBend;
      if (this._legR.userData._knee) this._legR.userData._knee.rotation.x = -kneeBendOpp;

      // Arms swing opposite to legs
      const armSwing = swing * 0.7;
      this._armL.rotation.x = -armSwing;
      this._armR.rotation.x =  armSwing;
      // Elbow bends slightly when arm swings forward
      const elbowL = this._armL.userData._elbow;
      const elbowR = this._armR.userData._elbow;
      if (elbowL) elbowL.rotation.x = -Math.max(0, Math.sin(this.walkPhase + Math.PI)) * 0.35;
      if (elbowR) elbowR.rotation.x = -Math.max(0, Math.sin(this.walkPhase)) * 0.35;

      // ---------------- Halo distance fade ----------------
      const dxv = player.position.x - this.position.x;
      const dyv = player.position.y - (this.position.y + 1.0);
      const dzv = player.position.z - this.position.z;
      const distToPlayer = Math.sqrt(dxv * dxv + dyv * dyv + dzv * dzv);
      let haloAlpha;
      if (distToPlayer < HALO_FADE_NEAR) {
        haloAlpha = 0.25; // dimmer at close range so it doesn't blow out
      } else if (distToPlayer > HALO_FADE_FAR) {
        haloAlpha = 0;
      } else {
        const t = 1 - (distToPlayer - HALO_FADE_NEAR) / (HALO_FADE_FAR - HALO_FADE_NEAR);
        haloAlpha = 0.55 * t;
      }
      if (this._haloMat) this._haloMat.opacity = haloAlpha;
      // Face halos toward camera-ish (yaw is already facing player; counter-rotate
      // the halo so it stays roughly perpendicular to view across pitch.)
      // Simple: leave at local +Z; group already faces player, looks fine.

      // ---------------- Attack ----------------
      if (this.attackCooldown > 0) {
        this.attackCooldown = Math.max(0, this.attackCooldown - dt);
      }
      if (hasLOS && horizDist < ENEMY_ATTACK_RANGE && this.attackCooldown <= 0 && !player.dead) {
        if (typeof player.takeDamage === "function") {
          player.takeDamage(ENEMY_ATTACK_DAMAGE);
        }
        this.attackCooldown = ENEMY_ATTACK_COOLDOWN;
      }

      // Sync mesh
      this.mesh.position.copy(this.position);
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

    // Spawn 6-10 chunky gibs at the entity's body center on death.
    _spawnGibs() {
      const cx = this.position.x;
      const cy = this.position.y + 1.1; // body center
      const cz = this.position.z;

      const count = GIB_COUNT_MIN + Math.floor(Math.random() * (GIB_COUNT_MAX - GIB_COUNT_MIN + 1));
      const bodyHex = this._bodyMat.color.getHex();

      for (let i = 0; i < count; i++) {
        // Per-gib material so opacity decays independently.
        const mat = new THREE.MeshLambertMaterial({
          color: bodyHex,
          transparent: true,
          opacity: 1.0
        });
        const mesh = new THREE.Mesh(GIB_GEOM, mat);
        // Random size variation
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
        // Don't tag with enemyRef — gibs aren't damageable. Tag isProjectile so
        // weapon raycasts skip them (matches existing convention in weapons.js).
        mesh.userData.isProjectile = true;
        mesh.userData.isGib = true;
        this.scene.add(mesh);

        const g = {
          mesh: mesh,
          mat: mat,
          vel: new THREE.Vector3(
            (Math.random() - 0.5) * 6,        // xz: ±3
            3 + Math.random() * 4,            // y: 3-7
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
          // Hard cap — destroy the oldest if we somehow overflow.
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
        // Integrate
        g.vel.y -= GIB_GRAVITY * dt;
        g.mesh.position.x += g.vel.x * dt;
        g.mesh.position.y += g.vel.y * dt;
        g.mesh.position.z += g.vel.z * dt;
        // Floor bounce (cheap)
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
        // Fade
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
        // Reset limb pose so the corpse looks neutral as it tips over.
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
        // Spawn gibs at the impact point.
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
      this.walkPhase = 0;
      this.velocity.set(0, 0, 0);
      this.position.copy(this.spawnPos);

      // Reset emissive
      for (let i = 0; i < this._allMats.length; i++) {
        const m = this._allMats[i];
        if (m && m.emissive) m.emissive.setHex(0x000000);
      }

      // Reset mesh transform
      this.mesh.position.copy(this.position);
      this.mesh.rotation.set(0, 0, 0);
      this.mesh.visible = true;

      // Reset limbs (and segmented joints)
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

      // Clear any lingering gibs
      for (let i = 0; i < this._gibs.length; i++) {
        this._destroyGib(this._gibs[i]);
      }
      this._gibs.length = 0;
    }
  };

  // ---------- Factory ----------
  window.Game.spawnEnemies = function (scene, level) {
    const result = [];
    if (!level || !Array.isArray(level.enemySpawns)) {
      return result;
    }
    for (let i = 0; i < level.enemySpawns.length; i++) {
      const sp = level.enemySpawns[i];
      if (!sp) continue;
      const enemy = new window.Game.Enemy(scene, sp);
      result.push(enemy);
    }
    return result;
  };
})();
