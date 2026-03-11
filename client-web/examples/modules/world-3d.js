import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const WORLD_SIZE = 100;
const GROUND_Y = 0;
const BUILD_ACTIONS = new Set(['buildRoad', 'buildShelter', 'expandMap']);
const HARVEST_DURATION_SECONDS = 2.8;

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
  leftClaw.name = 'lobster-left-claw';
  leftClaw.castShadow = true;
  group.add(leftClaw);

  const rightClaw = new THREE.Mesh(clawGeometry, bodyMaterial);
  rightClaw.position.set(0.8, -0.4, 0);
  rightClaw.name = 'lobster-right-claw';
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

function createHammerModel() {
  const group = new THREE.Group();

  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 1.3, 10),
    new THREE.MeshStandardMaterial({ color: 0x7b4f2a, roughness: 0.76, metalness: 0.18 })
  );
  handle.rotation.z = Math.PI / 2;
  handle.castShadow = true;
  group.add(handle);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.48, 0.34, 0.32),
    new THREE.MeshStandardMaterial({ color: 0xb6bdc5, roughness: 0.32, metalness: 0.85 })
  );
  head.position.x = 0.66;
  head.castShadow = true;
  group.add(head);

  const backWeight = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.22, 0.22),
    new THREE.MeshStandardMaterial({ color: 0x8f969e, roughness: 0.35, metalness: 0.8 })
  );
  backWeight.position.x = 0.31;
  backWeight.castShadow = true;
  group.add(backWeight);

  const sideSpikeLeft = new THREE.Mesh(
    new THREE.ConeGeometry(0.08, 0.18, 8),
    new THREE.MeshStandardMaterial({ color: 0xe5ebf3, roughness: 0.26, metalness: 0.9, emissive: 0x374250, emissiveIntensity: 0.25 })
  );
  sideSpikeLeft.rotation.z = Math.PI / 2;
  sideSpikeLeft.position.set(0.9, 0.05, 0);
  sideSpikeLeft.castShadow = true;
  group.add(sideSpikeLeft);

  const sideSpikeRight = sideSpikeLeft.clone();
  sideSpikeRight.position.y = -0.05;
  group.add(sideSpikeRight);

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

function createFloatingTextSprite(text, { color = '#ffd86b', stroke = '#281300', fontSize = 34 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `bold ${fontSize}px Trebuchet MS`;
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 9;
  ctx.strokeText(String(text || ''), canvas.width / 2, 64);
  ctx.fillStyle = color;
  ctx.fillText(String(text || ''), canvas.width / 2, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.generateMipmaps = false;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: true
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(3.2, 0.95, 1);
  return { sprite, texture, canvas };
}

function damageMarkerColor(type) {
  if (type === 'hammer') return { color: '#ffb14a', stroke: '#2f1900' };
  if (type === 'evade') return { color: '#9ee6ff', stroke: '#093447' };
  if (type === 'octopus') return { color: '#ff6d8b', stroke: '#3a0a1a' };
  return { color: '#ff3b30', stroke: '#3b0503' };
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

function pruneSeenSet(set, maxSize = 2000) {
  if (!set || set.size <= maxSize) return;
  const removeCount = set.size - maxSize;
  let removed = 0;
  for (const key of set) {
    set.delete(key);
    removed += 1;
    if (removed >= removeCount) break;
  }
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

function disposeObject3D(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach((mat) => mat.dispose());
      } else {
        obj.material.dispose();
      }
    }
  });
}

