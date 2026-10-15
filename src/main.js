import './style.css'
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ===== src/config.js =====
/** Immutable game-balancing data. Domain modules never import Three.js or the DOM. */
const MATERIALS = Object.freeze({
  wood: Object.freeze({ label: 'Timber', cost: 12, EA: 2.0e6, strength: 35000, weight: 75, color: 0xc28c55 }),
  steel: Object.freeze({ label: 'Steel', cost: 17, EA: 6.0e6, strength: 70000, weight: 105, color: 0x4f7e98 }),
  carbon: Object.freeze({ label: 'Carbon', cost: 28, EA: 9.0e6, strength: 110000, weight: 62, color: 0x586984 })
});
const LEVELS = Object.freeze([
  Object.freeze({ name: 'The first crossing', span: 12, budget: 1200, truck: 24000, limit: 0.17, description: "The roadway is ready, but it can't carry a truck by itself. Build connected triangles to support the deck." }),
  Object.freeze({ name: 'Across the ravine', span: 16, budget: 1650, truck: 25000, limit: 0.26, description: 'Build a longer bridge while controlling the budget. Diagonal braces share the load across the span.' }),
  Object.freeze({ name: 'The grand crossing', span: 20, budget: 2050, truck: 24000, limit: 0.35, description: 'A heavy engineering challenge. Balance strong material, triangular geometry and efficient beam lengths.' })
]);
const MAX_BEAM_LENGTH = 5;
const MAX_JOINTS = 65;
const TEST_DURATION = 7.2;
const SIMULATION_HZ = 30;


// ===== src/domain/BridgeModel.js =====

/** Owns the editable bridge graph. No graphics, UI, or simulation dependencies. */
class BridgeModel {
  constructor() {
    this.levelIndex = 0;
    this.nodes = [];
    this.beams = [];
    this.undoStack = [];
    this.nextNodeId = 1;
    this.nextBeamId = 1;
    this.version = 0;
    this._derivedVersion = -1;
    this._derived = null;
    this.reset(0);
  }

  get level() { return LEVELS[this.levelIndex]; }
  getNode(id) { return this._nodeById.get(id); }
  findNode(x, y) { return this.nodes.find(n => n.x === x && n.y === y) ?? null; }
  beamLength(beam) {
    const a = this.getNode(beam.a), b = this.getNode(beam.b);
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _invalidate() {
    this.version++;
    this._derivedVersion = -1;
    this._nodeById = new Map(this.nodes.map(n => [n.id, n]));
  }

  _addNode(x, y, anchor = false) {
    const n = { id: this.nextNodeId++, x, y, anchor };
    this.nodes.push(n);
    this._nodeById.set(n.id, n);
    return n;
  }

  _addBeam(a, b, type) {
    const beam = { id: this.nextBeamId++, a: a.id, b: b.id, type };
    this.beams.push(beam);
    return beam;
  }

  /** Set up the two fixed foundations plus the initial straight road. */
  _buildDeck() {
    this.nodes = [];
    this.beams = [];
    this._nodeById = new Map();
    this.nextNodeId = 1;
    this.nextBeamId = 1;
    const half = this.level.span / 2;
    let previous = null;
    for (let x = -half; x <= half; x += 2) {
      const joint = this._addNode(x, 0, x === -half || x === half);
      if (previous) this._addBeam(previous, joint, 'steel');
      previous = joint;
    }
    this._invalidate();
  }

  reset(index = this.levelIndex) {
    if (!Number.isInteger(index) || index < 0 || index >= LEVELS.length) return false;
    this.levelIndex = index;
    this.undoStack.length = 0;
    this._buildDeck();
    return true;
  }

  /** One snapshot per complete user action; snapshots are capped. */
  snapshot() {
    const state = {
      nodes: this.nodes.map(n => ({ ...n })),
      beams: this.beams.map(b => ({ ...b })),
      nextNodeId: this.nextNodeId,
      nextBeamId: this.nextBeamId
    };
    this.undoStack.push(state);
    if (this.undoStack.length > 45) this.undoStack.shift();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.nodes = s.nodes;
    this.beams = s.beams;
    this.nextNodeId = s.nextNodeId;
    this.nextBeamId = s.nextBeamId;
    this._invalidate();
    return true;
  }

  restoreDeck() {
    this.snapshot();
    this._buildDeck();
  }

  loadExample() {
    this.snapshot();
    this._buildDeck();
    const deck = this.nodes.slice();
    let previousBottom = null;
    for (let i = 0; i < deck.length - 1; i++) {
      const bottom = this._addNode(deck[i].x + 1, -3);
      this._addBeam(deck[i], bottom, 'steel');
      this._addBeam(deck[i + 1], bottom, 'steel');
      if (previousBottom) this._addBeam(previousBottom, bottom, 'steel');
      previousBottom = bottom;
    }
    this._invalidate();
  }

  addIsolatedJoint(x, y) {
    if (this.findNode(x, y)) return { ok: false, reason: 'A joint already exists here.' };
    if (this.nodes.length >= MAX_JOINTS) return { ok: false, reason: `Maximum ${MAX_JOINTS} joints reached.` };
    this.snapshot();
    const node = this._addNode(x, y);
    this._invalidate();
    return { ok: true, node };
  }

  /** Validates before snapshotting: failed edits never pollute undo history. */
  connect(fromId, x, y, type) {
    const start = this.getNode(fromId);
    const end = this.findNode(x, y);
    if (!start || !MATERIALS[type]) return { ok: false, reason: 'Invalid joint or material.' };
    if (end?.id === start.id) return { ok: false, reason: 'Select another joint.' };
    const distance = Math.hypot(x - start.x, y - start.y);
    if (distance < 0.8) return { ok: false, reason: 'Select a different grid point.' };
    if (distance > MAX_BEAM_LENGTH + 0.001) return { ok: false, reason: `A beam cannot exceed ${MAX_BEAM_LENGTH} metres.` };
    if (!end && this.nodes.length >= MAX_JOINTS) return { ok: false, reason: `Maximum ${MAX_JOINTS} joints reached.` };
    if (end && this.beams.some(b => (b.a === fromId && b.b === end.id) || (b.b === fromId && b.a === end.id))) {
      return { ok: false, reason: 'Those joints are already connected.' };
    }
    if (this.metrics.cost + distance * MATERIALS[type].cost > this.level.budget + 0.01) {
      return { ok: false, reason: 'Over budget. Use a shorter or cheaper beam.' };
    }
    this.snapshot();
    const target = end ?? this._addNode(x, y);
    this._addBeam(start, target, type);
    this._invalidate();
    return { ok: true, node: target };
  }

  removeJoint(id) {
    const n = this.getNode(id);
    if (!n) return { ok: false, reason: 'No joint selected.' };
    if (n.anchor) return { ok: false, reason: 'Foundation anchors cannot be removed.' };
    this.snapshot();
    this.nodes = this.nodes.filter(item => item.id !== id);
    this.beams = this.beams.filter(b => b.a !== id && b.b !== id);
    this._invalidate();
    return { ok: true };
  }

  removeBeam(id) {
    if (!this.beams.some(b => b.id === id)) return { ok: false, reason: 'No beam selected.' };
    this.snapshot();
    this.beams = this.beams.filter(b => b.id !== id);
    this._invalidate();
    return { ok: true };
  }

  get metrics() {
    if (this._derivedVersion === this.version) return this._derived;
    const edges = new Set();
    const neighbors = new Map(this.nodes.map(n => [n.id, new Set()]));
    let cost = 0;
    for (const b of this.beams) {
      cost += this.beamLength(b) * MATERIALS[b.type].cost;
      const a = Math.min(b.a, b.b), c = Math.max(b.a, b.b);
      edges.add(`${a}:${c}`);
      neighbors.get(b.a).add(b.b);
      neighbors.get(b.b).add(b.a);
    }
    // Enumerate existing graph edges, not every possible triple of joints.
    let triangles = 0;
    for (const a of this.nodes) {
      const adjacent = [...neighbors.get(a.id)].filter(id => id > a.id);
      for (let j = 0; j < adjacent.length; j++) {
        for (let k = j + 1; k < adjacent.length; k++) {
          const bId = adjacent[j], cId = adjacent[k];
          if (!edges.has(`${Math.min(bId, cId)}:${Math.max(bId, cId)}`)) continue;
          const b = this.getNode(bId), c = this.getNode(cId);
          const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          if (Math.abs(area2) > 0.01) triangles++;
        }
      }
    }
    const deckEdges = new Map(this.nodes.filter(n => n.y === 0).map(n => [n.id, []]));
    for (const b of this.beams) {
      if (!deckEdges.has(b.a) || !deckEdges.has(b.b)) continue;
      deckEdges.get(b.a).push(b.b);
      deckEdges.get(b.b).push(b.a);
    }
    const left = this.findNode(-this.level.span / 2, 0);
    const right = this.findNode(this.level.span / 2, 0);
    let road = null;
    if (left && right) {
      const queue = [left.id], prev = new Map([[left.id, null]]);
      for (let head = 0; head < queue.length && !prev.has(right.id); head++) {
        for (const next of deckEdges.get(queue[head]) ?? []) {
          if (!prev.has(next)) { prev.set(next, queue[head]); queue.push(next); }
        }
      }
      if (prev.has(right.id)) {
        const path = [];
        for (let id = right.id; id !== null; id = prev.get(id)) path.push(this.getNode(id));
        path.reverse();
        if (path.every((n, i) => i === 0 || n.x > path[i - 1].x)) road = path;
      }
    }
    this._derived = { cost, triangles, road };
    this._derivedVersion = this.version;
    return this._derived;
  }
}


// ===== src/domain/TrussSolver.js =====

/**
 * Linear 2-D pin-jointed finite-element truss model.
 * Compile ONLY when the bridge topology/materials change. Factorize the constant
 * stiffness matrix once, then solve fast changing right-hand sides as the truck moves.
 * Left foundation: pinned (ux = uy = 0). Right: roller (uy = 0).
 * Domain-only calculations; intentionally simplified for education, not real structures.
 */
class TrussSolver {
  constructor(bridge) {
    this.bridge = bridge;
    this.compiledVersion = -1;
    this.failure = null;
  }

