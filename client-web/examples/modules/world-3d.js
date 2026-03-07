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

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

    this.clockLabel = createTextSprite('');
    this.clockLabel.sprite.position.set(10, 7, 10);
    this.scene.add(this.clockLabel.sprite);

    this.createWorld();
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
        blending: THREE.AdditiveBlending
      })
    );
    this.moonBeam.position.set(50, 22, 50);
    this.scene.add(this.moonBeam);

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

  setPhaseLighting(phase) {
    if (phase === 'night') {
      this.scene.background.setHex(0x0b1a2e);
      this.scene.fog.color.setHex(0x0b1a2e);
      this.ambient.intensity = 0.55;
      this.directional.intensity = 0.15;
      this.moonDisc.material.opacity = 0.34;
      this.moonDiscCore.material.opacity = 0.28;
      this.moonBeam.material.opacity = 0.12;
      this.moonLight.intensity = 2.85;
    } else if (phase === 'dusk') {
      this.scene.background.setHex(0x5c5470);
      this.scene.fog.color.setHex(0x5c5470);
      this.ambient.intensity = 1.2;
      this.directional.intensity = 0.8;
      this.moonDisc.material.opacity = 0.16;
      this.moonDiscCore.material.opacity = 0.1;
      this.moonBeam.material.opacity = 0.05;
      this.moonLight.intensity = 1.0;
    } else if (phase === 'morning') {
      this.scene.background.setHex(0x6ba3d4);
      this.scene.fog.color.setHex(0x6ba3d4);
      this.ambient.intensity = 2.8;
      this.directional.intensity = 1.1;
      this.moonDisc.material.opacity = 0;
      this.moonDiscCore.material.opacity = 0;
      this.moonBeam.material.opacity = 0;
      this.moonLight.intensity = 0;
    } else {
      this.scene.background.setHex(0x77b5de);
      this.scene.fog.color.setHex(0x77b5de);
      this.ambient.intensity = 3.5;
      this.directional.intensity = 1.25;
      this.moonDisc.material.opacity = 0;
      this.moonDiscCore.material.opacity = 0;
      this.moonBeam.material.opacity = 0;
      this.moonLight.intensity = 0;
    }
  }

  update(snapshot) {
    const { world, lobsters } = snapshot;
    this.setPhaseLighting(world.dayPhase);

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
    this.renderer.dispose();
  }
}
