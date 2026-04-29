window.Game = window.Game || {};

window.Game.Player = class {
  constructor(scene, camera, level, ui, domElement) {
    // Store references
    this.scene = scene;
    this.camera = camera;
    this.level = level;
    this.ui = ui;
    this.dom = domElement;

    // Position at spawn (eye height)
    this.position = level.spawnPoint.clone();
    this.velocity = new THREE.Vector3();

    // Stats
    this.health = 100;
    this.armor = 0;
    this.maxHealth = 100;
    this.dead = false;
    this.onGround = false;

    // View angles
    this.yaw = 0;
    this.pitch = 0;

    // Movement tuning
    this.walkSpeed = 6;
    this.sprintSpeed = 9;
    this.jumpImpulse = 8;
    this.gravity = 25;
    this.groundAccelTime = 0.08; // time to reach full speed on ground
    this.airAccelTime = 0.4;     // time to reach full speed in air
    this.mouseSensitivity = 0.0022;
    this.pitchLimit = Math.PI / 2 - 0.05;

    // Input flags (use event.code so CapsLock doesn't matter)
    this.input = {
      forward: false,
      back: false,
      left: false,
      right: false,
      jump: false,
      sprint: false
    };

    // Reusable allocations to avoid per-frame GC
    this._aabb = new THREE.Box3(
      new THREE.Vector3(),
      new THREE.Vector3()
    );
    this._desiredVel = new THREE.Vector3();
    this._tmpVec = new THREE.Vector3();

    // Maximum vertical lift the player can absorb when blocked horizontally
    // and silently "step up" onto the obstacle (stairs, low ledges, curbs).
    // 0.55 is a hair above 0.5u — comfortably clears 0.5u stair steps without
    // letting the player ghost over knee-height cover (which is sized > 0.55u).
    this._stepUp = 0.55;

    // Configure camera once
    this.camera.rotation.order = 'YXZ';
    this.camera.position.copy(this.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    // Bind handlers so we can keep references
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);
  }

  _onKeyDown(event) {
    switch (event.code) {
      case 'KeyW':       this.input.forward = true; break;
      case 'KeyS':       this.input.back    = true; break;
      case 'KeyA':       this.input.left    = true; break;
      case 'KeyD':       this.input.right   = true; break;
      case 'Space':      this.input.jump    = true; break;
      case 'ShiftLeft':
      case 'ShiftRight': this.input.sprint  = true; break;
    }
  }

  _onKeyUp(event) {
    switch (event.code) {
      case 'KeyW':       this.input.forward = false; break;
      case 'KeyS':       this.input.back    = false; break;
      case 'KeyA':       this.input.left    = false; break;
      case 'KeyD':       this.input.right   = false; break;
      case 'Space':      this.input.jump    = false; break;
      case 'ShiftLeft':
      case 'ShiftRight': this.input.sprint  = false; break;
    }
  }

  _onMouseMove(event) {
    // Only consume mouse deltas when pointer is locked
    if (!document.pointerLockElement) {
      return;
    }
    if (this.dead) {
      return;
    }
    const dx = event.movementX || 0;
    const dy = event.movementY || 0;
    this.yaw   -= dx * this.mouseSensitivity;
    this.pitch -= dy * this.mouseSensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -this.pitchLimit, this.pitchLimit);
  }

  // Build the player AABB into this._aabb at the given position.
  _buildAABB(pos) {
    this._aabb.min.set(pos.x - 0.3, pos.y - 1.7, pos.z - 0.3);
    this._aabb.max.set(pos.x + 0.3, pos.y + 0.1, pos.z + 0.3);
    return this._aabb;
  }

  update(dt, ctx) {
    // If dead, freeze movement entirely. Camera still gets a final pose.
    if (this.dead) {
      this.camera.position.copy(this.position);
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
      return;
    }

    // ----- 1. Build desired velocity in world space using yaw only -----
    // Forward is along -Z when yaw = 0. Right is along +X when yaw = 0.
    let inputZ = 0; // forward (-1) / back (+1) along view forward
    let inputX = 0; // right   (+1) / left (-1) along view right

    if (this.input.forward) inputZ += 1;
    if (this.input.back)    inputZ -= 1;
    if (this.input.right)   inputX += 1;
    if (this.input.left)    inputX -= 1;

    const targetSpeed = this.input.sprint ? this.sprintSpeed : this.walkSpeed;

    // Compute world-space horizontal direction from yaw.
    // forward vector (yaw rotation around Y): (-sin yaw, 0, -cos yaw)
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const forwardX = -sinY;
    const forwardZ = -cosY;
    // right vector: (cos yaw, 0, -sin yaw)
    const rightX = cosY;
    const rightZ = -sinY;

    let desiredX = forwardX * inputZ + rightX * inputX;
    let desiredZ = forwardZ * inputZ + rightZ * inputX;

    // Normalize the input direction so diagonals don't go faster, then scale by target speed.
    const lenSq = desiredX * desiredX + desiredZ * desiredZ;
    if (lenSq > 1e-6) {
      const inv = 1 / Math.sqrt(lenSq);
      desiredX *= inv * targetSpeed;
      desiredZ *= inv * targetSpeed;
    } else {
      desiredX = 0;
      desiredZ = 0;
    }

    // ----- 2. Accelerate horizontal velocity toward desired -----
    // Using exponential damp so movement is frame-rate independent.
    // damp(current, target, lambda, dt) -> approximates: current + (target-current)*(1 - exp(-lambda*dt))
    // Pick lambda so we reach ~63% in accelTime, ~95% in 3*accelTime.
    const accelTime = this.onGround ? this.groundAccelTime : this.airAccelTime;
    const lambda = 1 / Math.max(accelTime, 1e-4);
    this.velocity.x = THREE.MathUtils.damp(this.velocity.x, desiredX, lambda, dt);
    this.velocity.z = THREE.MathUtils.damp(this.velocity.z, desiredZ, lambda, dt);

    // ----- 3. Gravity -----
    this.velocity.y -= this.gravity * dt;

    // ----- 6. Jump (handled here so we don't double-apply gravity this frame) -----
    if (this.input.jump && this.onGround) {
      this.velocity.y = this.jumpImpulse;
      this.onGround = false;
    }

    // ----- 4. Move with collision, axis-separated -----
    const level = ctx && ctx.level ? ctx.level : this.level;

    // Step-up: when an axis-separated horizontal move is blocked by a collider
    // shorter than this._stepUp above the player's feet, lift the player up by
    // _stepUp, retest the AABB, and if the lifted box is no longer pushed back
    // on this axis (and has clear headroom) keep the lift instead of stopping.
    // This lets the player walk smoothly up stairs and small curbs without
    // jumping, while taller obstacles still block as before.
    const STEP_UP = this._stepUp;
    const STEP_EPS = 0.01;
    let stepped = false;

    // X axis
    this.position.x += this.velocity.x * dt;
    if (level && typeof level.resolveAABB === 'function') {
      this._buildAABB(this.position);
      const pushX = level.resolveAABB(this._aabb);
      if (pushX && pushX.x !== 0) {
        // Try a step-up before falling back to "blocked, zero velocity".
        const savedY = this.position.y;
        this.position.y = savedY + STEP_UP;
        this._buildAABB(this.position);
        const liftedPush = level.resolveAABB(this._aabb);
        if (liftedPush && Math.abs(liftedPush.x) < STEP_EPS && liftedPush.y <= 0) {
          // Headroom is clear AND we no longer collide horizontally on X.
          // Accept the lift: keep raised position and velocity.
          stepped = true;
        } else {
          // Still blocked or no headroom — revert lift and apply original push.
          this.position.y = savedY;
          this.position.x += pushX.x;
          this.velocity.x = 0;
        }
      }
    }

    // Z axis
    this.position.z += this.velocity.z * dt;
    if (level && typeof level.resolveAABB === 'function') {
      this._buildAABB(this.position);
      const pushZ = level.resolveAABB(this._aabb);
      if (pushZ && pushZ.z !== 0) {
        const savedY = this.position.y;
        this.position.y = savedY + STEP_UP;
        this._buildAABB(this.position);
        const liftedPush = level.resolveAABB(this._aabb);
        if (liftedPush && Math.abs(liftedPush.z) < STEP_EPS && liftedPush.y <= 0) {
          stepped = true;
        } else {
          this.position.y = savedY;
          this.position.z += pushZ.z;
          this.velocity.z = 0;
        }
      }
    }

    // Y axis
    this.position.y += this.velocity.y * dt;
    // If we stepped up this frame the player is effectively standing on the
    // higher surface — start grounded so the Y-axis push from the step block
    // (which usually fires on the next frame anyway) doesn't briefly clear it.
    let landed = stepped;
    if (level && typeof level.resolveAABB === 'function') {
      this._buildAABB(this.position);
      const pushY = level.resolveAABB(this._aabb);
      if (pushY && pushY.y !== 0) {
        this.position.y += pushY.y;
        if (pushY.y > 0) {
          // pushed up -> we hit a floor / ledge from above -> grounded
          landed = true;
        }
        this.velocity.y = 0;
      }
    }
    this.onGround = landed;

    // ----- 5. Hard floor safety net -----
    if (this.position.y < 1.7) {
      this.position.y = 1.7;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onGround = true;
    }

    // ----- 9. Out-of-world (void) -----
    if (this.position.y < -50) {
      this.takeDamage(9999);
      // even after damage, snap camera so we don't render junk
      this.camera.position.copy(this.position);
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
      return;
    }

    // ----- 8. Sync camera to head -----
    this.camera.position.copy(this.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  takeDamage(amount) {
    if (this.dead) return;
    if (!(amount > 0)) return;

    // Armor absorbs 50% of the incoming damage, up to current armor pool.
    const absorbed = Math.min(amount * 0.5, this.armor);
    this.armor -= absorbed;
    amount -= absorbed;

    this.health -= amount;

    // Red flash; intensity scales mildly with damage
    if (this.ui && typeof this.ui.flash === 'function') {
      this.ui.flash(0.4 + Math.min(0.4, amount / 100));
    }
    if (this.ui && typeof this.ui.setHealth === 'function') {
      this.ui.setHealth(Math.max(0, this.health));
    }
    if (this.ui && typeof this.ui.setArmor === 'function') {
      this.ui.setArmor(Math.max(0, this.armor));
    }

    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      // freeze movement input
      this.input.forward = false;
      this.input.back = false;
      this.input.left = false;
      this.input.right = false;
      this.input.jump = false;
      this.input.sprint = false;
      this.velocity.set(0, 0, 0);
      if (this.ui && typeof this.ui.message === 'function') {
        this.ui.message('YOU ARE DEAD — PRESS R TO RESPAWN', 0);
      }
    }
  }

  respawn(level) {
    if (level) {
      this.level = level;
    }
    const lvl = this.level;

    this.health = this.maxHealth;
    this.armor = 0;
    this.dead = false;
    this.onGround = false;
    this.velocity.set(0, 0, 0);

    if (lvl && lvl.spawnPoint) {
      this.position.copy(lvl.spawnPoint);
    }

    // Reset HUD
    if (this.ui) {
      if (typeof this.ui.setHealth === 'function') this.ui.setHealth(this.health);
      if (typeof this.ui.setArmor === 'function')  this.ui.setArmor(this.armor);
      if (typeof this.ui.message === 'function')   this.ui.message('', 1);
    }

    // Snap camera to new spawn immediately
    this.camera.position.copy(this.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
};
