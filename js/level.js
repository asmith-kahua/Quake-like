// Game.Level - builds one of 5 procedurally-laid-out maps and exposes
// collision + raycast helpers used by player, enemies and weapon modules.
//
// API contract (relied upon by other modules):
//   level.colliders         : THREE.Box3[]   - solid AABBs (walls, pillars, platform). No floor.
//   level.collidableMeshes  : THREE.Mesh[]   - meshes for bullet raycasts (walls + ceil + floor + pillars + platform).
//   level.spawnPoint        : THREE.Vector3  - player eye spawn (y=1.7).
//   level.enemySpawns       : THREE.Vector3[]- foot positions for enemies (y=1.0).
//   level.bounds            : THREE.Box3     - overall map bounds.
//   level.resolveAABB(box)  : THREE.Vector3  - minimum translation push-out summed over overlaps.
//   level.resolveAABBAxis(box, axis) : scalar push-out along one axis
//   level.raycastWalls(o,d,maxDist) : { point, distance, normal, mesh } | null
//   level.raycastColliders(o,d,maxDist) : { point, distance, normal, mesh:null } | null
//                                          (FAST Box3 sweep - preferred for
//                                          bullets, projectiles, AI line-of-sight)
//
//   level.levelIndex        : 0..4
//   level.levelName         : string
//   level.exitTrigger       : THREE.Box3   - step here to advance
//   level.exitMesh          : THREE.Mesh   - emissive cyan slab visible at trigger
//   level.rocketPickup      : { position, mesh, picked } | null  (level 0 only)
//   level.healthPickups     : [{ position, mesh, picked, amount }]
//   level.dispose()         : remove from scene + free GPU resources
//
// PERF NOTE (perf/level branch):
//   * Walls / floors / ceilings / pillars / trim are batched into a tiny set
//     of THREE.InstancedMesh objects (one per material). Each renders in a
//     single draw call regardless of instance count.
//   * Visible surfaces are PlaneGeometry (2 tris) instead of BoxGeometry
//     (12 tris). Pillars/trim slabs emit one plane per visible face.
//   * MeshPhongMaterial replaces MeshStandardMaterial (cheaper than PBR).
//     A per-material normal + specular map is generated procedurally from
//     the diffuse stone canvas.
//   * Per-level PointLight count capped to 6 (was up to ~14). Ambient and
//     Hemisphere intensities raised to compensate.

window.Game = window.Game || {};

