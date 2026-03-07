import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const WORLD_SIZE = 100;
const GROUND_Y = 0;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function ensureMaterialColor(material, color) {
  if (!material || !material.color) return;
  material.color.setHex(color);
}

function createLobsterModel() {
  const group = new THREE.Group();

  const bodyGeometry = new THREE.CapsuleGeometry(0.3, 1.2, 8, 16);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xff4444,
    roughness: 0.5,
    metalness: 0.3
  });
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  body.rotation.z = Math.PI / 2;
  body.castShadow = true;
  group.add(body);

  for (let i = 0; i < 3; i += 1) {
    const segmentGeometry = new THREE.BoxGeometry(0.4 - i * 0.05, 0.5 - i * 0.1, 0.3 - i * 0.05);
    const segment = new THREE.Mesh(segmentGeometry, bodyMaterial);
    segment.position.set(-0.7 - i * 0.45, 0, 0);
    segment.castShadow = true;
    group.add(segment);
  }

  const clawGeometry = new THREE.BoxGeometry(0.6, 0.2, 0.2);
  const leftClaw = new THREE.Mesh(clawGeometry, bodyMaterial);
  leftClaw.position.set(0.8, 0.4, 0);
  leftClaw.castShadow = true;
  group.add(leftClaw);

  const rightClaw = new THREE.Mesh(clawGeometry, bodyMaterial);
  rightClaw.position.set(0.8, -0.4, 0);
  rightClaw.castShadow = true;
  group.add(rightClaw);

  const antennaGeometry = new THREE.CylinderGeometry(0.02, 0.02, 0.8);
  const antennaMaterial = new THREE.MeshStandardMaterial({ color: 0xcc3333 });
  const leftAntenna = new THREE.Mesh(antennaGeometry, antennaMaterial);
  leftAntenna.position.set(0.8, 0.15, 0.2);
  leftAntenna.rotation.z = Math.PI / 6;
  group.add(leftAntenna);

  const rightAntenna = new THREE.Mesh(antennaGeometry, antennaMaterial);
  rightAntenna.position.set(0.8, -0.15, 0.2);
  rightAntenna.rotation.z = -Math.PI / 6;
  group.add(rightAntenna);

  return group;
}

function createTextSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(4, 18, 32, 0.75)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e6f9ff';
  ctx.font = 'bold 24px Trebuchet MS';
  ctx.fillText(String(text || ''), 10, 42);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(7, 1.7, 1);
  return { sprite, texture, canvas };
}

