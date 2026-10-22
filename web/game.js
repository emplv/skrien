import * as THREE from './vendor/three.module.js';
import { RunSession, LANE_WIDTH, WORLDS } from './game-logic.js';

const PALETTES = {
  forest: { sky: 0xa9d8cb, top: 0x3f9c97, fog: 0xa9d8cb, road: 0x334e50, edge: 0x72dfbc, ground: 0x4d8f72, water: 0x499b9c, mountain: 0x668d82, sun: 0xffe6ab, light: 0xffedcf },
  canyon: { sky: 0xf5b88b, top: 0xad668d, fog: 0xf5b88b, road: 0x785568, edge: 0xffc29a, ground: 0xc17e69, water: 0xb47177, mountain: 0xb5838a, sun: 0xffedd0, light: 0xffd6ac },
  neon: { sky: 0x292444, top: 0x090e23, fog: 0x292444, road: 0x171d36, edge: 0x67efff, ground: 0x171c34, water: 0x141b33, mountain: 0x252846, sun: 0xf47ab9, light: 0x9edcff }
};
const TAU = Math.PI * 2;
const smooth = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const random = seed => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const material = (color, rest = {}) => new THREE.MeshStandardMaterial({ color, roughness: .84, flatShading: true, ...rest });
const addMesh = (parent, geometry, mat, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); parent.add(mesh); return mesh;
};
const box = (parent, mat, x, y, z, w, h, d) => addMesh(parent, new THREE.BoxGeometry(w, h, d), mat, x, y, z);