  prepare() {
    if (this.compiledVersion === this.bridge.version) return this.failure;
    const model = this.bridge;
    this.compiledVersion = model.version;
    const road = model.metrics.road;
    if (!road) return (this.failure = 'The roadway is disconnected. Restore the horizontal deck between both foundations.');
    const half = model.level.span / 2;
    const left = model.findNode(-half, 0), right = model.findNode(half, 0);
    if (!left?.anchor || !right?.anchor) return (this.failure = 'Both foundation anchors are required.');

    const adjacent = new Map(model.nodes.map(n => [n.id, []]));
    for (const beam of model.beams) {
      adjacent.get(beam.a).push(beam.b);
      adjacent.get(beam.b).push(beam.a);
    }
    const reachable = new Set([left.id]), queue = [left.id];
    for (let head = 0; head < queue.length; head++) {
      for (const id of adjacent.get(queue[head])) {
        if (!reachable.has(id)) { reachable.add(id); queue.push(id); }
      }
    }
    if (!reachable.has(right.id)) return (this.failure = 'Structural members must connect both abutments.');
    const active = model.nodes.filter(n => reachable.has(n.id));
    const ids = new Map(active.map((n, i) => [n.id, i]));
    const allDof = active.length * 2;
    const supports = new Set([ids.get(left.id) * 2, ids.get(left.id) * 2 + 1, ids.get(right.id) * 2 + 1]);
    const freeDof = [];
    const mapped = new Int32Array(allDof).fill(-1);
    for (let i = 0; i < allDof; i++) if (!supports.has(i)) {
      mapped[i] = freeDof.length;
      freeDof.push(i);
    }
    const n = freeDof.length;
    const stiffness = new Float64Array(n * n);
    const selfWeight = new Float64Array(n);
    const members = [];
    for (const beam of model.beams) {
      if (!ids.has(beam.a) || !ids.has(beam.b)) continue;
      const a = model.getNode(beam.a), b = model.getNode(beam.b);
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      if (length < 1e-6) return (this.failure = 'A member has zero length.');
      const c = dx / length, s = dy / length;
      const material = MATERIALS[beam.type], k = material.EA / length;
      const global = [ids.get(a.id) * 2, ids.get(a.id) * 2 + 1, ids.get(b.id) * 2, ids.get(b.id) * 2 + 1];
      const dof = global.map(g => mapped[g]);
      const v = [c, s, -c, -s];
      for (let i = 0; i < 4; i++) {
        const row = dof[i];
        if (row < 0) continue;
        for (let j = 0; j < 4; j++) {
          const col = dof[j];
          if (col >= 0) stiffness[row * n + col] += k * v[i] * v[j];
        }
      }
      const deadLoad = material.weight * length * 0.5;
      if (dof[1] >= 0) selfWeight[dof[1]] -= deadLoad;
      if (dof[3] >= 0) selfWeight[dof[3]] -= deadLoad;
      members.push({ beamId: beam.id, aId: a.id, bId: b.id, indexA: ids.get(a.id) * 2, indexB: ids.get(b.id) * 2, c, s, k,
        capacityPositive: material.strength,
        capacityNegative: material.strength / (1 + 0.035 * length * length) });
    }
    // Cholesky factorization on a symmetric positive definite stiffness matrix.
    // Near-zero pivots detect an unbraced mechanism without NaN explosions.
    const lower = new Float64Array(n * n);
    let maxDiag = 0;
    for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, stiffness[i * n + i]);
    const minPivot = Math.max(1e-10, maxDiag * 1e-10);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = stiffness[i * n + j];
        for (let k = 0; k < j; k++) sum -= lower[i * n + k] * lower[j * n + k];
        if (i === j) {
          if (!Number.isFinite(sum) || sum <= minPivot) {
            return (this.failure = 'The bridge is unstable. Add triangles to prevent free-moving joints.');
          }
          lower[i * n + i] = Math.sqrt(sum);
        } else {
          lower[i * n + j] = sum / lower[j * n + j];
        }
      }
    }
    this._n = n;
    this._lower = lower;
    this._rhs = new Float64Array(n);
    this._forward = new Float64Array(n);
    this._solution = new Float64Array(n);
    this._allU = new Float64Array(allDof);
    this._mapped = mapped;
    this._selfWeight = selfWeight;
    this._members = members;
    this._ids = ids;
    this._road = road;
    this._level = model.level;
    // Reused solve-output buffers: no new arrays/maps/objects per simulation tick.
    this.result = {
      ok: true,
      displacements: this._allU,
      nodeIndices: ids,
      beamStress: new Map(members.map(m => [m.beamId, { force: 0, ratio: 0 }])),
      maxRatio: 0,
      maxDeflection: 0,
      truckY: 0,
      truckSlope: 0
    };
    return (this.failure = null);
  }

  solve(vehicleX) {
    const failure = this.prepare();
    if (failure) return { ok: false, reason: failure };
    const road = this._road, model = this.bridge, n = this._n;
    const x = Math.max(road[0].x, Math.min(road[road.length - 1].x, vehicleX));
    let segment = road.length - 2;
    for (let i = 0; i < road.length - 1; i++) {
      if (x <= road[i + 1].x + 1e-8) { segment = i; break; }
    }
    const a = road[segment], b = road[segment + 1];
    const t = Math.max(0, Math.min(1, (x - a.x) / (b.x - a.x)));
    const rhs = this._rhs;
    rhs.set(this._selfWeight);
    const ay = this._mapped[this._ids.get(a.id) * 2 + 1];
    const by = this._mapped[this._ids.get(b.id) * 2 + 1];
    if (ay >= 0) rhs[ay] -= model.level.truck * (1 - t);
    if (by >= 0) rhs[by] -= model.level.truck * t;
    const L = this._lower, forward = this._forward, solution = this._solution;
    for (let i = 0; i < n; i++) {
      let sum = rhs[i];
      for (let j = 0; j < i; j++) sum -= L[i * n + j] * forward[j];
      forward[i] = sum / L[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let sum = forward[i];
      for (let j = i + 1; j < n; j++) sum -= L[j * n + i] * solution[j];
      solution[i] = sum / L[i * n + i];
    }
    const U = this._allU;
    for (let i = 0; i < U.length; i++) U[i] = this._mapped[i] < 0 ? 0 : solution[this._mapped[i]];
    let maxRatio = 0, maxDeflection = 0;
    for (const m of this._members) {
      const force = m.k * ((U[m.indexB] - U[m.indexA]) * m.c + (U[m.indexB + 1] - U[m.indexA + 1]) * m.s);
      const ratio = Math.abs(force) / (force < 0 ? m.capacityNegative : m.capacityPositive);
      const stress = this.result.beamStress.get(m.beamId);
      stress.force = force;
      stress.ratio = ratio;
      maxRatio = Math.max(maxRatio, ratio);
    }
    for (const joint of road) {
      const id = this._ids.get(joint.id) * 2 + 1;
      maxDeflection = Math.max(maxDeflection, Math.abs(U[id]));
    }
    const aY = U[this._ids.get(a.id) * 2 + 1];
    const bY = U[this._ids.get(b.id) * 2 + 1];
    const result = this.result;
    result.maxRatio = maxRatio;
    result.maxDeflection = maxDeflection;
    result.truckY = aY * (1 - t) + bY * t;
    result.truckSlope = Math.atan2(bY - aY, b.x - a.x);
    if (!Number.isFinite(maxRatio) || !Number.isFinite(maxDeflection)) {
      return { ok: false, reason: 'Numerical instability detected; add more triangulation.' };
    }
    return result;
  }
}