function createMoonlightTexture({
  size = 768,
  coreAlpha = 0.42,
  midAlpha = 0.24,
  edgeAlpha = 0.0,
  breakup = 0.08
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * 0.5;

  ctx.clearRect(0, 0, size, size);

  const gradient = ctx.createRadialGradient(cx, cy, size * 0.07, cx, cy, maxR);
  gradient.addColorStop(0, `rgba(226, 242, 255, ${coreAlpha})`);
  gradient.addColorStop(0.34, `rgba(191, 224, 255, ${midAlpha})`);
  gradient.addColorStop(0.74, `rgba(164, 208, 255, ${edgeAlpha + 0.06})`);
  gradient.addColorStop(1, `rgba(150, 200, 255, ${edgeAlpha})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  // Add fine-grain breakup so the light spread looks more organic.
  ctx.globalCompositeOperation = 'destination-in';
  const grain = ctx.createImageData(size, size);
  const data = grain.data;
  for (let i = 0; i < data.length; i += 4) {
    const x = ((i / 4) % size) - cx;
    const y = Math.floor((i / 4) / size) - cy;
    const d = Math.min(1, Math.sqrt((x * x) + (y * y)) / maxR);
    const mask = 1 - d;
    const n = (Math.random() * 2 - 1) * breakup;
    const alpha = Math.max(0, Math.min(1, mask + n));
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = Math.round(alpha * 255);
  }
  ctx.putImageData(grain, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createGlowTexture({
  size = 512,
  inner = 'rgba(255,245,210,0.95)',
  mid = 'rgba(255,220,140,0.45)',
  outer = 'rgba(255,180,80,0.0)'
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  const gradient = ctx.createRadialGradient(c, c, size * 0.03, c, c, size * 0.5);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(0.38, mid);
  gradient.addColorStop(1, outer);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function randomRange(min, max) {
  return min + (Math.random() * (max - min));
}

function createCloudTexture({ size = 384 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  ctx.clearRect(0, 0, size, size);
  const puffCount = 5 + Math.floor(Math.random() * 5);

  for (let i = 0; i < puffCount; i += 1) {
    const r = randomRange(size * 0.11, size * 0.2);
    const px = cx + randomRange(-size * 0.2, size * 0.2);
    const py = cy + randomRange(-size * 0.12, size * 0.12);
    const alpha = randomRange(0.16, 0.36);

    const gradient = ctx.createRadialGradient(px, py, r * 0.12, px, py, r);
    gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createCloudTexturePool(count = 18) {
  const pool = [];
  for (let i = 0; i < count; i += 1) {
    pool.push(createCloudTexture({ size: 256 }));
  }
  return pool;
}

function celestialPosition(timeHours, phaseOffsetHours = 0) {
  const t = ((((timeHours + phaseOffsetHours) % 24) + 24) % 24) / 24;
  const orbitAngle = (t * Math.PI * 2) - (Math.PI / 2);
  const elevation = Math.sin(orbitAngle); // -1..1 (below -> above horizon)
  const azimuth = orbitAngle;
  const horizontalRadius = 74;

  return {
    x: 50 + (Math.cos(azimuth) * horizontalRadius),
    y: 16 + (elevation * 52),
    z: 50 + (Math.sin(azimuth) * horizontalRadius * 0.82),
    elevation
  };
}

function positionBeamBetween(mesh, from, to, baseHeight = 44) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = Math.max(0.001, dir.length());
  mesh.position.copy(from).addScaledVector(dir, 0.5);
  mesh.scale.set(1, len / baseHeight, 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
}

function measureLobsterPhysics(mesh) {
  mesh.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(mesh);
  const baseY = Math.max(0.01, GROUND_Y - bounds.min.y + 0.02);
  return { baseY };
}

export class Example3DWorld {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x6ba3d4);
    this.scene.fog = new THREE.Fog(0x6ba3d4, 50, 200);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    this.camera.position.set(50, 50, -20);
    this.camera.lookAt(50, 0, 50);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(50, 0, 50);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 200;

    this.lobsters = new Map();
    this.foodMeshes = new Map();
    this.hazardMeshes = new Map();
    this.rescueMeshes = new Map();
    this.clouds = [];
    this.lastCloudUpdateAt = null;
    this.cloudUpdateAccumulator = 0;
    this.cloudTexturePool = createCloudTexturePool(20);

    this.clockLabel = createTextSprite('');
    this.clockLabel.sprite.position.set(10, 7, 10);
    this.scene.add(this.clockLabel.sprite);

    this.createWorld();
    this.createCloudField();
    this.resize();
    this.onWindowResize = () => this.resize();
    window.addEventListener('resize', this.onWindowResize);
    this.resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }
  }

  createWorld() {
    this.ambient = new THREE.AmbientLight(0xffffff, 3.5);
    this.scene.add(this.ambient);

    this.directional = new THREE.DirectionalLight(0xffffff, 1.2);
    this.directional.position.set(50, 100, 50);
    this.directional.castShadow = true;
    this.directional.shadow.camera.left = -100;
    this.directional.shadow.camera.right = 100;
    this.directional.shadow.camera.top = 100;
    this.directional.shadow.camera.bottom = -100;
    this.scene.add(this.directional);

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(WORLD_SIZE, 3, WORLD_SIZE),
      new THREE.MeshStandardMaterial({
        color: 0xc2b280,
        roughness: 0.8,
        metalness: 0.2,
        side: THREE.DoubleSide
      })
    );
    floor.position.set(50, -1.5, 50);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Night effect: circular moonlight zone centered on the floor.
    this.moonDiscTexture = createMoonlightTexture({
      coreAlpha: 0.48,
      midAlpha: 0.3,
      edgeAlpha: 0.0,
      breakup: 0.06
    });
    this.moonCoreTexture = createMoonlightTexture({
      coreAlpha: 0.34,
      midAlpha: 0.14,
      edgeAlpha: 0.0,
      breakup: 0.04
    });

    this.moonDisc = new THREE.Mesh(
      new THREE.CircleGeometry(44, 72),
      new THREE.MeshBasicMaterial({
        map: this.moonDiscTexture,
        color: 0xb7dbff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.NormalBlending
      })
    );
    this.moonDisc.rotation.x = -Math.PI / 2;
    this.moonDisc.position.set(50, 0.04, 50);
    this.scene.add(this.moonDisc);

    this.moonDiscCore = new THREE.Mesh(
      new THREE.CircleGeometry(28, 64),
      new THREE.MeshBasicMaterial({
        map: this.moonCoreTexture,
        color: 0xdcf0ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.NormalBlending
      })
    );
    this.moonDiscCore.rotation.x = -Math.PI / 2;
    this.moonDiscCore.position.set(50, 0.055, 50);
    this.scene.add(this.moonDiscCore);

    this.moonBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(10, 18, 44, 40, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xaed8ff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, -1, 0), GROUND_Y)]
      })
    );
    this.moonBeam.position.set(50, 22, 50);
    this.scene.add(this.moonBeam);

    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(3.8, 28, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd777 })
    );
    this.scene.add(this.sunMesh);

    this.moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(2.7, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xd8e9ff })
    );
    this.scene.add(this.moonMesh);

    this.sunGlowTexture = createGlowTexture();
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.sunGlowTexture,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }));
    this.sunGlow.scale.set(18, 18, 1);
    this.scene.add(this.sunGlow);

    this.sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(36, 68),
      new THREE.MeshBasicMaterial({
        map: this.moonDiscTexture,
        color: 0xffd986,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.NormalBlending
      })
    );
    this.sunDisc.rotation.x = -Math.PI / 2;
    this.sunDisc.position.set(50, 0.05, 50);
    this.scene.add(this.sunDisc);

    this.sunDiscCore = new THREE.Mesh(
      new THREE.CircleGeometry(24, 60),
      new THREE.MeshBasicMaterial({
        map: this.moonCoreTexture,
        color: 0xfff2bd,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.NormalBlending
      })
    );
    this.sunDiscCore.rotation.x = -Math.PI / 2;
    this.sunDiscCore.position.set(50, 0.065, 50);
    this.scene.add(this.sunDiscCore);

    this.moonLight = new THREE.SpotLight(0xaad4ff, 0);
    this.moonLight.position.set(50, 38, 50);
    this.moonLight.angle = 0.7;
    this.moonLight.penumbra = 0.8;
    this.moonLight.decay = 1.35;
    this.moonLight.distance = 170;
    this.moonLight.target.position.set(50, 0, 50);
    this.scene.add(this.moonLight);
    this.scene.add(this.moonLight.target);
  }

  createCloudField() {
    const requestedCount = 100 + Math.floor(Math.random() * 901);
    const cloudCount = Math.min(requestedCount, this.getAdaptiveCloudBudget());
    for (let i = 0; i < cloudCount; i += 1) {
      const cloud = this.spawnCloud({ initial: true });
      this.clouds.push(cloud);
      this.scene.add(cloud.sprite);
    }
  }

  getAdaptiveCloudBudget() {
    const cores = navigator.hardwareConcurrency || 4;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bounds = this.container.getBoundingClientRect();
    const pixels = Math.max(1, bounds.width * bounds.height * dpr * dpr);
    const pixelFactor = clamp(1_600_000 / pixels, 0.35, 1.1);
    const base = 420 * pixelFactor * (cores >= 8 ? 1 : 0.72);
    return Math.max(100, Math.floor(base));
  }

  spawnCloud({ initial = false } = {}) {
    const texture = this.cloudTexturePool[Math.floor(Math.random() * this.cloudTexturePool.length)];
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: initial ? randomRange(0.2, 0.45) : 0,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    const scale = randomRange(18, 36);
    sprite.scale.set(scale, scale * randomRange(0.42, 0.68), 1);

    const cloud = {
      sprite,
      texture,
      speed: randomRange(1.4, 3.1),
      drift: randomRange(-0.28, 0.28),
      ttl: randomRange(30, 56),
      fadeIn: randomRange(2.8, 6.2),
      fadeOut: randomRange(4.8, 9.0),
      age: initial ? randomRange(0, 10) : 0,
      seed: Math.random() * Math.PI * 2
    };

    this.resetCloud(cloud, { initial });
    return cloud;
  }

  resetCloud(cloud, { initial = false } = {}) {
    cloud.age = initial ? randomRange(0, 10) : 0;
    cloud.ttl = randomRange(30, 56);
    cloud.fadeIn = randomRange(2.8, 6.2);
    cloud.fadeOut = randomRange(4.8, 9.0);
    cloud.speed = randomRange(1.4, 3.1);
    cloud.drift = randomRange(-0.28, 0.28);
    cloud.seed = Math.random() * Math.PI * 2;

    const spawnSide = Math.random() > 0.5 ? -1 : 1;
    cloud.sprite.position.set(
      spawnSide < 0 ? randomRange(-28, 4) : randomRange(96, 128),
      randomRange(42, 68),
      randomRange(8, 92)
    );

    const scale = randomRange(18, 36);
    cloud.sprite.scale.set(scale, scale * randomRange(0.42, 0.68), 1);

    if (!initial) {
      cloud.texture = this.cloudTexturePool[Math.floor(Math.random() * this.cloudTexturePool.length)];
      cloud.sprite.material.map = cloud.texture;
      cloud.sprite.material.needsUpdate = true;
      cloud.sprite.material.opacity = 0;
    }
  }

  updateClouds(dt, dayStrength) {
    if (!this.clouds.length) return;
    // Throttle cloud simulation to avoid over-updating large cloud counts.
    this.cloudUpdateAccumulator += dt;
    if (this.cloudUpdateAccumulator < (1 / 24)) return;
    dt = this.cloudUpdateAccumulator;
    this.cloudUpdateAccumulator = 0;

    const baseVisibility = 0.08 + (dayStrength * 0.38);

    this.clouds.forEach((cloud) => {
      cloud.age += dt;
      const t = cloud.age;
      const life = cloud.ttl;
      const fadeIn = cloud.fadeIn;
      const fadeOut = cloud.fadeOut;

      let alpha = 1;
      if (t < fadeIn) alpha = t / Math.max(0.001, fadeIn);
      if (t > life - fadeOut) alpha = Math.min(alpha, (life - t) / Math.max(0.001, fadeOut));
      alpha = Math.max(0, Math.min(1, alpha));

      cloud.sprite.material.opacity = alpha * baseVisibility;

      cloud.sprite.position.x += cloud.speed * dt;
      cloud.sprite.position.z += Math.sin((t * 0.3) + cloud.seed) * cloud.drift * dt;

      const yWave = Math.sin((t * 0.24) + cloud.seed) * 0.35;
      cloud.sprite.position.y = clamp(cloud.sprite.position.y + (yWave * dt), 39, 72);

      if (t >= life || cloud.sprite.position.x > 132 || cloud.sprite.position.x < -32) {
        this.resetCloud(cloud, { initial: false });
      }
    });
  }

  resize() {
    const bounds = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || this.container.clientWidth || 1));
    const height = Math.max(1, Math.round(bounds.height || this.container.clientHeight || 1));
    // Keep canvas CSS at 100% of container; only update drawing buffer size.
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  getOrCreateLobster(lobster) {
    if (this.lobsters.has(lobster.id)) return this.lobsters.get(lobster.id);

    const mesh = createLobsterModel();
    mesh.position.set(lobster.position.x, 0, lobster.position.z);
    mesh.rotation.y = 0;
    const physics = measureLobsterPhysics(mesh);
    mesh.position.y = physics.baseY;
    this.scene.add(mesh);

    const tag = createTextSprite(lobster.name);
    tag.sprite.position.set(lobster.position.x, physics.baseY + 2.4, lobster.position.z);
    this.scene.add(tag.sprite);

    const record = { mesh, tag, baseY: physics.baseY };
    this.lobsters.set(lobster.id, record);
    return record;
  }

  syncFoods(foods = []) {
    const ids = new Set(foods.map((f) => f.id));

    for (const [id, mesh] of this.foodMeshes) {
      if (!ids.has(id)) {
        this.scene.remove(mesh);
        this.foodMeshes.delete(id);
      }
    }

    foods.forEach((food) => {
      let mesh = this.foodMeshes.get(food.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.35, 10, 10),
          new THREE.MeshStandardMaterial({ color: 0x6ce070, roughness: 0.4 })
        );
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.foodMeshes.set(food.id, mesh);
      }
      mesh.position.set(clamp(food.x, 0, 100), 0.3, clamp(food.z, 0, 100));
    });
  }

  syncHazards(hazards = []) {
    const ids = new Set(hazards.map((h) => h.id));

    for (const [id, mesh] of this.hazardMeshes) {
      if (!ids.has(id)) {
        this.scene.remove(mesh);
        this.hazardMeshes.delete(id);
      }
    }

    hazards.forEach((hazard) => {
      let mesh = this.hazardMeshes.get(hazard.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(hazard.radius, hazard.radius, 0.2, 24),
          new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.35, color: 0x00c2ff })
        );
        mesh.position.y = 0.12;
        this.scene.add(mesh);
        this.hazardMeshes.set(hazard.id, mesh);
      }

      const color = hazard.type === 'toxic' ? 0xff5a5f : hazard.type === 'predator' ? 0xffd166 : 0x00c2ff;
      ensureMaterialColor(mesh.material, color);
      mesh.scale.set(1, 1, 1);
      mesh.position.set(clamp(hazard.x, 0, 100), 0.12, clamp(hazard.z, 0, 100));
    });
  }

  syncRescues(rescues = []) {
    const ids = new Set(rescues.map((r) => r.id));

    for (const [id, mesh] of this.rescueMeshes) {
      if (!ids.has(id)) {
        this.scene.remove(mesh);
        this.rescueMeshes.delete(id);
      }
    }

    rescues.forEach((rescue) => {
      let mesh = this.rescueMeshes.get(rescue.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.TorusGeometry(1.4, 0.15, 12, 24),
          new THREE.MeshStandardMaterial({ color: 0xff9f1c })
        );
        mesh.rotation.x = Math.PI / 2;
        this.scene.add(mesh);
        this.rescueMeshes.set(rescue.id, mesh);
      }
      ensureMaterialColor(mesh.material, rescue.rescuedBy ? 0x7ae582 : 0xff9f1c);
      mesh.position.set(clamp(rescue.x, 0, 100), 0.22, clamp(rescue.z, 0, 100));
    });
  }

  updateCelestialBodies(timeHours = 12) {
    const sun = celestialPosition(timeHours, 0);
    const moon = celestialPosition(timeHours, 12);

    this.sunMesh.position.set(sun.x, sun.y, sun.z);
    this.moonMesh.position.set(moon.x, moon.y, moon.z);
    this.sunGlow.position.set(sun.x, sun.y, sun.z);
    this.sunMesh.visible = sun.elevation > -0.24;
    this.moonMesh.visible = moon.elevation > -0.35;
    this.sunGlow.visible = this.sunMesh.visible;

    this.directional.position.set(sun.x, Math.max(8, sun.y), sun.z);

    const moonTarget = new THREE.Vector3(
      clamp(50 + ((50 - moon.x) * 0.42), 8, 92),
      GROUND_Y + 0.02,
      clamp(50 + ((50 - moon.z) * 0.42), 8, 92)
    );
    const sunTarget = new THREE.Vector3(
      clamp(50 + ((50 - sun.x) * 0.35), 6, 94),
      GROUND_Y,
      clamp(50 + ((50 - sun.z) * 0.35), 6, 94)
    );
    const moonPos = new THREE.Vector3(moon.x, moon.y, moon.z);
    const sunPos = new THREE.Vector3(sun.x, sun.y, sun.z);
    // Always update targets so projection stays continuous and never appears cut off.
    this.moonLight.position.copy(moonPos);
    this.moonLight.target.position.copy(moonTarget);
    this.moonDisc.position.set(moonTarget.x, 0.04, moonTarget.z);
    this.moonDiscCore.position.set(moonTarget.x, 0.055, moonTarget.z);
    positionBeamBetween(this.moonBeam, moonPos, moonTarget, 44);

    this.sunDisc.position.set(sunTarget.x, 0.05, sunTarget.z);
    this.sunDiscCore.position.set(sunTarget.x, 0.065, sunTarget.z);
    return { sunElevation: sun.elevation, moonElevation: moon.elevation };
  }

  setPhaseLighting(phase, { sunElevation = 0, moonElevation = 0 } = {}) {
    const dayStrength = clamp(sunElevation, 0, 1);
    const moonStrength = clamp(moonElevation, 0, 1);

    if (phase === 'night') {
      this.scene.background.setHex(0x0b1a2e);
      this.scene.fog.color.setHex(0x0b1a2e);
      this.ambient.intensity = 0.38 + (moonStrength * 0.35);
      this.directional.intensity = 0.08 + (dayStrength * 0.25);
      this.moonDisc.material.opacity = 0.18 + (moonStrength * 0.26);
      this.moonDiscCore.material.opacity = 0.08 + (moonStrength * 0.22);
      this.moonBeam.material.opacity = 0.04 + (moonStrength * 0.13);
      this.moonLight.intensity = 1.2 + (moonStrength * 2.2);
      this.sunDisc.material.opacity = 0;
      this.sunDiscCore.material.opacity = 0;
      this.sunGlow.material.opacity = 0.18;
    } else if (phase === 'dusk') {
      this.scene.background.setHex(0x5c5470);
      this.scene.fog.color.setHex(0x5c5470);
      this.ambient.intensity = 0.85 + (dayStrength * 0.75);
      this.directional.intensity = 0.35 + (dayStrength * 0.75);
      this.moonDisc.material.opacity = 0.05 + (moonStrength * 0.16);
      this.moonDiscCore.material.opacity = 0.03 + (moonStrength * 0.09);
      this.moonBeam.material.opacity = 0.02 + (moonStrength * 0.06);
      this.moonLight.intensity = moonStrength * 1.3;
      this.sunDisc.material.opacity = 0.08 + (dayStrength * 0.16);
      this.sunDiscCore.material.opacity = 0.05 + (dayStrength * 0.1);
      this.sunGlow.material.opacity = 0.42 + (dayStrength * 0.2);
    } else if (phase === 'morning') {
      this.scene.background.setHex(0x6ba3d4);
      this.scene.fog.color.setHex(0x6ba3d4);
      this.ambient.intensity = 1.8 + (dayStrength * 1.2);
      this.directional.intensity = 0.65 + (dayStrength * 0.75);
      this.moonDisc.material.opacity = 0;
      this.moonDiscCore.material.opacity = 0;
      this.moonBeam.material.opacity = 0;
      this.moonLight.intensity = 0;
      this.sunDisc.material.opacity = 0.15 + (dayStrength * 0.19);
      this.sunDiscCore.material.opacity = 0.09 + (dayStrength * 0.12);
      this.sunGlow.material.opacity = 0.7 + (dayStrength * 0.2);
    } else {
      this.scene.background.setHex(0x77b5de);
      this.scene.fog.color.setHex(0x77b5de);
      this.ambient.intensity = 2.4 + (dayStrength * 1.2);
      this.directional.intensity = 0.8 + (dayStrength * 1.1);
      this.moonDisc.material.opacity = 0;
      this.moonDiscCore.material.opacity = 0;
      this.moonBeam.material.opacity = 0;
      this.moonLight.intensity = 0;
      this.sunDisc.material.opacity = 0.24 + (dayStrength * 0.22);
      this.sunDiscCore.material.opacity = 0.14 + (dayStrength * 0.14);
      this.sunGlow.material.opacity = 0.82 + (dayStrength * 0.24);
    }
  }

  update(snapshot) {
    const { world, lobsters } = snapshot;
    const celestial = this.updateCelestialBodies(world.timeHours);
    this.setPhaseLighting(world.dayPhase, celestial);

    if (typeof world.elapsedSeconds === 'number') {
      if (this.lastCloudUpdateAt === null) {
        this.lastCloudUpdateAt = world.elapsedSeconds;
      }
      const dt = clamp(world.elapsedSeconds - this.lastCloudUpdateAt, 0, 0.2);
      this.lastCloudUpdateAt = world.elapsedSeconds;
      this.updateClouds(dt, clamp(celestial.sunElevation, 0, 1));
    }

    this.syncFoods(world.foods);
    this.syncHazards(world.hazards);
    this.syncRescues(world.rescues);

    const seen = new Set();

    lobsters.forEach((lobster) => {
      const record = this.getOrCreateLobster(lobster);
      seen.add(lobster.id);

      const px = clamp(lobster.position.x, 0, 100);
      const pz = clamp(lobster.position.z, 0, 100);
      record.mesh.position.x = px;
      record.mesh.position.z = pz;
      record.mesh.position.y = Math.max(record.baseY, record.baseY + (lobster.position.y || 0));

      if (Number.isFinite(lobster.rotation)) {
        record.mesh.rotation.y = lobster.rotation;
      }

      record.tag.sprite.position.set(px, record.baseY + 2.4, pz);
    });

    for (const [id, record] of this.lobsters) {
      if (!seen.has(id)) {
        this.scene.remove(record.mesh);
        this.scene.remove(record.tag.sprite);
        this.lobsters.delete(id);
      }
    }

    const labelText = `Day ${String(world.day).padStart(2, '0')} - ${world.dayPhase.toUpperCase()} - Tick ${world.tick}`;
    const ctx = this.clockLabel.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.clockLabel.canvas.width, this.clockLabel.canvas.height);
    ctx.fillStyle = 'rgba(4, 18, 32, 0.75)';
    ctx.fillRect(0, 0, this.clockLabel.canvas.width, this.clockLabel.canvas.height);
    ctx.fillStyle = '#e6f9ff';
    ctx.font = 'bold 22px Trebuchet MS';
    ctx.fillText(labelText, 10, 42);
    this.clockLabel.texture.needsUpdate = true;
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    window.removeEventListener('resize', this.onWindowResize);
    if (this.moonDiscTexture) {
      this.moonDiscTexture.dispose();
      this.moonDiscTexture = null;
    }
    if (this.moonCoreTexture) {
      this.moonCoreTexture.dispose();
      this.moonCoreTexture = null;
    }
    if (this.sunGlowTexture) {
      this.sunGlowTexture.dispose();
      this.sunGlowTexture = null;
    }
    this.clouds.forEach((cloud) => {
      if (cloud.sprite && cloud.sprite.material) {
        cloud.sprite.material.dispose();
      }
    });
    this.cloudTexturePool.forEach((texture) => {
      texture.dispose();
    });
    this.clouds = [];
    this.renderer.dispose();
  }
}