/** A GPU-light procedural TV runner; public input is shared by camera, phone, and remote. */
export class RunnerGame {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas; this.callbacks = callbacks; this.session = new RunSession({ preview: true });
    this.status = 'attract'; this.world = 'forest'; this.visualTime = 0; this.attractDistance = 0;
    this.lastFrame = performance.now(); this.lastReport = -1; this.hitFlash = 0;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(53, 16 / 9, .1, 350);
    this.camera.position.set(0, 5.5, 12.6);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.setClearColor(PALETTES.forest.sky);
    this.renderer.info.autoReset = true;
    this.dummy = new THREE.Object3D(); this.tempColor = new THREE.Color();
    this.light = new THREE.DirectionalLight(0xffedcf, 2.7);
    this.light.position.set(-12, 25, 9); this.scene.add(this.light);
    this.scene.add(new THREE.HemisphereLight(0xe6fff7, 0x4a4b66, 2.0));
    this.makeSky(); this.makeTrack(); this.makeWorlds(); this.makeRunner();
    this.makeCoinPool(); this.makeParticles(); this.makeObstacles();
    this.setWorld('forest', false);
    this.resize = this.resize.bind(this); this.frame = this.frame.bind(this);
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(this.resize) : null;
    this.resizeObserver?.observe(canvas); window.addEventListener('resize', this.resize);
    this.onVisibility = () => { if (document.hidden && this.status === 'running') this.pause(); this.lastFrame = performance.now(); };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize(); this.raf = requestAnimationFrame(this.frame);
  }
  get state() { return { ...this.session.stats, status: this.status, lane: this.session.lane, world: this.world }; }
  start(options = {}) {
    this.options = { world: 'forest', duration: 90, mode: 'keyboard', gentle: false, difficulty: 'medium', ...options };
    this.session.reset(this.options);
    this.status = 'running'; this.lastReport = -1; this.hitFlash = 0;
    this.runner.position.set(0, 0, 4); this.setWorld(this.session.world); this.makeObstacles();
    this.callbacks.onStats?.(this.session.stats); this.callbacks.onCue?.(null);
    this.lastFrame = performance.now(); return this;
  }
  input(action, details = {}) { if (this.status === 'running') this.session.input(action, details); }
  pause() {
    if (this.status !== 'running') return;
    this.status = 'paused'; this.session.paused = true; this.callbacks.onPause?.();
  }
  resume() {
    if (this.status !== 'paused') return;
    this.status = 'running'; this.session.paused = false; this.lastFrame = performance.now();
  }
  stop() {
    this.status = 'attract'; this.session.reset({ preview: true, world: this.world }); this.attractDistance = 0;
    this.makeObstacles(); this.callbacks.onCue?.(null); this.lastReport = -1;
  }
  resize() {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h;
    this.camera.fov = w / h < 1 ? 67 : 53; this.camera.updateProjectionMatrix();
  }
  setWorld(name, notify = true) {
    if (!PALETTES[name]) name = 'forest';
    this.world = name; const p = PALETTES[name];
    Object.entries(this.worlds).forEach(([key, group]) => { group.visible = key === name; });
    this.scene.fog = new THREE.Fog(p.fog, name === 'neon' ? 38 : 60, 175);
    this.skyMaterial.uniforms.top.value.set(p.top); this.skyMaterial.uniforms.bottom.value.set(p.sky);
    this.roadMaterial.color.set(p.road); this.edgeMaterial.color.set(p.edge);
    this.edgeMaterial.emissive.set(name === 'neon' ? p.edge : 0x000000);
    this.edgeMaterial.emissiveIntensity = name === 'neon' ? .65 : 0;
    this.groundMaterial.color.set(p.ground); this.waterMaterial.color.set(p.water);
    this.sun.material.color.set(p.sun); this.sunHalo.material.color.set(p.sun);
    this.light.color.set(p.light); this.light.intensity = name === 'neon' ? 2.0 : 2.7;
    this.mountainMaterial.color.set(p.mountain);
    if (notify) this.callbacks.onWorldChange?.(name);
  }
  makeSky() {
    this.skyMaterial = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(PALETTES.forest.top) }, bottom: { value: new THREE.Color(PALETTES.forest.sky) } },
      vertexShader: 'varying vec3 vPosition; void main(){vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'uniform vec3 top;uniform vec3 bottom;varying vec3 vPosition;void main(){float h=clamp(normalize(vPosition).y*.95+.1,0.,1.);gl_FragColor=vec4(mix(bottom,top,pow(h,.6)),1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}'
    });
    addMesh(this.scene, new THREE.SphereGeometry(280, 24, 16), this.skyMaterial);
    this.sun = addMesh(this.scene, new THREE.SphereGeometry(12, 32, 16), new THREE.MeshBasicMaterial({ color: 0xffe6ab, fog: false }), -55, 35, -185);
    this.sunHalo = addMesh(this.scene, new THREE.SphereGeometry(16, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffe6ab, transparent: true, opacity: .1, depthWrite: false, fog: false }), -55, 35, -185);
    this.mountainMaterial = material(0x668d82);
    const rng = random(334);
    for (let i = 0; i < 16; i++) {
      const height = 22 + rng() * 35;
      const mountain = addMesh(this.scene, new THREE.ConeGeometry(16 + rng() * 20, height, 5), this.mountainMaterial,
        -170 + i * 23, height / 2 - 5, -145 - rng() * 35);
      mountain.rotation.y = rng() * 3;
    }
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: .19, transparent: true, depthWrite: false, fog: false });
    this.clouds = new THREE.Group();
    for (let i = 0; i < 9; i++) addMesh(this.clouds, new THREE.IcosahedronGeometry(1, 0), cloudMat, -100 + rng() * 200, 35 + rng() * 25, -90 - rng() * 100, 10 + rng() * 20, 1.2 + rng() * 2, 5);
    this.scene.add(this.clouds);
  }
  makeTrack() {
    this.roadMaterial = material(PALETTES.forest.road);
    this.edgeMaterial = material(PALETTES.forest.edge);
    this.groundMaterial = material(PALETTES.forest.ground);
    this.waterMaterial = material(PALETTES.forest.water, { roughness: .45, metalness: .2 });
    box(this.scene, this.waterMaterial, 0, -.85, -80, 500, .4, 450);
    box(this.scene, this.groundMaterial, 0, -.46, -70, 14.4, .7, 200);
    box(this.scene, this.roadMaterial, 0, -.06, -70, 8.5, .2, 200);
    box(this.scene, this.edgeMaterial, -4.29, .015, -70, .14, .13, 200);
    box(this.scene, this.edgeMaterial, 4.29, .015, -70, .14, .13, 200);
    const lineMaterial = material(0xc5d8c6, { transparent: true, opacity: .3 });
    const dashes = [];
    for (let i = 0; i < 40; i++) for (const side of [-1, 1])
      dashes.push({ x: side * LANE_WIDTH / 2, y: .05, z: 12 - i * 5, sx: .045, sy: .012, sz: 1.8 });
    this.laneDashes = this.instanced(this.scene, new THREE.BoxGeometry(1, 1, 1), lineMaterial, dashes);
    const seamMat = material(0x162b35, { transparent: true, opacity: .18 });
    const tiles = [];
    for (let i = 0; i < 32; i++) tiles.push({ x: 0, y: .055, z: 14 - i * 7, sx: 8.3, sy: .01, sz: .04 });
    this.roadTiles = this.instanced(this.scene, new THREE.BoxGeometry(1, 1, 1), seamMat, tiles);
    const rippleMat = new THREE.MeshBasicMaterial({ color: 0xc6fff3, transparent: true, opacity: .11 });
    const ripples = [];
    for (let i = 0; i < 32; i++) {
      const side = i % 2 ? -1 : 1;
      ripples.push({ x: side * (12 + i % 6 * 4), y: -.63, z: 10 - i * 5, sx: 3 + i % 5, sy: .01, sz: .08 });
    }
    this.ripples = this.instanced(this.scene, new THREE.BoxGeometry(1, 1, 1), rippleMat, ripples);
  }
  instanced(parent, geo, mat, records, colorFor) {
    const mesh = new THREE.InstancedMesh(geo, mat, records.length);
    records.forEach((r, i) => {
      this.dummy.position.set(r.x, r.y || 0, r.z); this.dummy.rotation.set(0, r.rotation || 0, 0);
      this.dummy.scale.set(r.sx || r.scale || 1, r.sy || r.scale || 1, r.sz || r.scale || 1);
      this.dummy.updateMatrix(); mesh.setMatrixAt(i, this.dummy.matrix);
      if (colorFor) mesh.setColorAt(i, this.tempColor.set(colorFor(r, i)));
    });
    mesh.instanceMatrix.needsUpdate = true; parent.add(mesh); return mesh;
  }
  makeWorlds() {
    this.worlds = {}; this.segments = {};
    for (const name of WORLDS) {
      const world = new THREE.Group(); this.worlds[name] = world; this.segments[name] = [];
      const segment = new THREE.Group();
      if (name === 'forest') this.forestSegment(segment);
      if (name === 'canyon') this.canyonSegment(segment);
      if (name === 'neon') this.neonSegment(segment);
      world.add(segment); this.segments[name].push(segment);
      const second = segment.clone(true); second.position.z = -160; world.add(second); this.segments[name].push(second);
      this.scene.add(world);
    }
  }
  forestSegment(parent) {
    const rng = random(841), trees = [], rocks = [], flowers = [];
    for (let i = 0; i < 85; i++) trees.push({ x: (i % 2 ? -1 : 1) * (6.4 + rng() * 28), z: -rng() * 160, scale: .64 + rng() * 1.18, rotation: rng() * 5 });
    const trunk = new THREE.CylinderGeometry(.14, .23, 2, 5); trunk.translate(0, 1, 0);
    const leavesLow = new THREE.ConeGeometry(1.6, 3.7, 6); leavesLow.translate(0, 3.35, 0);
    const leavesHigh = new THREE.ConeGeometry(1.16, 3.4, 6); leavesHigh.translate(0, 5.2, 0);
    this.instanced(parent, trunk, material(0x66585c), trees);
    this.instanced(parent, leavesLow, material(0xffffff), trees, (_, i) => [0x185d52, 0x237465, 0x368d70, 0x236a61][i % 4]);
    this.instanced(parent, leavesHigh, material(0xffffff), trees, (_, i) => [0x398d75, 0x47967c, 0x66aa7d, 0x308774][i % 4]);
    for (let i = 0; i < 60; i++) rocks.push({ x: (i % 2 ? -1 : 1) * (5 + rng() * 13), y: .18, z: -rng() * 160, sx: .5 + rng() * 1.3, sy: .3 + rng() * .6, sz: .5 + rng() * .9, rotation: rng() * 6 });
    this.instanced(parent, new THREE.IcosahedronGeometry(1, 0), material(0x87ab9a), rocks);
    for (let i = 0; i < 75; i++) flowers.push({ x: (i % 2 ? -1 : 1) * (4.8 + rng() * 2), y: .25, z: -rng() * 160, scale: .08 + rng() * .13 });
    this.instanced(parent, new THREE.IcosahedronGeometry(1, 0), material(0xffc8a5, { emissive: 0x9b5d29, emissiveIntensity: .1 }), flowers);
    const bridgeMat = material(0x6e7e6b), capMat = material(0xa7c4a5), posts = [], caps = [];
    for (const side of [-1, 1]) for (let i = 0; i < 8; i++) {
      posts.push({ x: side * 5.1, y: .45, z: -i * 20 - 8, sx: .16, sy: .9, sz: .16 });
      caps.push({ x: side * 5.1, y: .96, z: -i * 20 - 8, sx: .28, sy: .14, sz: .28 });
    }
    this.instanced(parent, new THREE.BoxGeometry(1, 1, 1), bridgeMat, posts);
    this.instanced(parent, new THREE.BoxGeometry(1, 1, 1), capMat, caps);
    // A suspended trail marker gives the world a strong, recognizable destination.
    const archMat = material(0x526f61);
    for (const side of [-1, 1]) box(parent, archMat, side * 5.1, 4, -140, .65, 8, .7);
    box(parent, archMat, 0, 7.9, -140, 11.1, .6, .9);
    box(parent, material(0xfad79a), 0, 7.4, -139.5, 2.7, .75, .15);
  }
  canyonSegment(parent) {
    const rng = random(223), cliffs = [], rocks = [], cacti = [];
    for (let i = 0; i < 55; i++) cliffs.push({ x: (i % 2 ? -1 : 1) * (9 + rng() * 20), z: -rng() * 160,
      y: 2, sx: 2 + rng() * 4, sy: 3 + rng() * 10, sz: 2 + rng() * 4, rotation: rng() * 6 });
    const cliffGeo = new THREE.CylinderGeometry(.68, 1, 1, 5); cliffGeo.translate(0, .5, 0);
    this.instanced(parent, cliffGeo, material(0xffffff), cliffs, (_, i) => [0xc98773, 0xb67573, 0xe19e7c, 0xa26f76][i % 4]);
    const cliffCap = new THREE.CylinderGeometry(.7, .72, .1, 5); cliffCap.translate(0, 1.02, 0);
    this.instanced(parent, cliffCap, material(0xf0b692), cliffs);
    for (let i = 0; i < 60; i++) rocks.push({ x: (i % 2 ? -1 : 1) * (5 + rng() * 8), z: -rng() * 160, y: .2,
      sx: .4 + rng(), sy: .3 + rng() * .65, sz: .4 + rng(), rotation: rng() * 6 });
    this.instanced(parent, new THREE.DodecahedronGeometry(.7, 0), material(0xe6b08a), rocks);
    for (let i = 0; i < 26; i++) cacti.push({ x: (i % 2 ? -1 : 1) * (6 + rng() * 5), z: -rng() * 160, y: .55, sy: .8 + rng() * 1.4, sx: .8, sz: .8 });
    this.instanced(parent, new THREE.CapsuleGeometry(.22, 1, 2, 5), material(0x577c6e), cacti);
    const archMat = material(0xd79176);
    for (const side of [-1, 1]) box(parent, archMat, side * 6, 5, -130, 3.7, 10, 6);
    const archTop = box(parent, archMat, 0, 10.4, -130, 15.5, 3.6, 6.8); archTop.rotation.z = .035;
    const stripeMat = material(0xeab18a);
    box(parent, stripeMat, 0, 11.2, -129.8, 16, .42, 7);
  }
  neonSegment(parent) {
    const rng = random(414), towers = [], windows = [], neonPoles = [];
    for (let i = 0; i < 56; i++) {
      const x = (i % 2 ? -1 : 1) * (8 + rng() * 29), z = -rng() * 160, height = 4 + rng() * 24;
      const width = 2 + rng() * 3.3;
      towers.push({ x, z, y: height / 2, sx: width, sy: height, sz: width });
      for (let y = 2; y < height; y += 2.4) windows.push({ x, y, z: z + width / 2 + .02, sx: width * .68, sy: .06, sz: .04 });
    }
    this.instanced(parent, new THREE.BoxGeometry(1, 1, 1), material(0xffffff, { metalness: .3 }), towers, (_, i) => [0x282944, 0x343253, 0x252f48][i % 3]);
    this.instanced(parent, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), windows, (_, i) => i % 3 ? 0x547c9c : 0xec7ebc);
    const postMat = material(0x69ecff, { emissive: 0x69ecff, emissiveIntensity: 1.1 });
    for (const side of [-1, 1]) for (let i = 0; i < 18; i++) neonPoles.push({ x: side * 5.2, y: 1, z: -i * 9 - 3, sx: .055, sy: 2, sz: .055 });
    this.instanced(parent, new THREE.BoxGeometry(1, 1, 1), postMat, neonPoles);
    const purple = material(0xaa77e5, { emissive: 0x7f44bd, emissiveIntensity: .8 });
    for (let i = 0; i < 3; i++) {
      const ring = addMesh(parent, new THREE.TorusGeometry(6.7, .08, 5, 6), purple, 0, 4.2, -45 - i * 52);
      ring.rotation.z = Math.PI / 6;
    }
  }
  makeRunner() {
    this.runner = new THREE.Group(); this.runner.position.set(0, 0, 4); this.scene.add(this.runner);
    this.body = new THREE.Group(); this.runner.add(this.body);
    const skin = material(0xe8b190), jersey = material(0xff805f), sleeve = material(0xffb18a);
    const ink = material(0x253d51), shoe = material(0x73dfcf), sole = material(0xf8e6cc);
    const hair = material(0x403747), backpack = material(0x3b7277);
    addMesh(this.body, new THREE.CapsuleGeometry(.35, .47, 3, 7), jersey, 0, 1.29, 0, 1.15, 1, .8);
    box(this.body, ink, 0, .86, 0, .64, .34, .45);
    addMesh(this.body, new THREE.SphereGeometry(.31, 9, 7), skin, 0, 1.98, -.03, 1, 1.12, 1);
    addMesh(this.body, new THREE.SphereGeometry(.33, 9, 7), hair, 0, 2.12, .025, 1, .66, 1.06);
    addMesh(this.body, new THREE.IcosahedronGeometry(.13, 1), hair, .23, 2.21, .17);
    box(this.body, backpack, 0, 1.35, .29, .48, .49, .15);
    box(this.body, sole, 0, 1.38, .38, .26, .045, .03);
    box(this.body, sleeve, -.21, 1.45, .3, .055, .5, .035);
    box(this.body, sleeve, .21, 1.45, .3, .055, .5, .035);
    this.arms = []; this.legs = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Group(); arm.position.set(side * .43, 1.59, 0); this.body.add(arm);
      addMesh(arm, new THREE.CapsuleGeometry(.105, .29, 2, 5), sleeve, 0, -.18, 0);
      addMesh(arm, new THREE.CapsuleGeometry(.085, .24, 2, 5), skin, 0, -.46, -.035);
      addMesh(arm, new THREE.SphereGeometry(.104, 7, 5), skin, 0, -.66, -.05);
      this.arms.push(arm);
      const leg = new THREE.Group(); leg.position.set(side * .19, .83, 0); this.body.add(leg);
      addMesh(leg, new THREE.CapsuleGeometry(.12, .46, 2, 5), ink, 0, -.28, 0);
      box(leg, shoe, 0, -.7, -.07, .27, .2, .46);
      box(leg, sole, 0, -.81, -.07, .28, .055, .46);
      this.legs.push(leg);
    }
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x112e38, transparent: true, opacity: .28, depthWrite: false });
    this.shadow = addMesh(this.scene, new THREE.CircleGeometry(.64, 24), shadowMat, 0, .07, 4, 1, .7, 1);
    this.shadow.rotation.x = -Math.PI / 2;
    this.aura = addMesh(this.runner, new THREE.TorusGeometry(.88, .027, 5, 24), new THREE.MeshBasicMaterial({ color: 0xffd568, transparent: true, opacity: .8 }), 0, 1.1, 0);
    this.aura.visible = false;
  }
  makeCoinPool() {
    const geo = new THREE.CylinderGeometry(.27, .27, .085, 10);
    geo.rotateX(Math.PI / 2);
    this.coinMesh = new THREE.InstancedMesh(geo, material(0xffd767, { metalness: .62, roughness: .3, emissive: 0xc78529, emissiveIntensity: .22 }), 100);
    this.coinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.coinMesh.frustumCulled = false;
    this.scene.add(this.coinMesh);
    const glowGeo = new THREE.TorusGeometry(.2, .028, 4, 10);
    this.coinRims = new THREE.InstancedMesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xffefb1 }), 100);
    this.coinRims.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.coinRims.frustumCulled = false;
    this.scene.add(this.coinRims);
  }
  makeObstacles() {
    if (this.obstacles) {
      this.scene.remove(this.obstacles);
      const geometries = new Set(), materials = new Set();
      this.obstacles.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) materials.add(o.material); });
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
    }
    this.obstacles = new THREE.Group(); this.obstacleMeshes = [];
    const teal = material(0x83e0cd), dark = material(0x304b54), orange = material(0xffa173);
    const gold = material(0xffd98a, { emissive: 0xc57d28, emissiveIntensity: .3 });
    const light = material(0xffedce), blue = material(0x5f9b9b);
    const glow = new THREE.MeshBasicMaterial({ color: 0xffd884 });
    for (const event of this.session.events) {
      const group = new THREE.Group();
      if (event.kind === 'jump') {
        const beam = addMesh(group, new THREE.CylinderGeometry(.32, .35, 7.7, 7), orange, 0, .63, 0);
        beam.rotation.z = Math.PI / 2;
        for (const x of [-3.7, -1.2, 1.2, 3.7]) {
          box(group, dark, x, .3, 0, .15, .6, .55);
          box(group, light, x, .86, .02, .3, .06, .48);
        }
        const arrow = addMesh(group, new THREE.ConeGeometry(.22, .3, 3), light, 0, 1.29, 0);
        arrow.rotation.z = 0;
      } else if (event.kind === 'duck') {
        for (const side of [-1, 1]) box(group, dark, side * 3.75, 1.45, 0, .22, 2.9, .38);
        box(group, teal, 0, 1.73, 0, 7.8, .77, .47);
        box(group, blue, 0, 2.25, 0, 7.9, .14, .55);
        for (const x of [-2.45, 0, 2.45]) {
          const arrow = addMesh(group, new THREE.ConeGeometry(.22, .32, 3), light, x, 1.74, .28);
          arrow.rotation.z = Math.PI;
        }
      } else if (event.kind === 'clap') {
        const ring = addMesh(group, new THREE.TorusGeometry(3.5, .105, 6, 6), gold, 0, 2.6, 0);
        ring.rotation.z = Math.PI / 6;
        const inner = addMesh(group, new THREE.TorusGeometry(3.22, .025, 4, 6), glow, 0, 2.6, .02);
        inner.rotation.z = Math.PI / 6;
        for (const side of [-1, 1]) {
          box(group, dark, side * 3.5, .3, 0, .55, .6, .65);
          addMesh(group, new THREE.OctahedronGeometry(.24, 0), gold, side * 1.6, 3.95, 0);
        }
        addMesh(group, new THREE.OctahedronGeometry(.42, 0), gold, 0, 4.45, 0);
      } else {
        for (const lane of [-1, 0, 1]) if (lane !== event.targetLane) {
          const x = lane * LANE_WIDTH;
          box(group, dark, x, 1.03, 0, 1.93, 2, .85);
          box(group, orange, x, 1.08, .46, 1.73, .22, .055);
          box(group, orange, x, 1.65, .46, 1.73, .14, .055);
          box(group, light, x, 2.05, 0, 2.02, .07, .92);
        }
        const arrow = addMesh(group, new THREE.ConeGeometry(.27, .42, 3), teal, event.targetLane * LANE_WIDTH, .8, .2);
        arrow.rotation.x = Math.PI / 2;
      }
      group.visible = false; this.obstacles.add(group); this.obstacleMeshes.push(group);
    }
    this.scene.add(this.obstacles);
  }
  makeParticles() {
    this.particles = []; this.particlePositions = new Float32Array(120 * 3); this.particleColors = new Float32Array(120 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.particleMesh = new THREE.Points(geometry, new THREE.PointsMaterial({ size: .12, vertexColors: true, transparent: true, opacity: .85, depthWrite: false }));
    this.particleMesh.frustumCulled = false; this.scene.add(this.particleMesh);
    // Sparse ambient motes add depth without a texture or a post-processing pass.
    const rng = random(882), positions = new Float32Array(75 * 3);
    for (let i = 0; i < 75; i++) { positions[i * 3] = (rng() - .5) * 30; positions[i * 3 + 1] = 1 + rng() * 10; positions[i * 3 + 2] = -rng() * 100; }
    const motesGeo = new THREE.BufferGeometry(); motesGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.motes = new THREE.Points(motesGeo, new THREE.PointsMaterial({ color: 0xffdfad, size: .055, transparent: true, opacity: .65 })); this.scene.add(this.motes);
  }
  burst(lane, success = false) {
    const color = new THREE.Color(success ? 0x8bffe0 : 0xffd980);
    for (let i = 0; i < (success ? 25 : 7) && this.particles.length < 120; i++) this.particles.push({
      x: lane * LANE_WIDTH, y: 1.25, z: 4, vx: (Math.random() - .5) * 3.5,
      vy: 1 + Math.random() * 4, vz: (Math.random() - .5) * 2, life: .45 + Math.random() * .45, color
    });
  }
  updateParticles(dt) {
    this.particles = this.particles.filter(p => (p.life -= dt) > 0);
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]; p.vy -= dt * 7; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      this.particlePositions.set([p.x, p.y, p.z], i * 3);
      this.particleColors.set([p.color.r, p.color.g, p.color.b], i * 3);
    }
    this.particleMesh.geometry.setDrawRange(0, this.particles.length);
    this.particleMesh.geometry.attributes.position.needsUpdate = true;
    this.particleMesh.geometry.attributes.color.needsUpdate = true;
  }
  updateRunner(dt, active) {
    const s = this.session, t = this.visualTime;
    const lane = active ? s.lane : 0;
    this.runner.position.x = smooth(this.runner.position.x, lane * LANE_WIDTH, 13, dt);
    const jumping = active ? s.jumpHeight : 0;
    const duck = active && s.ducking, clap = active && s.clapping;
    const stride = t * (active ? Math.max(5, s.speed * .85) : 8);
    this.runner.position.y = jumping + (jumping ? 0 : Math.abs(Math.sin(stride)) * .055);
    const lean = Math.max(-.2, Math.min(.2, (lane * LANE_WIDTH - this.runner.position.x) * -.1));
    this.runner.rotation.z = smooth(this.runner.rotation.z, lean, 8, dt);
    this.body.scale.y = smooth(this.body.scale.y, duck ? .52 : 1, 18, dt);
    this.body.rotation.x = smooth(this.body.rotation.x, duck ? -.2 : -.035, 10, dt);
    for (let i = 0; i < 2; i++) {
      const sign = i ? 1 : -1;
      this.legs[i].rotation.x = jumping ? sign * .55 : Math.sin(stride + i * Math.PI) * .77;
      this.arms[i].rotation.x = clap ? 0 : jumping ? -.8 : Math.sin(stride + i * Math.PI + Math.PI) * .7;
      this.arms[i].rotation.z = smooth(this.arms[i].rotation.z, clap ? -sign * 2.66 : -sign * .12, 20, dt);
    }
    this.shadow.position.x = this.runner.position.x;
    this.shadow.material.opacity = .28 / (1 + jumping * .5);
    this.shadow.scale.set(1 - jumping * .12, .7 - jumping * .06, 1);
    this.aura.visible = active && s.time < s.magnetUntil;
    if (this.aura.visible) { this.aura.rotation.y = t * 2; this.aura.rotation.z = t; }
  }
  updateCourse(distance) {
    let count = 0;
    for (const coin of this.session.coinsList) {
      if (coin.claimed || coin.distance < distance - 6 || coin.distance > distance + 130) continue;
      if (count >= 100) break;
      this.dummy.position.set(coin.lane * LANE_WIDTH, 1.22 + Math.sin(this.visualTime * 3 + coin.distance) * .09, 4 - (coin.distance - distance));
      this.dummy.rotation.set(0, this.visualTime * 2.7 + coin.distance * .06, 0); this.dummy.scale.setScalar(1); this.dummy.updateMatrix();
      this.coinMesh.setMatrixAt(count, this.dummy.matrix);
      this.dummy.translateZ(.049); this.dummy.updateMatrix(); this.coinRims.setMatrixAt(count, this.dummy.matrix); count++;
    }
    this.coinMesh.count = count; this.coinRims.count = count;
    this.coinMesh.instanceMatrix.needsUpdate = true; this.coinRims.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.session.events.length; i++) {
      const event = this.session.events[i], mesh = this.obstacleMeshes[i];
      const ahead = event.distance - distance;
      mesh.visible = !event.cancelled && ahead > -10 && ahead < 150;
      if (!mesh.visible) continue;
      mesh.position.z = 4 - ahead;
      mesh.position.y = event.success ? -Math.min(6, Math.max(0, -ahead) * .7) : 0;
      if (event.kind === 'clap') mesh.rotation.z = Math.sin(this.visualTime * 1.6) * .025;
    }
  }
  frame(now) {
    if (this.disposed) return;
    const dt = Math.min(.05, Math.max(0, (now - this.lastFrame) / 1000)); this.lastFrame = now;
    const playing = this.status === 'running', paused = this.status === 'paused', active = playing || paused || this.status === 'finished';
    if (!paused) this.visualTime += dt;
    if (playing) {
      this.session.step(dt);
      for (const event of this.session.drainEvents()) {
        if (event.kind === 'coin') this.burst(event.lane);
        if (event.kind === 'success') this.burst(this.session.lane, true);
        if (event.kind === 'miss') this.hitFlash = .35;
        this.callbacks.onFeedback?.(event);
      }
      if (this.visualTime - this.lastReport > .09) {
        this.callbacks.onStats?.(this.session.stats); this.callbacks.onCue?.(this.session.cue); this.lastReport = this.visualTime;
      }
      if (this.session.finished) {
        this.status = 'finished'; this.callbacks.onStats?.(this.session.stats);
        this.callbacks.onCue?.(null); this.callbacks.onFinish?.(this.session.stats);
      }
    } else if (this.status === 'attract') this.attractDistance = (this.attractDistance + dt * 4.5) % 650;
    const distance = active ? this.session.distance : this.attractDistance;
    const scroll = distance % 160;
    this.segments[this.world].forEach((g, i) => { g.position.z = scroll - i * 160; });
    this.laneDashes.position.z = distance % 5; this.roadTiles.position.z = distance % 7;
    this.ripples.position.z = distance * .25 % 5;
    this.motes.position.z = distance * .7 % 25;
    this.clouds.rotation.y = Math.sin(this.visualTime * .018) * .06;
    this.updateRunner(paused ? 0 : dt, active); this.updateCourse(distance); this.updateParticles(paused ? 0 : dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    const shake = this.hitFlash * Math.sin(this.visualTime * 80) * .11;
    this.camera.position.x = smooth(this.camera.position.x, active ? this.runner.position.x * .19 + shake : Math.sin(this.visualTime * .13) * .45, 3, dt);
    this.camera.position.y = smooth(this.camera.position.y, active ? 5.5 + this.session.jumpHeight * .08 : 5.8, 2, dt);
    this.camera.lookAt(this.camera.position.x * .4, 1.4, -16);
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.frame);
  }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.raf); this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.resize); document.removeEventListener('visibilitychange', this.onVisibility);
    const geometries = new Set(), materials = new Set();
    this.scene.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m)); });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); this.renderer.dispose();
  }
}

export { RunSession, WORLDS, DIFFICULTIES } from './game-logic.js';
