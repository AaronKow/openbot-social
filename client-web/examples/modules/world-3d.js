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
    new THREE.BoxGeometry(0.34, 0.24, 0.24),
    new THREE.MeshStandardMaterial({ color: 0xb6bdc5, roughness: 0.32, metalness: 0.85 })
  );
  head.position.x = 0.62;
  head.castShadow = true;
  group.add(head);

  const backWeight = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.18, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x8f969e, roughness: 0.35, metalness: 0.8 })
  );
  backWeight.position.x = 0.42;
  backWeight.castShadow = true;
  group.add(backWeight);

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
    this.hazardVisuals = new Map();
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
    hammerMesh.scale.set(3.35, 3.35, 3.35);
    hammerPivot.visible = false;
    hammerPivot.add(hammerMesh);
    mesh.add(hammerPivot);

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
    const dodge = clamp((combat.dodgeUntil || 0) / 1.0, 0, 1);
    const hitReact = clamp((combat.tookHitUntil || 0) / 0.6, 0, 1);

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
    if (record.hammerPivot.visible) {
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
    if (swing > 0.1) statuses.push('HAMMER SWING');
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

      record.group.position.set(clamp(hazard.x, 0, 100), 0, clamp(hazard.z, 0, 100));
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
    this.syncHazards(world.hazards);
    const hzTime = Number.isFinite(world.elapsedSeconds) ? world.elapsedSeconds : (world.tick / 12);
    for (const hazard of this.hazardVisuals.values()) {
      hazard.update(hzTime);
    }
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
        record.sleepGlyphs.forEach((glyph) => {
          glyph.sprite.material.dispose();
          glyph.texture.dispose();
        });
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
      record.sleepGlyphs.forEach((glyph) => {
        glyph.sprite.material.dispose();
        glyph.texture.dispose();
      });
      disposeObject3D(record.mesh);
      record.tag.sprite.material?.map?.dispose?.();
      record.tag.sprite.material?.dispose?.();
      record.statusTag.sprite.material?.map?.dispose?.();
      record.statusTag.sprite.material?.dispose?.();
    }
    this.lobsters.clear();
    for (const record of this.hazardVisuals.values()) {
      disposeObject3D(record.group);
    }
    this.hazardVisuals.clear();
    this.renderer.dispose();
  }
}