function createHazardVisual(hazard) {
  const group = new THREE.Group();
  const radius = Number(hazard.radius) || 8;
  const type = String(hazard.type || '').toLowerCase();
  const thunderState = {
    nextStrikeAt: randomRange(0.05, 0.45),
    activeUntil: 0,
    cloudCenter: new THREE.Vector3(0, 8.1, 0),
    target: new THREE.Vector3(0, 0.08, 0),
    points: []
  };

  const setThunderStrikeTarget = (timeSec = 0) => {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius * 0.95;
    thunderState.target.set(Math.cos(angle) * r, 0.08, Math.sin(angle) * r);

    const start = thunderState.cloudCenter.clone().add(
      new THREE.Vector3(randomRange(-0.9, 0.9), randomRange(-0.45, 0.2), randomRange(-0.9, 0.9))
    );
    const end = thunderState.target.clone();
    const points = [start];
    const segments = 6;
    for (let i = 1; i < segments; i += 1) {
      const t = i / segments;
      const y = THREE.MathUtils.lerp(start.y, end.y, t);
      const jitter = (1 - t) * 1.35;
      points.push(new THREE.Vector3(
        THREE.MathUtils.lerp(start.x, end.x, t) + randomRange(-jitter, jitter),
        y,
        THREE.MathUtils.lerp(start.z, end.z, t) + randomRange(-jitter, jitter)
      ));
    }
    points.push(end);
    thunderState.points = points;
    thunderState.activeUntil = timeSec + randomRange(0.22, 0.4);
    thunderState.nextStrikeAt = timeSec + randomRange(0.35, 0.95);
  };

  if (type === 'blizzard') {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.95, radius * 1.12, 0.34, 24),
      new THREE.MeshStandardMaterial({ color: 0x67b8ff, emissive: 0x366ea8, emissiveIntensity: 0.42, transparent: true, opacity: 0.32 })
    );
    base.position.y = 0.14;
    group.add(base);
    for (let i = 0; i < 26; i += 1) {
      const flake = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xeaf6ff, emissive: 0x2a5a8a, emissiveIntensity: 0.5 })
      );
      flake.userData.theta = (Math.PI * 2 * i) / 26;
      flake.userData.ring = randomRange(radius * 0.22, radius * 1.03);
      flake.userData.y = randomRange(0.7, 6.8);
      group.add(flake);
    }
  } else if (type === 'fire') {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.86, radius * 1.0, 0.34, 24),
      new THREE.MeshStandardMaterial({ color: 0xff5a2a, emissive: 0xb23600, emissiveIntensity: 0.95, transparent: true, opacity: 0.46 })
    );
    base.position.y = 0.14;
    group.add(base);
    for (let i = 0; i < 7; i += 1) {
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(randomRange(0.7, 1.25), randomRange(2.8, 5.7), 10),
        new THREE.MeshStandardMaterial({ color: i % 2 ? 0xff8a2b : 0xffc64d, emissive: 0xff3b00, emissiveIntensity: 1.1 })
      );
      flame.position.set(randomRange(-radius * 0.55, radius * 0.55), randomRange(1.1, 2.2), randomRange(-radius * 0.55, radius * 0.55));
      flame.userData.baseY = flame.position.y;
      group.add(flame);
    }
  } else if (type === 'thunder') {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.88, radius * 1.02, 0.28, 22),
      new THREE.MeshStandardMaterial({ color: 0xffd84f, emissive: 0x9e7f1f, emissiveIntensity: 0.45, transparent: true, opacity: 0.42 })
    );
    base.position.y = 0.12;
    group.add(base);

    const targetRing = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.12, radius * 0.98, 64),
      new THREE.MeshBasicMaterial({ color: 0xffe574, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    targetRing.rotation.x = -Math.PI / 2;
    targetRing.position.y = 0.06;
    targetRing.userData.hazardPart = 'thunder-target-ring';
    group.add(targetRing);

    const cloudMaterial = new THREE.MeshStandardMaterial({
      color: 0x11161d,
      roughness: 0.95,
      metalness: 0.04,
      emissive: 0x0a0d12,
      emissiveIntensity: 0.35
    });
    const cloudGroup = new THREE.Group();
    cloudGroup.position.copy(thunderState.cloudCenter);
    cloudGroup.userData.hazardPart = 'thunder-cloud';
    const cloudOffsets = [
      [-2.0, 0.0, -0.35, 1.35],
      [-1.1, 0.3, 1.0, 1.25],
      [0.2, 0.2, -1.15, 1.3],
      [1.15, 0.3, 0.82, 1.15],
      [2.05, 0.0, -0.12, 1.35],
      [0.0, 0.52, 0.14, 1.5]
    ];
    cloudOffsets.forEach(([x, y, z, s]) => {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(s, 18, 14), cloudMaterial);
      puff.position.set(x, y, z);
      puff.userData.hazardPart = 'thunder-cloud-puff';
      puff.castShadow = true;
      cloudGroup.add(puff);
    });
    group.add(cloudGroup);

    const boltMaterial = new THREE.MeshStandardMaterial({
      color: 0xe8f0ff,
      emissive: 0xbdd8ff,
      emissiveIntensity: 1.4,
      transparent: true,
      opacity: 0
    });
    for (let i = 0; i < 7; i += 1) {
      const segment = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, 1, 8), boltMaterial.clone());
      segment.userData.hazardPart = 'thunder-bolt-segment';
      segment.visible = false;
      group.add(segment);
    }

    const impact = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff2b2, transparent: true, opacity: 0 })
    );
    impact.userData.hazardPart = 'thunder-impact';
    impact.position.y = 0.1;
    group.add(impact);
  } else if (type === 'tornado') {
    const baseDisc = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 0.98, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.58, side: THREE.DoubleSide })
    );
    baseDisc.rotation.x = -Math.PI / 2;
    baseDisc.position.y = 0.03;
    baseDisc.userData.hazardPart = 'tornado-base-disc';
    group.add(baseDisc);

    const baseRing = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 0.9, 0.15, 8, 48),
      new THREE.MeshStandardMaterial({ color: 0xf8fdff, emissive: 0xdceeff, emissiveIntensity: 0.9, transparent: true, opacity: 0.88 })
    );
    baseRing.rotation.x = Math.PI / 2;
    baseRing.position.y = 0.12;
    baseRing.userData.hazardPart = 'tornado-base-ring';
    group.add(baseRing);

    const funnelMaterial = new THREE.MeshStandardMaterial({
      color: 0xadb8c4,
      roughness: 0.32,
      metalness: 0.08,
      transparent: true,
      opacity: 0.44,
      emissive: 0x597184,
      emissiveIntensity: 0.32
    });
    const funnelSegments = 14;
    for (let i = 0; i < funnelSegments; i += 1) {
      const t0 = i / funnelSegments;
      const t1 = (i + 1) / funnelSegments;
      const bottomR = THREE.MathUtils.lerp(radius * 0.12, radius * 0.52, t0);
      const topR = THREE.MathUtils.lerp(radius * 0.12, radius * 0.52, t1);
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(topR, bottomR, 0.92, 24, 1, true), funnelMaterial.clone());
      seg.position.y = 0.46 + (i * 0.82);
      seg.userData.hazardPart = 'tornado-funnel-segment';
      seg.userData.spin = randomRange(1.2, 2.2) * (i % 2 ? -1 : 1);
      seg.userData.phase = randomRange(0, Math.PI * 2);
      group.add(seg);
    }

    for (let i = 0; i < 20; i += 1) {
      const debris = new THREE.Mesh(
        new THREE.DodecahedronGeometry(randomRange(0.08, 0.19), 0),
        new THREE.MeshStandardMaterial({ color: 0x9ca5ae, emissive: 0x4f5f70, emissiveIntensity: 0.48, roughness: 0.82, metalness: 0.02 })
      );
      debris.userData.hazardPart = 'tornado-debris';
      debris.userData.theta = (Math.PI * 2 * i) / 20;
      debris.userData.r = randomRange(radius * 0.12, radius * 0.9);
      debris.userData.y = randomRange(0.35, 9.2);
      debris.userData.spin = randomRange(2.3, 5.5);
      group.add(debris);
    }
  }

  const update = (timeSec = 0) => {
    group.rotation.y += 0.006;
    group.children.forEach((child, idx) => {
      if (type === 'blizzard' && child.geometry?.type === 'SphereGeometry') {
        const theta = child.userData.theta + (timeSec * 1.85);
        const r = child.userData.ring;
        child.position.set(Math.cos(theta) * r, child.userData.y + Math.sin((timeSec * 2.1) + idx) * 0.35, Math.sin(theta) * r);
      } else if (type === 'fire' && child.geometry?.type === 'ConeGeometry') {
        child.position.y = child.userData.baseY + Math.sin((timeSec * 7.4) + idx) * 0.55;
        child.scale.y = 0.95 + ((Math.sin((timeSec * 8.3) + idx) + 1) * 0.26);
      } else if (type === 'thunder' && child.userData.hazardPart === 'thunder-cloud') {
        child.position.x = Math.sin(timeSec * 0.9) * 0.75;
        child.position.z = Math.cos(timeSec * 0.74) * 0.6;
      } else if (type === 'thunder' && child.userData.hazardPart === 'thunder-target-ring') {
        child.material.opacity = 0.22 + ((Math.sin(timeSec * 4.6) + 1) * 0.2);
      } else if (type === 'tornado' && child.userData.hazardPart === 'tornado-funnel-segment') {
        child.rotation.y += child.userData.spin * 0.055;
        child.rotation.z = Math.sin((timeSec * 3.1) + child.userData.phase) * 0.11;
        child.material.opacity = 0.34 + (Math.sin((timeSec * 4.1) + child.userData.phase) * 0.1);
      } else if (type === 'tornado' && child.userData.hazardPart === 'tornado-debris') {
        const theta = child.userData.theta + (timeSec * 4.2);
        const r = child.userData.r + Math.sin((timeSec * 1.8) + idx) * 0.22;
        child.position.set(Math.cos(theta) * r, child.userData.y + (Math.sin((timeSec * 2.8) + idx) * 0.32), Math.sin(theta) * r);
        child.rotation.x += 0.06;
        child.rotation.y += child.userData.spin * 0.035;
      } else if (type === 'tornado' && child.userData.hazardPart === 'tornado-base-ring') {
        child.rotation.z += 0.03;
        child.material.opacity = 0.68 + ((Math.sin(timeSec * 4.2) + 1) * 0.18);
      }
    });

    if (type === 'thunder') {
      if (!thunderState.points.length) setThunderStrikeTarget(timeSec);
      if (timeSec >= thunderState.nextStrikeAt) setThunderStrikeTarget(timeSec);

      const strikeActive = timeSec <= thunderState.activeUntil;
      const strikeFade = strikeActive ? (0.72 + ((Math.sin(timeSec * 96) + 1) * 0.24)) : 0;
      let segmentIndex = 0;

      group.children.forEach((child) => {
        if (child.userData.hazardPart === 'thunder-bolt-segment') {
          const from = thunderState.points[segmentIndex];
          const to = thunderState.points[segmentIndex + 1];
          if (strikeActive && from && to) {
            child.visible = true;
            positionBeamBetween(child, from, to, 1);
            child.material.opacity = strikeFade;
            child.material.emissiveIntensity = 1.2 + (strikeFade * 1.15);
            segmentIndex += 1;
          } else {
            child.visible = false;
          }
        } else if (child.userData.hazardPart === 'thunder-impact') {
          child.position.copy(thunderState.target);
          child.position.y = 0.14;
          child.material.opacity = strikeActive ? (0.55 + ((Math.sin(timeSec * 66) + 1) * 0.18)) : 0;
          const impactScale = strikeActive ? (1.3 + ((Math.sin(timeSec * 42) + 1) * 0.24)) : 0.5;
          child.scale.setScalar(impactScale);
        }
      });
    }
  };

  return { group, update };
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
    this.resourceMeshes = new Map();
    this.roadMeshes = new Map();
    this.shelterMeshes = new Map();
    this.hazardVisuals = new Map();
    this.rescueMeshes = new Map();
    this.worldWidth = WORLD_SIZE;
    this.worldHeight = WORLD_SIZE;
    this.worldBorder = null;
    this.worldCornerMarkers = [];
    this.expansionTileMeshes = new Map();
    this.clouds = [];
    this.lastCloudUpdateAt = null;
    this.cloudUpdateAccumulator = 0;
    this.cloudTexturePool = createCloudTexturePool(20);
    this.combatBursts = new Map();
    this.seenCombatBurstIds = new Set();
    this.octopusStrikeEffects = new Map();
    this.seenOctopusAttackIds = new Set();

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
    this.floorMesh = floor;
    this.createWorldBorder();

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

  createWorldBorder() {
    const points = [
      new THREE.Vector3(0, 0.12, 0),
      new THREE.Vector3(this.worldWidth, 0.12, 0),
      new THREE.Vector3(this.worldWidth, 0.12, this.worldHeight),
      new THREE.Vector3(0, 0.12, this.worldHeight)
    ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: 0xfff29a });
    this.worldBorder = new THREE.LineLoop(geometry, material);
    this.scene.add(this.worldBorder);

    for (let i = 0; i < 4; i += 1) {
      const marker = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.22, 1.8, 10),
        new THREE.MeshStandardMaterial({ color: 0xf8e36a, emissive: 0x6f6519, emissiveIntensity: 0.35 })
      );
      marker.position.y = 0.9;
      marker.castShadow = true;
      this.scene.add(marker);
      this.worldCornerMarkers.push(marker);
    }
    this.updateWorldBorder();
  }

  updateWorldBorder() {
    if (!this.worldBorder) return;
    const borderW = this.worldWidth;
    const borderH = this.worldHeight;
    const points = [
      new THREE.Vector3(0, 0.12, 0),
      new THREE.Vector3(borderW, 0.12, 0),
      new THREE.Vector3(borderW, 0.12, borderH),
      new THREE.Vector3(0, 0.12, borderH)
    ];
    this.worldBorder.geometry.setFromPoints(points);
    this.worldBorder.geometry.computeBoundingSphere();

    const corners = [
      [0, 0],
      [borderW, 0],
      [borderW, borderH],
      [0, borderH]
    ];
    this.worldCornerMarkers.forEach((marker, idx) => {
      const [x, z] = corners[idx];
      marker.position.x = x;
      marker.position.z = z;
    });
  }

  syncExpansionTiles(tiles = []) {
    const ids = new Set(tiles.map((t) => t.id));
    for (const [id, mesh] of this.expansionTileMeshes) {
      if (!ids.has(id)) {
        this.scene.remove(mesh);
        disposeObject3D(mesh);
        this.expansionTileMeshes.delete(id);
      }
    }

    tiles.forEach((tile) => {
      let tileGroup = this.expansionTileMeshes.get(tile.id);
      if (!tileGroup) {
        tileGroup = new THREE.Group();
        const baseGeo = new THREE.BoxGeometry(1, 3, 1);
        const baseMat = new THREE.MeshStandardMaterial({
          color: 0xc2b280,
          roughness: 0.82,
          metalness: 0.08
        });
        const base = new THREE.Mesh(baseGeo, baseMat);
        base.receiveShadow = true;
        base.castShadow = true;
        tileGroup.add(base);

        this.scene.add(tileGroup);
        this.expansionTileMeshes.set(tile.id, tileGroup);
      }
      tileGroup.position.set(Number(tile.x) || 0, -1.5, Number(tile.z) || 0);
    });
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

    const statusTag = createTextSprite('');
    statusTag.sprite.position.set(lobster.position.x, physics.baseY + 3.35, lobster.position.z);
    statusTag.sprite.visible = false;
    statusTag.sprite.scale.set(5.8, 1.4, 1);
    this.scene.add(statusTag.sprite);

    const sleepGroup = new THREE.Group();
    sleepGroup.visible = false;
    const sleepGlyphs = [
      createFloatingTextSprite('Z', { color: '#e8f7ff', stroke: '#27424f', fontSize: 42 }),
      createFloatingTextSprite('z', { color: '#d5efff', stroke: '#27424f', fontSize: 34 }),
      createFloatingTextSprite('z', { color: '#c3e7ff', stroke: '#27424f', fontSize: 28 })
    ];
    sleepGlyphs.forEach((glyph, idx) => {
      glyph.sprite.position.set(0.18 + (idx * 0.42), 0.2 + (idx * 0.42), 0);
      glyph.sprite.scale.set(1.3 - (idx * 0.15), 0.52 - (idx * 0.06), 1);
      sleepGroup.add(glyph.sprite);
    });
    this.scene.add(sleepGroup);

    const burnFlames = new THREE.Group();
    burnFlames.visible = false;
    for (let i = 0; i < 6; i += 1) {
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.08 + (i % 2 ? 0.03 : 0), 0.38 + ((i % 3) * 0.08), 8),
        new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff6f2e : 0xffca55, transparent: true, opacity: 0.88, depthWrite: false })
      );
      const theta = (Math.PI * 2 * i) / 6;
      flame.position.set(Math.cos(theta) * 0.52, 0.2 + ((i % 2) * 0.12), Math.sin(theta) * 0.52);
      flame.userData.theta = theta;
      flame.userData.baseY = flame.position.y;
      burnFlames.add(flame);
    }
    mesh.add(burnFlames);

    const surfaceMaterials = [];
    const surfaceMaterialSet = new Set();
    mesh.traverse((obj) => {
      if (!obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((mat) => {
        if (!mat || !mat.color || surfaceMaterialSet.has(mat)) return;
        surfaceMaterialSet.add(mat);
        mat.userData.baseColor = mat.color.clone();
        if (mat.emissive) mat.userData.baseEmissive = mat.emissive.clone();
        surfaceMaterials.push(mat);
      });
    });

    const shockGroup = new THREE.Group();
    shockGroup.visible = false;
    for (let i = 0; i < 3; i += 1) {
      const seg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.06, 0.85, 6),
        new THREE.MeshBasicMaterial({ color: 0xd6f8ff, transparent: true, opacity: 0.9 })
      );
      seg.position.y = 0.65;
      seg.userData.phase = i * ((Math.PI * 2) / 3);
      shockGroup.add(seg);
    }
    mesh.add(shockGroup);

    const tornadoRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.98, 0.07, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0xd4e0ec, transparent: true, opacity: 0, depthWrite: false })
    );
    tornadoRing.rotation.set(Math.PI / 2, 0, 0);
    tornadoRing.position.y = 0.4;
    tornadoRing.visible = false;
    mesh.add(tornadoRing);

    const hammerPivot = new THREE.Group();
    hammerPivot.position.set(0, 2.45, 0);
    hammerPivot.rotation.set(0, 0, 0);
    const hammerMesh = createHammerModel();
    hammerMesh.scale.set(4.8, 4.8, 4.8);
    hammerPivot.visible = false;
    hammerPivot.add(hammerMesh);
    mesh.add(hammerPivot);

    const buildHammerPivot = new THREE.Group();
    buildHammerPivot.position.set(0.18, 0.06, 0.02);
    buildHammerPivot.rotation.set(0.2, -0.08, 0.45);
    const buildHammerMesh = createHammerModel();
    buildHammerMesh.scale.set(1.15, 1.15, 1.15);
    buildHammerPivot.visible = false;
    buildHammerPivot.add(buildHammerMesh);
    const rightClaw = mesh.getObjectByName('lobster-right-claw');
    if (rightClaw) {
      rightClaw.add(buildHammerPivot);
    } else {
      mesh.add(buildHammerPivot);
    }

    const harvestBarGroup = new THREE.Group();
    harvestBarGroup.visible = false;
    const harvestBarBg = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 0.24),
      new THREE.MeshBasicMaterial({ color: 0x102030, transparent: true, opacity: 0.85, depthWrite: false })
    );
    harvestBarBg.position.set(0, 0, 0);
    harvestBarGroup.add(harvestBarBg);

    const harvestBarFill = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 0.16),
      new THREE.MeshBasicMaterial({ color: 0x52f59a, transparent: true, opacity: 0.95, depthWrite: false })
    );
    harvestBarFill.position.set(-0.02, 0, 0.01);
    harvestBarGroup.add(harvestBarFill);
    this.scene.add(harvestBarGroup);

    const record = {
      mesh,
      tag,
      statusTag,
      sleepGroup,
      sleepGlyphs,
      baseY: physics.baseY,
      burnFlames,
      surfaceMaterials,
      shockGroup,
      tornadoRing,
      hammerPivot,
      hammerMesh,
      buildHammerPivot,
      buildHammerMesh,
      harvestBarGroup,
      harvestBarFill,
      seenDamageIds: new Set(),
      damageMarkers: new Map()
    };
    this.lobsters.set(lobster.id, record);
    return record;
  }

  updateLobsterEffects(record, lobster, timeSec) {
    const effects = lobster.statusEffects || {};
    const combat = lobster.combat || {};
    const burn = clamp((effects.burning || 0) / 4.2, 0, 1);
    const frozen = clamp((effects.frozen || 0) / 3.2, 0, 1);
    const shock = clamp((effects.electrocuted || 0) / 2.8, 0, 1);
    const tornado = clamp((effects.tornadoSpin || 0) / 2.6, 0, 1);
    const swing = clamp((combat.swingUntil || 0) / 0.42, 0, 1);
    const queuedAction = lobster.actionQueue?.[0]?.type || '';
    const buildIntent = BUILD_ACTIONS.has(lobster.state) || BUILD_ACTIONS.has(queuedAction);
    const dodge = clamp((combat.dodgeUntil || 0) / 1.0, 0, 1);
    const hitReact = clamp((combat.tookHitUntil || 0) / 0.6, 0, 1);
    const activeAction = lobster.actionQueue?.[0] || null;
    const isHarvesting = lobster.state === 'harvesting' && activeAction?.type === 'harvest';
    const harvestElapsed = Number(activeAction?.payload?.harvestElapsed) || 0;
    const harvestProgress = clamp(harvestElapsed / HARVEST_DURATION_SECONDS, 0, 1);

    record.burnFlames.visible = burn > 0.02;
    if (record.burnFlames.visible) {
      record.burnFlames.rotation.y += 0.06;
      record.burnFlames.children.forEach((flame, idx) => {
        flame.position.y = flame.userData.baseY + (Math.sin((timeSec * 12) + idx) * 0.1);
        flame.scale.y = 0.9 + ((Math.sin((timeSec * 16) + idx) + 1) * 0.26 * burn);
        flame.material.opacity = 0.45 + (burn * 0.5);
      });
    }

    record.shockGroup.visible = shock > 0.02;
    if (record.shockGroup.visible) {
      record.shockGroup.rotation.y += 0.22;
      record.shockGroup.children.forEach((seg) => {
        const phase = seg.userData.phase || 0;
        seg.position.x = Math.cos((timeSec * 10) + phase) * 0.65;
        seg.position.z = Math.sin((timeSec * 10) + phase) * 0.65;
        seg.rotation.z = Math.sin((timeSec * 22) + phase) * 0.8;
        seg.material.opacity = 0.58 + ((Math.sin((timeSec * 36) + phase) + 1) * 0.2);
      });
    }

    record.tornadoRing.visible = tornado > 0.02;
    if (record.tornadoRing.visible) {
      record.tornadoRing.rotation.z += 0.19;
      record.tornadoRing.position.y = 0.4 + ((Math.sin(timeSec * 13) + 1) * 0.65);
      record.tornadoRing.material.opacity = tornado * 0.66;
    }

    record.hammerPivot.visible = swing > 0.01;
    if (swing > 0.01) {
      const swingProgress = 1 - swing;
      if (swingProgress < 0.45) {
        // Wind-up above head.
        const windup = swingProgress / 0.45;
        record.hammerPivot.position.x = 0.7 + (windup * 0.55);
        record.hammerPivot.position.y = 2.45 + (windup * 0.45);
        record.hammerPivot.rotation.x = 0.25 + (windup * 0.35);
        record.hammerPivot.rotation.y = Math.sin((timeSec * 8) + 0.3) * 0.2;
        record.hammerPivot.rotation.z = 0.22 + (windup * 0.38);
      } else {
        // Downward strike: extends out and slams to floor level.
        const smash = (swingProgress - 0.45) / 0.55;
        record.hammerPivot.position.x = 1.25 + (smash * 4.1);
        record.hammerPivot.position.y = 2.9 - (smash * 2.25);
        record.hammerPivot.rotation.x = 0.6 + (smash * 0.28);
        record.hammerPivot.rotation.y = Math.sin((timeSec * 9) + 0.3) * 0.14;
        record.hammerPivot.rotation.z = 0.6 - (smash * 2.2);
      }
    } else {
      record.hammerPivot.position.x = 0;
      record.hammerPivot.position.y = 2.45;
      record.hammerPivot.rotation.set(0, 0, 0);
    }

    record.buildHammerPivot.visible = buildIntent;
    if (record.buildHammerPivot.visible) {
      record.buildHammerPivot.position.x = 0.18 + (Math.sin(timeSec * 6) * 0.015);
      record.buildHammerPivot.position.y = 0.06 + (Math.sin(timeSec * 8) * 0.02);
      record.buildHammerPivot.position.z = 0.02 + (Math.cos(timeSec * 6) * 0.01);
      record.buildHammerPivot.rotation.x = 0.2;
      record.buildHammerPivot.rotation.y = -0.08 + (Math.sin(timeSec * 5) * 0.04);
      record.buildHammerPivot.rotation.z = 0.45;
    }

    record.harvestBarGroup.visible = isHarvesting;
    if (isHarvesting) {
      record.harvestBarGroup.position.set(
        record.mesh.position.x,
        record.baseY + 4.25,
        record.mesh.position.z
      );
      record.harvestBarGroup.lookAt(this.camera.position);
      record.harvestBarFill.scale.x = Math.max(0.02, harvestProgress);
      record.harvestBarFill.position.x = -1.12 + (1.12 * record.harvestBarFill.scale.x);
    }

    record.mesh.rotation.x = Math.sin(timeSec * 18) * 0.12 * dodge;
    record.mesh.rotation.z = (Math.sin(timeSec * 23) * 0.2 * dodge) + (Math.sin(timeSec * 38) * 0.12 * hitReact);
    if (hitReact > 0.01) {
      record.mesh.position.y += Math.abs(Math.sin(timeSec * 42)) * 0.16 * hitReact;
    }

    const burnTint = new THREE.Color(0x6a2f18);
    const freezeTint = new THREE.Color(0x5fbbff);
    record.surfaceMaterials.forEach((mat) => {
      const baseColor = mat.userData.baseColor || mat.color;
      const nextColor = baseColor.clone();
      if (burn > 0.02) nextColor.lerp(burnTint, burn * 0.4);
      if (frozen > 0.02) nextColor.lerp(freezeTint, frozen * 0.82);
      mat.color.copy(nextColor);
      if (mat.emissive) {
        const baseEmissive = mat.userData.baseEmissive || new THREE.Color(0x000000);
        mat.emissive.copy(baseEmissive);
        mat.emissive.lerp(new THREE.Color(0xff6f2e), burn * 0.32);
        mat.emissive.lerp(new THREE.Color(0x7ad7ff), frozen * 0.22);
        mat.emissive.lerp(new THREE.Color(0xc5f3ff), shock * 0.4);
      }
    });

    const statuses = [];
    if (burn > 0.1) statuses.push('BURNING');
    if (frozen > 0.1) statuses.push('FROZEN');
    if (shock > 0.1) statuses.push('ELECTROCUTED');
    if ((effects.paralyzed || 0) > 0.1) statuses.push('PARALYZED');
    if (tornado > 0.1) statuses.push('TWISTED');
    if (swing > 0.1) statuses.push('BIG HAMMER WHACK');
    if (buildIntent && swing <= 0.1) statuses.push('BUILDING');
    if (dodge > 0.1) statuses.push('DODGING');
    if (hitReact > 0.1) statuses.push('HIT');

    if (statuses.length) {
      const text = statuses.join(' | ');
      const ctx = record.statusTag.canvas.getContext('2d');
      ctx.clearRect(0, 0, record.statusTag.canvas.width, record.statusTag.canvas.height);
      ctx.fillStyle = 'rgba(4, 18, 32, 0.78)';
      ctx.fillRect(0, 0, record.statusTag.canvas.width, record.statusTag.canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px Trebuchet MS';
      ctx.fillText(text, 10, 42);
      record.statusTag.texture.needsUpdate = true;
      record.statusTag.sprite.visible = true;
    } else {
      record.statusTag.sprite.visible = false;
    }

    const sleeping = Boolean(lobster.sleeping);
    record.sleepGroup.visible = sleeping;
    if (sleeping) {
      record.sleepGroup.position.set(
        record.mesh.position.x + 0.35,
        record.baseY + 2.9 + (Math.sin(timeSec * 2.3) * 0.12),
        record.mesh.position.z
      );
      record.sleepGlyphs.forEach((glyph, idx) => {
        const drift = ((timeSec * 0.65) + (idx * 0.28)) % 1;
        glyph.sprite.position.y = 0.18 + (idx * 0.38) + (drift * 0.48);
        glyph.sprite.material.opacity = 0.5 + ((1 - drift) * 0.45);
      });
    }
  }

  syncDamageMarkers(record, lobster, timeSec) {
    const incoming = Array.isArray(lobster.damageMarkers) ? lobster.damageMarkers : [];
    incoming.forEach((entry) => {
      if (!entry || !entry.id || record.seenDamageIds.has(entry.id)) return;
      record.seenDamageIds.add(entry.id);
      const style = damageMarkerColor(entry.type);
      const value = Math.max(1, Math.round(Number(entry.amount) || 1));
      const marker = createFloatingTextSprite(`-${value}`, style);
      marker.sprite.position.set(record.mesh.position.x, record.baseY + 2.3, record.mesh.position.z);
      this.scene.add(marker.sprite);
      record.damageMarkers.set(entry.id, {
        ...marker,
        startAt: Number.isFinite(entry.at) ? entry.at : timeSec,
        driftX: randomRange(-0.5, 0.5),
        driftZ: randomRange(-0.32, 0.32)
      });
    });

    for (const [id, marker] of record.damageMarkers) {
      const age = timeSec - marker.startAt;
      if (age > 1.4) {
        this.scene.remove(marker.sprite);
        marker.sprite.material.dispose();
        marker.texture.dispose();
        record.damageMarkers.delete(id);
        continue;
      }

      marker.sprite.position.set(
        record.mesh.position.x + (marker.driftX * age),
        record.baseY + 2.3 + (age * 2.2),
        record.mesh.position.z + (marker.driftZ * age)
      );
      marker.sprite.material.opacity = clamp(1 - (age / 1.4), 0, 1);
    }
  }

  setWorldBounds(width = WORLD_SIZE, height = WORLD_SIZE) {
    this.worldWidth = Math.max(WORLD_SIZE, Number(width) || WORLD_SIZE);
    this.worldHeight = Math.max(WORLD_SIZE, Number(height) || WORLD_SIZE);
    // Keep the base map stable visually; show growth via per-tile expansion meshes.
    this.updateWorldBorder();
  }

  clampWorldX(x) {
    return clamp(x, 0, this.worldWidth);
  }

  clampWorldZ(z) {
    return clamp(z, 0, this.worldHeight);
  }

  createResourceMesh(type) {
    if (type === 'rock') {
      return new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.7, 0),
        new THREE.MeshStandardMaterial({ color: 0x8c9098, roughness: 0.9, metalness: 0.08 })
      );
    }
    if (type === 'kelp') {
      const kelp = new THREE.Group();
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.18, 2.4, 8),
        new THREE.MeshStandardMaterial({ color: 0x2ca86f, roughness: 0.7 })
      );
      stem.position.y = 1.1;
      kelp.add(stem);
      const leaf = new THREE.Mesh(
        new THREE.PlaneGeometry(0.8, 1.9),
        new THREE.MeshStandardMaterial({ color: 0x3ecf8e, side: THREE.DoubleSide })
      );
      leaf.position.set(0.16, 1.2, 0);
      leaf.rotation.y = Math.PI / 3;
      kelp.add(leaf);
      return kelp;
    }
    const seaweed = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x5fcf65, roughness: 0.72 });
    for (let i = 0; i < 3; i += 1) {
      const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, 1.8, 8), mat);
      blade.position.set((i - 1) * 0.22, 0.9, 0);
      blade.rotation.z = (i - 1) * 0.2;
      seaweed.add(blade);
    }
    return seaweed;
  }

  syncResources(resources = []) {
    const ids = new Set(resources.map((r) => r.id));
    for (const [id, mesh] of this.resourceMeshes) {
      if (!ids.has(id)) {
        this.scene.remove(mesh);
        disposeObject3D(mesh);
        this.resourceMeshes.delete(id);
      }
    }

    resources.forEach((resource) => {
      let mesh = this.resourceMeshes.get(resource.id);
      if (!mesh) {
        mesh = this.createResourceMesh(resource.type);
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.resourceMeshes.set(resource.id, mesh);
      }
      mesh.position.set(this.clampWorldX(resource.x), 0.35, this.clampWorldZ(resource.z));
    });
  }

  syncRoads(roads = []) {
    const ids = new Set(roads.map((r) => r.id));
    for (const [id, mesh] of this.roadMeshes) {
      if (!ids.has(id)) {
        this.scene.remove(mesh);
        disposeObject3D(mesh);
        this.roadMeshes.delete(id);
      }
    }

    roads.forEach((road) => {
      let mesh = this.roadMeshes.get(road.id);
      const dx = road.x2 - road.x1;
      const dz = road.z2 - road.z1;
      const length = Math.max(0.2, Math.hypot(dx, dz));
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(1, 0.08, 1),
          new THREE.MeshStandardMaterial({ color: 0x6d4c41, roughness: 0.85, metalness: 0.05 })
        );
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.roadMeshes.set(road.id, mesh);
      }
      mesh.scale.set(length, 1, 1);
      mesh.position.set(this.clampWorldX((road.x1 + road.x2) * 0.5), 0.05, this.clampWorldZ((road.z1 + road.z2) * 0.5));
      mesh.rotation.y = Math.atan2(dz, dx);
    });
  }

  syncShelters(shelters = [], lobsters = []) {
    const ids = new Set(shelters.map((s) => s.id));
    const ownerNameById = new Map(lobsters.map((l) => [l.id, l.name]));
    for (const [id, record] of this.shelterMeshes) {
      if (!ids.has(id)) {
        this.scene.remove(record.group);
        this.scene.remove(record.tag.sprite);
        disposeObject3D(record.group);
        record.tag.sprite.material?.map?.dispose?.();
        record.tag.sprite.material?.dispose?.();
        this.shelterMeshes.delete(id);
      }
    }

    shelters.forEach((shelter) => {
      let record = this.shelterMeshes.get(shelter.id);
      if (!record) {
        const group = new THREE.Group();
        const base = new THREE.Mesh(
          new THREE.BoxGeometry(3.4, 2.2, 3.2),
          new THREE.MeshStandardMaterial({ color: 0xbfa46a, roughness: 0.72 })
        );
        base.position.y = 1.1;
        base.castShadow = true;
        group.add(base);
        const roof = new THREE.Mesh(
          new THREE.ConeGeometry(2.6, 1.5, 4),
          new THREE.MeshStandardMaterial({ color: 0x7a5337, roughness: 0.8 })
        );
        roof.position.y = 2.8;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        group.add(roof);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(1.8, Number(shelter.radius) || 5, 40),
          new THREE.MeshBasicMaterial({ color: 0x9cf2d1, transparent: true, opacity: 0.26, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.08;
        group.add(ring);
        const tag = createTextSprite(ownerNameById.get(shelter.ownerId) || shelter.ownerId || 'Shelter');
        tag.sprite.scale.set(6, 1.4, 1);
        this.scene.add(group);
        this.scene.add(tag.sprite);
        record = { group, tag };
        this.shelterMeshes.set(shelter.id, record);
      }

      record.group.position.set(this.clampWorldX(shelter.x), 0, this.clampWorldZ(shelter.z));
      record.tag.sprite.position.set(this.clampWorldX(shelter.x), 4.6, this.clampWorldZ(shelter.z));
    });
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
      mesh.position.set(this.clampWorldX(food.x), 0.3, this.clampWorldZ(food.z));
    });
  }

  syncHazards(hazards = []) {
    const ids = new Set(hazards.map((h) => h.id));

    for (const [id, record] of this.hazardVisuals) {
      if (!ids.has(id)) {
        this.scene.remove(record.group);
        disposeObject3D(record.group);
        this.hazardVisuals.delete(id);
      }
    }

    hazards.forEach((hazard) => {
      let record = this.hazardVisuals.get(hazard.id);
      if (!record) {
        record = createHazardVisual(hazard);
        this.scene.add(record.group);
        this.hazardVisuals.set(hazard.id, record);
      }

      record.group.position.set(this.clampWorldX(hazard.x), 0, this.clampWorldZ(hazard.z));
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
      mesh.position.set(this.clampWorldX(rescue.x), 0.22, this.clampWorldZ(rescue.z));
    });
  }

  spawnCombatBurst(effect, timeSec = 0) {
    const power = clamp(Number(effect.power) || 1, 0.45, 2.8);
    const type = String(effect.type || 'hammer-whack');
    const isWhiff = type === 'hammer-whiff';
    const isOctopus = type === 'octopus-hit';
    const ringColor = isOctopus ? 0xff6b92 : (isWhiff ? 0xa8e7ff : 0xffb347);
    const sparkColor = isOctopus ? 0xffd2df : (isWhiff ? 0xdcf8ff : 0xfff2be);

    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.95, 36),
      new THREE.MeshBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.12;
    group.add(ring);

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 12, 10),
      new THREE.MeshBasicMaterial({
        color: sparkColor,
        transparent: true,
        opacity: 0.9,
        depthWrite: false
      })
    );
    core.position.y = 0.24;
    group.add(core);

    const spikes = [];
    const spikeCount = isWhiff ? 7 : 11;
    for (let i = 0; i < spikeCount; i += 1) {
      const spike = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.42 + (Math.random() * 0.34), 0.08),
        new THREE.MeshBasicMaterial({
          color: sparkColor,
          transparent: true,
          opacity: 0.85,
          depthWrite: false
        })
      );
      spike.position.y = 0.25;
      spike.userData.theta = (Math.PI * 2 * i) / spikeCount;
      spike.userData.radius = 0.34 + (Math.random() * 0.34);
      spike.userData.speed = 1.4 + (Math.random() * 2.2);
      spike.userData.tilt = randomRange(-0.25, 0.25);
      group.add(spike);
      spikes.push(spike);
    }

    group.position.set(this.clampWorldX(effect.x), 0, this.clampWorldZ(effect.z));
    this.scene.add(group);
    this.combatBursts.set(effect.id, {
      id: effect.id,
      group,
      ring,
      core,
      spikes,
      type,
      power,
      startAt: Number.isFinite(effect.at) ? effect.at : timeSec
    });
  }

  syncCombatBursts(effects = [], timeSec = 0) {
    effects.forEach((effect) => {
      if (!effect || !effect.id || this.seenCombatBurstIds.has(effect.id)) return;
      this.seenCombatBurstIds.add(effect.id);
      this.spawnCombatBurst(effect, timeSec);
    });
    pruneSeenSet(this.seenCombatBurstIds, 1600);

    for (const [id, burst] of this.combatBursts) {
      const age = timeSec - burst.startAt;
      const ttl = burst.type === 'hammer-swing' ? 0.5 : 0.72;
      if (age > ttl) {
        this.scene.remove(burst.group);
        disposeObject3D(burst.group);
        this.combatBursts.delete(id);
        continue;
      }
      const t = clamp(age / ttl, 0, 1);
      const swell = burst.power * (0.7 + (t * 1.8));
      burst.ring.scale.setScalar(Math.max(0.2, swell));
      burst.ring.material.opacity = (1 - t) * 0.78;
      burst.core.scale.setScalar(1 + (t * 0.9 * burst.power));
      burst.core.material.opacity = (1 - t) * 0.88;
      burst.spikes.forEach((spike) => {
        const theta = spike.userData.theta + (t * spike.userData.speed);
        const radius = spike.userData.radius + (t * 1.25 * burst.power);
        spike.position.x = Math.cos(theta) * radius;
        spike.position.z = Math.sin(theta) * radius;
        spike.position.y = 0.2 + (t * 0.9);
        spike.rotation.x = spike.userData.tilt + (t * 1.35);
        spike.rotation.z = -spike.userData.tilt + (t * 0.95);
        spike.material.opacity = (1 - t) * 0.8;
      });
    }
  }

  spawnOctopusStrike(attack, timeSec = 0) {
    const power = clamp(Number(attack.power) || 1, 0.55, 2.5);
    const group = new THREE.Group();

    const warningRing = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1.08, 44),
      new THREE.MeshBasicMaterial({
        color: 0xff6f9a,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    warningRing.rotation.x = -Math.PI / 2;
    warningRing.position.y = 0.09;
    group.add(warningRing);

    const splash = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.56, 0.54, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffd7e4,
        transparent: true,
        opacity: 0.84,
        depthWrite: false
      })
    );
    splash.position.y = 0.28;
    group.add(splash);

    const tentacle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.34, 4.8 + (power * 1.4), 14),
      new THREE.MeshStandardMaterial({
        color: 0xcb3f67,
        emissive: 0x5e122b,
        emissiveIntensity: 0.42,
        roughness: 0.58,
        metalness: 0.08,
        transparent: true,
        opacity: 0.9
      })
    );
    tentacle.position.y = 6.3 + (power * 0.8);
    group.add(tentacle);

    group.position.set(this.clampWorldX(attack.x), 0, this.clampWorldZ(attack.z));
    this.scene.add(group);
    this.octopusStrikeEffects.set(attack.id, {
      id: attack.id,
      group,
      power,
      warningRing,
      splash,
      tentacle,
      startAt: Number.isFinite(attack.at) ? attack.at : timeSec
    });
  }

  syncOctopusAttacks(attacks = [], timeSec = 0) {
    attacks.forEach((attack) => {
      if (!attack || !attack.id || this.seenOctopusAttackIds.has(attack.id)) return;
      this.seenOctopusAttackIds.add(attack.id);
      this.spawnOctopusStrike(attack, timeSec);
    });
    pruneSeenSet(this.seenOctopusAttackIds, 1000);

    for (const [id, effect] of this.octopusStrikeEffects) {
      const age = timeSec - effect.startAt;
      const ttl = 1.05;
      if (age > ttl) {
        this.scene.remove(effect.group);
        disposeObject3D(effect.group);
        this.octopusStrikeEffects.delete(id);
        continue;
      }

      const t = clamp(age / ttl, 0, 1);
      const descend = clamp(t / 0.42, 0, 1);
      const rebound = t > 0.42 ? clamp((t - 0.42) / 0.58, 0, 1) : 0;
      effect.warningRing.scale.setScalar(0.78 + (t * 2.8 * effect.power));
      effect.warningRing.material.opacity = (1 - t) * 0.8;
      effect.splash.scale.setScalar(0.6 + (Math.sin(Math.min(t, 0.72) * Math.PI) * 1.25 * effect.power));
      effect.splash.material.opacity = (1 - t) * 0.86;
      effect.tentacle.position.y = (6.3 + (effect.power * 0.8)) - (descend * (6 + (effect.power * 1.1))) + (rebound * 1.6);
      effect.tentacle.rotation.z = Math.sin(t * 16) * 0.14;
      effect.tentacle.material.opacity = 0.92 - (t * 0.62);
    }
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
      GROUND_Y + 0.14,
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
    this.setWorldBounds(world.width, world.height);
    const celestial = this.updateCelestialBodies(world.timeHours);
    this.setPhaseLighting(world.dayPhase, celestial);
    // Prevent underside artifacts: never render moon beam when camera is below the floor plane.
    this.moonBeam.visible = this.camera.position.y >= (GROUND_Y - 0.05) && this.moonLight.intensity > 0.01;

    if (typeof world.elapsedSeconds === 'number') {
      if (this.lastCloudUpdateAt === null) {
        this.lastCloudUpdateAt = world.elapsedSeconds;
      }
      const dt = clamp(world.elapsedSeconds - this.lastCloudUpdateAt, 0, 0.2);
      this.lastCloudUpdateAt = world.elapsedSeconds;
      this.updateClouds(dt, clamp(celestial.sunElevation, 0, 1));
    }

    this.syncFoods(world.foods);
    this.syncExpansionTiles(world.expansionTiles || []);
    this.syncResources(world.resources);
    this.syncRoads(world.roads);
    this.syncShelters(world.shelters, lobsters);
    this.syncHazards(world.hazards);
    const hzTime = Number.isFinite(world.elapsedSeconds) ? world.elapsedSeconds : (world.tick / 12);
    this.syncCombatBursts(world.battleFx || [], hzTime);
    this.syncOctopusAttacks(world.octopusAttacks || [], hzTime);
    for (const hazard of this.hazardVisuals.values()) {
      hazard.update(hzTime);
    }
    this.syncRescues(world.rescues);

    const seen = new Set();

    lobsters.forEach((lobster) => {
      const record = this.getOrCreateLobster(lobster);
      seen.add(lobster.id);

      const px = this.clampWorldX(lobster.position.x);
      const pz = this.clampWorldZ(lobster.position.z);
      record.mesh.position.x = px;
      record.mesh.position.z = pz;
      record.mesh.position.y = Math.max(record.baseY, record.baseY + (lobster.position.y || 0));

      if (Number.isFinite(lobster.rotation)) {
        record.mesh.rotation.y = lobster.rotation;
      }

      record.tag.sprite.position.set(px, record.baseY + 2.4, pz);
      record.statusTag.sprite.position.set(px, record.baseY + 3.35, pz);
      this.updateLobsterEffects(record, lobster, hzTime);
      this.syncDamageMarkers(record, lobster, hzTime);
    });

    for (const [id, record] of this.lobsters) {
      if (!seen.has(id)) {
        for (const marker of record.damageMarkers.values()) {
          this.scene.remove(marker.sprite);
          marker.sprite.material.dispose();
          marker.texture.dispose();
        }
        record.damageMarkers.clear();
        this.scene.remove(record.mesh);
        this.scene.remove(record.tag.sprite);
        this.scene.remove(record.statusTag.sprite);
        this.scene.remove(record.sleepGroup);
        this.scene.remove(record.harvestBarGroup);
        record.sleepGlyphs.forEach((glyph) => {
          glyph.sprite.material.dispose();
          glyph.texture.dispose();
        });
        disposeObject3D(record.harvestBarGroup);
        this.lobsters.delete(id);
      }
    }

    this.syncCombatBursts([], hzTime);
    this.syncOctopusAttacks([], hzTime);

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
    for (const record of this.lobsters.values()) {
      for (const marker of record.damageMarkers.values()) {
        this.scene.remove(marker.sprite);
        marker.sprite.material.dispose();
        marker.texture.dispose();
      }
      this.scene.remove(record.mesh);
      this.scene.remove(record.tag.sprite);
      this.scene.remove(record.statusTag.sprite);
      this.scene.remove(record.sleepGroup);
      this.scene.remove(record.harvestBarGroup);
      record.sleepGlyphs.forEach((glyph) => {
        glyph.sprite.material.dispose();
        glyph.texture.dispose();
      });
      disposeObject3D(record.mesh);
      record.tag.sprite.material?.map?.dispose?.();
      record.tag.sprite.material?.dispose?.();
      record.statusTag.sprite.material?.map?.dispose?.();
      record.statusTag.sprite.material?.dispose?.();
      disposeObject3D(record.harvestBarGroup);
    }
    this.lobsters.clear();
    for (const mesh of this.foodMeshes.values()) {
      this.scene.remove(mesh);
      disposeObject3D(mesh);
    }
    this.foodMeshes.clear();
    for (const mesh of this.resourceMeshes.values()) {
      this.scene.remove(mesh);
      disposeObject3D(mesh);
    }
    this.resourceMeshes.clear();
    for (const mesh of this.roadMeshes.values()) {
      this.scene.remove(mesh);
      disposeObject3D(mesh);
    }
    this.roadMeshes.clear();
    for (const record of this.shelterMeshes.values()) {
      this.scene.remove(record.group);
      this.scene.remove(record.tag.sprite);
      disposeObject3D(record.group);
      record.tag.sprite.material?.map?.dispose?.();
      record.tag.sprite.material?.dispose?.();
    }
    this.shelterMeshes.clear();
    for (const mesh of this.rescueMeshes.values()) {
      this.scene.remove(mesh);
      disposeObject3D(mesh);
    }
    this.rescueMeshes.clear();
    for (const burst of this.combatBursts.values()) {
      this.scene.remove(burst.group);
      disposeObject3D(burst.group);
    }
    this.combatBursts.clear();
    this.seenCombatBurstIds.clear();
    for (const effect of this.octopusStrikeEffects.values()) {
      this.scene.remove(effect.group);
      disposeObject3D(effect.group);
    }
    this.octopusStrikeEffects.clear();
    this.seenOctopusAttackIds.clear();
    for (const record of this.hazardVisuals.values()) {
      disposeObject3D(record.group);
    }
    this.hazardVisuals.clear();
    if (this.worldBorder) {
      this.scene.remove(this.worldBorder);
      this.worldBorder.geometry?.dispose?.();
      this.worldBorder.material?.dispose?.();
      this.worldBorder = null;
    }
    this.worldCornerMarkers.forEach((marker) => {
      this.scene.remove(marker);
      disposeObject3D(marker);
    });
    this.worldCornerMarkers = [];
    for (const mesh of this.expansionTileMeshes.values()) {
      this.scene.remove(mesh);
      disposeObject3D(mesh);
    }
    this.expansionTileMeshes.clear();
    this.renderer.dispose();
  }
}