window.Game.Level = class
{
  constructor(scene, levelIndex = 0)
  {
    this.scene = scene;
    this.levelIndex = (levelIndex | 0);
    if (this.levelIndex < 0) this.levelIndex = 0;
    if (this.levelIndex > 4) this.levelIndex = 4;

    // Public collections
    this.colliders = [];
    this.collidableMeshes = [];
    this.enemySpawns = [];
    this.healthPickups = [];
    this.rocketPickup = null;
    this.exitTrigger = null;
    this.exitMesh = null;

    // Reusable scratch objects to avoid allocations in hot paths
    this._scratchVec = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
    // Scratch state for raycastColliders (Box3-sweep). Pre-allocated so the
    // hot path performs zero allocations beyond cloning the returned hit.
    this._rcRay     = new THREE.Ray();
    this._rcDir     = new THREE.Vector3();
    this._rcHit     = new THREE.Vector3();
    this._rcBest    = new THREE.Vector3();
    this._rcNormal  = new THREE.Vector3();
    this._ownedTextures = [];
    this._ownedMaterials = [];
    this._ownedGeometries = [];
    this._ownedInstancedMeshes = [];

    // Root group
    this.root = new THREE.Group();
    this.root.name = 'Level' + this.levelIndex;
    scene.add(this.root);

    // Per-level palette tweaks (slight hue shift per level for atmosphere)
    const palette = this._paletteForLevel(this.levelIndex);
    this._textures = this._buildTextures(palette);
    this._materials = this._buildMaterials(this._textures, palette);

    // Per-instanced-material plane queues. After all builders run we pack
    // them into one InstancedMesh per material in _finalizeInstances().
    this._instanceQueues = {
      wall:  [],
      floor: [],
      ceil:  [],
      trim:  [],
    };

    // Default spawn (overridden by builders if desired)
    this.spawnPoint = new THREE.Vector3(0, 1.7, 0);
    this.levelName = 'UNNAMED';

    // Build the chosen level
    switch (this.levelIndex)
    {
      case 0: this._buildLevel0(); break;
      case 1: this._buildLevel1(); break;
      case 2: this._buildLevel2(); break;
      case 3: this._buildLevel3(); break;
      case 4: this._buildLevel4(); break;
    }

    // Pack queued plane instances into per-material InstancedMesh objects.
    this._finalizeInstances();

    // Compute overall bounds from the colliders.
    const bounds = new THREE.Box3();
    if (this.colliders.length > 0)
    {
      bounds.copy(this.colliders[0]);
      for (let i = 1; i < this.colliders.length; i++)
      {
        bounds.union(this.colliders[i]);
      }
    }
    else
    {
      bounds.set(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 10, 50));
    }
    bounds.min.y = 0;
    this.bounds = bounds;
  }

  // ---------------------------------------------------------------------------
  // Palette / textures / materials
  // ---------------------------------------------------------------------------

  _paletteForLevel(idx)
  {
    // Each palette: wall base/dark, floor base/dark, trim base/dark, ceil base/dark,
    // material color tints, torch color, ambient color, hemi sky/ground.
    const palettes = [
      // 0: SLIPGATE COMPLEX - cool grey/brown stone
      {
        wall:  [[70, 60, 50],  [40, 32, 26]],
        floor: [[95, 85, 72],  [55, 48, 40]],
        trim:  [[45, 38, 32],  [22, 18, 15]],
        ceil:  [[40, 35, 30],  [22, 18, 15]],
        wallTint:  0xa49080,
        floorTint: 0xb8a890,
        ceilTint:  0x6a5e54,
        trimTint:  0x5a4a3a,
        torchColor: 0xff7733,
        torchEmissive: 0xffaa55,
        ambient: 0x2a2620,
        hemiSky: 0x404858,
        hemiGround: 0x1a1612,
      },
      // 1: ARMORY - cooler/bluer steel
      {
        wall:  [[60, 64, 72],  [30, 34, 40]],
        floor: [[80, 84, 92],  [42, 46, 52]],
        trim:  [[40, 44, 52],  [18, 22, 28]],
        ceil:  [[35, 38, 44],  [18, 22, 26]],
        wallTint:  0x90a0b0,
        floorTint: 0xa0b0c0,
        ceilTint:  0x586068,
        trimTint:  0x404858,
        torchColor: 0xffaa55,
        torchEmissive: 0xffd088,
        ambient: 0x252a30,
        hemiSky: 0x506070,
        hemiGround: 0x18181c,
      },
      // 2: DEEP HALLS - greenish damp stone
      {
        wall:  [[58, 64, 54],  [30, 36, 28]],
        floor: [[80, 86, 70],  [44, 50, 38]],
        trim:  [[42, 48, 38],  [20, 24, 18]],
        ceil:  [[34, 40, 32],  [18, 22, 16]],
        wallTint:  0x98a888,
        floorTint: 0xa8b898,
        ceilTint:  0x586458,
        trimTint:  0x485040,
        torchColor: 0xffcc55,
        torchEmissive: 0xffe088,
        ambient: 0x202824,
        hemiSky: 0x405048,
        hemiGround: 0x161812,
      },
      // 3: PALACE OF FIRE - reddish/orange tinted stone
      {
        wall:  [[88, 56, 42],  [54, 30, 22]],
        floor: [[110, 72, 52], [70, 42, 30]],
        trim:  [[60, 30, 22],  [32, 14, 10]],
        ceil:  [[50, 30, 22],  [28, 16, 12]],
        wallTint:  0xc88060,
        floorTint: 0xd0a070,
        ceilTint:  0x603830,
        trimTint:  0x703828,
        torchColor: 0xff5520,
        torchEmissive: 0xff8030,
        ambient: 0x352018,
        hemiSky: 0x60281a,
        hemiGround: 0x1a0a06,
      },
      // 4: THE SLAUGHTERHOUSE - dark steel with rust-red trim
      {
        wall:  [[58, 56, 60],  [28, 26, 30]],
        floor: [[72, 70, 76],  [38, 36, 40]],
        trim:  [[78, 38, 28],  [40, 18, 12]],
        ceil:  [[34, 32, 36],  [16, 16, 18]],
        wallTint:  0x8090a0,
        floorTint: 0x9098a4,
        ceilTint:  0x484850,
        trimTint:  0xa05030,
        torchColor: 0xff6644,
        torchEmissive: 0xff9966,
        ambient: 0x2a2428,
        hemiSky: 0x404858,
        hemiGround: 0x14100e,
      },
    ];
    return palettes[idx];
  }

  _buildTextures(p)
  {
    // Generate diffuse + procedural normal + procedural spec for each
    // surface type. All canvases are kept around (anchored on textures via
    // CanvasTexture.image). Computing normal/spec maps from the diffuse is
    // a one-time cost per level.
    // 256px canvases (was 128) so floors/long walls survive aggressive
    // mipmap minification at oblique view angles. Anisotropy 16 (was 4)
    // sharpens the streaking that shows when the camera looks down a long
    // floor — modern GPUs all support 16x at no real cost.
    const wallSet  = this._buildTextureSet(256, p.wall[0],  p.wall[1],  0.55);
    const floorSet = this._buildTextureSet(256, p.floor[0], p.floor[1], 0.45);
    const trimSet  = this._buildTextureSet(256, p.trim[0],  p.trim[1],  0.65);
    const ceilSet  = this._buildTextureSet(256, p.ceil[0],  p.ceil[1],  0.55);

    const all = [
      wallSet.map, wallSet.normalMap, wallSet.specularMap,
      floorSet.map, floorSet.normalMap, floorSet.specularMap,
      trimSet.map, trimSet.normalMap, trimSet.specularMap,
      ceilSet.map, ceilSet.normalMap, ceilSet.specularMap,
    ];
    all.forEach(t =>
    {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      // We rely on a per-instance UV scaling shader hook (see _patchPhongShader),
      // so the texture's own .repeat stays at (1,1).
      t.repeat.set(1, 1);
      t.anisotropy = 16;
      this._ownedTextures.push(t);
    });

    return {
      wall:  wallSet,
      floor: floorSet,
      trim:  trimSet,
      ceil:  ceilSet,
    };
  }

  _buildTextureSet(size, baseRGB, darkRGB, noiseAmount)
  {
    const diffuseCanvas = this._makeStoneCanvas(size, baseRGB, darkRGB, noiseAmount);
    const normalCanvas  = this._makeNormalFromCanvas(diffuseCanvas);
    const specCanvas    = this._makeSpecFromCanvas(diffuseCanvas);

    return {
      map:         new THREE.CanvasTexture(diffuseCanvas),
      normalMap:   new THREE.CanvasTexture(normalCanvas),
      specularMap: new THREE.CanvasTexture(specCanvas),
    };
  }

  _makeStoneCanvas(size, baseRGB, darkRGB, noiseAmount)
  {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = `rgb(${baseRGB[0]},${baseRGB[1]},${baseRGB[2]})`;
    ctx.fillRect(0, 0, size, size);

    const img = ctx.getImageData(0, 0, size, size);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4)
    {
      const n = (Math.random() - 0.5) * 2 * noiseAmount;
      data[i  ] = Math.max(0, Math.min(255, data[i  ] + n * (baseRGB[0] - darkRGB[0])));
      data[i+1] = Math.max(0, Math.min(255, data[i+1] + n * (baseRGB[1] - darkRGB[1])));
      data[i+2] = Math.max(0, Math.min(255, data[i+2] + n * (baseRGB[2] - darkRGB[2])));
    }
    ctx.putImageData(img, 0, 0);

    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 14; i++)
    {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 4 + Math.random() * 12;
      ctx.fillStyle = `rgb(${darkRGB[0]},${darkRGB[1]},${darkRGB[2]})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = `rgb(${Math.floor(darkRGB[0]*0.6)},${Math.floor(darkRGB[1]*0.6)},${Math.floor(darkRGB[2]*0.6)})`;
    ctx.lineWidth = 1;
    const cols = 4;
    const rows = 4;
    const cw = size / cols;
    const rh = size / rows;
    for (let r = 0; r < rows; r++)
    {
      const offset = (r % 2 === 0) ? 0 : cw * 0.5;
      ctx.beginPath();
      ctx.moveTo(0, r * rh);
      ctx.lineTo(size, r * rh);
      ctx.stroke();
      for (let c = 0; c <= cols; c++)
      {
        const x = (c * cw + offset) % size;
        ctx.beginPath();
        ctx.moveTo(x, r * rh);
        ctx.lineTo(x, (r + 1) * rh);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    return canvas;
  }

  // 3x3 Sobel filter on luminance to produce a tangent-space normal map.
  // dx and dy are encoded as RGB: r = (dx+1)/2, g = (dy+1)/2, b = 1.
  // Mortar lines (the dark seams) translate to crisp creases in the normal
  // map, which gives the surface a tactile bumpy feel under torchlight.
  _makeNormalFromCanvas(srcCanvas)
  {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const srcCtx = srcCanvas.getContext('2d');
    const src = srcCtx.getImageData(0, 0, w, h).data;

    // Build a luminance buffer once for fast reuse.
    const lum = new Float32Array(w * h);
    for (let i = 0, j = 0; i < src.length; i += 4, j++)
    {
      // Rec.601-ish luminance (cheap)
      lum[j] = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
    }

    const out = new Uint8ClampedArray(w * h * 4);
    const STRENGTH = 2.5; // amplifies bumpiness; tuned to read well at torch range
    for (let y = 0; y < h; y++)
    {
      const ym = (y - 1 + h) % h;
      const yp = (y + 1) % h;
      for (let x = 0; x < w; x++)
      {
        const xm = (x - 1 + w) % w;
        const xp = (x + 1) % w;

        const tl = lum[ym * w + xm];
        const tc = lum[ym * w + x ];
        const tr = lum[ym * w + xp];
        const ml = lum[y  * w + xm];
        const mr = lum[y  * w + xp];
        const bl = lum[yp * w + xm];
        const bc = lum[yp * w + x ];
        const br = lum[yp * w + xp];

        // Sobel
        const dx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const dy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);

        // Compose normal: invert dx/dy then normalize.
        let nx = -dx * STRENGTH;
        let ny = -dy * STRENGTH;
        let nz = 1.0;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len; ny /= len; nz /= len;

        const idx = (y * w + x) * 4;
        out[idx    ] = Math.round((nx * 0.5 + 0.5) * 255);
        out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        out[idx + 3] = 255;
      }
    }

    const dst = document.createElement('canvas');
    dst.width = w; dst.height = h;
    const dstCtx = dst.getContext('2d');
    const imgData = dstCtx.createImageData(w, h);
    imgData.data.set(out);
    dstCtx.putImageData(imgData, 0, 0);
    return dst;
  }

  // Specular map: brighter where mortar (dark seams in diffuse) lives, dimmer
  // on stone face. Produces subtle highlights along grout lines, a classic
  // wet-stone look under point lights.
  _makeSpecFromCanvas(srcCanvas)
  {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const srcCtx = srcCanvas.getContext('2d');
    const src = srcCtx.getImageData(0, 0, w, h).data;

    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < src.length; i += 4)
    {
      const lum = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
      // Invert + remap so darkest (mortar) -> 0.75, lightest (face) -> 0.15
      const inv = 1 - lum;
      const s = 0.15 + Math.max(0, Math.min(1, (inv - 0.2) / 0.6)) * 0.6;
      const v = Math.round(s * 255);
      out[i    ] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }

    const dst = document.createElement('canvas');
    dst.width = w; dst.height = h;
    const dstCtx = dst.getContext('2d');
    const imgData = dstCtx.createImageData(w, h);
    imgData.data.set(out);
    dstCtx.putImageData(imgData, 0, 0);
    return dst;
  }

  _buildMaterials(tex, p)
  {
    // MeshPhongMaterial replaces MeshStandardMaterial. Phong is a fragment-cheap
    // Blinn-Phong shader vs StandardMaterial's full PBR roughness/metalness.
    // Phong supports normalMap + specularMap natively. shininess + specular
    // tint give us the highlight character.
    const wall  = new THREE.MeshPhongMaterial({
      map: tex.wall.map,
      normalMap: tex.wall.normalMap,
      specularMap: tex.wall.specularMap,
      color: p.wallTint,
      shininess: 18,
      specular: 0x665544,
    });
    const floor = new THREE.MeshPhongMaterial({
      map: tex.floor.map,
      normalMap: tex.floor.normalMap,
      specularMap: tex.floor.specularMap,
      color: p.floorTint,
      shininess: 22,
      specular: 0x554433,
    });
    const ceil  = new THREE.MeshPhongMaterial({
      map: tex.ceil.map,
      normalMap: tex.ceil.normalMap,
      specularMap: tex.ceil.specularMap,
      color: p.ceilTint,
      shininess: 8,
      specular: 0x222222,
    });
    const trim  = new THREE.MeshPhongMaterial({
      map: tex.trim.map,
      normalMap: tex.trim.normalMap,
      specularMap: tex.trim.specularMap,
      color: p.trimTint,
      shininess: 35,
      specular: 0x887766,
    });

    // Patch each so that per-instance UVs scale with the instance's local
    // dimensions — texels then tile at a consistent world-space rate
    // regardless of plane size.
    [wall, floor, ceil, trim].forEach(m => this._patchPhongShader(m));

    const torchEmissive  = new THREE.MeshBasicMaterial({ color: p.torchEmissive });
    const exitEmissive   = new THREE.MeshBasicMaterial({ color: 0x55ffff });
    const healthEmissive = new THREE.MeshBasicMaterial({ color: 0x33ff66 });
    const rocketBody     = new THREE.MeshBasicMaterial({ color: 0xff7722 });
    const rocketTip      = new THREE.MeshBasicMaterial({ color: 0xffaa44 });
    const rocketPedestal = new THREE.MeshPhongMaterial({ color: 0x444444, shininess: 25, specular: 0x222222 });

    const mats = { wall, floor, ceil, trim, torchEmissive, exitEmissive, healthEmissive, rocketBody, rocketTip, rocketPedestal };
    for (const k in mats) this._ownedMaterials.push(mats[k]);

    // Keep palette torch color around for lights
    mats._torchColor = p.torchColor;
    mats._ambient = p.ambient;
    mats._hemiSky = p.hemiSky;
    mats._hemiGround = p.hemiGround;

    return mats;
  }

  // Inject per-instance UV scaling. Each instance carries a `vec2` attribute
  // `instanceUVScale` that multiplies the source UV. Combined with
  // RepeatWrapping textures, this gives "tile per world unit" across all
  // instances regardless of their world-space size.
  _patchPhongShader(material)
  {
    material.onBeforeCompile = (shader) =>
    {
      shader.vertexShader = 'attribute vec2 instanceUVScale;\n' + shader.vertexShader;
      // <uv_vertex> in r128 sets vUv from `uv`. Replace it so the UV is
      // multiplied by the per-instance scale before any uvTransform.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        [
          '#ifdef USE_UV',
          '  vUv = ( uvTransform * vec3( uv * instanceUVScale, 1 ) ).xy;',
          '#endif',
        ].join('\n'),
      );
    };
    // r128: ensure the material recompiles since onBeforeCompile changed.
    material.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Surface emission - planes are queued, packed into InstancedMesh later
  // ---------------------------------------------------------------------------

  // Map a material to its instance-queue key, or null if the material isn't
  // batched (e.g. emissive markers stay as plain meshes).
  _queueKeyForMaterial(material)
  {
    const m = this._materials;
    if (material === m.wall)  return 'wall';
    if (material === m.floor) return 'floor';
    if (material === m.ceil)  return 'ceil';
    if (material === m.trim)  return 'trim';
    return null;
  }

  // Add one plane instance to the queue.
  // pos: world-space center of plane.
  // quat: orientation (PlaneGeometry default is +Z normal).
  // uSize/vSize: world-space dimensions (also used as UV scale = "tiles per
  //              world unit" feeds directly because base texture is 1m^2).
  _emitPlane(material, pos, quat, uSize, vSize)
  {
    const key = this._queueKeyForMaterial(material);
    if (key == null) return;
    this._instanceQueues[key].push({
      pos: pos.clone(),
      quat: quat.clone(),
      uSize: uSize,
      vSize: vSize,
    });
  }

  // Emit the visible faces of an axis-aligned box. `faceMask` selects which
  // faces to emit. Bits: +X=1, -X=2, +Y=4, -Y=8, +Z=16, -Z=32. 63 = all faces.
  _emitBoxFaces(cx, cy, cz, sx, sy, sz, material, faceMask)
  {
    const halfSx = sx * 0.5, halfSy = sy * 0.5, halfSz = sz * 0.5;
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const euler = new THREE.Euler();

    // Detect the "big axis" — the axis whose +/- faces are the strictly
    // largest pair on this box. We extend ONLY the big-axis faces (in both
    // in-plane directions) by the perpendicular box thickness so 270deg
    // corner pockets between adjacent walls/floor edges are filled.
    // Cubic shapes (pillars) tie — bigAxis stays null and no extension is
    // applied (they're free-standing and don't have corner gaps).
    const aXY = sy * sz; // +/-X face area
    const aYZ = sx * sz; // +/-Y face area
    const aZX = sx * sy; // +/-Z face area
    const TIE_EPS = 1e-3;
    let bigAxis = null;
    if (aZX > aYZ + TIE_EPS && aZX > aXY + TIE_EPS) bigAxis = 'z';
    else if (aYZ > aZX + TIE_EPS && aYZ > aXY + TIE_EPS) bigAxis = 'y';
    else if (aXY > aZX + TIE_EPS && aXY > aYZ + TIE_EPS) bigAxis = 'x';
    const extX = (bigAxis === 'x') ? sx : 0;
    const extY = (bigAxis === 'y') ? sy : 0;
    const extZ = (bigAxis === 'z') ? sz : 0;

    // +X face: normal = +X, plane local-x = world-z, plane local-y = world-y
    if (faceMask & 1)
    {
      euler.set(0, Math.PI * 0.5, 0);
      q.setFromEuler(euler);
      pos.set(cx + halfSx, cy, cz);
      this._emitPlane(material, pos, q, sz + extX, sy + extX);
    }
    // -X face
    if (faceMask & 2)
    {
      euler.set(0, -Math.PI * 0.5, 0);
      q.setFromEuler(euler);
      pos.set(cx - halfSx, cy, cz);
      this._emitPlane(material, pos, q, sz + extX, sy + extX);
    }
    // +Y face (top)
    if (faceMask & 4)
    {
      euler.set(-Math.PI * 0.5, 0, 0);
      q.setFromEuler(euler);
      pos.set(cx, cy + halfSy, cz);
      this._emitPlane(material, pos, q, sx + extY, sz + extY);
    }
    // -Y face (bottom)
    if (faceMask & 8)
    {
      euler.set(Math.PI * 0.5, 0, 0);
      q.setFromEuler(euler);
      pos.set(cx, cy - halfSy, cz);
      this._emitPlane(material, pos, q, sx + extY, sz + extY);
    }
    // +Z face
    if (faceMask & 16)
    {
      q.set(0, 0, 0, 1);
      pos.set(cx, cy, cz + halfSz);
      this._emitPlane(material, pos, q, sx + extZ, sy + extZ);
    }
    // -Z face
    if (faceMask & 32)
    {
      euler.set(0, Math.PI, 0);
      q.setFromEuler(euler);
      pos.set(cx, cy, cz - halfSz);
      this._emitPlane(material, pos, q, sx + extZ, sy + extZ);
    }
  }

  // ---------------------------------------------------------------------------
  // Block builder helpers (preserve old API; emit planes + collider only)
  // ---------------------------------------------------------------------------

  // Internal helper: register collider only.
  _addCollider(cx, cy, cz, sx, sy, sz)
  {
    const half = new THREE.Vector3(sx * 0.5, sy * 0.5, sz * 0.5);
    const center = new THREE.Vector3(cx, cy, cz);
    this.colliders.push(new THREE.Box3(
      center.clone().sub(half),
      center.clone().add(half),
    ));
  }

  // Drop-in replacement for the old _addBox. Emits visible planes for the
  // box's surfaces under the given material, and registers a collider if
  // requested. For instanced (wall/floor/ceil/trim) materials, planes go to
  // the instance queue and no per-mesh allocation occurs. For non-instanced
  // materials (e.g. exit emissive marker), a plain Mesh is added so existing
  // visual behaviour is preserved for those one-offs.
  _addBox(group, cx, cy, cz, sx, sy, sz, material, collide)
  {
    if (collide)
    {
      this._addCollider(cx, cy, cz, sx, sy, sz);
    }

    const key = this._queueKeyForMaterial(material);
    if (key != null)
    {
      // Generic box: emit all 6 faces. Backface culling will drop the ones
      // that face away from the camera; remaining faces still pay vertex cost
      // but render in the parent material's single draw call.
      this._emitBoxFaces(cx, cy, cz, sx, sy, sz, material, 63);
      return null;
    }

    // Non-instanced fallback (emissive markers etc.)
    const geom = new THREE.BoxGeometry(sx, sy, sz);
    this._ownedGeometries.push(geom);
    const mesh = new THREE.Mesh(geom, material);
    mesh.position.set(cx, cy, cz);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    (group || this.root).add(mesh);
    return mesh;
  }

  // Floor slab. Visually only the top is seen, so emit a single +Y plane.
  // No collider for floors (player gravity handles ground).
  _addFloor(group, cx, cz, sx, sz)
  {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, 0));
    const pos = new THREE.Vector3(cx, 0, cz);
    this._emitPlane(this._materials.floor, pos, q, sx, sz);
    return null;
  }

  // Ceiling slab. Only the bottom is seen from below, so emit a single -Y plane.
  _addCeiling(group, cx, cy, cz, sx, sz)
  {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI * 0.5, 0, 0));
    const pos = new THREE.Vector3(cx, cy, cz);
    this._emitPlane(this._materials.ceil, pos, q, sx, sz);
    return null;
  }

  // Wall along X axis. The wall is thin in Z. Both Z faces can be seen at
  // various times (e.g. inner corridor walls), so emit two planes back-to-back.
  // Skip the top/bottom/end faces — they're hidden by floor/ceiling/joining walls.
  _wallX(group, cx, cy, cz, length, height)
  {
    // Collider matches the original BoxGeometry footprint (length, height, 0.5).
    const ccy = cy + height * 0.5;
    this._addCollider(cx, ccy, cz, length, height, 0.5);
    // Two plane faces facing +Z and -Z.
    this._emitBoxFaces(cx, ccy, cz, length, height, 0.5, this._materials.wall, 16 | 32);
  }

  _wallZ(group, cx, cy, cz, length, height)
  {
    const ccy = cy + height * 0.5;
    this._addCollider(cx, ccy, cz, 0.5, height, length);
    // Two plane faces facing +X and -X.
    this._emitBoxFaces(cx, ccy, cz, 0.5, height, length, this._materials.wall, 1 | 2);
  }

  // Build a wall along X with a doorway opening at (openCx, openWidth). Doorway at floor up to doorH.
  // The wall is at z=cz, runs from x=minX to x=maxX, height h.
  _wallXWithDoor(group, minX, maxX, cz, h, openCx, openWidth, doorH)
  {
    const halfOpen = openWidth * 0.5;
    const leftMaxX = openCx - halfOpen;
    const rightMinX = openCx + halfOpen;
    if (leftMaxX > minX + 0.01)
    {
      const len = leftMaxX - minX;
      this._wallX(group, (minX + leftMaxX) * 0.5, 0, cz, len, h);
    }
    if (maxX > rightMinX + 0.01)
    {
      const len = maxX - rightMinX;
      this._wallX(group, (rightMinX + maxX) * 0.5, 0, cz, len, h);
    }
    // Lintel above opening
    const lintelH = h - doorH;
    if (lintelH > 0.05)
    {
      this._addBox(group, openCx, doorH + lintelH * 0.5, cz, openWidth, lintelH, 0.5, this._materials.trim, true);
    }
  }

  // Build a wall along Z with a doorway opening at (openCz, openWidth).
  _wallZWithDoor(group, cx, minZ, maxZ, h, openCz, openWidth, doorH)
  {
    const halfOpen = openWidth * 0.5;
    const lowerMaxZ = openCz - halfOpen;
    const upperMinZ = openCz + halfOpen;
    if (lowerMaxZ > minZ + 0.01)
    {
      const len = lowerMaxZ - minZ;
      this._wallZ(group, cx, 0, (minZ + lowerMaxZ) * 0.5, len, h);
    }
    if (maxZ > upperMinZ + 0.01)
    {
      const len = maxZ - upperMinZ;
      this._wallZ(group, cx, 0, (upperMinZ + maxZ) * 0.5, len, h);
    }
    const lintelH = h - doorH;
    if (lintelH > 0.05)
    {
      this._addBox(group, cx, doorH + lintelH * 0.5, openCz, 0.5, lintelH, openWidth, this._materials.trim, true);
    }
  }

  // ---------------------------------------------------------------------------
  // InstancedMesh finalize - one draw call per material
  // ---------------------------------------------------------------------------

  _finalizeInstances()
  {
    // Shared unit plane geometry used by every InstancedMesh. Each instance
    // matrix scales the unit plane (from -0.5..0.5 in local x/y) to its world
    // size, so the geometry is reused across all instances in all materials.
    const planeGeom = new THREE.PlaneGeometry(1, 1);
    this._ownedGeometries.push(planeGeom);

    const mat4 = new THREE.Matrix4();
    const scale = new THREE.Vector3();

    const keys = Object.keys(this._instanceQueues);
    for (let i = 0; i < keys.length; i++)
    {
      const key = keys[i];
      const queue = this._instanceQueues[key];
      const count = queue.length;
      if (count === 0) continue;

      const material = this._materials[key];
      const im = new THREE.InstancedMesh(planeGeom, material, count);
      im.name = 'Instanced_' + key;
      im.frustumCulled = false; // bbox of merged instances is wide; skip per-mesh frustum
      im.receiveShadow = true;
      im.castShadow = false;

      // Per-instance UV scale (vec2 = u-tiles, v-tiles, derived from world size).
      const uvScales = new Float32Array(count * 2);
      const uvAttr = new THREE.InstancedBufferAttribute(uvScales, 2);
      uvAttr.setUsage(THREE.StaticDrawUsage);

      // The diffuse canvas already has a 4x4 stone-block grid baked in;
      // setting UV-scale = world-size meant 16 stones per world meter,
      // which read as fine noise / "stretched" tile mush. Divide by the
      // canvas's intrinsic tile span (4m) so each stone is ~25cm wide.
      const TEX_TILE_M = 4;
      for (let k = 0; k < count; k++)
      {
        const inst = queue[k];
        scale.set(inst.uSize, inst.vSize, 1);
        mat4.compose(inst.pos, inst.quat, scale);
        im.setMatrixAt(k, mat4);
        uvScales[k * 2    ] = inst.uSize / TEX_TILE_M;
        uvScales[k * 2 + 1] = inst.vSize / TEX_TILE_M;
      }
      im.instanceMatrix.needsUpdate = true;
      im.geometry.setAttribute('instanceUVScale', uvAttr);

      this.root.add(im);
      this._ownedInstancedMeshes.push(im);
      this.collidableMeshes.push(im);

      // We can drop the queue after baking.
      this._instanceQueues[key] = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Decorations: exit pad, health pickups, rocket pickup, lighting
  // ---------------------------------------------------------------------------

  _placeExitPad(x, z)
  {
    const slabSx = 2, slabSy = 0.05, slabSz = 2;
    const geom = new THREE.BoxGeometry(slabSx, slabSy, slabSz);
    this._ownedGeometries.push(geom);
    const mesh = new THREE.Mesh(geom, this._materials.exitEmissive);
    mesh.position.set(x, 0.03, z);
    this.root.add(mesh);
    this.exitMesh = mesh;
    // Trigger box slightly larger and taller than slab so player intersects easily
    const min = new THREE.Vector3(x - 1.0, 0, z - 1.0);
    const max = new THREE.Vector3(x + 1.0, 2.5, z + 1.0);
    this.exitTrigger = new THREE.Box3(min, max);

    // Optional cyan point-light hint
    const light = new THREE.PointLight(0x66ffff, 0.6, 6, 2);
    light.position.set(x, 1.2, z);
    this.root.add(light);
  }

  _placeHealthCrystal(x, z)
  {
    const geom = new THREE.OctahedronGeometry(0.25, 0);
    this._ownedGeometries.push(geom);
    const mesh = new THREE.Mesh(geom, this._materials.healthEmissive);
    mesh.position.set(x, 0.7, z);
    mesh.rotation.y = Math.random() * Math.PI;
    this.root.add(mesh);
    this.healthPickups.push({
      position: new THREE.Vector3(x, 0.7, z),
      mesh: mesh,
      picked: false,
      amount: 25,
    });
  }

  _placeRocketPickup(x, z)
  {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const pedGeom = new THREE.CylinderGeometry(0.45, 0.55, 0.4, 12);
    this._ownedGeometries.push(pedGeom);
    const pedestal = new THREE.Mesh(pedGeom, this._materials.rocketPedestal);
    pedestal.position.y = 0.2;
    group.add(pedestal);

    const bodyGeom = new THREE.CylinderGeometry(0.18, 0.18, 0.7, 10);
    this._ownedGeometries.push(bodyGeom);
    const body = new THREE.Mesh(bodyGeom, this._materials.rocketBody);
    body.position.y = 0.4 + 0.35;
    group.add(body);

    const tipGeom = new THREE.ConeGeometry(0.18, 0.3, 10);
    this._ownedGeometries.push(tipGeom);
    const tip = new THREE.Mesh(tipGeom, this._materials.rocketTip);
    tip.position.y = 0.4 + 0.7 + 0.15;
    group.add(tip);

    this.root.add(group);

    // Orange glow
    const light = new THREE.PointLight(0xff8833, 0.5, 4, 2);
    light.position.set(0, 0.9, 0);
    group.add(light);

    this.rocketPickup = {
      position: new THREE.Vector3(x, 0.9, z),
      mesh: group,
      picked: false,
    };
  }

  // Add baseline ambient + hemisphere lighting AND up to 6 dominant
  // PointLights (pre-sorted by intensity by the caller). Per-fragment
  // PointLight cost is the most expensive part of the lighting model with
  // this many surfaces; capping the count is the single biggest GPU win.
  _addLighting(torches)
  {
    const m = this._materials;

    // Brightened to compensate for fewer point lights. Old: ambient 0.35,
    // hemi 0.25. New: ambient 0.6, hemi 0.45.
    const ambient = new THREE.AmbientLight(m._ambient, 0.6);
    this.root.add(ambient);
    const hemi = new THREE.HemisphereLight(m._hemiSky, m._hemiGround, 0.45);
    this.root.add(hemi);

    const torchGeom = new THREE.SphereGeometry(0.12, 8, 6);
    this._ownedGeometries.push(torchGeom);

    // Sort by intensity (descending) and keep the brightest 6 as PointLights;
    // the rest are still placed as visible torch sphere meshes (cheap, no
    // lighting cost) so the room "looks lit" the same.
    const MAX_POINT_LIGHTS = 6;
    const sorted = torches.slice().sort((a, b) =>
    {
      const ai = (a.intensity != null) ? a.intensity : 1.0;
      const bi = (b.intensity != null) ? b.intensity : 1.0;
      return bi - ai;
    });

    for (let i = 0; i < sorted.length; i++)
    {
      const t = sorted[i];
      const intensity = (t.intensity != null) ? t.intensity : 1.0;
      const range = (t.range != null) ? t.range : 12;

      if (i < MAX_POINT_LIGHTS)
      {
        const light = new THREE.PointLight(m._torchColor, intensity, range, 2);
        light.position.copy(t.p);
        this.root.add(light);
      }

      // Visible torch sphere (always added for visual continuity; basic mat,
      // unaffected by scene lighting and effectively free).
      const sphere = new THREE.Mesh(torchGeom, m.torchEmissive);
      sphere.position.copy(t.p);
      sphere.position.y -= 0.05;
      this.root.add(sphere);
    }
  }

  // ===========================================================================
  // LEVEL 0 - SLIPGATE COMPLEX
  // ===========================================================================
  _buildLevel0()
  {
    this.levelName = 'SLIPGATE COMPLEX';

    this._buildL0_SpawnRoom();
    this._buildL0_NorthCorridor();
    this._buildL0_Arena();
    this._buildL0_EastCorridor();
    this._buildL0_SideChamber();

    this._addLighting([
      { p: new THREE.Vector3(-4.5, 2.6,  4.5), intensity: 1.0 },
      { p: new THREE.Vector3( 4.5, 2.6, -4.5), intensity: 1.0 },
      { p: new THREE.Vector3( 0,   2.8, 11),   intensity: 0.9 },
      { p: new THREE.Vector3(-9,   3.6, 22),   intensity: 1.1 },
      { p: new THREE.Vector3( 9,   3.6, 22),   intensity: 1.1 },
      { p: new THREE.Vector3(-9,   3.6, 32),   intensity: 1.1 },
      { p: new THREE.Vector3( 9,   3.6, 32),   intensity: 1.1 },
      { p: new THREE.Vector3(15,   2.8, 27),   intensity: 0.8 },
      { p: new THREE.Vector3(29,   2.6, 23),   intensity: 1.0 },
      { p: new THREE.Vector3(29,   2.6, 31),   intensity: 1.0 },
    ]);

    this.spawnPoint = new THREE.Vector3(0, 1.7, 0);

    this.enemySpawns = [
      new THREE.Vector3(-7,  1.0, 20),
      new THREE.Vector3( 7,  1.0, 20),
      new THREE.Vector3( 0,  1.0, 27),
      new THREE.Vector3(-7,  1.0, 32),
      new THREE.Vector3(24,  1.0, 30),
      new THREE.Vector3(28,  1.0, 24),
      new THREE.Vector3( 0,  1.0, 10),
    ];

    // Side chamber has platform at center [23.5..26.5] x [25.5..28.5].
    // Health crystals: spawn room, arena, side chamber - clear of all colliders.
    this._placeHealthCrystal(-3.5, -3.5);   // spawn room corner
    this._placeHealthCrystal( 0,    20);    // arena south, between pillars
    this._placeHealthCrystal( 22,   24);    // side chamber SW corner, off platform
    // Rocket pickup in side chamber, off platform (NE)
    this._placeRocketPickup(28, 30);
    // Exit pad in side chamber far corner — opposite the rocket pickup so they
    // don't overlap. Side chamber is x[20..30] z[22..32], platform at [23.5..26.5]x[25.5..28.5].
    // Use NW corner at (21.5, 30.5): clear of platform (x_min 23.5) and walls (x_min 20).
    this._placeExitPad(21.5, 30.5);
  }

  _buildL0_SpawnRoom()
  {
    const g = new THREE.Group();
    g.name = 'L0_SpawnRoom';
    this.root.add(g);

    const floorMinX = -5, floorMaxX = 5;
    const floorMinZ = -5, floorMaxZ = 5;
    const cx = 0, cz = 0;
    const sx = 10, sz = 10;
    const h  = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    this._wallX(g, cx, 0, floorMinZ, sx, h);
    this._wallZ(g, floorMinX, 0, cz, sz, h);
    this._wallZ(g, floorMaxX, 0, cz, sz, h);
    this._wallXWithDoor(g, floorMinX, floorMaxX, floorMaxZ, h, 0, 3, 2.8);
    this._addBox(g, cx, 0.15, floorMinZ, sx, 0.3, 0.55, this._materials.trim, false);
  }

  _buildL0_NorthCorridor()
  {
    const g = new THREE.Group();
    g.name = 'L0_NorthCorridor';
    this.root.add(g);

    const minX = -1.5, maxX = 1.5;
    const minZ = 5,    maxZ = 17;
    const cx = 0;
    const cz = 11;
    const sx = 3, sz = 12;
    const h  = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  _buildL0_Arena()
  {
    const g = new THREE.Group();
    g.name = 'L0_Arena';
    this.root.add(g);

    const minX = -10, maxX = 10;
    const minZ =  17, maxZ = 37;
    const cx = 0, cz = 27;
    const sx = 20, sz = 20;
    const h  = 5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    this._wallXWithDoor(g, minX, maxX, minZ, h, 0, 3, 3.0);
    this._wallX(g, cx, 0, maxZ, sx, h);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZWithDoor(g, maxX, minZ, maxZ, h, 27, 3, 3.0);

    const pillarPositions = [[-5, 22], [5, 22], [-5, 32], [5, 32]];
    pillarPositions.forEach(p =>
    {
      this._addBox(g, p[0], 2.5, p[1], 1.5, 5, 1.5, this._materials.trim, true);
      this._addBox(g, p[0], 5 - 0.15, p[1], 1.7, 0.3, 1.7, this._materials.wall, false);
    });
  }

  _buildL0_EastCorridor()
  {
    const g = new THREE.Group();
    g.name = 'L0_EastCorridor';
    this.root.add(g);

    const minX = 10, maxX = 20;
    const minZ = 25.5, maxZ = 28.5;
    const cx = 15, cz = 27;
    const sx = 10, sz = 3;
    const h  = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    this._wallX(g, cx, 0, minZ, sx, h);
    this._wallX(g, cx, 0, maxZ, sx, h);
  }

  _buildL0_SideChamber()
  {
    const g = new THREE.Group();
    g.name = 'L0_SideChamber';
    this.root.add(g);

    const minX = 20, maxX = 30;
    const minZ = 22, maxZ = 32;
    const cx = 25, cz = 27;
    const sx = 10, sz = 10;
    const h  = 3.5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    this._wallZWithDoor(g, minX, minZ, maxZ, h, 27, 3, 3.0);
    this._wallX(g, cx, 0, minZ, sx, h);
    this._wallX(g, cx, 0, maxZ, sx, h);
    this._wallZ(g, maxX, 0, cz, sz, h);

    this._addBox(g, cx, 0.4, cz, 3, 0.8, 3, this._materials.trim, true);
  }

  // ===========================================================================
  // LEVEL 1 - THE ARMORY
  // Central rotunda 24x24 with 6 short pillars + raised inner ring,
  // 3 spoke corridors to 3 alcove rooms (10x10), exit in far alcove.
  // ===========================================================================
  _buildLevel1()
  {
    this.levelName = 'THE ARMORY';

    // Spawn alcove sits to the south, connected to rotunda via south spoke.
    // Layout (top-down):
    //   Spawn alcove  : x[-5,5], z[-25,-15], h=4
    //   South spoke   : x[-2,2], z[-15,-12], h=4   (3 wide; rotunda inner edge at z=-12)
    //   Rotunda       : x[-12,12], z[-12,12], h=6
    //   East spoke    : x[12,15], z[-2,2], h=4
    //   East alcove   : x[15,25], z[-5,5], h=4
    //   North spoke   : x[-2,2], z[12,15], h=4
    //   North alcove  : x[-5,5], z[15,25], h=4   (EXIT here)

    this._buildL1_SpawnAlcove();
    this._buildL1_SouthSpoke();
    this._buildL1_Rotunda();
    this._buildL1_EastSpoke();
    this._buildL1_EastAlcove();
    this._buildL1_NorthSpoke();
    this._buildL1_NorthAlcove();

    this._addLighting([
      { p: new THREE.Vector3(-3.5, 2.6, -23), intensity: 0.9 },
      { p: new THREE.Vector3( 3.5, 2.6, -17), intensity: 0.9 },
      { p: new THREE.Vector3(0,    4.4, -10), intensity: 1.2, range: 16 },
      { p: new THREE.Vector3(-9,   4.4,  0),  intensity: 1.2, range: 16 },
      { p: new THREE.Vector3( 9,   4.4,  0),  intensity: 1.2, range: 16 },
      { p: new THREE.Vector3(0,    4.4, 10),  intensity: 1.2, range: 16 },
      { p: new THREE.Vector3(0,    4.4,  0),  intensity: 0.8, range: 14 },
      { p: new THREE.Vector3(13.5, 2.8,  0),  intensity: 0.8 },
      { p: new THREE.Vector3(22,   2.6,  3),  intensity: 1.0 },
      { p: new THREE.Vector3(22,   2.6, -3),  intensity: 1.0 },
      { p: new THREE.Vector3(0,    2.8, 13.5),intensity: 0.8 },
      { p: new THREE.Vector3(-3.5, 2.6, 22),  intensity: 1.0 },
      { p: new THREE.Vector3( 3.5, 2.6, 18),  intensity: 1.0 },
    ]);

    this.spawnPoint = new THREE.Vector3(0, 1.7, -20);

    // Enemy spawns - 10 total. All on floor (y=1.0), clear of pillars/walls.
    // Rotunda inner ring is a band: outer radius 8, inner 7, at y[0..0.6] - colliding box ring.
    // Pillar centers at radius 6 around rotunda origin: 6 positions at angles 30,90,150,210,270,330.
    // Avoid radius < 1.0 of pillar centers and radius > 7.5 (inner ring lip blocks at z near 0).
    // Easier: place enemies further out (radius ~9+) on rotunda outer ring or inside alcoves/spokes.
    this.enemySpawns = [
      new THREE.Vector3(-9,  1.0, -9),   // rotunda SW
      new THREE.Vector3( 9,  1.0, -9),   // rotunda SE
      new THREE.Vector3(-9,  1.0,  9),   // rotunda NW
      new THREE.Vector3( 9,  1.0,  9),   // rotunda NE
      new THREE.Vector3(-9,  1.0,  0),   // rotunda W edge
      new THREE.Vector3( 0,  1.0, -9),   // rotunda S edge
      new THREE.Vector3(20,  1.0,  3),   // east alcove
      new THREE.Vector3(20,  1.0, -3),   // east alcove
      new THREE.Vector3(-3,  1.0, 18),   // north alcove (away from exit)
      new THREE.Vector3( 0,  1.0, -22),  // spawn alcove far end (behind player)
    ];

    // Health crystals - 4
    this._placeHealthCrystal(-3.5, -23);   // spawn alcove
    this._placeHealthCrystal( 22,    3);   // east alcove
    this._placeHealthCrystal(-9.5,  -9);   // rotunda SW corner
    this._placeHealthCrystal( 9.5,   9);   // rotunda NE corner

    // Exit in far (north) alcove - place at far end
    this._placeExitPad(0, 22);
  }

  _buildL1_SpawnAlcove()
  {
    const g = new THREE.Group();
    g.name = 'L1_SpawnAlcove';
    this.root.add(g);

    const minX = -5, maxX = 5;
    const minZ = -25, maxZ = -15;
    const cx = 0, cz = -20;
    const sx = 10, sz = 10;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    this._wallX(g, cx, 0, minZ, sx, h);                     // south wall closed
    this._wallZ(g, minX, 0, cz, sz, h);                     // west closed
    this._wallZ(g, maxX, 0, cz, sz, h);                     // east closed
    // North wall has 4-wide doorway at x=0 (matches south spoke 4 wide)
    this._wallXWithDoor(g, minX, maxX, maxZ, h, 0, 4, 3.0);
  }

  _buildL1_SouthSpoke()
  {
    const g = new THREE.Group();
    g.name = 'L1_SouthSpoke';
    this.root.add(g);

    const minX = -2, maxX = 2;
    const minZ = -15, maxZ = -12;
    const cx = 0, cz = -13.5;
    const sx = 4, sz = 3;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    // South end opens into spawn alcove (alcove's north wall has the matching door).
    // North end opens into rotunda (rotunda's south wall has the matching door).
    // Side walls only.
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  _buildL1_Rotunda()
  {
    const g = new THREE.Group();
    g.name = 'L1_Rotunda';
    this.root.add(g);

    const minX = -12, maxX = 12;
    const minZ = -12, maxZ = 12;
    const cx = 0, cz = 0;
    const sx = 24, sz = 24;
    const h = 6;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // South wall: opening 4-wide for south spoke at x=0
    this._wallXWithDoor(g, minX, maxX, minZ, h, 0, 4, 3.0);
    // North wall: opening 4-wide for north spoke at x=0
    this._wallXWithDoor(g, minX, maxX, maxZ, h, 0, 4, 3.0);
    // West wall: closed
    this._wallZ(g, minX, 0, cz, sz, h);
    // East wall: opening 4-wide at z=0 for east spoke
    this._wallZWithDoor(g, maxX, minZ, maxZ, h, 0, 4, 3.0);

    // 6 short pillars at radius 6, every 60°
    for (let i = 0; i < 6; i++)
    {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const px = Math.cos(a) * 6;
      const pz = Math.sin(a) * 6;
      this._addBox(g, px, 1.5, pz, 1.2, 3, 1.2, this._materials.trim, true);
      this._addBox(g, px, 3 - 0.1, pz, 1.4, 0.2, 1.4, this._materials.wall, false);
    }

    // Raised inner ring (a small platform ring around center). To stay within budget,
    // build 4 short trim slabs forming a square ring around the center, leaving the
    // center walkable. Each slab: 4x0.4x0.8.
    // Inner square at [-2,2] x [-2,2], slabs just outside that.
    const ringH = 0.4;
    const ringY = ringH * 0.5;
    // North slab
    this._addBox(g, 0,  ringY,  3, 6, ringH, 1, this._materials.trim, true);
    // South slab
    this._addBox(g, 0,  ringY, -3, 6, ringH, 1, this._materials.trim, true);
    // East slab
    this._addBox(g,  3, ringY, 0, 1, ringH, 6, this._materials.trim, true);
    // West slab
    this._addBox(g, -3, ringY, 0, 1, ringH, 6, this._materials.trim, true);
  }

  _buildL1_EastSpoke()
  {
    const g = new THREE.Group();
    g.name = 'L1_EastSpoke';
    this.root.add(g);

    const minX = 12, maxX = 15;
    const minZ = -2, maxZ = 2;
    const cx = 13.5, cz = 0;
    const sx = 3, sz = 4;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    this._wallX(g, cx, 0, minZ, sx, h);
    this._wallX(g, cx, 0, maxZ, sx, h);
  }

  _buildL1_EastAlcove()
  {
    const g = new THREE.Group();
    g.name = 'L1_EastAlcove';
    this.root.add(g);

    const minX = 15, maxX = 25;
    const minZ = -5, maxZ = 5;
    const cx = 20, cz = 0;
    const sx = 10, sz = 10;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // West wall: doorway 4-wide at z=0 connecting to east spoke
    this._wallZWithDoor(g, minX, minZ, maxZ, h, 0, 4, 3.0);
    this._wallX(g, cx, 0, minZ, sx, h);
    this._wallX(g, cx, 0, maxZ, sx, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  _buildL1_NorthSpoke()
  {
    const g = new THREE.Group();
    g.name = 'L1_NorthSpoke';
    this.root.add(g);

    const minX = -2, maxX = 2;
    const minZ = 12, maxZ = 15;
    const cx = 0, cz = 13.5;
    const sx = 4, sz = 3;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  _buildL1_NorthAlcove()
  {
    const g = new THREE.Group();
    g.name = 'L1_NorthAlcove';
    this.root.add(g);

    const minX = -5, maxX = 5;
    const minZ = 15, maxZ = 25;
    const cx = 0, cz = 20;
    const sx = 10, sz = 10;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // South wall: doorway 4-wide at x=0
    this._wallXWithDoor(g, minX, maxX, minZ, h, 0, 4, 3.0);
    this._wallX(g, cx, 0, maxZ, sx, h);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  // ===========================================================================
  // LEVEL 2 - DEEP HALLS
  // 4 chambers in a snake, right-angle corridors, vertical variation in chamber 3.
  // ===========================================================================
  _buildLevel2()
  {
    this.levelName = 'DEEP HALLS';

    // Layout (top-down). Spawn in chamber A (south-west), exit in chamber D (north-east).
    //   Chamber A : x[-12,0],   z[-30,-18], h=5  (12x12)        spawn here
    //   Corr A->B : x[-2,2],    z[-18,-10], h=4  (4 wide x 8 long)
    //   Chamber B : x[-7,7],    z[-10,4],   h=5  (14x14)
    //   Corr B->C : x[7,18],    z[-2,2],    h=4  (11 long x 4 wide)
    //   Chamber C : x[18,32],   z[-7,7],    h=6  (14x14, has raised platform + ramp)
    //   Corr C->D : x[23,27],   z[7,18],    h=4  (4 wide x 11 long)
    //   Chamber D : x[15,33],   z[18,33],   h=5  (18x15)        exit here

    this._buildL2_ChamberA();
    this._buildL2_CorrAB();
    this._buildL2_ChamberB();
    this._buildL2_CorrBC();
    this._buildL2_ChamberC();
    this._buildL2_CorrCD();
    this._buildL2_ChamberD();

    this._addLighting([
      { p: new THREE.Vector3(-9,   3.6, -27), intensity: 1.0 },
      { p: new THREE.Vector3(-3,   3.6, -21), intensity: 1.0 },
      { p: new THREE.Vector3( 0,   2.8, -14), intensity: 0.8 },
      { p: new THREE.Vector3(-5,   3.6, -3),  intensity: 1.0 },
      { p: new THREE.Vector3( 5,   3.6, -3),  intensity: 1.0 },
      { p: new THREE.Vector3(13,   2.8, 0),   intensity: 0.8 },
      { p: new THREE.Vector3(22,   4.4, -3),  intensity: 1.1 },
      { p: new THREE.Vector3(28,   4.4,  3),  intensity: 1.1 },
      { p: new THREE.Vector3(25,   2.8, 13),  intensity: 0.8 },
      { p: new THREE.Vector3(20,   3.6, 24),  intensity: 1.0 },
      { p: new THREE.Vector3(30,   3.6, 30),  intensity: 1.0 },
      { p: new THREE.Vector3(20,   3.6, 30),  intensity: 1.0 },
    ]);

    this.spawnPoint = new THREE.Vector3(-6, 1.7, -24);

    this.enemySpawns = [
      new THREE.Vector3(-9,  1.0, -22),  // chamber A NW
      new THREE.Vector3(-3,  1.0, -28),  // chamber A SE
      new THREE.Vector3( 0,  1.0, -14),  // corridor A->B
      new THREE.Vector3(-5,  1.0, -3),   // chamber B SW
      new THREE.Vector3( 5,  1.0,  0),   // chamber B east
      new THREE.Vector3( 0,  1.0,  2),   // chamber B north center
      new THREE.Vector3(13,  1.0,  0),   // corridor B->C
      new THREE.Vector3(20,  1.0, -5),   // chamber C SW (off platform)
      new THREE.Vector3(30,  1.0,  5),   // chamber C NE
      new THREE.Vector3(25,  1.0, 13),   // corridor C->D
      new THREE.Vector3(18,  1.0, 22),   // chamber D SW
      new THREE.Vector3(30,  1.0, 22),   // chamber D SE
      new THREE.Vector3(20,  1.0, 30),   // chamber D N
      new THREE.Vector3(28,  1.0, 30),   // chamber D NE
    ];

    this._placeHealthCrystal(-9, -28);    // chamber A
    this._placeHealthCrystal(-5,  3);     // chamber B
    this._placeHealthCrystal(30, -5);     // chamber C ground level
    this._placeHealthCrystal(25,  0);     // chamber C platform top (placed at floor level since crystal y is auto)
    this._placeHealthCrystal(31, 31);     // chamber D NE corner
    // Adjust the platform-top crystal: place at correct y manually
    // (crystal is at y=0.7 by default; on platform top y=1.5+0.7=2.2)
    const lastIdx = this.healthPickups.length - 1;
    // we want the C-platform crystal — that's index 3 (the 4th call).
    if (this.healthPickups[3])
    {
      this.healthPickups[3].mesh.position.y = 2.2;
      this.healthPickups[3].position.y = 2.2;
    }

    // Exit pad in chamber D far corner (NE)
    this._placeExitPad(28, 30);
  }

  _buildL2_ChamberA()
  {
    const g = new THREE.Group();
    g.name = 'L2_ChamberA';
    this.root.add(g);

    const minX = -12, maxX = 0;
    const minZ = -30, maxZ = -18;
    const cx = -6, cz = -24;
    const sx = 12, sz = 12;
    const h = 5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // North wall: doorway 4 wide at x=0 (corridor A->B is x[-2,2])
    this._wallXWithDoor(g, minX, maxX, maxZ, h, 0, 4, 3.0);
    this._wallX(g, cx, 0, minZ, sx, h);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  _buildL2_CorrAB()
  {
    const g = new THREE.Group();
    g.name = 'L2_CorrAB';
    this.root.add(g);

    const minX = -2, maxX = 2;
    const minZ = -18, maxZ = -10;
    const cx = 0, cz = -14;
    const sx = 4, sz = 8;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  _buildL2_ChamberB()
  {
    const g = new THREE.Group();
    g.name = 'L2_ChamberB';
    this.root.add(g);

    const minX = -7, maxX = 7;
    const minZ = -10, maxZ = 4;
    const cx = 0, cz = -3;
    const sx = 14, sz = 14;
    const h = 5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // South wall: doorway 4-wide at x=0
    this._wallXWithDoor(g, minX, maxX, minZ, h, 0, 4, 3.0);
    // North wall: closed
    this._wallX(g, cx, 0, maxZ, sx, h);
    // West wall: closed
    this._wallZ(g, minX, 0, cz, sz, h);
    // East wall: doorway 4-wide at z=0 (corridor B->C z[-2,2])
    this._wallZWithDoor(g, maxX, minZ, maxZ, h, 0, 4, 3.0);
  }

  _buildL2_CorrBC()
  {
    const g = new THREE.Group();
    g.name = 'L2_CorrBC';
    this.root.add(g);

    const minX = 7, maxX = 18;
    const minZ = -2, maxZ = 2;
    const cx = 12.5, cz = 0;
    const sx = 11, sz = 4;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    this._wallX(g, cx, 0, minZ, sx, h);
    this._wallX(g, cx, 0, maxZ, sx, h);
  }

  _buildL2_ChamberC()
  {
    const g = new THREE.Group();
    g.name = 'L2_ChamberC';
    this.root.add(g);

    const minX = 18, maxX = 32;
    const minZ = -7, maxZ = 7;
    const cx = 25, cz = 0;
    const sx = 14, sz = 14;
    const h = 6;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // West wall: doorway 4-wide at z=0 (matches B->C corridor)
    this._wallZWithDoor(g, minX, minZ, maxZ, h, 0, 4, 3.0);
    // North wall: doorway 4-wide at x=25 (matches C->D corridor x[23,27])
    this._wallXWithDoor(g, minX, maxX, maxZ, h, 25, 4, 3.0);
    // South wall: closed
    this._wallX(g, cx, 0, minZ, sx, h);
    // East wall: closed
    this._wallZ(g, maxX, 0, cz, sz, h);

    // Raised platform 4x1.5x4 in NW area, with a ramp from south
    // Platform: x[20,24], z[2,6], y[0..1.5]
    this._addBox(g, 22, 0.75, 4, 4, 1.5, 4, this._materials.trim, true);
    // Ramp block as a step (single stair, 0.75 high, 1.5 deep) at south edge of platform
    this._addBox(g, 22, 0.375, 1.25, 4, 0.75, 1.5, this._materials.trim, true);
  }

  _buildL2_CorrCD()
  {
    const g = new THREE.Group();
    g.name = 'L2_CorrCD';
    this.root.add(g);

    const minX = 23, maxX = 27;
    const minZ = 7, maxZ = 18;
    const cx = 25, cz = 12.5;
    const sx = 4, sz = 11;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  _buildL2_ChamberD()
  {
    const g = new THREE.Group();
    g.name = 'L2_ChamberD';
    this.root.add(g);

    const minX = 15, maxX = 33;
    const minZ = 18, maxZ = 33;
    const cx = 24, cz = 25.5;
    const sx = 18, sz = 15;
    const h = 5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // South wall: doorway 4-wide at x=25 (matches C->D corridor)
    this._wallXWithDoor(g, minX, maxX, minZ, h, 25, 4, 3.0);
    // North/East/West closed
    this._wallX(g, cx, 0, maxZ, sx, h);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  // ===========================================================================
  // LEVEL 3 - PALACE OF FIRE
  // Grand hall 30x40 with 8 pillars + 2 side wings (12x12) + back chamber (12x14) with exit.
  // ===========================================================================
  _buildLevel3()
  {
    this.levelName = 'PALACE OF FIRE';

    // Layout (top-down):
    //   Spawn antechamber : x[-5,5],     z[-35,-25], h=4   (10x10) — small entrance room
    //   Spawn->Hall corr  : x[-3,3],     z[-25,-20], h=4   (6 wide x 5 long)
    //   Grand hall        : x[-15,15],   z[-20,20],  h=8   (30x40)
    //     8 pillars at quadrant grid
    //   West wing doorway : at x=-15, z=0, 5 wide
    //   East wing doorway : at x=+15, z=0, 5 wide
    //   West wing         : x[-27,-15], z[-6,6],   h=5   (12x12)
    //   East wing         : x[15,27],   z[-6,6],   h=5   (12x12)
    //   Back chamber      : x[-7,7],    z[20,34],  h=6   (14x14) — exit
    //   Back doorway      : at z=20, x=0, 5 wide

    this._buildL3_SpawnAnte();
    this._buildL3_SpawnCorr();
    this._buildL3_GrandHall();
    this._buildL3_WestWing();
    this._buildL3_EastWing();
    this._buildL3_BackChamber();

    // Higher torch density and intensity for "fire" vibe (but cap to ~14)
    this._addLighting([
      { p: new THREE.Vector3(-3, 2.6, -33), intensity: 1.0 },
      { p: new THREE.Vector3( 3, 2.6, -27), intensity: 1.0 },
      { p: new THREE.Vector3(-12, 5.5, -15), intensity: 1.4, range: 18 },
      { p: new THREE.Vector3( 12, 5.5, -15), intensity: 1.4, range: 18 },
      { p: new THREE.Vector3(-12, 5.5,  0),  intensity: 1.4, range: 18 },
      { p: new THREE.Vector3( 12, 5.5,  0),  intensity: 1.4, range: 18 },
      { p: new THREE.Vector3(-12, 5.5, 15),  intensity: 1.4, range: 18 },
      { p: new THREE.Vector3( 12, 5.5, 15),  intensity: 1.4, range: 18 },
      { p: new THREE.Vector3(-25, 3.6,  0),  intensity: 1.2, range: 14 },
      { p: new THREE.Vector3( 25, 3.6,  0),  intensity: 1.2, range: 14 },
      { p: new THREE.Vector3(-5,  4.4, 26),  intensity: 1.3, range: 16 },
      { p: new THREE.Vector3( 5,  4.4, 32),  intensity: 1.3, range: 16 },
      { p: new THREE.Vector3( 0,  4.4, 26),  intensity: 1.0, range: 14 },
    ]);

    this.spawnPoint = new THREE.Vector3(0, 1.7, -30);

    // 18 enemies spread across hall, wings, back chamber (cluster guarding exit)
    this.enemySpawns = [
      // grand hall corners and edges (avoid pillars at +/-9, z=-15/-5/5/15)
      new THREE.Vector3(-13, 1.0, -18),
      new THREE.Vector3( 13, 1.0, -18),
      new THREE.Vector3(  0, 1.0, -10),
      new THREE.Vector3(-13, 1.0,  -2),
      new THREE.Vector3( 13, 1.0,  -2),
      new THREE.Vector3(  0, 1.0,  10),
      new THREE.Vector3(-13, 1.0,  18),
      new THREE.Vector3( 13, 1.0,  18),
      new THREE.Vector3( -4, 1.0,   0),
      new THREE.Vector3(  4, 1.0,   0),
      // wings
      new THREE.Vector3(-22, 1.0, -3),
      new THREE.Vector3(-22, 1.0,  3),
      new THREE.Vector3( 22, 1.0, -3),
      new THREE.Vector3( 22, 1.0,  3),
      // back chamber (cluster guarding exit)
      new THREE.Vector3(-4, 1.0, 24),
      new THREE.Vector3( 4, 1.0, 24),
      new THREE.Vector3(-3, 1.0, 30),
      new THREE.Vector3( 3, 1.0, 30),
    ];

    // 6 health crystals
    this._placeHealthCrystal( 0, -32);
    this._placeHealthCrystal(-13, -10);
    this._placeHealthCrystal( 13,  10);
    this._placeHealthCrystal(-25,  0);
    this._placeHealthCrystal( 25,  0);
    this._placeHealthCrystal( 5,  22);

    // Exit pad at far end of back chamber
    this._placeExitPad(0, 32);
  }

  _buildL3_SpawnAnte()
  {
    const g = new THREE.Group();
    g.name = 'L3_SpawnAnte';
    this.root.add(g);

    const minX = -5, maxX = 5;
    const minZ = -35, maxZ = -25;
    const cx = 0, cz = -30;
    const sx = 10, sz = 10;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    this._wallX(g, cx, 0, minZ, sx, h);
    // North: doorway 6 wide at x=0 (matches corridor x[-3,3])
    this._wallXWithDoor(g, minX, maxX, maxZ, h, 0, 6, 3.0);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  _buildL3_SpawnCorr()
  {
    const g = new THREE.Group();
    g.name = 'L3_SpawnCorr';
    this.root.add(g);

    const minX = -3, maxX = 3;
    const minZ = -25, maxZ = -20;
    const cx = 0, cz = -22.5;
    const sx = 6, sz = 5;
    const h = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  _buildL3_GrandHall()
  {
    const g = new THREE.Group();
    g.name = 'L3_GrandHall';
    this.root.add(g);

    const minX = -15, maxX = 15;
    const minZ = -20, maxZ = 20;
    const cx = 0, cz = 0;
    const sx = 30, sz = 40;
    const h = 8;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // South wall: doorway 6-wide at x=0
    this._wallXWithDoor(g, minX, maxX, minZ, h, 0, 6, 3.5);
    // North wall: doorway 6-wide at x=0 (back chamber 14 wide centered at x=0)
    // Back chamber corridor doorway 5 wide; we’ll match.
    this._wallXWithDoor(g, minX, maxX, maxZ, h, 0, 6, 3.5);
    // West wall: doorway 5-wide at z=0 for west wing
    this._wallZWithDoor(g, minX, minZ, maxZ, h, 0, 5, 3.5);
    // East wall: doorway 5-wide at z=0 for east wing
    this._wallZWithDoor(g, maxX, minZ, maxZ, h, 0, 5, 3.5);

    // 8 pillars: 2 columns of 4 at x=±9, z = -15, -5, 5, 15
    const px = [-9, 9];
    const pz = [-15, -5, 5, 15];
    for (let i = 0; i < px.length; i++)
    {
      for (let j = 0; j < pz.length; j++)
      {
        this._addBox(g, px[i], 4, pz[j], 1.8, 8, 1.8, this._materials.trim, true);
        this._addBox(g, px[i], 8 - 0.2, pz[j], 2.0, 0.4, 2.0, this._materials.wall, false);
      }
    }
  }

  _buildL3_WestWing()
  {
    const g = new THREE.Group();
    g.name = 'L3_WestWing';
    this.root.add(g);

    const minX = -27, maxX = -15;
    const minZ = -6, maxZ = 6;
    const cx = -21, cz = 0;
    const sx = 12, sz = 12;
    const h = 5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // East wall: doorway 5 wide at z=0 (matches grand hall west doorway)
    this._wallZWithDoor(g, maxX, minZ, maxZ, h, 0, 5, 3.5);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallX(g, cx, 0, minZ, sx, h);
    this._wallX(g, cx, 0, maxZ, sx, h);
  }

  _buildL3_EastWing()
  {
    const g = new THREE.Group();
    g.name = 'L3_EastWing';
    this.root.add(g);

    const minX = 15, maxX = 27;
    const minZ = -6, maxZ = 6;
    const cx = 21, cz = 0;
    const sx = 12, sz = 12;
    const h = 5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // West wall: doorway 5 wide at z=0
    this._wallZWithDoor(g, minX, minZ, maxZ, h, 0, 5, 3.5);
    this._wallZ(g, maxX, 0, cz, sz, h);
    this._wallX(g, cx, 0, minZ, sx, h);
    this._wallX(g, cx, 0, maxZ, sx, h);
  }

  _buildL3_BackChamber()
  {
    const g = new THREE.Group();
    g.name = 'L3_BackChamber';
    this.root.add(g);

    const minX = -7, maxX = 7;
    const minZ = 20, maxZ = 34;
    const cx = 0, cz = 27;
    const sx = 14, sz = 14;
    const h = 6;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // South wall: doorway 6 wide at x=0 (matches grand hall north doorway)
    this._wallXWithDoor(g, minX, maxX, minZ, h, 0, 6, 3.5);
    this._wallX(g, cx, 0, maxZ, sx, h);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  // ===========================================================================
  // LEVEL 4 - THE SLAUGHTERHOUSE
  // 60x60 multi-route deathmatch arena. Central courtyard with cover, ramps,
  // catwalks at y=4 forming an L over the NE half, an RJ-only perch at y=7
  // over center. Three wings (West, East, North) connect to the courtyard
  // via dedicated doorways AND via two flanking corridors that link wings
  // to North directly (so a defender at the north door can be flanked).
  // ===========================================================================
  _buildLevel4()
  {
    this.levelName = 'THE SLAUGHTERHOUSE';

    // Layout (top-down). All floors at y=0 except the East-wing pit-rim platforms.
    //   Courtyard         : x[-10,10],  z[-10,10],  h=10  (20x20, the open centre)
    //   West wing         : x[-25,-10], z[-8,8],    h=5   (15x16)
    //   East wing (pit)   : x[10,25],   z[-8,8],    h=5   (15x16) — has y=1 raised border platforms
    //   North wing        : x[-15,15],  z[10,28],   h=5   (30x18)  EXIT here
    //   W->Courtyard door : x=-10, z=0, 4 wide
    //   E->Courtyard door : x=+10, z=0, 4 wide
    //   N->Courtyard door : x=0, z=10, 4 wide
    //   W->N flank corr   : x[-13.5,-10.5], z[8,10], 3 wide x 2 long, h=4
    //   E->N flank corr   : x[10.5,13.5],   z[8,10], 3 wide x 2 long, h=4
    //
    // Courtyard verticality:
    //   - Catwalk L at y=4 (0.4 thick platforms): along inner E wall and inner N wall.
    //   - 2 staircases (4 steps of 1u) climbing from courtyard floor to catwalks.
    //   - RJ-only perch at y=7 over centre (2x2, gap of 3u from catwalk top — un-jumpable).
    //   - 4 cover obstacles in the courtyard.

    this._buildL4_Courtyard();
    this._buildL4_WestWing();
    this._buildL4_EastWing();
    this._buildL4_NorthWing();
    this._buildL4_FlankCorrWN();
    this._buildL4_FlankCorrEN();

    // Lighting (12 torches; cap is ~14)
    this._addLighting([
      // Courtyard - bright, varied heights
      { p: new THREE.Vector3(-7,  6.2, -7),  intensity: 1.2, range: 16 },
      { p: new THREE.Vector3( 7,  6.2,  7),  intensity: 1.2, range: 16 },
      { p: new THREE.Vector3( 7,  6.2, -7),  intensity: 1.0, range: 14 },
      { p: new THREE.Vector3(-7,  6.2,  7),  intensity: 1.0, range: 14 },
      { p: new THREE.Vector3( 0,  8.4,  0),  intensity: 1.0, range: 14 },
      // West wing
      { p: new THREE.Vector3(-22, 3.6, -5),  intensity: 1.0 },
      { p: new THREE.Vector3(-22, 3.6,  5),  intensity: 1.0 },
      // East wing (pit)
      { p: new THREE.Vector3( 22, 3.6, -5),  intensity: 1.0 },
      { p: new THREE.Vector3( 22, 3.6,  5),  intensity: 1.0 },
      // North wing
      { p: new THREE.Vector3(-9,  3.6, 18),  intensity: 1.1 },
      { p: new THREE.Vector3( 9,  3.6, 18),  intensity: 1.1 },
      { p: new THREE.Vector3( 0,  3.6, 25),  intensity: 1.0 },
    ]);

    // Spawn near south edge of the courtyard, eye height
    this.spawnPoint = new THREE.Vector3(0, 1.7, -7);

    // 10 enemy / DM spawn points distributed across all 4 main areas.
    // Verified clear of: courtyard pillars at (-5,-5)/(5,5), low walls at (-5,5)/(5,-5),
    // east-wing border platforms x[14..23] z[-7..-5]/z[5..7]/x[20..23] z[-5..5],
    // and stair blocks. All on floor at y=1.0.
    this.enemySpawns = [
      // Courtyard
      new THREE.Vector3( 0,  1.0, -7),   // south centre
      new THREE.Vector3( 0,  1.0,  4),   // north of centre, off cover
      new THREE.Vector3(-7,  1.0,  0),   // west edge
      // West wing
      new THREE.Vector3(-22, 1.0, -5),
      new THREE.Vector3(-22, 1.0,  5),
      new THREE.Vector3(-15, 1.0,  0),   // near east doorway
      // East wing (pit interior — clear of border platforms)
      new THREE.Vector3( 12, 1.0,  0),   // pit floor west side
      new THREE.Vector3( 17, 1.0,  0),   // pit floor centre
      // North wing
      new THREE.Vector3(-10, 1.0, 14),
      new THREE.Vector3( 10, 1.0, 22),
    ];

    // 6 health crystals — at least one per wing, one in courtyard, two on catwalks
    this._placeHealthCrystal(-22,   0);   // West wing centre
    this._placeHealthCrystal( 17,   0);   // East wing pit interior
    this._placeHealthCrystal(  0,  20);   // North wing centre
    this._placeHealthCrystal( -7,  -7);   // Courtyard SW (near cover)
    // Two on catwalks (manual y override after place)
    this._placeHealthCrystal(  6,   8.5); // North catwalk (east end)
    this.healthPickups[this.healthPickups.length - 1].mesh.position.y = 4.7;
    this.healthPickups[this.healthPickups.length - 1].position.y       = 4.7;
    this._placeHealthCrystal(  8.5,  6);  // East catwalk (north end)
    this.healthPickups[this.healthPickups.length - 1].mesh.position.y = 4.7;
    this.healthPickups[this.healthPickups.length - 1].position.y       = 4.7;

    // Rocket pickup in centre of courtyard — visible from all entry doors
    this._placeRocketPickup(0, 0);

    // Exit pad in the north wing (back wall area) — MP-only in practice but
    // keeps solo mode functional if this map is loaded from the menu.
    this._placeExitPad(0, 26);
  }

  _buildL4_Courtyard()
  {
    const g = new THREE.Group();
    g.name = 'L4_Courtyard';
    this.root.add(g);

    const minX = -10, maxX = 10;
    const minZ = -10, maxZ = 10;
    const cx = 0, cz = 0;
    const sx = 20, sz = 20;
    const h  = 10;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // Walls with doorways. Door height kept BELOW catwalk underside (catwalk at y=4 t=0.4 -> bottom=3.8).
    // West wall: doorway 4 wide at z=0 -> west wing
    this._wallZWithDoor(g, minX, minZ, maxZ, h, 0, 4, 3.5);
    // East wall: doorway 4 wide at z=0 -> east wing
    this._wallZWithDoor(g, maxX, minZ, maxZ, h, 0, 4, 3.5);
    // North wall: doorway 4 wide at x=0 -> north wing
    this._wallXWithDoor(g, minX, maxX, maxZ, h, 0, 4, 3.5);
    // South wall: closed
    this._wallX(g, cx, 0, minZ, sx, h);

    // ---- Cover obstacles in the courtyard ----
    // Two tall pillars (diagonal pair)
    this._addBox(g, -5, 2.0, -5, 1.4, 4.0, 1.4, this._materials.trim, true);
    this._addBox(g,  5, 2.0,  5, 1.4, 4.0, 1.4, this._materials.trim, true);
    this._addBox(g, -5, 4.0 - 0.15, -5, 1.6, 0.3, 1.6, this._materials.wall, false);
    this._addBox(g,  5, 4.0 - 0.15,  5, 1.6, 0.3, 1.6, this._materials.wall, false);
    // Two low walls (other diagonal pair) — cover blocks player can shoot over by jumping
    this._addBox(g,  5, 0.6, -5, 3.0, 1.2, 0.8, this._materials.trim, true);
    this._addBox(g, -5, 0.6,  5, 0.8, 1.2, 3.0, this._materials.trim, true);

    // ---- Catwalks at y=4, t=0.4 (top at 4.2, bottom at 3.8) ----
    // East catwalk: along inner east wall, runs along z[-2..9.5]
    this._addBox(g, 8.5, 4.0, 3.75, 1.5, 0.4, 11.5, this._materials.trim, true);
    // North catwalk: along inner north wall, runs along x[-2..7.5]
    // (joins the east catwalk near NE corner)
    this._addBox(g, 2.75, 4.0, 8.5, 9.5, 0.4, 1.5, this._materials.trim, true);
    // Catwalk railings (low decorative trim — also collide so players don't roll off)
    // East catwalk inner edge (toward courtyard centre at x=7.75)
    this._addBox(g, 7.75, 4.6, 3.75, 0.2, 0.8, 11.5, this._materials.trim, true);
    // North catwalk inner edge (toward courtyard centre at z=7.75)
    this._addBox(g, 2.75, 4.6, 7.75, 9.5, 0.8, 0.2, this._materials.trim, true);

    // ---- Staircase ramp 1: SE area, climbs in -z to land on east catwalk ----
    // 8 steps 2u wide (x[7.5..9.5]), 0.6u deep along z, each step rising 0.5u.
    // Step rise of 0.5u is below player.js STEP_UP (0.55), so the player walks
    // smoothly up without jumping. Solid stacked blocks (cy = sy/2 -> top at sy).
    // Top step at z=-2.5 lands at y=4 — the east catwalk top is y=4.2 (a final
    // 0.2u stride that auto step-up handles).
    this._addBox(g, 8.5, 0.25, -6.7, 2.0, 0.5, 0.6, this._materials.trim, true); // y top 0.5
    this._addBox(g, 8.5, 0.5,  -6.1, 2.0, 1.0, 0.6, this._materials.trim, true); // y top 1.0
    this._addBox(g, 8.5, 0.75, -5.5, 2.0, 1.5, 0.6, this._materials.trim, true); // y top 1.5
    this._addBox(g, 8.5, 1.0,  -4.9, 2.0, 2.0, 0.6, this._materials.trim, true); // y top 2.0
    this._addBox(g, 8.5, 1.25, -4.3, 2.0, 2.5, 0.6, this._materials.trim, true); // y top 2.5
    this._addBox(g, 8.5, 1.5,  -3.7, 2.0, 3.0, 0.6, this._materials.trim, true); // y top 3.0
    this._addBox(g, 8.5, 1.75, -3.1, 2.0, 3.5, 0.6, this._materials.trim, true); // y top 3.5
    this._addBox(g, 8.5, 2.0,  -2.5, 2.0, 4.0, 0.6, this._materials.trim, true); // y top 4.0

    // ---- Staircase ramp 2: NW area, climbs in +x to land on north catwalk ----
    // 8 steps 2u deep (z[7.5..9.5]), 0.6u along x, each step rising 0.5u.
    // Top step at x=-2.5 lands at y=4 — the north catwalk top is y=4.2.
    this._addBox(g, -6.7, 0.25, 8.5, 0.6, 0.5, 2.0, this._materials.trim, true); // y top 0.5
    this._addBox(g, -6.1, 0.5,  8.5, 0.6, 1.0, 2.0, this._materials.trim, true); // y top 1.0
    this._addBox(g, -5.5, 0.75, 8.5, 0.6, 1.5, 2.0, this._materials.trim, true); // y top 1.5
    this._addBox(g, -4.9, 1.0,  8.5, 0.6, 2.0, 2.0, this._materials.trim, true); // y top 2.0
    this._addBox(g, -4.3, 1.25, 8.5, 0.6, 2.5, 2.0, this._materials.trim, true); // y top 2.5
    this._addBox(g, -3.7, 1.5,  8.5, 0.6, 3.0, 2.0, this._materials.trim, true); // y top 3.0
    this._addBox(g, -3.1, 1.75, 8.5, 0.6, 3.5, 2.0, this._materials.trim, true); // y top 3.5
    this._addBox(g, -2.5, 2.0,  8.5, 0.6, 4.0, 2.0, this._materials.trim, true); // y top 4.0

    // ---- RJ-only perch at y=7 over courtyard centre ----
    // 2x2x0.4 platform (top at y=7.2). Catwalk top at 4.2, so a 3u vertical
    // gap — unreachable by player jump (max ~1.3u). Requires rocket-jump.
    this._addBox(g, 0, 7.0, 0, 2.0, 0.4, 2.0, this._materials.trim, true);
    // Small emissive marker on the perch so players can see it from below
    this._addBox(g, 0, 7.3, 0, 0.4, 0.1, 0.4, this._materials.exitEmissive, false);
  }

  _buildL4_WestWing()
  {
    const g = new THREE.Group();
    g.name = 'L4_WestWing';
    this.root.add(g);

    const minX = -25, maxX = -10;
    const minZ = -8, maxZ = 8;
    const cx = -17.5, cz = 0;
    const sx = 15, sz = 16;
    const h  = 5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // West wall: closed
    this._wallZ(g, minX, 0, cz, sz, h);
    // East wall: NOT built here — the courtyard's west wall (with its doorway)
    // serves as the shared boundary at x=-10. Avoids double-walls.
    // South wall: closed
    this._wallX(g, cx, 0, minZ, sx, h);
    // North wall: doorway 3 wide at x=-12 (-> W->N flank corridor at x[-13.5..-10.5])
    this._wallXWithDoor(g, minX, maxX, maxZ, h, -12, 3, 3.0);

    // A pair of cover crates / pillars in the wing
    this._addBox(g, -20, 0.6,  3, 1.2, 1.2, 1.2, this._materials.trim, true);
    this._addBox(g, -20, 0.6, -3, 1.2, 1.2, 1.2, this._materials.trim, true);
    // Tall narrow pillar near doorway choke
    this._addBox(g, -14, 1.5,  0, 0.8, 3.0, 0.8, this._materials.trim, true);
  }

  _buildL4_EastWing()
  {
    const g = new THREE.Group();
    g.name = 'L4_EastWing';
    this.root.add(g);

    const minX = 10, maxX = 25;
    const minZ = -8, maxZ = 8;
    const cx = 17.5, cz = 0;
    const sx = 15, sz = 16;
    const h  = 5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // West wall: NOT built here — the courtyard's east wall (with its doorway)
    // serves as the shared boundary at x=10. Avoids double-walls.
    // East wall: closed
    this._wallZ(g, maxX, 0, cz, sz, h);
    // South wall: closed
    this._wallX(g, cx, 0, minZ, sx, h);
    // North wall: doorway 3 wide at x=12 (-> E->N flank corridor at x[10.5..13.5])
    this._wallXWithDoor(g, minX, maxX, maxZ, h, 12, 3, 3.0);

    // ---- The PIT ----
    // The wing has raised border platforms at y=1 framing a "pit" interior at y=0.
    // Player crosses from the courtyard at y=0 directly INTO the pit; the surrounding
    // ledges are the visually higher rim. To get out (or move through the wing) the
    // player jumps up to a 1u-high platform — a clean step-down feel without breaking
    // the player.js y<1.7 safety clamp.
    //
    // Pit interior (no collider, just default y=0 floor): x[14..20] z[-5..5]
    // Border platforms (collidable, y[0..1]):

    // North border platform: x[10..23] z[5..7] (extends to wing west wall)
    this._addBox(g, 16.5, 0.5,  6, 13.0, 1.0, 2.0, this._materials.trim, true);
    // South border platform: x[10..23] z[-7..-5]
    this._addBox(g, 16.5, 0.5, -6, 13.0, 1.0, 2.0, this._materials.trim, true);
    // East border platform: x[20..23] z[-5..5]
    this._addBox(g, 21.5, 0.5,  0, 3.0, 1.0, 10.0, this._materials.trim, true);

    // The pit interior x[10..20] z[-5..5] sits at y=0 — the same global level as
    // the courtyard. Surrounded on 3 sides by 1u-tall border platforms, so it
    // visually reads as a pit while preserving the y<1.7 player safety clamp.
    // Players step down INTO the pit by entering through the courtyard doorway
    // at z=0 (the entry strip x[10..14] z[-2..2] is uncovered). Players climb
    // OUT of the pit by jumping (1u step is jumpable).
  }

  _buildL4_NorthWing()
  {
    const g = new THREE.Group();
    g.name = 'L4_NorthWing';
    this.root.add(g);

    const minX = -15, maxX = 15;
    const minZ = 10, maxZ = 28;
    const cx = 0, cz = 19;
    const sx = 30, sz = 18;
    const h  = 5;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);

    // South wall: the courtyard's north wall (z=10) already covers x[-10..10] with
    // a door at x=0. The north wing only needs to build the wall segments OUTSIDE
    // x[-10..10] (i.e. above the flank corridors), each with their own doorway.
    //
    //   West outer segment: x[-15..-10] with door at x=-12 (3 wide -> W->N flank)
    //   East outer segment: x[10..15]   with door at x=12  (3 wide -> E->N flank)
    {
      const z = minZ;
      this._wallXWithDoor(g, -15, -10, z, h, -12, 3, 3.0);
      this._wallXWithDoor(g,  10,  15, z, h,  12, 3, 3.0);
    }
    // North/East/West walls closed
    this._wallX(g, cx, 0, maxZ, sx, h);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);

    // Cover obstacles inside the north wing
    this._addBox(g, -8, 1.0, 14, 1.2, 2.0, 1.2, this._materials.trim, true);
    this._addBox(g,  8, 1.0, 14, 1.2, 2.0, 1.2, this._materials.trim, true);
    this._addBox(g,  0, 0.6, 16, 4.0, 1.2, 1.0, this._materials.trim, true);
    // A pair of cover blocks near the back wall, framing the exit
    this._addBox(g, -4, 0.6, 25, 1.2, 1.2, 1.2, this._materials.trim, true);
    this._addBox(g,  4, 0.6, 25, 1.2, 1.2, 1.2, this._materials.trim, true);
  }

  _buildL4_FlankCorrWN()
  {
    const g = new THREE.Group();
    g.name = 'L4_FlankCorrWN';
    this.root.add(g);

    // Connects west wing's north door at x=-12 (x[-13.5..-10.5]) to
    // north wing's south door at x=-12 (same x range), via 2u of z.
    const minX = -13.5, maxX = -10.5;
    const minZ = 8, maxZ = 10;
    const cx = -12, cz = 9;
    const sx = 3, sz = 2;
    const h  = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    // East and west walls of the corridor
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
    // North and south are open (matching doorways in the rooms it connects).
  }

  _buildL4_FlankCorrEN()
  {
    const g = new THREE.Group();
    g.name = 'L4_FlankCorrEN';
    this.root.add(g);

    // Connects east wing's north door at x=12 (x[10.5..13.5]) to
    // north wing's south door at x=12 (same x range), via 2u of z.
    const minX = 10.5, maxX = 13.5;
    const minZ = 8, maxZ = 10;
    const cx = 12, cz = 9;
    const sx = 3, sz = 2;
    const h  = 4;

    this._addFloor(g, cx, cz, sx, sz);
    this._addCeiling(g, cx, h, cz, sx, sz);
    this._wallZ(g, minX, 0, cz, sz, h);
    this._wallZ(g, maxX, 0, cz, sz, h);
  }

  // ---------------------------------------------------------------------------
  // Collision: minimum-translation push-out summed across colliders
  // ---------------------------------------------------------------------------

  resolveAABB(box)
  {
    const push = new THREE.Vector3(0, 0, 0);

    for (let i = 0; i < this.colliders.length; i++)
    {
      const c = this.colliders[i];
      if (!box.intersectsBox(c)) continue;

      const overlapX1 = c.max.x - box.min.x;
      const overlapX2 = box.max.x - c.min.x;
      const overlapY1 = c.max.y - box.min.y;
      const overlapY2 = box.max.y - c.min.y;
      const overlapZ1 = c.max.z - box.min.z;
      const overlapZ2 = box.max.z - c.min.z;

      const pushX = (overlapX1 < overlapX2) ?  overlapX1 : -overlapX2;
      const pushY = (overlapY1 < overlapY2) ?  overlapY1 : -overlapY2;
      const pushZ = (overlapZ1 < overlapZ2) ?  overlapZ1 : -overlapZ2;

      const absX = Math.abs(pushX);
      const absY = Math.abs(pushY);
      const absZ = Math.abs(pushZ);

      let chosen = 'x';
      let min = absX;
      if (absZ < min)
      {
        chosen = 'z';
        min = absZ;
      }
      if (absY < min - 0.001)
      {
        chosen = 'y';
        min = absY;
      }

      if (chosen === 'x')      push.x += pushX;
      else if (chosen === 'z') push.z += pushZ;
      else                     push.y += pushY;
    }

    return push;
  }

  resolveAABBAxis(box, axis)
  {
    let total = 0;
    for (let i = 0; i < this.colliders.length; i++)
    {
      const c = this.colliders[i];
      if (!box.intersectsBox(c)) continue;

      let o1, o2;
      if (axis === 'x')      { o1 = c.max.x - box.min.x; o2 = box.max.x - c.min.x; }
      else if (axis === 'y') { o1 = c.max.y - box.min.y; o2 = box.max.y - c.min.y; }
      else                   { o1 = c.max.z - box.min.z; o2 = box.max.z - c.min.z; }

      total += (o1 < o2) ? o1 : -o2;
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // Raycast against world geometry
  // ---------------------------------------------------------------------------
  //
  // Three.js r128 supports raycasting against InstancedMesh: hits include an
  // `instanceId` field, and `face.normal` is in the LOCAL plane space (which
  // for our PlaneGeometry is +Z). To recover the world-space normal we use
  // the per-instance matrix (im.getMatrixAt) -> normal matrix, the same way
  // we'd handle a regular mesh's matrixWorld but composed with the instance
  // transform.

  raycastWalls(origin, dir, maxDist)
  {
    const ndir = this._scratchVec.copy(dir).normalize();
    this._raycaster.set(origin, ndir);
    this._raycaster.near = 0;
    this._raycaster.far = (maxDist != null) ? maxDist : 1000;

    const hits = this._raycaster.intersectObjects(this.collidableMeshes, false);
    if (hits.length === 0) return null;

    const h = hits[0];
    let normal;
    if (h.face && h.face.normal)
    {
      normal = h.face.normal.clone();
      // For an InstancedMesh hit we need to combine the instance's local
      // transform with the mesh's matrixWorld to derive the world-space
      // normal matrix.
      if (h.object && h.object.isInstancedMesh && (h.instanceId != null))
      {
        const instMat = new THREE.Matrix4();
        h.object.getMatrixAt(h.instanceId, instMat);
        const composed = new THREE.Matrix4().multiplyMatrices(h.object.matrixWorld, instMat);
        const nm = new THREE.Matrix3().getNormalMatrix(composed);
        normal.applyMatrix3(nm).normalize();
      }
      else
      {
        const nm = new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld);
        normal.applyMatrix3(nm).normalize();
      }
    }
    else
    {
      normal = new THREE.Vector3(0, 1, 0);
    }

    return {
      point: h.point.clone(),
      distance: h.distance,
      normal: normal,
      mesh: h.object,
    };
  }

  // ---------------------------------------------------------------------------
  // FAST wall-occlusion raycast: sweep against the Box3 collider list.
  // ---------------------------------------------------------------------------
  //
  // Use this in preference to `raycastWalls` whenever the caller only needs to
  // know "did the ray hit a wall, and if so where?" - i.e. bullet wall hits,
  // projectile collision, AI line-of-sight. It is dramatically cheaper than
  // `raycastWalls` because it does O(N) AABB tests (N ~ 50-150 boxes) rather
  // than iterating every per-instance triangle of the level's InstancedMesh
  // batches (which Three.js r128 does internally for each InstancedMesh in
  // Raycaster.intersectObjects).
  //
  // `raycastWalls` is still the right call if you need a real mesh object
  // (e.g. picking up a face normal from a non-axis-aligned surface or
  // identifying which mesh was hit). For the axis-aligned world geometry that
  // makes up the level, this method's normal is exact.
  //
  // Returns { point, distance, normal, mesh:null } or null. `point` and
  // `normal` are freshly allocated Vector3s safe for the caller to retain.
  raycastColliders(origin, direction, maxDist)
  {
    const colliders = this.colliders;
    const n = colliders.length;
    if (n === 0) return null;

    const far = (maxDist != null) ? maxDist : 1000;

    // Set up the ray once, with a normalized direction.
    const dir = this._rcDir.copy(direction).normalize();
    const ray = this._rcRay;
    ray.origin.copy(origin);
    ray.direction.copy(dir);

    let bestDistSq = Infinity;
    let bestBox = null;
    const farSq = far * far;

    for (let i = 0; i < n; i++)
    {
      const box = colliders[i];
      // intersectBox writes into the target Vector3 and returns it on hit, or
      // null on miss. Its result is the entry point of the ray into the box
      // (or origin if origin is already inside).
      const hit = ray.intersectBox(box, this._rcHit);
      if (hit === null) continue;

      const dx = hit.x - origin.x;
      const dy = hit.y - origin.y;
      const dz = hit.z - origin.z;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > farSq) continue;
      if (dSq >= bestDistSq) continue;

      bestDistSq = dSq;
      bestBox = box;
      this._rcBest.copy(hit);
    }

    if (bestBox === null) return null;

    // Recover the surface normal by detecting which face of the Box3 the hit
    // point sits on. For an axis-aligned box the hit lies on exactly one face
    // (within numerical tolerance); pick the closest plane on each axis.
    const eps = 1e-4;
    const p = this._rcBest;
    const dxMin = Math.abs(p.x - bestBox.min.x);
    const dxMax = Math.abs(p.x - bestBox.max.x);
    const dyMin = Math.abs(p.y - bestBox.min.y);
    const dyMax = Math.abs(p.y - bestBox.max.y);
    const dzMin = Math.abs(p.z - bestBox.min.z);
    const dzMax = Math.abs(p.z - bestBox.max.z);

    let best = dxMin;
    let nx = -1, ny = 0, nz = 0;
    if (dxMax < best) { best = dxMax; nx =  1; ny = 0; nz = 0; }
    if (dyMin < best) { best = dyMin; nx =  0; ny = -1; nz = 0; }
    if (dyMax < best) { best = dyMax; nx =  0; ny =  1; nz = 0; }
    if (dzMin < best) { best = dzMin; nx =  0; ny = 0; nz = -1; }
    if (dzMax < best) { best = dzMax; nx =  0; ny = 0; nz =  1; }

    // `eps` is informational only - we already picked the closest face. If the
    // ray grazed past the box on a single axis the picked normal will still be
    // the closest plane, which matches Three.js Raycaster behaviour.
    void eps;

    return {
      point: this._rcBest.clone(),
      distance: Math.sqrt(bestDistSq),
      normal: this._rcNormal.set(nx, ny, nz).clone(),
      mesh: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  dispose()
  {
    if (this.root && this.root.parent)
    {
      this.root.parent.remove(this.root);
    }
    if (this.root)
    {
      this.root.traverse((obj) =>
      {
        if (obj.geometry && typeof obj.geometry.dispose === 'function')
        {
          obj.geometry.dispose();
        }
        if (obj.material)
        {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(m =>
          {
            if (m && typeof m.dispose === 'function') m.dispose();
          });
        }
      });
    }
    // Dispose any tracked resources we own that may not have been traversed
    for (let i = 0; i < this._ownedInstancedMeshes.length; i++)
    {
      const im = this._ownedInstancedMeshes[i];
      if (im && typeof im.dispose === 'function') im.dispose();
    }
    for (let i = 0; i < this._ownedGeometries.length; i++)
    {
      const g = this._ownedGeometries[i];
      if (g && typeof g.dispose === 'function') g.dispose();
    }
    for (let i = 0; i < this._ownedMaterials.length; i++)
    {
      const m = this._ownedMaterials[i];
      if (m && typeof m.dispose === 'function') m.dispose();
    }
    for (let i = 0; i < this._ownedTextures.length; i++)
    {
      const t = this._ownedTextures[i];
      if (t && typeof t.dispose === 'function') t.dispose();
    }
    this._ownedInstancedMeshes.length = 0;
    this._ownedGeometries.length = 0;
    this._ownedMaterials.length = 0;
    this._ownedTextures.length = 0;
    this.colliders.length = 0;
    this.collidableMeshes.length = 0;
    this.enemySpawns.length = 0;
    this.healthPickups.length = 0;
    this.rocketPickup = null;
    this.exitMesh = null;
    this.exitTrigger = null;
    this.root = null;
  }
};
