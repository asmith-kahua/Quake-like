// bots.js — Game.Bot class and Game.spawnBots factory.
// Stylized "white-and-red mech" android opponent. Drop-in replacement for Game.Enemy:
// exposes the same surface (.alive, .position, .mesh, .health, update, takeDamage, respawn)
// so weapons.js / level.js / main.js work without modification.
//
// Differences from Game.Enemy:
//   - Boxy white-and-red mech body (not the dark-red ogre) with glowing yellow eyes.
//   - Three difficulty tiers ("easy" / "medium" / "hard") tuning hp, speed and ranged AI.
//   - Medium/hard bots fire a slow red glowing projectile when the player is between 4-25m
//     with line of sight. Hard bots lead the target.
window.Game = window.Game || {};

(function () {
  "use strict";

  // ---------- Shared geometries (one allocation, shared across all bots) ----------
  // Mech proportions are deliberately a bit different from the ogre (chunkier torso,
  // square shoulders, blocky head) so the silhouette reads as "robot" not "fiend".
  const TORSO_GEOM    = new THREE.BoxGeometry(0.95, 1.05, 0.65);
  const CHEST_GEOM    = new THREE.BoxGeometry(1.10, 0.35, 0.70); // shoulder yoke
  const HEAD_GEOM     = new THREE.BoxGeometry(0.55, 0.45, 0.55);
  const VISOR_GEOM    = new THREE.BoxGeometry(0.46, 0.10, 0.02);
  const ARM_GEOM      = new THREE.BoxGeometry(0.22, 0.75, 0.22);
  const SHOULDER_GEOM = new THREE.BoxGeometry(0.30, 0.30, 0.30);
  const LEG_GEOM      = new THREE.BoxGeometry(0.26, 0.75, 0.26);
  const FOOT_GEOM     = new THREE.BoxGeometry(0.32, 0.10, 0.40);
  const EYE_GEOM      = new THREE.SphereGeometry(0.07, 8, 6);
  const ACCENT_GEOM   = new THREE.BoxGeometry(0.55, 0.10, 0.02); // chest stripe
  const PROJECTILE_GEOM = new THREE.SphereGeometry(0.18, 12, 10);

  // Unlit materials so they always glow regardless of scene lighting.
  const EYE_MAT       = new THREE.MeshBasicMaterial({ color: 0xfff060 });
  const VISOR_MAT     = new THREE.MeshBasicMaterial({ color: 0x331a00 });
  const ACCENT_MAT    = new THREE.MeshBasicMaterial({ color: 0xff2020 });
  const PROJECTILE_MAT = new THREE.MeshBasicMaterial({ color: 0xff3030 });

  // ---------- Tunables (shared) ----------
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
  const PROJ_SPEED          = 18;     // m/s
  const PROJ_DAMAGE         = 15;
  const PROJ_HIT_RADIUS     = 0.45;   // distance to player center to count as hit
  const PROJ_TOTAL_DMG_CAP  = 60;     // bot retires the projectile after this much *potential* dmg
  const PROJ_RANGE_MIN      = 4;
  const PROJ_RANGE_MAX      = 25;

  // Per-difficulty config
  const DIFFICULTIES = {
    easy: {
      health: 50,
      speed: 2,
      ranged: false,
      fireCooldown: 0,
      leadTarget: false,
      bodyColor:   0xf2f2f2,
      accentColor: 0xcc1818,
      headColor:   0xe0e0e0
    },
    medium: {
      health: 75,
      speed: 3,
      ranged: true,
      fireCooldown: 2.2,
      leadTarget: false,
      bodyColor:   0xf2f2f2,
      accentColor: 0xdd2222,
      headColor:   0xdedede
    },
    hard: {
      health: 110,
      speed: 4,
      ranged: true,
      fireCooldown: 1.2,
      leadTarget: true,
      bodyColor:   0xfafafa,
      accentColor: 0xff1010,
      headColor:   0xeeeeee
    }
  };

  // Per-bot materials (so hit-flash emissive doesn't bleed across bots).
  function makeBodyMaterial(color) {
    return new THREE.MeshLambertMaterial({ color: color, emissive: 0x000000 });
  }
  function makeAccentMaterial(color) {
    return new THREE.MeshLambertMaterial({ color: color, emissive: 0x000000 });
  }
  function makeHeadMaterial(color) {
    return new THREE.MeshLambertMaterial({ color: color, emissive: 0x000000 });
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
      this.position.y = 0; // feet on floor
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

      // Active projectiles owned by this bot
      this._projectiles = [];

      // ---------- Build mesh ----------
      const group = new THREE.Group();

      // Per-bot materials
      this._bodyMat   = makeBodyMaterial(cfg.bodyColor);
      this._headMat   = makeHeadMaterial(cfg.headColor);
      this._accentMat = makeAccentMaterial(cfg.accentColor);
      this._allMats   = [this._bodyMat, this._headMat, this._accentMat];

      // Torso
      const torso = new THREE.Mesh(TORSO_GEOM, this._bodyMat);
      torso.position.set(0, 1.225, 0);
      group.add(torso);
      this._torso = torso;

      // Shoulder yoke (red accent across the upper chest)
      const chest = new THREE.Mesh(CHEST_GEOM, this._accentMat);
      chest.position.set(0, 1.65, 0);
      group.add(chest);

      // Vertical accent stripe on chest
      const stripe = new THREE.Mesh(ACCENT_GEOM, ACCENT_MAT);
      stripe.position.set(0, 1.20, 0.331);
      stripe.rotation.z = Math.PI / 2;
      group.add(stripe);

      // Head
      const head = new THREE.Mesh(HEAD_GEOM, this._headMat);
      head.position.set(0, 2.05, 0);
      group.add(head);
      this._head = head;

      // Visor strip (dark band behind the eyes)
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

      // Shoulders (small cubes)
      const shL = new THREE.Mesh(SHOULDER_GEOM, this._accentMat);
      shL.position.set(-0.62, 1.70, 0);
      group.add(shL);
      const shR = new THREE.Mesh(SHOULDER_GEOM, this._accentMat);
      shR.position.set(0.62, 1.70, 0);
      group.add(shR);

      // Arms (pivot at shoulder)
      const armPivotY  = 1.55;
      const armOffsetY = -0.375;
      const armL = new THREE.Group();
      armL.position.set(-0.62, armPivotY, 0);
      const armLMesh = new THREE.Mesh(ARM_GEOM, this._bodyMat);
      armLMesh.position.y = armOffsetY;
      armL.add(armLMesh);
      group.add(armL);
      this._armL = armL;

      const armR = new THREE.Group();
      armR.position.set(0.62, armPivotY, 0);
      const armRMesh = new THREE.Mesh(ARM_GEOM, this._bodyMat);
      armRMesh.position.y = armOffsetY;
      armR.add(armRMesh);
      group.add(armR);
      this._armR = armR;

      // Legs (pivot at hip)
      const legPivotY  = 0.7;
      const legOffsetY = -0.375;
      const legL = new THREE.Group();
      legL.position.set(-0.22, legPivotY, 0);
      const legLMesh = new THREE.Mesh(LEG_GEOM, this._bodyMat);
      legLMesh.position.y = legOffsetY;
      legL.add(legLMesh);
      // Foot
      const footL = new THREE.Mesh(FOOT_GEOM, this._accentMat);
      footL.position.set(0, -0.78, 0.05);
      legL.add(footL);
      group.add(legL);
      this._legL = legL;

      const legR = new THREE.Group();
      legR.position.set(0.22, legPivotY, 0);
      const legRMesh = new THREE.Mesh(LEG_GEOM, this._bodyMat);
      legRMesh.position.y = legOffsetY;
      legR.add(legRMesh);
      const footR = new THREE.Mesh(FOOT_GEOM, this._accentMat);
      footR.position.set(0, -0.78, 0.05);
      legR.add(footR);
      group.add(legR);
      this._legR = legR;

      // Position the group at feet
      group.position.copy(this.position);

      // Tag every mesh so weapon raycasts can find this bot via mesh.userData.enemyRef
      const self = this;
      group.traverse((m) => {
        if (m.isMesh) {
          m.userData.enemyRef = self;
        }
      });

      this.mesh = group;
      scene.add(group);

      // Reusable allocations
      this._aabb = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
      this._toPlayer = new THREE.Vector3();
      this._botEye = new THREE.Vector3();
      this._rayDir = new THREE.Vector3();
      this._tmpVec = new THREE.Vector3();
      this._tmpVec2 = new THREE.Vector3();
      this._lastPlayerPos = new THREE.Vector3();
      this._hasLastPlayerPos = false;
      this._losRay = new THREE.Ray();
      this._losHit = new THREE.Vector3();
      // Reusable scratch for _fireProjectile so we don't alloc Vec3s per shot.
      this._fpOrigin = new THREE.Vector3();
      this._fpAim    = new THREE.Vector3();
      this._fpDir    = new THREE.Vector3();
    }

    // Cheap LOS / wall-hit test against level.colliders[] (Box3[]). Returns
    // hit distance along the ray (>=0), or -1 if no hit within `len`. Far
    // cheaper than raycasting InstancedMesh walls every frame.
    _losDistance(level, from, dir, len)
    {
      if (!level) return -1;
      if (Array.isArray(level.colliders) && level.colliders.length > 0)
      {
        this._losRay.origin.copy(from);
        this._losRay.direction.copy(dir);
        const cols = level.colliders;
        let bestSq = -1;
        for (let i = 0; i < cols.length; i++)
        {
          const hit = this._losRay.intersectBox(cols[i], this._losHit);
          if (!hit) continue;
          const dx = this._losHit.x - from.x;
          const dy = this._losHit.y - from.y;
          const dz = this._losHit.z - from.z;
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq > len * len) continue;
          if (bestSq < 0 || dSq < bestSq) bestSq = dSq;
        }
        return bestSq < 0 ? -1 : Math.sqrt(bestSq);
      }
      if (typeof level.raycastWalls === "function")
      {
        const hit = level.raycastWalls(from, dir, len);
        return (hit && hit.distance <= len) ? hit.distance : -1;
      }
      return -1;
    }

    _buildAABB(pos) {
      this._aabb.min.set(pos.x - BOT_RADIUS, pos.y, pos.z - BOT_RADIUS);
      this._aabb.max.set(pos.x + BOT_RADIUS, pos.y + BOT_HEIGHT, pos.z + BOT_RADIUS);
      return this._aabb;
    }

    update(dt, ctx) {
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
        // Let in-flight projectiles continue to update so they don't freeze in air
        this._updateProjectiles(dt, ctx);
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

      this._botEye.set(this.position.x, this.position.y + BOT_EYE_HEIGHT, this.position.z);
      this._rayDir.set(
        player.position.x - this._botEye.x,
        player.position.y - this._botEye.y,
        player.position.z - this._botEye.z
      );
      const rayLen = this._rayDir.length();
      let hasLOS = true;
      if (rayLen > 1e-4) {
        this._rayDir.multiplyScalar(1 / rayLen);
        const dHit = this._losDistance(level, this._botEye, this._rayDir, rayLen);
        if (dHit >= 0 && dHit < rayLen - 0.05) {
          hasLOS = false;
        }
      }

      // ---------------- Decide movement ----------------
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

      // ---------------- Gravity ----------------
      this.velocity.y -= BOT_GRAVITY * dt;

      // ---------------- Collision (axis-separated) ----------------
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

      // ---------------- Soft bot-vs-bot/enemy separation ----------------
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

      // ---------------- Face the player (yaw only) ----------------
      if (Math.abs(dxh) + Math.abs(dzh) > 1e-4) {
        const yaw = Math.atan2(dxh, dzh);
        this.mesh.rotation.y = yaw;
      }

      // ---------------- Walk cycle ----------------
      if (this.isMoving) {
        this.walkPhase += dt * 8;
      } else {
        this.walkPhase *= Math.max(0, 1 - dt * 6);
      }
      const swing = Math.sin(this.walkPhase) * 0.55;
      this._legL.rotation.x =  swing;
      this._legR.rotation.x = -swing;
      const armSwing = swing * 0.6;
      this._armL.rotation.x = -armSwing;
      this._armR.rotation.x =  armSwing;

      // ---------------- Melee attack ----------------
      if (this.attackCooldown > 0) {
        this.attackCooldown = Math.max(0, this.attackCooldown - dt);
      }
      if (hasLOS && horizDist < BOT_ATTACK_RANGE && this.attackCooldown <= 0 && !player.dead) {
        if (typeof player.takeDamage === "function") {
          player.takeDamage(BOT_ATTACK_DAMAGE);
        }
        this.attackCooldown = BOT_ATTACK_COOLDOWN;
      }

      // ---------------- Ranged attack ----------------
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
        // Add small jitter so a row of bots doesn't sync up
        this.fireCooldown = this._cfg.fireCooldown * (0.85 + Math.random() * 0.3);
      }

      // ---------------- Projectile updates ----------------
      this._updateProjectiles(dt, ctx);

      // Track player pos for lead estimation
      this._tmpVec.copy(player.position);
      this._lastPlayerPos.copy(this._tmpVec);
      this._hasLastPlayerPos = true;

      // ---------------- Sync mesh ----------------
      this.mesh.position.copy(this.position);
    }

    _fireProjectile(player, dt) {
      // Origin: roughly the bot's chest, slightly forward. (Reused scratch.)
      const origin = this._fpOrigin.set(
        this.position.x,
        this.position.y + 1.3,
        this.position.z
      );

      // Aim point: player center (~ eye - 0.85). (Reused scratch.)
      const aim = this._fpAim.set(
        player.position.x,
        player.position.y - 0.85,
        player.position.z
      );

      // Optional simple lead: project player velocity from last-frame delta.
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
          // Cap lead so we don't aim absurdly far ahead at low projectile speed
          const leadT = Math.min(tFlight, 0.6);
          aim.x += vx * leadT;
          aim.z += vz * leadT;
        }
      }

      const dir = this._fpDir.subVectors(aim, origin);
      const dlen = dir.length();
      if (dlen < 1e-4) return;
      dir.multiplyScalar(1 / dlen);

      const projMesh = new THREE.Mesh(PROJECTILE_GEOM, PROJECTILE_MAT);
      projMesh.position.copy(origin);
      // Mark so any future raycasts can ignore (matches weapons.js convention)
      projMesh.userData.isProjectile = true;
      this.scene.add(projMesh);

      // Optional point-light glow if it isn't too expensive
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

        // Wall hit for this step. Use cheap AABB sweep against level.colliders[]
        // instead of raycasting InstancedMesh walls every frame.
        let blocked = false;
        const wallDist = this._losDistance(level, p.pos, p.dir, stepDist + 0.1);
        if (wallDist >= 0 && wallDist <= stepDist + 0.05) {
          p.pos.x += p.dir.x * wallDist;
          p.pos.y += p.dir.y * wallDist;
          p.pos.z += p.dir.z * wallDist;
          p.mesh.position.copy(p.pos);
          this._destroyProjectile(p);
          this._projectiles.splice(i, 1);
          blocked = true;
        }
        if (blocked) continue;

        // Advance
        p.pos.x += p.dir.x * stepDist;
        p.pos.y += p.dir.y * stepDist;
        p.pos.z += p.dir.z * stepDist;
        p.mesh.position.copy(p.pos);
        p.damageBudget -= PROJ_DAMAGE * dt; // tracks "potential dps drain" (caps total at 60)

        // Player hit test
        if (player && !player.dead && !p.damaged) {
          const px = player.position.x - p.pos.x;
          // player.position.y is at eye height (~1.7); test against center
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
      // PROJECTILE_GEOM and PROJECTILE_MAT are shared — do NOT dispose them.
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
      this.fireCooldown = (this._cfg.fireCooldown || 0) * (0.4 + Math.random() * 0.4);
      this.walkPhase = 0;
      this.velocity.set(0, 0, 0);
      this.position.copy(this.spawnPos);

      for (let i = 0; i < this._allMats.length; i++) {
        const m = this._allMats[i];
        if (m && m.emissive) m.emissive.setHex(0x000000);
      }

      this.mesh.position.copy(this.position);
      this.mesh.rotation.set(0, 0, 0);
      this.mesh.visible = true;

      if (this._legL) this._legL.rotation.x = 0;
      if (this._legR) this._legR.rotation.x = 0;
      if (this._armL) this._armL.rotation.x = 0;
      if (this._armR) this._armR.rotation.x = 0;

      // Clear any in-flight projectiles
      for (let i = 0; i < this._projectiles.length; i++) {
        this._destroyProjectile(this._projectiles[i]);
      }
      this._projectiles.length = 0;
    }
  };

  // ---------- Factory ----------
  // Distribute `count` bots across `level.enemySpawns`. If count > spawns, bots
  // wrap and reuse spawn points (matching how spawnEnemies expects spawn points
  // to be safe spots). If count is omitted, one bot per spawn.
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
