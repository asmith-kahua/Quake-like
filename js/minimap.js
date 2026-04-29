// Game.Minimap - top-down 2D overlay rendered to a 220x220 canvas pinned at
// the top-right of the viewport. Cheap: clears + redraws each frame using
// only stack-allocated locals (no per-frame object/array allocation).
//
// Public API:
//   const mm = new Game.Minimap(level);
//   mm.attachTo(document.body);
//   mm.update(player, enemies, { remotePlayers, exitTrigger, pickups });
//   mm.setLevel(newLevel);
//   mm.show() / mm.hide() / mm.toggle();
//
// Visibility toggles with the 'M' key (KeyM). Default visible.

window.Game = window.Game || {};

window.Game.Minimap = class
{
  constructor(level)
  {
    // ---- canvas / DOM ----
    this.size = 220;
    this.padding = 6;
    this.visible = true;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    this.canvas.id = 'gameMinimap';

    const s = this.canvas.style;
    s.position = 'fixed';
    s.top = '12px';
    s.right = '12px';
    s.width = this.size + 'px';
    s.height = this.size + 'px';
    s.background = 'rgba(12, 10, 8, 0.55)';
    s.border = '1px solid #d8b070';
    s.boxShadow = '0 0 8px rgba(216, 176, 112, 0.25)';
    s.imageRendering = 'pixelated';
    s.pointerEvents = 'none';
    s.zIndex = '50';

    this.ctx = this.canvas.getContext('2d');

    // ---- world->canvas transform (recomputed on setLevel) ----
    this._scale = 1;          // pixels per world unit
    this._minX = -50;         // world x at left edge of usable area
    this._minZ = -50;         // world z at top edge
    this._offsetX = 0;        // canvas x where world _minX lands
    this._offsetY = 0;        // canvas y where world _minZ lands

    // ---- pulse animation timer (for engaged enemies) ----
    this._t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    // ---- key handler bound once, no per-frame allocation ----
    this._onKeyDown = (e) => {
      if (e.code === 'KeyM' || e.key === 'm' || e.key === 'M')
      {
        this.toggle();
      }
    };
    window.addEventListener('keydown', this._onKeyDown);

    this.setLevel(level);
  }

  // ---------------------------------------------------------------------------
  // Level swap / world->canvas transform
  // ---------------------------------------------------------------------------
  setLevel(level)
  {
    this.level = level || null;
    this._recomputeTransform();
  }

  _recomputeTransform()
  {
    let minX = 0, maxX = 0, minZ = 0, maxZ = 0;
    let have = false;

    const lvl = this.level;
    if (lvl)
    {
      const b = lvl.bounds;
      if (b && b.min && b.max && (b.max.x - b.min.x) > 0.001 && (b.max.z - b.min.z) > 0.001)
      {
        minX = b.min.x; maxX = b.max.x;
        minZ = b.min.z; maxZ = b.max.z;
        have = true;
      }
      else if (lvl.colliders && lvl.colliders.length > 0)
      {
        const cs = lvl.colliders;
        const c0 = cs[0];
        minX = c0.min.x; maxX = c0.max.x;
        minZ = c0.min.z; maxZ = c0.max.z;
        for (let i = 1; i < cs.length; i++)
        {
          const c = cs[i];
          if (c.min.x < minX) minX = c.min.x;
          if (c.max.x > maxX) maxX = c.max.x;
          if (c.min.z < minZ) minZ = c.min.z;
          if (c.max.z > maxZ) maxZ = c.max.z;
        }
        have = true;
      }
    }

    if (!have)
    {
      minX = -50; maxX = 50; minZ = -50; maxZ = 50;
    }

    const inner = this.size - this.padding * 2;
    const wx = Math.max(0.001, maxX - minX);
    const wz = Math.max(0.001, maxZ - minZ);

    // Aspect-preserving fit, then center.
    const scale = Math.min(inner / wx, inner / wz);
    const drawnW = wx * scale;
    const drawnH = wz * scale;

    this._scale = scale;
    this._minX = minX;
    this._minZ = minZ;
    this._offsetX = this.padding + (inner - drawnW) * 0.5;
    this._offsetY = this.padding + (inner - drawnH) * 0.5;
  }

  // World -> canvas helpers (no allocation; callers use the scalar results)
  _wx(worldX) { return this._offsetX + (worldX - this._minX) * this._scale; }
  _wy(worldZ) { return this._offsetY + (worldZ - this._minZ) * this._scale; }

  // ---------------------------------------------------------------------------
  // DOM mounting / visibility
  // ---------------------------------------------------------------------------
  attachTo(parentEl)
  {
    if (!parentEl) parentEl = document.body;
    if (this.canvas.parentNode !== parentEl)
    {
      parentEl.appendChild(this.canvas);
    }
  }

  show()
  {
    this.visible = true;
    this.canvas.style.display = 'block';
  }

  hide()
  {
    this.visible = false;
    this.canvas.style.display = 'none';
  }

  toggle()
  {
    if (this.visible) this.hide();
    else this.show();
  }

  dispose()
  {
    window.removeEventListener('keydown', this._onKeyDown);
    if (this.canvas.parentNode)
    {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame redraw
  // ---------------------------------------------------------------------------
  update(player, enemies, opts)
  {
    if (!this.visible) return;

    const ctx = this.ctx;
    const size = this.size;

    // Clear
    ctx.clearRect(0, 0, size, size);

    // Background tint (slightly darker than the CSS background to give walls contrast)
    ctx.fillStyle = 'rgba(20, 16, 12, 0.55)';
    ctx.fillRect(0, 0, size, size);

    const lvl = this.level;
    if (!lvl)
    {
      this._drawFrame();
      return;
    }

    // ---- Walls ----
    const cs = lvl.colliders;
    if (cs && cs.length > 0)
    {
      ctx.fillStyle = '#7a6850';
      ctx.strokeStyle = '#3a3024';
      ctx.lineWidth = 1;

      for (let i = 0; i < cs.length; i++)
      {
        const c = cs[i];
        const x0 = this._wx(c.min.x);
        const y0 = this._wy(c.min.z);
        const w  = (c.max.x - c.min.x) * this._scale;
        const h  = (c.max.z - c.min.z) * this._scale;
        if (w < 1 && h < 1) continue;
        ctx.fillRect(x0, y0, w, h);
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
      }
    }

    // ---- Exit pad ----
    const exit = (opts && opts.exitTrigger) || lvl.exitTrigger;
    if (exit && exit.min && exit.max)
    {
      const ex = this._wx(exit.min.x);
      const ey = this._wy(exit.min.z);
      const ew = (exit.max.x - exit.min.x) * this._scale;
      const eh = (exit.max.z - exit.min.z) * this._scale;
      // Glow ring
      ctx.strokeStyle = 'rgba(0, 220, 240, 0.55)';
      ctx.lineWidth = 3;
      ctx.strokeRect(ex - 1.5, ey - 1.5, ew + 3, eh + 3);
      // Solid pad
      ctx.fillStyle = '#22e0ff';
      ctx.fillRect(ex, ey, ew, eh);
      ctx.strokeStyle = '#0a6a78';
      ctx.lineWidth = 1;
      ctx.strokeRect(ex + 0.5, ey + 0.5, ew, eh);
    }

    // ---- Health pickups ----
    const hps = lvl.healthPickups;
    if (hps && hps.length > 0)
    {
      ctx.fillStyle = '#3ce070';
      ctx.strokeStyle = '#0c4020';
      ctx.lineWidth = 1;
      for (let i = 0; i < hps.length; i++)
      {
        const p = hps[i];
        if (!p || p.picked) continue;
        const pos = p.position || (p.mesh && p.mesh.position);
        if (!pos) continue;
        const cx = this._wx(pos.x);
        const cy = this._wy(pos.z);
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // ---- Rocket pickup ----
    const rp = lvl.rocketPickup;
    if (rp && !rp.picked)
    {
      const pos = rp.position || (rp.mesh && rp.mesh.position);
      if (pos)
      {
        const cx = this._wx(pos.x);
        const cy = this._wy(pos.z);
        const r = 4;
        ctx.fillStyle = '#ff8a1c';
        ctx.strokeStyle = '#5a2a08';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy + r);
        ctx.lineTo(cx - r, cy + r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // Generic pickups (optional opts.pickups: [{x,z,color?}])
    const extraPickups = opts && opts.pickups;
    if (extraPickups && extraPickups.length)
    {
      for (let i = 0; i < extraPickups.length; i++)
      {
        const p = extraPickups[i];
        if (!p) continue;
        ctx.fillStyle = p.color || '#bcd8ff';
        ctx.beginPath();
        ctx.arc(this._wx(p.x), this._wy(p.z), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- Enemies ----
    if (enemies && enemies.length > 0)
    {
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      const pulse = 0.5 + 0.5 * Math.sin((now - this._t0) * 0.008);

      const px = (player && player.position) ? player.position.x : 0;
      const pz = (player && player.position) ? player.position.z : 0;
      const engageR2 = 8 * 8;

      for (let i = 0; i < enemies.length; i++)
      {
        const e = enemies[i];
        if (!e) continue;
        const alive = (e.alive !== undefined) ? e.alive : !e._dead;
        if (!alive) continue;
        const ep = e.position || (e.mesh && e.mesh.position);
        if (!ep) continue;

        const cx = this._wx(ep.x);
        const cy = this._wy(ep.z);

        const dx = ep.x - px;
        const dz = ep.z - pz;
        const engaged = (dx * dx + dz * dz) <= engageR2;

        if (engaged)
        {
          const ringR = 5 + pulse * 3;
          ctx.strokeStyle = 'rgba(255, 60, 60, ' + (0.35 + 0.45 * (1 - pulse)) + ')';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.fillStyle = '#ff3434';
        ctx.strokeStyle = '#400808';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // ---- Remote players ----
    const remotes = opts && opts.remotePlayers;
    if (remotes && remotes.length > 0)
    {
      for (let i = 0; i < remotes.length; i++)
      {
        const r = remotes[i];
        if (!r) continue;
        const cx = this._wx(r.x);
        const cy = this._wy(r.z);
        ctx.fillStyle = r.color || '#ffffff';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // ---- Local player (yellow arrow) ----
    if (player && player.position)
    {
      const cx = this._wx(player.position.x);
      const cy = this._wy(player.position.z);
      // Game forward at yaw=0 is -Z (up on minimap). Canvas y grows downward,
      // and world->canvas Z mapping preserves orientation, so to point to -Z
      // we draw upward (negative canvas y).
      const yaw = (typeof player.yaw === 'number') ? player.yaw : 0;
      // Forward vector in world XZ at this yaw: (-sin yaw, -cos yaw)
      // Map to canvas: dx_canvas = -sin(yaw), dy_canvas = -cos(yaw) (z->y identity)
      const fx = -Math.sin(yaw);
      const fy = -Math.cos(yaw);
      // Right vector (perpendicular, +90deg in canvas): (-fy, fx)
      const rx = -fy;
      const ry = fx;

      const tipLen = 7;
      const baseLen = 4;
      const baseHalfW = 3.5;

      const tipX = cx + fx * tipLen;
      const tipY = cy + fy * tipLen;
      const baseCX = cx - fx * baseLen * 0.25;
      const baseCY = cy - fy * baseLen * 0.25;
      const blX = baseCX + rx * baseHalfW - fx * baseLen * 0.5;
      const blY = baseCY + ry * baseHalfW - fy * baseLen * 0.5;
      const brX = baseCX - rx * baseHalfW - fx * baseLen * 0.5;
      const brY = baseCY - ry * baseHalfW - fy * baseLen * 0.5;

      ctx.fillStyle = '#ffe24a';
      ctx.strokeStyle = '#3a2a00';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(blX, blY);
      ctx.lineTo(brX, brY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    this._drawFrame();
  }

  _drawFrame()
  {
    // Inner border tint (CSS already draws the outer 1px amber border)
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(216, 176, 112, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, this.size - 1, this.size - 1);
  }
};
