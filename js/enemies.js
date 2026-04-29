// enemies.js — Game.Enemy class and Game.spawnEnemies factory.
// Stylized "ogre / fiend" monster, walks toward the player, melee attacks.
window.Game = window.Game || {};

(function () {
  "use strict";

  // ---------- Shared geometries (cheap: one allocation, shared across all enemies) ----------
  const TORSO_GEOM = new THREE.BoxGeometry(0.8, 1.0, 0.6);
  const HEAD_GEOM  = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const ARM_GEOM   = new THREE.BoxGeometry(0.18, 0.7, 0.18);
  const LEG_GEOM   = new THREE.BoxGeometry(0.22, 0.7, 0.22);
  const EYE_GEOM   = new THREE.SphereGeometry(0.06, 8, 6);

  // Eyes are unlit basic so they always glow regardless of scene lighting.
  const EYE_MAT = new THREE.MeshBasicMaterial({ color: 0xff2200 });

  // Tunables
  const ENEMY_SPEED         = 3.5;
  const ENEMY_GRAVITY       = 25;
  const ENEMY_ATTACK_RANGE  = 1.6;
  const ENEMY_ATTACK_DAMAGE = 12;
  const ENEMY_ATTACK_COOLDOWN = 1.0;
  const ENEMY_HEIGHT        = 1.6;   // collision height (feet at y=0)
  const ENEMY_RADIUS        = 0.4;   // collision half-width
  const ENEMY_EYE_HEIGHT    = 1.4;   // for line-of-sight raycast
  const SOFT_SEPARATION_R   = 1.0;
  const HIT_FLASH_DURATION  = 0.15;
  const DEATH_DURATION      = 0.6;

  // Make a fresh torso material per enemy so hit-flash emissive doesn't bleed across mobs.
  function makeBodyMaterial() {
    return new THREE.MeshLambertMaterial({
      color: 0x4a2418,
      emissive: 0x000000
    });
  }

  function makeHeadMaterial() {
    return new THREE.MeshLambertMaterial({
      color: 0x301a10,
      emissive: 0x000000
    });
  }

  function makeLimbMaterial() {
    return new THREE.MeshLambertMaterial({
      color: 0x3a1d12,
      emissive: 0x000000
    });
  }

  window.Game.Enemy = class {
    constructor(scene, position) {
      this.scene = scene;

      // Core state
      this.position = position.clone();
      // Snap onto floor (feet at y=0 by convention).
      this.position.y = 0;
      this.spawnPos = this.position.clone();

      this.velocity = new THREE.Vector3();
      this.health = 50;
      this.maxHealth = 50;
      this.alive = true;
      this._dead = false;       // becomes true once death anim has started; disables collision
      this.attackCooldown = 0;
      this.walkPhase = 0;
      this.hitFlashT = 0;
      this.deathT = 0;          // counts up from 0 to DEATH_DURATION while dying
      this.isMoving = false;

      // ---------- Build mesh group ----------
      const group = new THREE.Group();

      // Cloned materials per enemy so we can flash emissive on hit.
      this._bodyMat  = makeBodyMaterial();
      this._headMat  = makeHeadMaterial();
      this._limbMat  = makeLimbMaterial();
      this._allMats  = [this._bodyMat, this._headMat, this._limbMat];

      // Torso — center at y = legs(0.7) + torso/2(0.5) = 1.2
      const torso = new THREE.Mesh(TORSO_GEOM, this._bodyMat);
      torso.position.set(0, 1.2, 0);
      group.add(torso);
      this._torso = torso;

      // Head — center at y = 1.7 + 0.25 = ~1.95
      const head = new THREE.Mesh(HEAD_GEOM, this._headMat);
      head.position.set(0, 1.95, 0);
      group.add(head);
      this._head = head;

      // Eyes — slight forward (+Z is forward in our local frame after we rotate the group)
      const eyeL = new THREE.Mesh(EYE_GEOM, EYE_MAT);
      eyeL.position.set(-0.12, 1.98, 0.26);
      group.add(eyeL);
      const eyeR = new THREE.Mesh(EYE_GEOM, EYE_MAT);
      eyeR.position.set(0.12, 1.98, 0.26);
      group.add(eyeR);

      // Arms — pivot at shoulder, geom centered so it hangs down
      const armPivotY = 1.6;
      const armOffsetY = -0.35; // half of arm length
      const armL = new THREE.Group();
      armL.position.set(-0.55, armPivotY, 0);
      const armLMesh = new THREE.Mesh(ARM_GEOM, this._limbMat);
      armLMesh.position.y = armOffsetY;
      armL.add(armLMesh);
      group.add(armL);
      this._armL = armL;

      const armR = new THREE.Group();
      armR.position.set(0.55, armPivotY, 0);
      const armRMesh = new THREE.Mesh(ARM_GEOM, this._limbMat);
      armRMesh.position.y = armOffsetY;
      armR.add(armRMesh);
      group.add(armR);
      this._armR = armR;

      // Legs — pivot at hip (y=0.7), geom hangs down by 0.35
      const legPivotY = 0.7;
      const legOffsetY = -0.35;
      const legL = new THREE.Group();
      legL.position.set(-0.2, legPivotY, 0);
      const legLMesh = new THREE.Mesh(LEG_GEOM, this._limbMat);
      legLMesh.position.y = legOffsetY;
      legL.add(legLMesh);
      group.add(legL);
      this._legL = legL;

      const legR = new THREE.Group();
      legR.position.set(0.2, legPivotY, 0);
      const legRMesh = new THREE.Mesh(LEG_GEOM, this._limbMat);
      legRMesh.position.y = legOffsetY;
      legR.add(legRMesh);
      group.add(legR);
      this._legR = legR;

      // Position the group at feet
      group.position.copy(this.position);

      // Tag every mesh so weapon raycasts can find this enemy via mesh.userData.enemyRef
      const self = this;
      group.traverse((m) => {
        if (m.isMesh) {
          m.userData.enemyRef = self;
        }
      });

      this.mesh = group;
      scene.add(group);

      // ---------- Reusable allocations to avoid per-frame GC ----------
      this._aabb = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
      this._toPlayer = new THREE.Vector3();
      this._enemyEye = new THREE.Vector3();
      this._rayDir = new THREE.Vector3();
      this._tmpVec = new THREE.Vector3();
    }

    // Build the enemy's AABB into this._aabb at the given foot position.
    _buildAABB(pos) {
      this._aabb.min.set(pos.x - ENEMY_RADIUS, pos.y, pos.z - ENEMY_RADIUS);
      this._aabb.max.set(pos.x + ENEMY_RADIUS, pos.y + ENEMY_HEIGHT, pos.z + ENEMY_RADIUS);
      return this._aabb;
    }

    update(dt, ctx) {
      // ---------------- Death animation ----------------
      if (!this.alive) {
        if (this.deathT < DEATH_DURATION) {
          this.deathT = Math.min(DEATH_DURATION, this.deathT + dt);
          const t = this.deathT / DEATH_DURATION;
          // tilt forward and sink slightly so the corpse lies flat on the floor
          this.mesh.rotation.x = THREE.MathUtils.lerp(0, Math.PI / 2, t);
          this.mesh.position.y = THREE.MathUtils.lerp(this.spawnPos.y, this.spawnPos.y - 0.1, t);
        }
        // also let any hit flash fade out post-mortem
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
      // Player position is at eye height; foot-to-foot distance is what we use for chase AI
      // but for LOS we cast from enemy "eye" to player position.
      const playerFootY = player.position.y - 1.7;
      this._toPlayer.set(
        player.position.x - this.position.x,
        playerFootY - this.position.y,
        player.position.z - this.position.z
      );
      // Horizontal distance (foot-plane) for chase
      const dxh = this._toPlayer.x;
      const dzh = this._toPlayer.z;
      const horizDist = Math.sqrt(dxh * dxh + dzh * dzh);

      // LOS raycast from enemy eye to player position
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
        // Don't shove all the way into the player — keep just inside attack range.
        if (horizDist > ENEMY_ATTACK_RANGE * 0.8) {
          const inv = 1 / Math.max(horizDist, 1e-4);
          desiredX = (dxh * inv) * ENEMY_SPEED;
          desiredZ = (dzh * inv) * ENEMY_SPEED;
          this.isMoving = true;
        }
      }

      // Snap horizontal velocity (cheap; enemies don't need momentum-based feel)
      this.velocity.x = desiredX;
      this.velocity.z = desiredZ;

      // ---------------- Gravity ----------------
      this.velocity.y -= ENEMY_GRAVITY * dt;

      // ---------------- Collision: axis-separated like the player ----------------
      // X
      this.position.x += this.velocity.x * dt;
      if (typeof level.resolveAABB === "function") {
        this._buildAABB(this.position);
        const pushX = level.resolveAABB(this._aabb);
        if (pushX && pushX.x !== 0) {
          this.position.x += pushX.x;
          this.velocity.x = 0;
        }
      }
      // Z
      this.position.z += this.velocity.z * dt;
      if (typeof level.resolveAABB === "function") {
        this._buildAABB(this.position);
        const pushZ = level.resolveAABB(this._aabb);
        if (pushZ && pushZ.z !== 0) {
          this.position.z += pushZ.z;
          this.velocity.z = 0;
        }
      }
      // Y
      this.position.y += this.velocity.y * dt;
      if (typeof level.resolveAABB === "function") {
        this._buildAABB(this.position);
        const pushY = level.resolveAABB(this._aabb);
        if (pushY && pushY.y !== 0) {
          this.position.y += pushY.y;
          this.velocity.y = 0;
        }
      }
      // Floor clamp
      if (this.position.y < 0) {
        this.position.y = 0;
        if (this.velocity.y < 0) this.velocity.y = 0;
      }

      // ---------------- Soft enemy <-> enemy separation ----------------
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
            // push half the overlap (other half handled when 'o' processes us)
            const push = overlap * 0.5;
            const nx = ox / d;
            const nz = oz / d;
            this.position.x -= nx * push;
            this.position.z -= nz * push;
          }
        }
      }

      // ---------------- Face the player (yaw only) ----------------
      if (Math.abs(dxh) + Math.abs(dzh) > 1e-4) {
        const yaw = Math.atan2(dxh, dzh);
        this.mesh.rotation.y = yaw;
      }

      // ---------------- Walk cycle ----------------
      if (this.isMoving) {
        this.walkPhase += dt * 8;
      } else {
        // Decay phase to zero so we settle into idle pose
        this.walkPhase *= Math.max(0, 1 - dt * 6);
      }
      const swing = Math.sin(this.walkPhase) * 0.6;
      this._legL.rotation.x =  swing;
      this._legR.rotation.x = -swing;
      // Arms swing opposite to legs and a little gentler
      const armSwing = swing * 0.7;
      this._armL.rotation.x = -armSwing;
      this._armR.rotation.x =  armSwing;

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

      // ---------------- Sync mesh ----------------
      this.mesh.position.copy(this.position);
    }

    _applyHitFlash() {
      // Map hitFlashT in [0..HIT_FLASH_DURATION] to red emissive intensity.
      const t = this.hitFlashT / HIT_FLASH_DURATION;
      const v = Math.max(0, Math.min(1, t));
      const r = Math.round(0xff * v);
      const hex = (r << 16) | 0; // pure red, scaled
      for (let i = 0; i < this._allMats.length; i++) {
        const m = this._allMats[i];
        if (m && m.emissive) {
          m.emissive.setHex(hex);
        }
      }
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
        // Stop all motion immediately
        this.velocity.set(0, 0, 0);
        // Reset limb pose so the corpse looks neutral as it tips over
        if (this._legL) this._legL.rotation.x = 0;
        if (this._legR) this._legR.rotation.x = 0;
        if (this._armL) this._armL.rotation.x = 0;
        if (this._armR) this._armR.rotation.x = 0;
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

      // Reset limbs
      if (this._legL) this._legL.rotation.x = 0;
      if (this._legR) this._legR.rotation.x = 0;
      if (this._armL) this._armL.rotation.x = 0;
      if (this._armR) this._armR.rotation.x = 0;
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