// ===== src/rendering/BridgeWorld.js =====



/** Three.js adapter: batched meshes, scene, camera, preview and demand-driven loop. */
class BridgeWorld {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // 4K/retina devices otherwise multiply fragment work by 4-9x.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, matchMedia('(max-width: 700px)').matches ? 1.25 : 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this._debug = new URLSearchParams(window.location.search).has('debug');
    if (this._debug) {
      this._debugLabel = document.createElement('output');
      Object.assign(this._debugLabel.style, { position: 'fixed', right: '15px', bottom: '15px', zIndex: '15', background: '#163b49dd', color: '#fff', padding: '8px 10px', borderRadius: '8px', font: '12px monospace', pointerEvents: 'none' });
      this._debugLabel.textContent = 'Measuring draw calls…';
      document.body.append(this._debugLabel);
      this._lastDebug = 0;
    }
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xdcecec);
    this.scene.fog = new THREE.Fog(0xdcecec, 55, 115);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 250);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.08, enablePan: false,
      minDistance: 16, maxDistance: 68,
      minAzimuthAngle: -0.38, maxAzimuthAngle: 0.38,
      minPolarAngle: 1.12, maxPolarAngle: 1.58
    });
    this.controls.mouseButtons.LEFT = null;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x72929a, 2.3));
    const sun = new THREE.DirectionalLight(0xfff6da, 2.35);
    sun.position.set(-12, 20, 13);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 30, bottom: -25 });
    sun.shadow.normalBias = 0.025;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x9ee8e4, 0.8);
    fill.position.set(10, 4, -15);
    this.scene.add(fill);
    this.terrainRoot = new THREE.Group();
    this.bridgeRoot = new THREE.Group();
    this.effectsRoot = new THREE.Group();
    this.scene.add(this.terrainRoot, this.bridgeRoot, this.effectsRoot);
    this.geos = {
      box: new THREE.BoxGeometry(1, 1, 1),
      plane: new THREE.PlaneGeometry(1, 1),
      bar: new THREE.CylinderGeometry(0.065, 0.065, 1, 8),
      web: new THREE.BoxGeometry(0.12, 1, 0.59),
      road: new THREE.BoxGeometry(1, 0.13, 1.62),
      dash: new THREE.BoxGeometry(1, 0.015, 0.035),
      sphere: new THREE.SphereGeometry(0.165, 12, 8),
      ring: new THREE.TorusGeometry(0.205, 0.026, 6, 14),
      anchor: new THREE.CylinderGeometry(0.31, 0.43, 0.26, 5),
      bark: new THREE.CylinderGeometry(0.12, 0.15, 1.2, 7),
      foliage: new THREE.IcosahedronGeometry(0.7, 1),
      rock: new THREE.DodecahedronGeometry(1, 0)
    };
    this.mats = new Map();
    this._mat('road', 0xe4edf0, { roughness: 0.76 });
    this._mat('stripe', 0xffffff, { type: 'basic', transparent: true, opacity: 0.8 });
    this._mat('joint', 0xf5fcf5, { roughness: 0.46, metalness: 0.18 });
    this._mat('ring', 0x6c9b9e, { roughness: 0.45, metalness: 0.25 });
    this._mat('base', 0x4c9d87, { roughness: 0.55 });
    this._mat('preview', 0x8bd6bc, { transparent: true, opacity: 0.46, depthWrite: false });
    this._mat('selection', 0xffcc79, { type: 'basic', transparent: true, opacity: 0.95, depthTest: false });
    this._mat('wood-beam', 0xffffff, { roughness: 0.75, metalness: 0.05 });
    this._mat('steel-beam', 0xffffff, { roughness: 0.48, metalness: 0.37 });
    this._mat('carbon-beam', 0xffffff, { roughness: 0.48, metalness: 0.37 });
    this._scratch = {
      position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1),
      quat: new THREE.Quaternion(), matrix: new THREE.Matrix4(),
      axis: new THREE.Vector3(0, 1, 0), axisZ: new THREE.Vector3(0, 0, 1), direction: new THREE.Vector3(),
      from: new THREE.Vector3(), to: new THREE.Vector3(), color: new THREE.Color()
    };
    this._baseColors = Object.fromEntries(Object.entries(MATERIALS).map(([k, v]) => [k, new THREE.Color(v.color)]));
    this._stressColors = {
      overload: new THREE.Color(0xd86262), compressionLow: new THREE.Color(0x5ba1aa),
      compressionHigh: new THREE.Color(0xf6ad5f), tensionLow: new THREE.Color(0x5d839b),
      tensionHigh: new THREE.Color(0x48c1a4)
    };
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.025, 8, 32), this.mats.get('selection'));
    this.halo.visible = false;
    this.halo.renderOrder = 100;
    this.effectsRoot.add(this.halo);
    this.ghostJoint = new THREE.Mesh(this.geos.sphere, this.mats.get('preview'));
    this.ghostJoint.visible = false;
    this.effectsRoot.add(this.ghostJoint);
    this.ghostBarMaterial = this.mats.get('preview').clone();
    this.ghostBar = new THREE.Mesh(this.geos.bar, this.ghostBarMaterial);
    this.ghostBar.visible = false;
    this.effectsRoot.add(this.ghostBar);
    this.truck = this._createTruck();
    this.scene.add(this.truck);
    this.truck.visible = false;
    this.selectedNodeId = null;
    this.model = null;
    this._frameId = null;
    this._lastTime = 0;
    this._dirty = true;
    this.animating = false;
    this.onFrame = null;
    this._frame = this._frame.bind(this);
    this._resize = this.resize.bind(this);
    window.addEventListener('resize', this._resize, { passive: true });
    document.addEventListener('visibilitychange', () => { this._lastTime = 0; if (!document.hidden) this.invalidate(); });
    this.controls.addEventListener('change', () => this.invalidate());
    this.resize();
  }

  _mat(key, color, options = {}) {
    if (this.mats.has(key)) return this.mats.get(key);
    const { type = 'standard', ...rest } = options;
    const material = type === 'basic' ? new THREE.MeshBasicMaterial({ color, ...rest })
      : new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02, ...rest });
    this.mats.set(key, material);
    return material;
  }

  _createTruck() {
    const truck = new THREE.Group();
    const make = (geo, material, x, y, z) => {
      const obj = new THREE.Mesh(geo, material);
      obj.position.set(x, y, z);
      obj.castShadow = true;
      truck.add(obj);
      return obj;
    };
    make(new THREE.BoxGeometry(1.65, 0.42, 0.86), this._mat('truck-gold', 0xf3ad5b), 0, 0.54, 0);
    make(new THREE.BoxGeometry(0.68, 0.55, 0.84), this._mat('truck-cab', 0xd9824b), 0.41, 0.98, 0);
    make(new THREE.BoxGeometry(0.37, 0.3, 0.86), this._mat('truck-windshield', 0xcce2e7), 0.53, 1.02, 0);
    make(new THREE.BoxGeometry(0.87, 0.39, 0.79), this._mat('truck-load', 0xf7c879), -0.42, 0.94, 0);
    const wheelGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.15, 12);
    const rubber = this._mat('rubber', 0x263e4b);
    for (const x of [-0.53, 0.55]) for (const z of [-0.48, 0.48]) {
      make(wheelGeo, rubber, x, 0.32, z).rotation.x = Math.PI / 2;
    }
    return truck;
  }

  _box(root, w, h, d, material, x, y, z, shadow = false) {
    const mesh = new THREE.Mesh(this.geos.box, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    mesh.castShadow = shadow;
    root.add(mesh);
    return mesh;
  }

  _instances(geometry, material, count, target, castShadow = false) {
    if (!count) return null;
    const inst = new THREE.InstancedMesh(geometry, material, count);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.frustumCulled = false; // Instanced bounds would otherwise need recomputing on deformation.
    inst.castShadow = castShadow;
    inst.receiveShadow = true;
    target.add(inst);
    return inst;
  }

  _matrix(x, y, z, sx = 1, sy = 1, sz = 1, q = null) {
    const s = this._scratch;
    s.position.set(x, y, z);
    s.scale.set(sx, sy, sz);
    s.matrix.compose(s.position, q ?? this._identityQuat(), s.scale);
    return s.matrix;
  }

  _identityQuat() {
    if (!this._identity) this._identity = new THREE.Quaternion();
    return this._identity;
  }

  static seeded(i) {
    const x = Math.sin(i * 127.1 + 29.4) * 43758.5453;
    return x - Math.floor(x);
  }

  _clearGroup(root) {
    for (const child of [...root.children]) {
      child.traverse(obj => {
        if (obj.isInstancedMesh) obj.dispose();
        if (obj.userData.uniqueGeometry) obj.geometry.dispose();
      });
      root.remove(child);
    }
  }

  setLevel(level) {
    this._clearGroup(this.terrainRoot);
    const root = this.terrainRoot, half = level.span / 2, rnd = BridgeWorld.seeded;
    const water = new THREE.Mesh(this.geos.plane, this._mat('water', 0x4eacb0, { roughness: 0.32, metalness: 0.13, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    water.rotation.x = -Math.PI / 2;
    water.scale.set(150, 60, 1);
    water.position.set(0, -4.7, -2);
    root.add(water);
    this._box(root, 160, 0.5, 100, this._mat('basin', 0x75a7a7), 0, -5.06, -4);
    const ripples = this._instances(this.geos.box, this._mat('ripples', 0xd6f3ec, { type: 'basic', transparent: true, opacity: 0.24, depthWrite: false }), 35, root);
    for (let i = 0; i < 35; i++) {
      ripples.setMatrixAt(i, this._matrix((rnd(i + 3) - 0.5) * (level.span + 8), -4.665, -11 + rnd(i + 45) * 23, 0.3 + rnd(i + 18) * 1.4, 0.013, 0.025));
    }
    ripples.instanceMatrix.needsUpdate = true;

    const trees = [], rocks = [];
    for (const side of [-1, 1]) {
      this._box(root, 38, 7.9, 27, this._mat('stone', 0xbda28b), side * (half + 19), -4.1, -0.8);
      this._box(root, 38, 0.38, 27, this._mat('grass', 0x96b9a5), side * (half + 19), -0.12, -0.8);
      for (let i = 0; i < 11; i++) {
        trees.push({ x: side * (half + 2.2 + rnd(i + side * 10 + 40) * 13),
          z: -8 + rnd(i + 12 + side * 8) * 15, s: 0.5 + rnd(i + 23 + side * 17) * 0.8, color: i % 2 });
      }
      this._box(root, 1.6, 0.32, 2.4, this._mat('ledge', 0xf0e9d5), side * (half + 0.75), -0.08, 0);
      this._box(root, 0.45, 0.3, 1.55, this._mat('abutment', 0xa8c9bf), side * (half + 0.18), -0.18, 0);
      for (let i = 0; i < 12; i++) {
        const size = 0.25 + rnd(i + 4) * 0.35;
        rocks.push({ x: side * (half + 0.3 + rnd(i + 79) * 1.4), y: -2 - rnd(i + 61) * 2.6,
          z: -6 + rnd(i + 101) * 13, s: size, color: i % 2 });
      }
    }
    const trunks = this._instances(this.geos.bark, this._mat('bark', 0x887a5d), trees.length, root);
    const foliage = this._instances(this.geos.foliage, this._mat('foliage', 0xffffff), trees.length, root, true);
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      trunks.setMatrixAt(i, this._matrix(t.x, 0.55 * t.s, t.z, t.s, t.s, t.s));
      foliage.setMatrixAt(i, this._matrix(t.x, 1.4 * t.s, t.z, t.s, t.s, t.s));
      foliage.setColorAt(i, new THREE.Color(t.color ? 0x71a998 : 0x84bb9b));
    }
    trunks.instanceMatrix.needsUpdate = true;
    foliage.instanceMatrix.needsUpdate = true;
    foliage.instanceColor.needsUpdate = true;
    const rockBatch = this._instances(this.geos.rock, this._mat('rocks', 0xffffff), rocks.length, root);
    for (let i = 0; i < rocks.length; i++) {
      const r = rocks[i];
      rockBatch.setMatrixAt(i, this._matrix(r.x, r.y, r.z, r.s, r.s * 1.6, r.s * 1.4));
      rockBatch.setColorAt(i, new THREE.Color(r.color ? 0xab9a8c : 0xd0baa1));
    }
    rockBatch.instanceMatrix.needsUpdate = true;
    rockBatch.instanceColor.needsUpdate = true;

    // A pair of batched grid line buffers, rather than a draw call for every line.
    for (const major of [false, true]) {
      const positions = [];
      for (let x = -half; x <= half; x += 1) {
        if ((x % 2 === 0) !== major) continue;
        positions.push(x, -4.2, -0.7, x, 4.1, -0.7);
      }
      for (let y = -4; y <= 4; y++) {
        if ((y === 0) !== major) continue;
        positions.push(-half, y, -0.7, half, y, -0.7);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const grid = new THREE.LineSegments(geometry, this._mat(major ? 'grid-major' : 'grid-minor', major ? 0x609c9d : 0x90b9b5, { type: 'basic', transparent: true, opacity: major ? 0.28 : 0.35, depthWrite: false }));
      grid.userData.uniqueGeometry = true;
      root.add(grid);
    }
    this.camera.position.set(0.3, Math.max(7, level.span * 0.44), Math.max(27, level.span * 1.8));
    this.controls.target.set(0, -0.45, 0);
    this.controls.update();
    this.invalidate();
  }

  /** Reallocate GPU instance buffers only on an actual editing operation. */
  syncBridge(model) {
    this.model = model;
    this._clearGroup(this.bridgeRoot);
    this._beamsByType = new Map();
    for (const name of Object.keys(MATERIALS)) this._beamsByType.set(name, []);
    for (const b of model.beams) this._beamsByType.get(b.type).push(b);
    this._batches = new Map();
    for (const [type, beams] of this._beamsByType) {
      if (!beams.length) continue;
      const mat = this.mats.get(`${type}-beam`);
      const rails = this._instances(this.geos.bar, mat, beams.length * 2, this.bridgeRoot, false);
      const webs = this._instances(this.geos.web, mat, beams.length, this.bridgeRoot, false);
      this._batches.set(type, { rails, webs, beams });
    }
    const nodeCount = model.nodes.length;
    this._joints = this._instances(this.geos.sphere, this.mats.get('joint'), nodeCount, this.bridgeRoot);
    this._rings = this._instances(this.geos.ring, this.mats.get('ring'), nodeCount, this.bridgeRoot);
    const anchors = model.nodes.filter(n => n.anchor);
    this._anchorNodes = anchors;
    this._anchors = this._instances(this.geos.anchor, this.mats.get('base'), anchors.length, this.bridgeRoot);
    for (let i = 0; i < nodeCount; i++) {
      const node = model.nodes[i];
      this._joints.setColorAt(i, new THREE.Color(node.anchor ? 0x55baa0 : 0xffffff));
      this._rings.setColorAt(i, new THREE.Color(node.anchor ? 0x49baa1 : 0x6c9b9e));
    }
    this._joints.instanceColor.needsUpdate = true;
    this._rings.instanceColor.needsUpdate = true;
    this._roadBeams = model.beams.filter(b => model.getNode(b.a).y === 0 && model.getNode(b.b).y === 0);
    this._roads = this._instances(this.geos.road, this.mats.get('road'), this._roadBeams.length, this.bridgeRoot);
    this._roadDashes = this._instances(this.geos.dash, this.mats.get('stripe'), this._roadBeams.length, this.bridgeRoot);
    this.applyEvaluation(null);
  }

  _displaced(id, evaluation, target) {
    const n = this.model.getNode(id);
    const idx = evaluation?.nodeIndices.get(id);
    const x = idx == null ? 0 : evaluation.displacements[idx * 2];
    const y = idx == null ? 0 : evaluation.displacements[idx * 2 + 1];
    target.set(n.x + x, n.y + y, 0);
    return target;
  }

  _stressColor(type, sample) {
    const c = this._scratch.color, palette = this._stressColors;
    if (!sample) return c.copy(this._baseColors[type]);
    if (sample.ratio > 1) return c.copy(palette.overload);
    return sample.force < 0
      ? c.lerpColors(palette.compressionLow, palette.compressionHigh, Math.min(1, sample.ratio) * 0.88)
      : c.lerpColors(palette.tensionLow, palette.tensionHigh, Math.min(1, sample.ratio));
  }

  _memberPose(beam, evaluation) {
    const s = this._scratch;
    this._displaced(beam.a, evaluation, s.from);
    this._displaced(beam.b, evaluation, s.to);
    const dx = s.to.x - s.from.x, dy = s.to.y - s.from.y;
    const length = Math.hypot(dx, dy);
    s.position.set((s.from.x + s.to.x) * 0.5, (s.from.y + s.to.y) * 0.5, 0);
    s.direction.set(dx / Math.max(length, 1e-6), dy / Math.max(length, 1e-6), 0);
    s.quat.setFromUnitVectors(s.axis, s.direction);
    return length;
  }

  applyEvaluation(evaluation) {
    if (!this.model) return;
    const s = this._scratch;
    for (const [type, batch] of this._batches) {
      for (let i = 0; i < batch.beams.length; i++) {
        const b = batch.beams[i], length = this._memberPose(b, evaluation);
        const color = this._stressColor(type, evaluation?.beamStress.get(b.id));
        batch.rails.setMatrixAt(i * 2, this._matrix(s.position.x, s.position.y, -0.34, 1, length, 1, s.quat));
        batch.rails.setMatrixAt(i * 2 + 1, this._matrix(s.position.x, s.position.y, 0.34, 1, length, 1, s.quat));
        batch.webs.setMatrixAt(i, this._matrix(s.position.x, s.position.y, 0, 1, length, 1, s.quat));
        batch.rails.setColorAt(i * 2, color);
        batch.rails.setColorAt(i * 2 + 1, color);
        batch.webs.setColorAt(i, color);
      }
      batch.rails.instanceMatrix.needsUpdate = true;
      batch.webs.instanceMatrix.needsUpdate = true;
      batch.rails.instanceColor.needsUpdate = true;
      batch.webs.instanceColor.needsUpdate = true;
    }
    for (let i = 0; i < this.model.nodes.length; i++) {
      const n = this.model.nodes[i];
      this._displaced(n.id, evaluation, s.from);
      this._joints.setMatrixAt(i, this._matrix(s.from.x, s.from.y, 0));
      this._rings.setMatrixAt(i, this._matrix(s.from.x, s.from.y, 0.075));
    }
    this._joints.instanceMatrix.needsUpdate = true;
    this._rings.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this._anchorNodes.length; i++) {
      const n = this._anchorNodes[i];
      this._anchors.setMatrixAt(i, this._matrix(n.x, n.y - 0.29, 0));
    }
    this._anchors.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this._roadBeams.length; i++) {
      const b = this._roadBeams[i];
      this._displaced(b.a, evaluation, s.from);
      this._displaced(b.b, evaluation, s.to);
      const dx = s.to.x - s.from.x, dy = s.to.y - s.from.y;
      const length = Math.hypot(dx, dy), angle = Math.atan2(dy, dx);
      const centerX = (s.from.x + s.to.x) * 0.5, centerY = (s.from.y + s.to.y) * 0.5;
      s.quat.setFromAxisAngle(s.axisZ, angle);
      this._roads.setMatrixAt(i, this._matrix(centerX, centerY + 0.25, 0, length + 0.055, 1, 1, s.quat));
      this._roadDashes.setMatrixAt(i, this._matrix(centerX, centerY + 0.33, 0, Math.max(0.18, length * 0.28), 1, 1, s.quat));
    }
    if (this._roads) {
      this._roads.instanceMatrix.needsUpdate = true;
      this._roadDashes.instanceMatrix.needsUpdate = true;
    }
    this.selectJoint(this.selectedNodeId, evaluation, false);
    this.invalidate();
  }

  selectJoint(id, evaluation = null, invalidate = true) {
    this.selectedNodeId = id;
    const joint = id == null ? null : this.model?.getNode(id);
    this.halo.visible = Boolean(joint);
    if (joint) {
      this._displaced(id, evaluation, this._scratch.from);
      this.halo.position.set(this._scratch.from.x, this._scratch.from.y, 0.64);
    }
    if (invalidate) this.invalidate();
  }

  setGhost(position, selected, canConnect = true) {
    this.ghostJoint.visible = Boolean(position && !position.existing);
    if (this.ghostJoint.visible) this.ghostJoint.position.set(position.x, position.y, 0.55);
    this.ghostBar.visible = Boolean(position && selected && (selected.x !== position.x || selected.y !== position.y));
    if (this.ghostBar.visible) {
      const s = this._scratch;
      s.from.set(selected.x, selected.y, 0.5);
      s.to.set(position.x, position.y, 0.5);
      s.direction.subVectors(s.to, s.from);
      this.ghostBar.position.copy(s.from).add(s.to).multiplyScalar(0.5);
      const length = s.direction.length();
      this.ghostBar.quaternion.setFromUnitVectors(s.axis, s.direction.multiplyScalar(1 / length));
      this.ghostBar.scale.y = length;
      this.ghostBarMaterial.color.setHex(canConnect ? 0x68bf9b : 0xe86b62);
    }
    this.invalidate();
  }

  clearGhost() {
    if (!this.ghostBar.visible && !this.ghostJoint.visible) return;
    this.ghostBar.visible = false;
    this.ghostJoint.visible = false;
    this.invalidate();
  }

  showTruck(x, elevation, slope) {
    this.truck.visible = true;
    this.truck.position.set(x, elevation + 0.25, 0);
    this.truck.rotation.z = slope;
    this.invalidate();
  }

  hideTruck() {
    this.truck.visible = false;
    this.invalidate();
  }

  /** Direct ray-plane selection avoids expensive object-level raycasts. */
  buildPoint(clientX, clientY) {
    const bounds = this.canvas.getBoundingClientRect();
    const ndc = this._ndc ?? (this._ndc = new THREE.Vector2());
    ndc.set(2 * (clientX - bounds.left) / bounds.width - 1, 1 - 2 * (clientY - bounds.top) / bounds.height);
    const ray = this._raycaster ?? (this._raycaster = new THREE.Raycaster());
    ray.setFromCamera(ndc, this.camera);
    const hit = this._hit ?? (this._hit = new THREE.Vector3());
    const plane = this._plane ?? (this._plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));
    return ray.ray.intersectPlane(plane, hit) ? hit : null;
  }

  resize() {
    const width = Math.max(1, window.innerWidth), height = Math.max(1, window.innerHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  setAnimating(enabled) {
    this.animating = enabled;
    this._lastTime = 0;
    this.invalidate();
  }

  invalidate() {
    this._dirty = true;
    if (this._frameId === null && !document.hidden) this._frameId = requestAnimationFrame(this._frame);
  }

  _frame(now) {
    this._frameId = null;
    const dt = this._lastTime ? Math.min(0.08, (now - this._lastTime) / 1000) : 0;
    this._lastTime = now;
    const wasDirty = this._dirty;
    this._dirty = false;
    const cameraMoved = this.controls.update();
    if (this.animating) this.onFrame?.(dt);
    if (wasDirty || cameraMoved || this._dirty || this.animating) {
      this.renderer.render(this.scene, this.camera);
      if (this._debug && now - this._lastDebug > 750) {
        const stats = this.renderer.info.render;
        this._debugLabel.textContent = `${stats.calls} draw calls · ${stats.triangles.toLocaleString()} triangles · DPR ${this.renderer.getPixelRatio().toFixed(2)}`;
        this._lastDebug = now;
      }
    }
    if (cameraMoved || this._dirty || this.animating) {
      if (this._frameId === null) this._frameId = requestAnimationFrame(this._frame);
    } else {
      this._lastTime = 0;
    }
  }
}


// ===== src/presentation/GameUI.js =====

/** DOM-only adapter. Game rules and rendering are not implemented here. */
class GameUI {
  constructor(doc = document) {
    this.doc = doc;
    this.el = Object.fromEntries([
      'mission-number', 'mission-name', 'mission-description', 'cost', 'budget-total', 'beam-count',
      'triangle-count', 'span-stat', 'budget-fill', 'budget-state', 'road-check', 'insight-title',
      'insight-text', 'undo-btn', 'deflection-stat', 'stress-stat', 'build-btn', 'erase-btn',
      'test-btn', 'test-label', 'top-title', 'status-text', 'progress-fill', 'sim-banner',
      'sim-progress', 'modal-backdrop', 'modal-symbol', 'modal-eyebrow', 'modal-title',
      'modal-body', 'result-cost', 'result-deflection', 'result-stress', 'next-level',
      'pointer-tip', 'toast'
    ].map(id => [id, doc.getElementById(id)]));
    this.levelButtons = [...doc.querySelectorAll('[data-level]')];
    this.materialButtons = [...doc.querySelectorAll('[data-material]')];
    this.toastTimer = null;
  }

  bind(game) {
    this.el['build-btn'].addEventListener('click', () => game.setTool('build'));
    this.el['erase-btn'].addEventListener('click', () => game.setTool('erase'));
    this.materialButtons.forEach(button => button.addEventListener('click', () => game.setMaterial(button.dataset.material)));
    this.levelButtons.forEach(button => button.addEventListener('click', () => game.loadLevel(Number(button.dataset.level))));
    this.doc.getElementById('starter-btn').addEventListener('click', () => game.resetDeck());
    this.doc.getElementById('example-btn').addEventListener('click', () => game.loadExample());
    this.el['undo-btn'].addEventListener('click', () => game.undo());
    this.el['test-btn'].addEventListener('click', () => game.startTest());
    this.doc.getElementById('close-modal').addEventListener('click', () => game.closeModal());
    this.el['next-level'].addEventListener('click', () => game.advance());
    this.el['modal-backdrop'].addEventListener('click', event => {
      if (event.target === this.el['modal-backdrop']) game.closeModal();
    });
  }

  showLevel(index) {
    const level = LEVELS[index], e = this.el;
    e['mission-number'].textContent = `CHALLENGE 0${index + 1} / 03`;
    e['mission-name'].textContent = level.name;
    e['mission-description'].textContent = level.description;
    this.levelButtons.forEach(button => button.classList.toggle('active', Number(button.dataset.level) === index));
    e['budget-total'].textContent = ` / ${level.budget}`;
    e['span-stat'].textContent = `${level.span} m`;
  }

  showTool(tool) {
    this.el['build-btn'].classList.toggle('active', tool === 'build');
    this.el['erase-btn'].classList.toggle('active', tool === 'erase');
  }

  showMaterial(material) {
    this.materialButtons.forEach(button => button.classList.toggle('active', button.dataset.material === material));
  }

  /** Called on design edits, not on animation frames. */
  updateDesign(model) {
    const e = this.el, stats = model.metrics;
    e.cost.textContent = String(Math.round(stats.cost));
    e['beam-count'].textContent = String(model.beams.length);
    e['triangle-count'].textContent = String(stats.triangles);
    e['road-check'].textContent = stats.road ? 'Connected ✓' : 'Disconnected ✕';
    const fraction = Math.min(1, stats.cost / model.level.budget);
    e['budget-fill'].style.width = `${fraction * 100}%`;
    e['budget-fill'].style.background = fraction > 0.85 ? '#e1a056' : '#38a38a';
    e['budget-state'].textContent = fraction > 0.85 ? 'LOW REMAINING' : 'ON TRACK';
    e['undo-btn'].disabled = model.undoStack.length === 0;
    e['insight-title'].textContent = stats.triangles ? `${stats.triangles} rigid triangle${stats.triangles === 1 ? '' : 's'}` : 'Why triangles?';
    e['insight-text'].textContent = stats.triangles
      ? 'Triangular cells resist changing shape. Use shorter members to reduce compression buckling.'
      : "A triangle cannot change shape without changing a side's length. Add diagonals to stop the road bending.";
  }

  clearResults() {
    this.el['deflection-stat'].textContent = 'Not tested';
    this.el['stress-stat'].textContent = 'Not tested';
    this.el['progress-fill'].style.width = '0%';
    this.el['status-text'].textContent = 'READY TO BUILD';
    this.el['top-title'].textContent = 'STRUCTURAL DESIGN MODE';
  }

  beginTest() {
    const e = this.el;
    e['test-btn'].disabled = true;
    e['test-label'].textContent = 'Testing…';
    e['top-title'].textContent = 'LIVE LOAD SIMULATION';
    e['status-text'].textContent = 'TRUCK MOVING';
    e['sim-banner'].style.display = 'block';
    this.updateTest(0, 0, 0);
  }

  updateTest(fraction, peakStress, peakSag) {
    const e = this.el, pct = Math.round(fraction * 100);
    e['progress-fill'].style.width = `${pct}%`;
    e['sim-progress'].textContent = `${pct}%`;
    e['deflection-stat'].textContent = `${(peakSag * 100).toFixed(1)} cm`;
    e['stress-stat'].textContent = `${Math.round(peakStress * 100)}%`;
  }

  showResult({ passed, reason, levelIndex, cost, sag, stress }) {
    const e = this.el;
    e['test-btn'].disabled = false;
    e['test-label'].textContent = 'Run load test';
    e['sim-banner'].style.display = 'none';
    e['top-title'].textContent = 'STRUCTURAL DESIGN MODE';
    e['status-text'].textContent = passed ? 'TEST PASSED' : 'TEST FAILED';
    e['modal-symbol'].className = `modal-symbol${passed ? '' : ' fail'}`;
    e['modal-symbol'].textContent = passed ? '✓' : '!';
    e['modal-eyebrow'].textContent = passed ? 'STRUCTURAL CERTIFICATE' : 'STRUCTURAL INSPECTION';
    e['modal-title'].textContent = passed ? 'Bridge passed!' : 'Bridge needs work';
    e['modal-body'].textContent = passed
      ? 'Your design carried the moving load. Triangular bracing and a continuous roadway kept the structure stable.'
      : reason;
    e['result-cost'].textContent = String(Math.round(cost));
    e['result-deflection'].textContent = `${(sag * 100).toFixed(1)} cm`;
    e['result-stress'].textContent = `${Math.round(stress * 100)}%`;
    e['next-level'].textContent = passed ? (levelIndex === LEVELS.length - 1 ? 'Play again ↻' : 'Next challenge →') : 'Try again →';
    e['modal-backdrop'].style.display = 'flex';
  }

  get modalOpen() { return this.el['modal-backdrop'].style.display === 'flex'; }
  hideModal() { this.el['modal-backdrop'].style.display = 'none'; }

  showTooltip(x, y, length, angle, canConnect) {
    const tip = this.el['pointer-tip'];
    tip.textContent = `${length.toFixed(1)} m  ·  ${angle.toFixed(0)}°  ·  ${canConnect ? 'Click to connect' : 'Too long / over budget'}`;
    tip.style.display = 'block';
    tip.style.left = `${Math.min(window.innerWidth - 180, x + 17)}px`;
    tip.style.top = `${Math.max(60, y - 45)}px`;
  }

  hideTooltip() { this.el['pointer-tip'].style.display = 'none'; }

  toast(message) {
    const el = this.el.toast;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }
}


// ===== src/application/Game.js =====


/** Use-case coordinator: translates user intent into pure domain operations. */
class Game {
  constructor({ model, world, ui }) {
    this.model = model;
    this.world = world;
    this.ui = ui;
    this.solver = new TrussSolver(model);
    this.tool = 'build';
    this.material = 'steel';
    this.selectedJoint = null;
    this.testing = false;
    this.lastPassed = false;
    this._dragStart = null;
    this._dragged = false;
    this._previewQueued = false;
    this._previewPointer = null;
    this._sim = null;
    world.onFrame = dt => this._tick(dt);
    ui.bind(this);
    this._bindCanvas();
    this._bindKeys();
    this.loadLevel(0);
  }

  _editable() { return !this.testing && !this.ui.modalOpen; }

  _afterEdit() {
    this.world.hideTruck();
    this.world.syncBridge(this.model);
    this.world.selectJoint(this.selectedJoint);
    this.ui.updateDesign(this.model);
    this.ui.clearResults();
  }

  loadLevel(index) {
    if (!this._editable() || !Number.isInteger(index) || index < 0 || index >= LEVELS.length) return;
    this.model.reset(index);
    this.selectedJoint = null;
    this.setTool('build');
    this.world.clearGhost();
    this.world.setLevel(this.model.level);
    this.ui.showLevel(index);
    this._afterEdit();
  }

  resetDeck() {
    if (!this._editable()) return;
    this.model.restoreDeck();
    this.selectedJoint = null;
    this._afterEdit();
    this.world.clearGhost();
    this.ui.toast('Back to the starter roadway.');
  }

  loadExample() {
    if (!this._editable()) return;
    this.model.loadExample();
    this.selectedJoint = null;
    this._afterEdit();
    this.world.clearGhost();
    this.ui.toast('Example triangular truss loaded. Run the truck test!');
  }

  undo() {
    if (!this._editable()) return;
    if (!this.model.undo()) { this.ui.toast('Nothing left to undo.'); return; }
    this.selectedJoint = null;
    this._afterEdit();
    this.world.clearGhost();
  }

  setTool(tool) {
    if (!this._editable() || !['build', 'erase'].includes(tool)) return;
    this.tool = tool;
    this.selectedJoint = null;
    this.world.selectJoint(null);
    this.world.clearGhost();
    this.ui.hideTooltip();
    this.ui.showTool(tool);
  }

  setMaterial(material) {
    if (!this._editable() || !MATERIALS[material]) return;
    this.material = material;
    this.ui.showMaterial(material);
  }

  _snap(point) {
    const half = this.model.level.span / 2;
    return { x: Math.round(Math.max(-half, Math.min(half, point.x))), y: Math.round(Math.max(-4, Math.min(4, point.y))) };
  }

  _nearestNode(p) {
    let best = null, distance = 0.43;
    for (const node of this.model.nodes) {
      const d = Math.hypot(node.x - p.x, node.y - p.y);
      if (d < distance) { distance = d; best = node; }
    }
    return best;
  }

  _nearestBeam(p) {
    let best = null, distance = 0.22;
    for (const beam of this.model.beams) {
      const a = this.model.getNode(beam.a), b = this.model.getNode(beam.b);
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      if (l2 <= 1e-8) continue;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
      if (d < distance) { distance = d; best = beam; }
    }
    return best;
  }

  _click(x, y) {
    if (!this._editable()) return;
    const point = this.world.buildPoint(x, y);
    if (!point) return;
    const joint = this._nearestNode(point);
    if (this.tool === 'erase') {
      const result = joint ? this.model.removeJoint(joint.id) : this.model.removeBeam(this._nearestBeam(point)?.id);
      if (!result.ok) { if (joint) this.ui.toast(result.reason); return; }
      if (joint?.id === this.selectedJoint) this.selectedJoint = null;
      this._afterEdit();
      return;
    }
    const snap = this._snap(point);
    if (this.selectedJoint === null) {
      if (joint) this.selectedJoint = joint.id;
      else {
        const result = this.model.addIsolatedJoint(snap.x, snap.y);
        if (!result.ok) { this.ui.toast(result.reason); return; }
        this.selectedJoint = result.node.id;
        this._afterEdit();
      }
      this.world.selectJoint(this.selectedJoint);
      return;
    }
    if (joint?.id === this.selectedJoint) {
      this.selectedJoint = null;
      this.world.selectJoint(null);
      this.world.clearGhost();
      this.ui.hideTooltip();
      return;
    }
    const target = joint ?? snap;
    const result = this.model.connect(this.selectedJoint, target.x, target.y, this.material);
    if (!result.ok) { this.ui.toast(result.reason); return; }
    // Chain connections for rapid triangle construction. Escape ends the chain.
    this.selectedJoint = result.node.id;
    this._afterEdit();
  }

  _preview(x, y) {
    if (!this._editable()) { this.world.clearGhost(); this.ui.hideTooltip(); return; }
    const point = this.world.buildPoint(x, y);
    if (!point) { this.world.clearGhost(); this.ui.hideTooltip(); return; }
    const joint = this._nearestNode(point);
    const candidate = joint ?? this._snap(point);
    const target = { x: candidate.x, y: candidate.y, existing: Boolean(joint) };
    const selected = this.selectedJoint == null ? null : this.model.getNode(this.selectedJoint);
    const length = selected ? Math.hypot(target.x - selected.x, target.y - selected.y) : 0;
    const canConnect = length >= 0.8 && length <= MAX_BEAM_LENGTH + 0.001
      && this.model.metrics.cost + length * MATERIALS[this.material].cost <= this.model.level.budget + 0.01;
    if (this.tool === 'build') {
      this.world.setGhost(target, selected, canConnect);
      if (selected && length > 0.01) {
        const angle = Math.abs(Math.atan2(target.y - selected.y, target.x - selected.x) * 180 / Math.PI);
        this.ui.showTooltip(x, y, length, angle, canConnect);
      } else this.ui.hideTooltip();
    } else {
      this.world.clearGhost();
      this.ui.hideTooltip();
    }
    this.world.canvas.style.cursor = this.tool === 'erase'
      ? (joint || this._nearestBeam(point) ? 'pointer' : 'not-allowed')
      : (joint ? 'pointer' : 'crosshair');
  }

  _bindCanvas() {
    const canvas = this.world.canvas;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      this._dragStart = { x: event.clientX, y: event.clientY };
      this._dragged = false;
    });
    canvas.addEventListener('pointermove', event => {
      if (this._dragStart && Math.hypot(event.clientX - this._dragStart.x, event.clientY - this._dragStart.y) > 6) this._dragged = true;
      this._previewPointer = { x: event.clientX, y: event.clientY };
      if (this._previewQueued) return;
      this._previewQueued = true;
      requestAnimationFrame(() => {
        this._previewQueued = false;
        if (this._previewPointer) this._preview(this._previewPointer.x, this._previewPointer.y);
      });
    }, { passive: true });
    canvas.addEventListener('pointerup', event => {
      if (event.button === 0 && this._dragStart && !this._dragged) this._click(event.clientX, event.clientY);
      this._dragStart = null;
    });
    const exit = () => {
      this._dragStart = null;
      this._previewPointer = null;
      this.world.clearGhost();
      this.ui.hideTooltip();
    };
    canvas.addEventListener('pointercancel', exit);
    canvas.addEventListener('pointerleave', exit);
  }

  _bindKeys() {
    window.addEventListener('keydown', event => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) || event.repeat) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); this.undo(); return;
      }
      if (event.key === 'Escape') {
        if (this.ui.modalOpen) this.closeModal();
        this.selectedJoint = null;
        this.world.selectJoint(null);
        this.world.clearGhost();
        this.ui.hideTooltip();
        return;
      }
      if (!this._editable()) return;
      const key = event.key.toLowerCase();
      if (key === 'b') this.setTool('build');
      if (key === 'e') this.setTool('erase');
      if (key === 't') this.startTest();
      if (key === '1') this.setMaterial('wood');
      if (key === '2') this.setMaterial('steel');
      if (key === '3') this.setMaterial('carbon');
    });
  }

  startTest() {
    if (!this._editable()) return;
    this.selectedJoint = null;
    this.world.selectJoint(null);
    this.world.clearGhost();
    this.ui.hideTooltip();
    const prepared = this.solver.prepare();
    this._sim = { time: 0, accumulator: 0, sinceHud: 0, peakStress: 0, peakSag: 0 };
    if (prepared) { this._finish(false, prepared); return; }
    this.testing = true;
    this.lastPassed = false;
    this.ui.beginTest();
    this.world.setAnimating(true);
  }

  /** Solver runs at a fixed 30Hz while the renderer uses requestAnimationFrame. */
  _tick(dt) {
    if (!this.testing) return;
    const s = this._sim, step = 1 / SIMULATION_HZ;
    s.accumulator = Math.min(0.12, s.accumulator + dt);
    while (s.accumulator >= step && this.testing) {
      s.accumulator -= step;
      s.time = Math.min(TEST_DURATION, s.time + step);
      const fraction = s.time / TEST_DURATION;
      const x = this.model.level.span * (fraction - 0.5);
      const result = this.solver.solve(x);
      if (!result.ok) { this._finish(false, result.reason); break; }
      s.peakStress = Math.max(s.peakStress, result.maxRatio);
      s.peakSag = Math.max(s.peakSag, result.maxDeflection);
      this.world.applyEvaluation(result);
      this.world.showTruck(x, result.truckY, result.truckSlope);
      s.sinceHud += step;
      if (s.sinceHud >= 0.1 || fraction >= 1) {
        this.ui.updateTest(fraction, s.peakStress, s.peakSag);
        s.sinceHud = 0;
      }
      if (result.maxRatio > 1.001) {
        this._finish(false, `A member reached ${Math.round(result.maxRatio * 100)}% of its capacity. Add braces or stronger material.`);
      } else if (result.maxDeflection > this.model.level.limit) {
        this._finish(false, `The roadway sagged ${(result.maxDeflection * 100).toFixed(1)} cm; maximum permitted is ${(this.model.level.limit * 100).toFixed(0)} cm. Add deeper triangulation.`);
      } else if (fraction >= 1) this._finish(true, '');
    }
  }

  _finish(passed, reason) {
    this.testing = false;
    this.lastPassed = passed;
    this.world.setAnimating(false);
    this.world.hideTruck();
    this.ui.showResult({ passed, reason, levelIndex: this.model.levelIndex,
      cost: this.model.metrics.cost, sag: this._sim?.peakSag ?? 0, stress: this._sim?.peakStress ?? 0 });
  }

  closeModal() {
    this.ui.hideModal();
    this.world.applyEvaluation(null);
  }

  advance() {
    const next = this.lastPassed ? (this.model.levelIndex + 1) % LEVELS.length : this.model.levelIndex;
    this.closeModal();
    if (this.lastPassed) this.loadLevel(next);
  }
}


// ===== src/main.js =====




const model = new BridgeModel();
const world = new BridgeWorld(document.querySelector('#world'));
const ui = new GameUI();
const game = new Game({ model, world, ui });
// Opt-in browser inspection: append ?debug=1 to the URL.
if (new URLSearchParams(location.search).has('debug')) {
  window.geometryBridgeDebug = Object.freeze({ model, world, ui, game });
}
