import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { config } from './config.js';

const LOBSTER_HEAD_ALIGNMENT_THRESHOLD = THREE.MathUtils.degToRad(2);
const LOBSTER_MAX_TURN_RATE = 6.8; // rad/s
const LOBSTER_MAX_FORWARD_SPEED = 16; // world units/s
const LOBSTER_COLLISION_RADIUS = 1.2;
const MAP_EDGE_BUFFER = LOBSTER_COLLISION_RADIUS + 0.35;
const COLLISION_PUSH_BUFFER = 0.35;
const RECOVERY_MOVE_DISTANCE = 10;
const RECOVERY_TIMEOUT_MS = 1200;
const MOVE_PROGRESS_EPSILON = 0.04;
const MOVE_STUCK_TIMEOUT_MS = 1000;
const SKY_UPDATE_MAX_FPS = 24;
const CLOUD_UPDATE_MAX_FPS = 12;
const CLOUD_TEXTURE_POOL_SIZE = 10;
const GROUND_Y = 0;
const THREAT_UPDATE_MAX_FPS = 24;
const COMBAT_FX_MAX = 220;
const CAMERA_VIEW_PRESETS = Object.freeze({
    isometric: Object.freeze({ x: 10, y: 8, z: 10 }),
    dimetric: Object.freeze({ x: 12, y: 9, z: 6 }),
    trimetric: Object.freeze({ x: 14, y: 10, z: 4 })
});

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function randomRange(min, max) {
    return min + (Math.random() * (max - min));
}

function disposeObject3D(root) {
    if (!root) return;
    root.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (!obj.material) return;
        if (Array.isArray(obj.material)) {
            obj.material.forEach((mat) => mat?.dispose?.());
            return;
        }
        obj.material.dispose();
    });
}

function createGlowTexture({
    size = 256,
    inner = 'rgba(255,245,210,0.96)',
    mid = 'rgba(255,220,140,0.48)',
    outer = 'rgba(255,190,90,0.0)'
} = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const center = size / 2;

    const gradient = ctx.createRadialGradient(center, center, size * 0.03, center, center, size * 0.5);
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

function createMoonlightTexture({
    size = 512,
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

    // Add slight breakup to avoid a perfectly smooth projected circle.
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

const BEAM_UP = new THREE.Vector3(0, 1, 0);
const BEAM_VECTOR = new THREE.Vector3();

function positionBeamBetween(mesh, start, end, baseHeight = 44) {
    if (!mesh || !start || !end) return;
    BEAM_VECTOR.subVectors(end, start);
    const length = Math.max(0.001, BEAM_VECTOR.length());
    mesh.position.copy(start).addScaledVector(BEAM_VECTOR, 0.5);
    BEAM_VECTOR.normalize();
    mesh.quaternion.setFromUnitVectors(BEAM_UP, BEAM_VECTOR);
    mesh.scale.set(1, length / baseHeight, 1);
}

function hashString(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
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

function createCloudTexture(size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2;
    const cy = size / 2;
    const puffCount = 4 + Math.floor(Math.random() * 5);

    ctx.clearRect(0, 0, size, size);
    for (let i = 0; i < puffCount; i += 1) {
        const radius = randomRange(size * 0.13, size * 0.24);
        const px = cx + randomRange(-size * 0.2, size * 0.2);
        const py = cy + randomRange(-size * 0.16, size * 0.16);
        const alpha = randomRange(0.12, 0.3);
        const gradient = ctx.createRadialGradient(px, py, radius * 0.16, px, py, radius);
        gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
}

function createCloudTexturePool(count = CLOUD_TEXTURE_POOL_SIZE) {
    const pool = [];
    for (let i = 0; i < count; i += 1) {
        pool.push(createCloudTexture(256));
    }
    return pool;
}

function celestialPosition(timeHours, phaseOffsetHours = 0) {
    const normalizedHours = ((((Number(timeHours) || 0) + phaseOffsetHours) % 24) + 24) % 24;
    const dayProgress = normalizedHours / 24;
    const orbitAngle = (dayProgress * Math.PI * 2) - (Math.PI / 2);
    const elevation = Math.sin(orbitAngle);
    const horizontalRadius = 74;

    return {
        x: 50 + (Math.cos(orbitAngle) * horizontalRadius),
        y: 14 + (elevation * 56),
        z: 50 + (Math.sin(orbitAngle) * horizontalRadius * 0.82),
        elevation
    };
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
    return { sprite, texture };
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
        new THREE.MeshStandardMaterial({
            color: 0xe5ebf3,
            roughness: 0.26,
            metalness: 0.9,
            emissive: 0x374250,
            emissiveIntensity: 0.25
        })
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

function createOctopusModel() {
    const group = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({
        color: 0x7b57d1,
        roughness: 0.5,
        metalness: 0.18,
        emissive: 0x26154f,
        emissiveIntensity: 0.18
    });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1.3, 20, 18), bodyMaterial);
    body.position.y = 1.2;
    body.castShadow = true;
    group.add(body);

    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xf5f8ff });
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x0d1020 });
    const eyeOffsets = [-0.34, 0.34];
    for (const offset of eyeOffsets) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), eyeMat);
        eye.position.set(0.48, 1.4, offset);
        group.add(eye);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), pupilMat);
        pupil.position.set(0.6, 1.38, offset);
        group.add(pupil);
    }

    for (let i = 0; i < 8; i += 1) {
        const angle = (i / 8) * Math.PI * 2;
        const tentacle = new THREE.Mesh(
            new THREE.CylinderGeometry(0.08, 0.15, 1.65, 8),
            new THREE.MeshStandardMaterial({ color: 0x5f3bb4, roughness: 0.62, metalness: 0.08 })
        );
        tentacle.position.set(Math.cos(angle) * 0.72, 0.28, Math.sin(angle) * 0.72);
        tentacle.rotation.z = Math.cos(angle) * 0.26;
        tentacle.rotation.x = Math.sin(angle) * 0.26;
        tentacle.castShadow = true;
        tentacle.userData.baseRotationX = tentacle.rotation.x;
        tentacle.userData.baseRotationZ = tentacle.rotation.z;
        group.add(tentacle);
    }

    return group;
}

class OpenBotWorld {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.agents = new Map(); // agentId -> { mesh, data }
        this.obstacles = [];
        this.decorationMeshes = new Map();
        this.threatMeshes = new Map(); // threatId -> render data
        this.chatBubbles = new Map(); // agentId -> { bubble, createdAt }
        this.connected = false;
        this.pollInterval = config.pollInterval;
        this.worldTick = null; // Last successfully applied world tick
        this.worldDeltaEnabled = false; // Switch to incremental polling after first full sync
        this.worldObjectsSignature = '';
        this.expansionTileMeshes = new Map(); // tileId -> THREE.Group
        this.expansionTilePulseEffects = new Map(); // tileId -> pulse effect
        this.expansionTilesById = new Map();
        this.expansionTilesSeen = new Set();
        this.hazardVisuals = new Map(); // eventId -> hazard visual
        this.latestExpansionStats = {
            mapExpansionLevel: 0,
            newTilesCount: 0,
            topBuilders: [],
            totalTiles: 0
        };
        this.lastChatTimestamp = 0;
        this.agentSleepStateById = new Map(); // agentId -> sleeping flag (for UI-only energy system messages)
        this.agentNameMap = new Map(); // agentName -> agentId
        this.serverStartTime = null; // Server process start time (uptime metadata)
        this.worldCreatedAt = null; // Persistent world day anchor
        this.worldCycleSeconds = 24 * 60 * 60;
        this.totalEntitiesCreated = 0; // Total entities ever created
        this.followedAgentId = null; // Agent currently being followed by camera
        this.followedAgentInitialPos = null; // Initial position when started following
        this.viewPreset = 'isometric';
        this.followCameraOffset = new THREE.Vector3(10, 8, 10);
        this.cameraTransitionUntilMs = 0;
        this.activityLogFetched = false; // Whether the activity log has been loaded for this tab visit
        this.summarizationTriggered = false; // Whether we've sent the one-time check this session
        this.leaderboardTriggered = false;
        this._lastLeaderboard = null;
        this._lastWorldProgress = null;
        this.worldProgressPollMs = 20000;
        this._nextWorldProgressRefreshAt = 0;
        
        // Keyboard state tracking
        this.keysPressed = {
            arrowUp: false,
            arrowDown: false,
            arrowLeft: false,
            arrowRight: false,
            w: false,
            a: false,
            s: false,
            d: false
        };
        this.keyboardSpeed = 0.5; // Units per frame
        
        // Raycaster for clicking on lobsters
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        
        // Mouse drag tracking
        this.isMouseDown = false;
        this.mouseDragStartX = 0;
        this.mouseDragStartY = 0;
        this.mouseDragThreshold = 5; // pixels
        
        // Chat scroll tracking
        this.chatIsAtBottom = true;
        
        // Chat lazy-loading state
        this.chatIsLoading = false;  // prevents concurrent history fetches
        this.chatHasMore = true;     // set false when server returns no older messages
        this.worldPollInFlight = false; // prevents overlapping world-state poll requests
        this.chatPollInFlight = false; // prevents overlapping chat poll requests
        this.worldPollTimer = null;
        this.chatPollTimer = null;
        this.worldPollFailures = 0;
        this.chatPollFailures = 0;
        this.maxPollBackoffMs = 30_000;
        this.hiddenPollIntervalMs = Math.max(this.pollInterval, 10_000);
        this.isPageHidden = document.visibilityState === 'hidden';

        // Contextual menu + wiki state
        this.contextMenuAgentId = null;
        this.contextMenuOpen = false;
        this.suppressNextClick = false;
        this.longPressTimer = null;
        this.longPressMoved = false;
        this.longPressTargetAgentId = null;
        this.longPressStart = { x: 0, y: 0 };
        this.longPressMs = 550;
        this.longPressMoveThreshold = 10;
        this.wikiCache = new Map(); // entityId -> { ts, data }
        this.wikiCacheTtlMs = 60_000;
        this.wikiDirectoryCache = { ts: 0, data: [] };
        this.currentWiki = null;
        this.currentWikiEntityId = null;
        this.currentQuestEntityId = null;
        this.questSummary = null;
        this.lastQuestFetchAt = 0;
        this.worldEvents = [];
        this.timelineFilter = 'all';
        this.wikiAvatarRenderers = [];
        this.worldDayLabel = '';
        this.worldClockMinuteKey = '';
        this.worldTimeState = null;
        this.worldTimeSync = null; // Canonical world clock state from server
        this.hasSyncedWorldDay = false;
        this.cachedWorldDay = null;
        this.worldDayCacheKey = 'openbot.worldDay';
        this.worldDayCacheTimestampKey = 'openbot.worldDayUpdatedAt';
        this.skyUpdateAccumulator = 0;
        this.cloudUpdateAccumulator = 0;
        this.lastAnimationFrameMs = performance.now();
        this.clouds = [];
        this.cloudTexturePool = [];
        this.combatEffects = [];
        this.seenCombatEvents = new Set();
        this.lastThreatUpdateMs = 0;
        this.cloudBounds = { minX: -30, maxX: 130, minZ: 5, maxZ: 95, minY: 42, maxY: 72 };
        this.sunMesh = null;
        this.moonMesh = null;
        this.sunGlow = null;
        this.moonDisc = null;
        this.moonDiscCore = null;
        this.moonBeam = null;
        this.sunDisc = null;
        this.sunDiscCore = null;
        this.moonLight = null;
        this.moonDiscTexture = null;
        this.moonCoreTexture = null;
        this._moonTargetVec = new THREE.Vector3();
        this._sunTargetVec = new THREE.Vector3();
        this._moonPosVec = new THREE.Vector3();
        this._sunPosVec = new THREE.Vector3();
        this.ignoredAnimationStateLogThrottleMs = 60_000;
        this.ignoredAnimationStateLogs = new Map(); // "action|state" -> lastLogMs
        this.showAnimationDiagnosticsInAgentList = new URLSearchParams(window.location.search).get('animDebug') === '1';
        this.loadCachedWorldDay();
        // API URL configuration (priority order):
        // 1. Query parameter: ?server=https://your-api.com
        // 2. config.js defaultApiUrl (set via environment or manual edit)
        // 3. Fallback: '' (same-origin, for local development)
        const params = new URLSearchParams(window.location.search);
        this.debugHead = params.get('debugHead') === '1';
        const serverUrl = params.get('server') || config.defaultApiUrl || '';
        if (serverUrl && /^https?:\/\/.+/.test(serverUrl)) {
            this.apiBase = serverUrl.replace(/\/+$/, '');
        } else {
            this.apiBase = '';
        }
        
        console.log(`OpenBot Social - Connecting to API: ${this.apiBase}`);
        
        this.init();
        this.setupUIControls();
        this.setupKeyboardControls();
        this.setupMouseControls();
        this.exposeAutomationApi();
        this.startPolling();
        this.startUptimeTimer();
        // triggerSummarizationCheck is called after first successful connection
        this.animate();
    }
    
    init() {
        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x6ba3d4);
        this.scene.fog = new THREE.Fog(0x6ba3d4, 50, 200);
        
        // Camera - Isometric/bird's eye view
        this.camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        this.camera.position.set(50, 50, -20);
        this.camera.lookAt(50, 0, 50);
        
        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.localClippingEnabled = true;
        document.getElementById('canvas-container').appendChild(this.renderer.domElement);
        
        // Controls - completely free zoom
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(50, 0, 50);  // Center orbit around world center
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 0;  // No minimum distance
        this.controls.maxDistance = Infinity;  // No maximum distance
        
        // Lights
        this.ambientLight = new THREE.AmbientLight(0xffffff, 3.5);
        this.scene.add(this.ambientLight);
        
        this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
        this.directionalLight.position.set(50, 100, 50);
        this.directionalLight.castShadow = true;
        this.directionalLight.shadow.camera.left = -100;
        this.directionalLight.shadow.camera.right = 100;
        this.directionalLight.shadow.camera.top = 100;
        this.directionalLight.shadow.camera.bottom = -100;
        this.scene.add(this.directionalLight);
        this.createSkySystem();
        this.createCloudSystem();
        
        // Ocean floor
        this.createOceanFloor();
        
        // Decorations are loaded from persisted world-state objects.
        this.addDecorations();
        
        // Handle window resize
        window.addEventListener('resize', () => this.onWindowResize());
    }

    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    safeClassToken(value, fallback = 'unknown') {
        const normalized = String(value ?? fallback).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        return normalized || fallback;
    }
    
    createOceanFloor() {
        // Sand floor - smooth and even (now with thickness)
        const floorGeometry = new THREE.BoxGeometry(100, 3, 100);
        const floorMaterial = new THREE.MeshStandardMaterial({
            color: 0xc2b280,
            roughness: 0.8,
            metalness: 0.2,
            side: THREE.DoubleSide  // Visible from both sides
        });
        
        const floor = new THREE.Mesh(floorGeometry, floorMaterial);
        floor.position.set(50, -1.5, 50);
        floor.receiveShadow = true;
        this.scene.add(floor);
    }
    
    addDecorations() {
        this.clearDecorations();
        this.obstacles = [];
    }

    createSkySystem() {
        this.moonDiscTexture = createMoonlightTexture({
            coreAlpha: 0.48,
            midAlpha: 0.3,
            edgeAlpha: 0,
            breakup: 0.06
        });
        this.moonCoreTexture = createMoonlightTexture({
            coreAlpha: 0.34,
            midAlpha: 0.14,
            edgeAlpha: 0,
            breakup: 0.04
        });

        this.sunMesh = new THREE.Mesh(
            new THREE.SphereGeometry(3.6, 24, 24),
            new THREE.MeshBasicMaterial({ color: 0xffd777 })
        );
        this.moonMesh = new THREE.Mesh(
            new THREE.SphereGeometry(2.6, 20, 20),
            new THREE.MeshBasicMaterial({ color: 0xd7e6ff })
        );

        this.sunGlowTexture = createGlowTexture();
        this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: this.sunGlowTexture,
            transparent: true,
            opacity: 0.75,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        }));
        this.sunGlow.scale.set(16, 16, 1);

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

        this.moonLight = new THREE.SpotLight(0xaad4ff, 0);
        this.moonLight.position.set(50, 38, 50);
        this.moonLight.angle = 0.7;
        this.moonLight.penumbra = 0.8;
        this.moonLight.decay = 1.35;
        this.moonLight.distance = 170;
        this.moonLight.target.position.set(50, 0, 50);

        this.scene.add(this.sunMesh);
        this.scene.add(this.moonMesh);
        this.scene.add(this.sunGlow);
        this.scene.add(this.moonDisc);
        this.scene.add(this.moonDiscCore);
        this.scene.add(this.moonBeam);
        this.scene.add(this.sunDisc);
        this.scene.add(this.sunDiscCore);
        this.scene.add(this.moonLight);
        this.scene.add(this.moonLight.target);
    }

    createCloudSystem() {
        this.cloudTexturePool = createCloudTexturePool(CLOUD_TEXTURE_POOL_SIZE);
        const count = this.getAdaptiveCloudBudget();
        for (let i = 0; i < count; i += 1) {
            const cloud = this.spawnCloud(true);
            this.clouds.push(cloud);
            this.scene.add(cloud.sprite);
        }
    }

    getAdaptiveCloudBudget() {
        const cores = navigator.hardwareConcurrency || 4;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pixels = Math.max(1, window.innerWidth * window.innerHeight * dpr * dpr);
        const pixelFactor = clamp(1_500_000 / pixels, 0.4, 1.1);
        const base = 56 * pixelFactor * (cores >= 8 ? 1.25 : 1);
        return Math.max(28, Math.min(96, Math.floor(base)));
    }

    spawnCloud(initial = false) {
        const texture = this.cloudTexturePool[Math.floor(Math.random() * this.cloudTexturePool.length)];
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            opacity: initial ? randomRange(0.06, 0.22) : 0,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(material);
        const cloud = {
            sprite,
            age: 0,
            ttl: 0,
            fadeIn: 0,
            fadeOut: 0,
            speed: 0,
            drift: 0,
            seed: 0
        };
        this.resetCloud(cloud, initial);
        return cloud;
    }

    resetCloud(cloud, initial = false) {
        cloud.age = initial ? randomRange(0, 9) : 0;
        cloud.ttl = randomRange(32, 60);
        cloud.fadeIn = randomRange(3, 6);
        cloud.fadeOut = randomRange(5, 9);
        cloud.speed = randomRange(0.9, 2.2);
        cloud.drift = randomRange(-0.22, 0.22);
        cloud.seed = Math.random() * Math.PI * 2;

        const { minX, maxX, minY, maxY, minZ, maxZ } = this.cloudBounds;
        cloud.sprite.position.set(
            Math.random() > 0.5 ? randomRange(minX, 4) : randomRange(96, maxX),
            randomRange(minY, maxY),
            randomRange(minZ, maxZ)
        );
        const scale = randomRange(14, 28);
        cloud.sprite.scale.set(scale, scale * randomRange(0.42, 0.66), 1);
        cloud.sprite.material.opacity = initial ? randomRange(0.06, 0.22) : 0;

        if (!initial && this.cloudTexturePool.length > 0) {
            const texture = this.cloudTexturePool[Math.floor(Math.random() * this.cloudTexturePool.length)];
            cloud.sprite.material.map = texture;
            cloud.sprite.material.needsUpdate = true;
        }
    }

    updateClouds(dt, daylight) {
        if (!this.clouds.length) return;
        const { minX, maxX, minY, maxY, minZ, maxZ } = this.cloudBounds;
        const visibility = 0.05 + (daylight * 0.34);

        for (const cloud of this.clouds) {
            cloud.age += dt;
            const t = cloud.age;
            const fadeIn = cloud.fadeIn;
            const fadeOut = cloud.fadeOut;
            const life = cloud.ttl;

            let alpha = 1;
            if (t < fadeIn) alpha = t / Math.max(0.001, fadeIn);
            if (t > life - fadeOut) alpha = Math.min(alpha, (life - t) / Math.max(0.001, fadeOut));
            cloud.sprite.material.opacity = clamp(alpha, 0, 1) * visibility;

            cloud.sprite.position.x += cloud.speed * dt;
            cloud.sprite.position.z += Math.sin((t * 0.33) + cloud.seed) * cloud.drift * dt;
            cloud.sprite.position.y = clamp(
                cloud.sprite.position.y + (Math.sin((t * 0.22) + cloud.seed) * 0.3 * dt),
                minY,
                maxY
            );

            if (t >= life || cloud.sprite.position.x > maxX || cloud.sprite.position.x < minX || cloud.sprite.position.z < minZ || cloud.sprite.position.z > maxZ) {
                this.resetCloud(cloud, false);
            }
        }
    }


    buildWorldObjectsSignature(objects) {
        if (!Array.isArray(objects) || objects.length === 0) return 'empty';
        return objects.map((object) => {
            const id = object?.id ?? '';
            const type = object?.type ?? '';
            const p = object?.position || {};
            const d = object?.data || {};
            const servesRemaining = Number(d.servesRemaining);
            const x = Number(p.x);
            const y = Number(p.y);
            const z = Number(p.z);
            const serves = Number.isFinite(servesRemaining) ? servesRemaining : '';
            return `${id}:${type}:${x.toFixed ? x.toFixed(2) : x}|${y.toFixed ? y.toFixed(2) : y}|${z.toFixed ? z.toFixed(2) : z}:${serves}`;
        }).join(';');
    }

    clearDecorations() {
        for (const mesh of this.decorationMeshes.values()) {
            this.scene.remove(mesh);
        }
        this.decorationMeshes.clear();
    }

    renderWorldObjects(objects) {
        if (!Array.isArray(objects)) {
            return;
        }

        const signature = this.buildWorldObjectsSignature(objects);
        if (signature === this.worldObjectsSignature) {
            return;
        }
        this.worldObjectsSignature = signature;

        this.clearDecorations();
        this.obstacles = [];

        for (const object of objects) {
            const { id, type, position = {}, data = {} } = object;
            const x = Number(position.x);
            const y = Number(position.y);
            const z = Number(position.z);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                continue;
            }

            let mesh = null;
            let radius = Number(data.radius) || 0.9;
            let yOffset = 0;
            if (type === 'rock') {
                const geometry = new THREE.DodecahedronGeometry(radius);
                mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.9 }));
                mesh.rotation.set(
                    Number(data.rotation?.x) || 0,
                    Number(data.rotation?.y) || 0,
                    Number(data.rotation?.z) || 0
                );
                mesh.receiveShadow = true;
            } else if (type === 'kelp' || type === 'seaweed') {
                const height = Number(data.height) || (type === 'kelp' ? 4 : 3);
                const topRadius = type === 'kelp' ? 0.1 : 0.08;
                const bottomRadius = type === 'kelp' ? 0.2 : 0.16;
                const color = type === 'kelp' ? 0x2d5016 : 0x3f7d39;
                mesh = new THREE.Mesh(
                    new THREE.CylinderGeometry(topRadius, bottomRadius, height),
                    new THREE.MeshStandardMaterial({ color, roughness: 0.7 })
                );
                radius = Number(data.radius) || (type === 'kelp' ? 0.9 : 0.7);
            } else if (type === 'algae_pallet') {
                radius = Number(data.radius) || 0.95;
                const servesRemaining = Math.max(0, Math.floor(Number(data.servesRemaining) || 0));
                const fillRatio = Math.max(0.1, Math.min(1, servesRemaining / 3));
                mesh = new THREE.Group();

                const trayHeight = 0.22;
                const tray = new THREE.Mesh(
                    new THREE.CylinderGeometry(radius * 0.92, radius, trayHeight, 24),
                    new THREE.MeshStandardMaterial({ color: 0x7b5b33, roughness: 0.86, metalness: 0.04 })
                );
                tray.position.y = trayHeight * 0.5;
                tray.receiveShadow = true;
                mesh.add(tray);

                const algaeCore = new THREE.Mesh(
                    new THREE.SphereGeometry(radius * 0.34, 16, 14),
                    new THREE.MeshStandardMaterial({
                        color: 0x6ce070,
                        roughness: 0.42,
                        emissive: 0x1f5c2d,
                        emissiveIntensity: 0.2
                    })
                );
                algaeCore.position.y = trayHeight + (radius * 0.28);
                algaeCore.scale.setScalar(fillRatio);
                mesh.add(algaeCore);

                const pelletOffsets = [
                    [-0.22, 0.16],
                    [0.24, 0.12],
                    [0.06, -0.2],
                    [-0.12, -0.24]
                ];
                for (let i = 0; i < pelletOffsets.length; i += 1) {
                    const [ox, oz] = pelletOffsets[i];
                    const pellet = new THREE.Mesh(
                        new THREE.SphereGeometry(radius * 0.16, 12, 10),
                        new THREE.MeshStandardMaterial({
                            color: 0x6ce070,
                            roughness: 0.4,
                            emissive: 0x2f7f3b,
                            emissiveIntensity: 0.16
                        })
                    );
                    const pelletScale = Math.max(0.35, fillRatio - (i * 0.12));
                    pellet.position.set(ox * radius, trayHeight + (radius * 0.16), oz * radius);
                    pellet.scale.setScalar(pelletScale);
                    mesh.add(pellet);
                }
                yOffset = 0.02;
            } else {
                continue;
            }

            mesh.position.set(x, y + yOffset, z);
            mesh.castShadow = true;
            this.scene.add(mesh);
            this.decorationMeshes.set(String(id || `${type}-${x}-${z}`), mesh);
            this.obstacles.push({ x, z, radius });
        }
    }

    createExpansionTileMesh(tile = {}) {
        const group = new THREE.Group();
        const level = Math.max(0, Number(tile.level || 0));
        const color = level >= 20 ? 0x76ffd9 : level >= 10 ? 0x8fd8ff : 0xffe7a4;

        const fill = new THREE.Mesh(
            new THREE.PlaneGeometry(0.94, 0.94),
            new THREE.MeshStandardMaterial({
                color,
                transparent: true,
                opacity: 0.42,
                emissive: color,
                emissiveIntensity: 0.08,
                roughness: 0.58,
                metalness: 0.06,
                side: THREE.DoubleSide,
                depthWrite: false
            })
        );
        fill.rotation.x = -Math.PI / 2;
        fill.position.y = 0.06;
        group.add(fill);

        const border = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
            new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })
        );
        border.rotation.x = -Math.PI / 2;
        border.position.y = 0.07;
        group.add(border);

        return group;
    }

    syncExpansionTiles(expansionTiles = []) {
        if (!Array.isArray(expansionTiles)) {
            return;
        }

        const normalizedTiles = [];
        for (const tile of expansionTiles) {
            const x = Math.round(Number(tile?.x));
            const z = Math.round(Number(tile?.z));
            if (!Number.isFinite(x) || !Number.isFinite(z)) {
                continue;
            }
            const id = String(tile?.id || `expansion-${x}-${z}`);
            normalizedTiles.push({ ...tile, id, x, z });
        }

        const nextIds = new Set(normalizedTiles.map((tile) => tile.id));
        for (const [tileId, mesh] of this.expansionTileMeshes.entries()) {
            if (nextIds.has(tileId)) {
                continue;
            }
            this.scene.remove(mesh);
            disposeObject3D(mesh);
            this.expansionTileMeshes.delete(tileId);
            this.expansionTilePulseEffects.delete(tileId);
            this.expansionTilesById.delete(tileId);
            this.expansionTilesSeen.delete(tileId);
        }

        const newTiles = [];
        for (const tile of normalizedTiles) {
            let mesh = this.expansionTileMeshes.get(tile.id);
            if (!mesh) {
                mesh = this.createExpansionTileMesh(tile);
                this.scene.add(mesh);
                this.expansionTileMeshes.set(tile.id, mesh);
            }

            mesh.position.set(tile.x, 0, tile.z);
            this.expansionTilesById.set(tile.id, tile);

            if (!this.expansionTilesSeen.has(tile.id)) {
                newTiles.push(tile);
            }
        }

        this.latestExpansionStats = {
            mapExpansionLevel: Number.isFinite(Number(normalizedTiles.length)) ? normalizedTiles.length : 0,
            newTilesCount: newTiles.length,
            topBuilders: this.computeTopBuilders(normalizedTiles),
            totalTiles: normalizedTiles.length
        };

        this.updateExpansionHud();

        for (const tile of newTiles) {
            this.expansionTilesSeen.add(tile.id);
            this.spawnExpansionPulse(tile);
        }
    }

    resolveHazardType(event = {}) {
        const explicitType = String(event?.hazardType || event?.variant || event?.subtype || '').toLowerCase();
        const allowedTypes = new Set(['blizzard', 'fire', 'thunder', 'tornado']);
        if (allowedTypes.has(explicitType)) {
            return explicitType;
        }

        const hazardTypes = ['blizzard', 'fire', 'thunder', 'tornado'];
        const index = hashString(event?.id || event?.title || event?.description || 'hazard-zone') % hazardTypes.length;
        return hazardTypes[index];
    }

    mapHazardEvents(events = []) {
        if (!Array.isArray(events)) return [];
        const hazards = [];
        for (const event of events) {
            if (!event || String(event.type || '').toLowerCase() !== 'hazard_zone') continue;
            if (String(event.status || '').toLowerCase() !== 'active') continue;
            const center = event.center || {};
            const x = Number(center.x);
            const z = Number(center.z);
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
            const radius = Math.max(2, Number(event.radius) || 9);
            hazards.push({
                id: String(event.id || `hazard-zone-${x}-${z}`),
                type: this.resolveHazardType(event),
                radius,
                x,
                z
            });
        }
        return hazards;
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
            record.group.position.set(hazard.x, 0, hazard.z);
        });
    }

    computeTopBuilders(expansionTiles = []) {
        const counts = new Map();
        for (const tile of expansionTiles) {
            const owner = String(tile?.ownerAgentId || tile?.ownerEntityId || '').trim();
            if (!owner) continue;
            counts.set(owner, (counts.get(owner) || 0) + 1);
        }

        return Array.from(counts.entries())
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .slice(0, 3)
            .map(([ownerId, count]) => ({ ownerId, count }));
    }

    spawnExpansionPulse(tile) {
        const mesh = this.expansionTileMeshes.get(tile.id);
        const pulseRoot = mesh || this.scene;
        if (!pulseRoot) return;

        const marker = new THREE.Mesh(
            new THREE.RingGeometry(0.24, 0.56, 24),
            new THREE.MeshBasicMaterial({
                color: 0x7afad9,
                transparent: true,
                opacity: 0.95,
                depthWrite: false,
                side: THREE.DoubleSide
            })
        );
        marker.rotation.x = -Math.PI / 2;
        if (mesh) {
            marker.position.y = 0.11;
            mesh.add(marker);
        } else {
            marker.position.set(Number(tile?.x) || 0, 0.12, Number(tile?.z) || 0);
            this.scene.add(marker);
        }

        this.expansionTilePulseEffects.set(tile.id, {
            marker,
            startedAt: performance.now(),
            durationMs: 850
        });
    }

    updateExpansionPulseEffects(nowMs = performance.now()) {
        for (const [tileId, effect] of this.expansionTilePulseEffects.entries()) {
            if (!effect?.marker) {
                this.expansionTilePulseEffects.delete(tileId);
                continue;
            }
            const elapsed = nowMs - effect.startedAt;
            const t = clamp(elapsed / Math.max(1, effect.durationMs), 0, 1);
            effect.marker.scale.setScalar(1 + (t * 1.75));
            if (effect.marker.material) {
                effect.marker.material.opacity = (1 - t) * 0.95;
            }

            if (t >= 1) {
                effect.marker.parent?.remove(effect.marker);
                effect.marker.geometry?.dispose?.();
                effect.marker.material?.dispose?.();
                this.expansionTilePulseEffects.delete(tileId);
            }
        }
    }

    resolveAgentNameForId(agentId) {
        if (!agentId) return null;
        const direct = this.agents.get(agentId)?.data?.name;
        if (direct) return direct;
        for (const [name, id] of this.agentNameMap.entries()) {
            if (id === agentId) {
                return name;
            }
        }
        return null;
    }

    updateExpansionHud() {
        const levelEl = document.getElementById('map-expansion-level');
        if (levelEl) {
            levelEl.textContent = `L${this.latestExpansionStats.mapExpansionLevel || 0}`;
        }

        const newTilesEl = document.getElementById('expansion-new-tiles');
        if (newTilesEl) {
            newTilesEl.textContent = `+${this.latestExpansionStats.newTilesCount || 0}`;
        }

        const topBuildersEl = document.getElementById('expansion-top-builders');
        if (topBuildersEl) {
            if (!Array.isArray(this.latestExpansionStats.topBuilders) || this.latestExpansionStats.topBuilders.length === 0) {
                topBuildersEl.textContent = '—';
            } else {
                topBuildersEl.textContent = this.latestExpansionStats.topBuilders
                    .map(({ ownerId, count }) => {
                        const name = this.resolveAgentNameForId(ownerId) || ownerId.slice(0, 8);
                        return `${name} (${count})`;
                    })
                    .join(', ');
            }
        }
    }

    updateWorldMomentumHud() {
        const data = this._lastWorldProgress;
        const idleEl = document.getElementById('momentum-idle-chat-ratio');
        const explorersEl = document.getElementById('momentum-top-explorers');
        const frontierGainEl = document.getElementById('momentum-frontier-gain');
        const objectiveShareEl = document.getElementById('momentum-objective-action-share');
        const pressureEl = document.getElementById('momentum-social-pressure');
        const recFollowEl = document.getElementById('momentum-rec-follow-through');
        const missionLiftEl = document.getElementById('momentum-mission-lift');

        if (!data || data.success === false) {
            if (idleEl) idleEl.textContent = '0.0%';
            if (explorersEl) explorersEl.textContent = '—';
            if (frontierGainEl) frontierGainEl.textContent = '0.00';
            if (objectiveShareEl) objectiveShareEl.textContent = '0.0%';
            if (pressureEl) pressureEl.textContent = '0.000';
            if (recFollowEl) recFollowEl.textContent = '0.0%';
            if (missionLiftEl) missionLiftEl.textContent = '0.000';
            return;
        }

        if (idleEl) idleEl.textContent = `${(Number(data.idleChatRatio || 0) * 100).toFixed(1)}%`;
        if (frontierGainEl) frontierGainEl.textContent = Number(data.frontierGainPerDay || 0).toFixed(2);
        if (objectiveShareEl) objectiveShareEl.textContent = `${(Number(data.objectiveActionShare || 0) * 100).toFixed(1)}%`;
        if (pressureEl) pressureEl.textContent = Number(data.socialOnlyPressure || 0).toFixed(3);
        const rec = data.recommendationEffectiveness || {};
        if (recFollowEl) recFollowEl.textContent = `${(Number(rec.followThroughRate || 0) * 100).toFixed(1)}%`;
        if (missionLiftEl) missionLiftEl.textContent = Number(rec.missionLiftPerFollowThrough || 0).toFixed(3);
        if (explorersEl) {
            const rows = Array.isArray(data.topExplorers) ? data.topExplorers : [];
            explorersEl.textContent = rows.length > 0
                ? rows
                    .slice(0, 3)
                    .map((row) => `${String(row.entityId || 'n/a')} (${Number(row.uniqueGridCellsVisited || 0)})`)
                    .join(', ')
                : '—';
        }
    }

    maybeRefreshWorldProgress(force = false) {
        const now = Date.now();
        if (!force && now < this._nextWorldProgressRefreshAt) return;
        this._nextWorldProgressRefreshAt = now + this.worldProgressPollMs;
        this.fetchWorldProgress(7).then(() => this.updateWorldMomentumHud());
    }


    syncThreats(threats = []) {
        const nextIds = new Set();
        threats.forEach((threat) => {
            if (!threat?.id) return;
            nextIds.add(threat.id);
            const pos = threat.position || {};
            const x = Number(pos.x);
            const y = Number(pos.y);
            const z = Number(pos.z);
            if (!Number.isFinite(x) || !Number.isFinite(z)) return;

            let record = this.threatMeshes.get(threat.id);
            if (!record) {
                const mesh = createOctopusModel();
                mesh.position.set(x, Number.isFinite(y) ? y : 0.6, z);
                this.scene.add(mesh);

                const hpGroup = new THREE.Group();
                const hpBg = new THREE.Mesh(
                    new THREE.PlaneGeometry(2.8, 0.28),
                    new THREE.MeshBasicMaterial({ color: 0x1c2233, transparent: true, opacity: 0.85, depthWrite: false })
                );
                hpGroup.add(hpBg);
                const hpFill = new THREE.Mesh(
                    new THREE.PlaneGeometry(2.7, 0.18),
                    new THREE.MeshBasicMaterial({ color: 0xff5f6d, transparent: true, opacity: 0.95, depthWrite: false })
                );
                hpFill.position.z = 0.01;
                hpGroup.add(hpFill);
                this.scene.add(hpGroup);

                record = {
                    mesh,
                    hpGroup,
                    hpFill,
                    hpRatio: 1,
                    bobPhase: Math.random() * Math.PI * 2
                };
                this.threatMeshes.set(threat.id, record);
            }

            const targetY = Number.isFinite(y) ? y : 0.6;
            record.mesh.position.lerp(new THREE.Vector3(x, targetY, z), 0.55);
            const hp = Math.max(0, Number(threat.hp) || 0);
            const maxHp = Math.max(1, Number(threat.maxHp) || 1);
            record.hpRatio = clamp(hp / maxHp, 0, 1);
            record.hpFill.scale.x = Math.max(0.01, record.hpRatio);
            record.hpFill.position.x = -1.35 + (1.35 * record.hpFill.scale.x);
            record.hpGroup.position.set(record.mesh.position.x, record.mesh.position.y + 2.4, record.mesh.position.z);
            record.hpGroup.lookAt(this.camera.position);
        });

        for (const [id, record] of this.threatMeshes.entries()) {
            if (nextIds.has(id)) continue;
            this.scene.remove(record.mesh);
            this.scene.remove(record.hpGroup);
            record.hpFill.material.dispose();
            record.hpFill.geometry.dispose();
            record.hpGroup.children.forEach((child) => {
                if (child !== record.hpFill) {
                    if (child.material) child.material.dispose();
                    if (child.geometry) child.geometry.dispose();
                }
            });
            record.mesh.traverse((obj) => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            });
            this.threatMeshes.delete(id);
        }
    }

    addCombatRing(position, color = 0xffa66a, maxScale = 4.8, ttl = 0.6) {
        if (!position) return;
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.6, 0.95, 26),
            new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.85,
                side: THREE.DoubleSide,
                depthWrite: false
            })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(Number(position.x) || 0, 0.08, Number(position.z) || 0);
        this.scene.add(ring);
        this.combatEffects.push({
            type: 'ring',
            mesh: ring,
            createdAt: performance.now(),
            ttlMs: ttl * 1000,
            maxScale
        });
    }

    addHammerWhackAt(position, power = 1) {
        if (!position) return;
        const p = clamp(Number(power) || 1, 0.6, 2.6);
        const group = new THREE.Group();

        const shockRing = new THREE.Mesh(
            new THREE.RingGeometry(0.72, 1.08, 36),
            new THREE.MeshBasicMaterial({
                color: 0xffb347,
                transparent: true,
                opacity: 0.92,
                side: THREE.DoubleSide,
                depthWrite: false
            })
        );
        shockRing.rotation.x = -Math.PI / 2;
        shockRing.position.y = 0.11;
        group.add(shockRing);

        const coreFlash = new THREE.Mesh(
            new THREE.SphereGeometry(0.24, 12, 10),
            new THREE.MeshBasicMaterial({
                color: 0xfff0c5,
                transparent: true,
                opacity: 0.95,
                depthWrite: false
            })
        );
        coreFlash.position.y = 0.22;
        group.add(coreFlash);

        const fragments = [];
        const fragmentCount = 11;
        for (let i = 0; i < fragmentCount; i += 1) {
            const frag = new THREE.Mesh(
                new THREE.BoxGeometry(0.08, 0.34 + (Math.random() * 0.38), 0.08),
                new THREE.MeshBasicMaterial({
                    color: 0xfff1bf,
                    transparent: true,
                    opacity: 0.88,
                    depthWrite: false
                })
            );
            frag.position.y = 0.26;
            frag.userData.theta = (Math.PI * 2 * i) / fragmentCount;
            frag.userData.radius = 0.35 + (Math.random() * 0.38);
            frag.userData.speed = 1.4 + (Math.random() * 2.4);
            group.add(frag);
            fragments.push(frag);
        }

        const smashHammer = createHammerModel();
        smashHammer.scale.set(2.5, 2.5, 2.5);
        smashHammer.position.set(0, 2.5, 0);
        smashHammer.rotation.set(0.1, randomRange(-0.15, 0.15), 0.5);
        group.add(smashHammer);

        group.position.set(Number(position.x) || 0, 0, Number(position.z) || 0);
        this.scene.add(group);
        this.combatEffects.push({
            type: 'hammer_whack',
            group,
            shockRing,
            coreFlash,
            fragments,
            smashHammer,
            power: p,
            createdAt: performance.now(),
            ttlMs: 760
        });
    }

    addOctopusStrikeAt(position, power = 1) {
        if (!position) return;
        const p = clamp(Number(power) || 1, 0.55, 2.6);
        const group = new THREE.Group();

        const warningRing = new THREE.Mesh(
            new THREE.RingGeometry(0.7, 1.08, 44),
            new THREE.MeshBasicMaterial({
                color: 0xff6f9a,
                transparent: true,
                opacity: 0.84,
                side: THREE.DoubleSide,
                depthWrite: false
            })
        );
        warningRing.rotation.x = -Math.PI / 2;
        warningRing.position.y = 0.1;
        group.add(warningRing);

        const splash = new THREE.Mesh(
            new THREE.CylinderGeometry(0.3, 0.56, 0.54, 12),
            new THREE.MeshBasicMaterial({
                color: 0xffd7e4,
                transparent: true,
                opacity: 0.9,
                depthWrite: false
            })
        );
        splash.position.y = 0.28;
        group.add(splash);

        const tentacle = new THREE.Mesh(
            new THREE.CylinderGeometry(0.24, 0.34, 4.8 + (p * 1.4), 14),
            new THREE.MeshStandardMaterial({
                color: 0xcb3f67,
                emissive: 0x5e122b,
                emissiveIntensity: 0.42,
                roughness: 0.58,
                metalness: 0.08,
                transparent: true,
                opacity: 0.92
            })
        );
        tentacle.position.y = 6.3 + (p * 0.8);
        group.add(tentacle);

        group.position.set(Number(position.x) || 0, 0, Number(position.z) || 0);
        this.scene.add(group);
        this.combatEffects.push({
            type: 'octopus_strike',
            group,
            warningRing,
            splash,
            tentacle,
            power: p,
            createdAt: performance.now(),
            ttlMs: 1050
        });
    }

    addDamageMarkerAt(position, amount, type = 'impact') {
        if (!position) return;
        const style = type === 'octopus'
            ? { color: '#ff6f86', stroke: '#2c0c1a' }
            : type === 'long_range'
                ? { color: '#8fd6ff', stroke: '#0d2331' }
                : { color: '#ffd77a', stroke: '#2a1706' };
        const marker = createFloatingTextSprite(`-${Math.max(1, Math.round(Number(amount) || 1))}`, style);
        marker.sprite.position.set(Number(position.x) || 0, 2.6, Number(position.z) || 0);
        this.scene.add(marker.sprite);
        this.combatEffects.push({
            type: 'damage',
            sprite: marker.sprite,
            texture: marker.texture,
            createdAt: performance.now(),
            ttlMs: 1350,
            driftX: randomRange(-0.45, 0.45),
            driftZ: randomRange(-0.25, 0.25)
        });
    }

    handleCombatEvents(events = []) {
        if (!Array.isArray(events) || events.length === 0) return;
        events.forEach((event) => {
            if (!event?.id || this.seenCombatEvents.has(event.id)) return;
            this.seenCombatEvents.add(event.id);
            if (this.seenCombatEvents.size > 2000) {
                const keep = Array.from(this.seenCombatEvents).slice(-1000);
                this.seenCombatEvents = new Set(keep);
            }

            const actorPos = event.position || {};
            if (event.eventType === 'lobster_attack') {
                this.addCombatRing(actorPos, event.attackType === 'long_range' ? 0x7fd0ff : 0xffbe72, event.attackType === 'long_range' ? 7.2 : 4.6, 0.5);
                if (event.attackType !== 'long_range') {
                    this.addHammerWhackAt(actorPos, 0.95);
                }
                const targets = Array.isArray(event.targets) ? event.targets : [];
                targets.forEach((target) => {
                    const threat = this.threatMeshes.get(target.threatId);
                    if (threat) {
                        this.addDamageMarkerAt(threat.mesh.position, target.damage, event.attackType);
                        this.addHammerWhackAt(threat.mesh.position, 1 + ((Number(target.damage) || 0) / 18));
                    }
                });
            } else if (event.eventType === 'threat_attack') {
                this.addCombatRing(actorPos, event.attackType === 'long_range' ? 0xb37dff : 0xff5b7f, event.attackType === 'long_range' ? 9.2 : 4.2, 0.7);
                this.addOctopusStrikeAt(actorPos, event.attackType === 'long_range' ? 1.25 : 0.95);
                const targets = Array.isArray(event.targets) ? event.targets : [];
                targets.forEach((target) => {
                    const agent = this.agents.get(target.targetId);
                    if (agent?.mesh) {
                        this.addDamageMarkerAt(agent.mesh.position, target.damage, 'octopus');
                        this.addOctopusStrikeAt(agent.mesh.position, 0.85 + ((Number(target.damage) || 0) / 22));
                    }
                });
            } else if (event.eventType === 'threat_defeated') {
                this.addCombatRing(actorPos, 0x65ffad, 6.5, 0.85);
            }
        });
    }

    updateCombatEffectsFrame(nowPerfMs, dtSeconds) {
        if (!Array.isArray(this.combatEffects) || this.combatEffects.length === 0) return;
        const next = [];
        for (const fx of this.combatEffects) {
            const ageMs = nowPerfMs - Number(fx.createdAt || nowPerfMs);
            const ttlMs = Math.max(1, Number(fx.ttlMs) || 1);
            const progress = clamp(ageMs / ttlMs, 0, 1);
            if (progress >= 1) {
                if (fx.mesh) {
                    this.scene.remove(fx.mesh);
                    if (fx.mesh.material) fx.mesh.material.dispose();
                    if (fx.mesh.geometry) fx.mesh.geometry.dispose();
                }
                if (fx.group) {
                    this.scene.remove(fx.group);
                    disposeObject3D(fx.group);
                }
                if (fx.sprite) {
                    this.scene.remove(fx.sprite);
                    if (fx.sprite.material) fx.sprite.material.dispose();
                }
                if (fx.texture) fx.texture.dispose();
                continue;
            }

            if (fx.type === 'ring' && fx.mesh) {
                const scale = 1 + ((Number(fx.maxScale) - 1) * progress);
                fx.mesh.scale.setScalar(scale);
                fx.mesh.material.opacity = (1 - progress) * 0.9;
            } else if (fx.type === 'hammer_whack' && fx.group) {
                const p = Number(fx.power) || 1;
                fx.shockRing.scale.setScalar(1 + (progress * 4.4 * p));
                fx.shockRing.material.opacity = (1 - progress) * 0.9;
                fx.coreFlash.scale.setScalar(1 + (progress * 1.6 * p));
                fx.coreFlash.material.opacity = (1 - progress) * 0.94;
                fx.fragments.forEach((frag) => {
                    const theta = frag.userData.theta + (progress * frag.userData.speed);
                    const radius = frag.userData.radius + (progress * 1.65 * p);
                    frag.position.x = Math.cos(theta) * radius;
                    frag.position.z = Math.sin(theta) * radius;
                    frag.position.y = 0.2 + (progress * 1.05);
                    frag.rotation.x += dtSeconds * 5.2;
                    frag.rotation.z += dtSeconds * 4.3;
                    frag.material.opacity = (1 - progress) * 0.86;
                });
                const descend = clamp(progress / 0.42, 0, 1);
                const rebound = progress > 0.42 ? clamp((progress - 0.42) / 0.58, 0, 1) : 0;
                fx.smashHammer.position.y = 2.5 - (descend * 2.5) + (rebound * 0.8);
                fx.smashHammer.rotation.z = 0.55 - (descend * 1.8);
            } else if (fx.type === 'octopus_strike' && fx.group) {
                const p = Number(fx.power) || 1;
                const descend = clamp(progress / 0.42, 0, 1);
                const rebound = progress > 0.42 ? clamp((progress - 0.42) / 0.58, 0, 1) : 0;
                fx.warningRing.scale.setScalar(0.84 + (progress * 2.8 * p));
                fx.warningRing.material.opacity = (1 - progress) * 0.82;
                fx.splash.scale.setScalar(0.6 + (Math.sin(Math.min(progress, 0.72) * Math.PI) * 1.25 * p));
                fx.splash.material.opacity = (1 - progress) * 0.88;
                fx.tentacle.position.y = (6.3 + (p * 0.8)) - (descend * (6 + (p * 1.1))) + (rebound * 1.6);
                fx.tentacle.rotation.z = Math.sin(progress * 16) * 0.14;
                fx.tentacle.material.opacity = 0.92 - (progress * 0.62);
            } else if (fx.type === 'damage' && fx.sprite) {
                fx.sprite.position.y += dtSeconds * 1.8;
                fx.sprite.position.x += (Number(fx.driftX) || 0) * dtSeconds;
                fx.sprite.position.z += (Number(fx.driftZ) || 0) * dtSeconds;
                fx.sprite.material.opacity = 1 - progress;
            }
            next.push(fx);
        }
        this.combatEffects = next.slice(-COMBAT_FX_MAX);
    }
    
    createLobsterModel() {
        // Lobster body - simplified representation
        const group = new THREE.Group();
        const bodyMaterial = new THREE.MeshStandardMaterial({
            color: 0xff4444,
            roughness: 0.5,
            metalness: 0.3
        });

        const addPart = (geometry, position, rotation = null, material = bodyMaterial) => {
            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.set(position.x, position.y, position.z);
            if (rotation) {
                mesh.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
            }
            mesh.castShadow = true;
            group.add(mesh);
            return mesh;
        };

        // Main body
        addPart(
            new THREE.CapsuleGeometry(0.3, 1.2, 8, 16),
            { x: 0, y: 0, z: 0 },
            { z: Math.PI / 2 }
        );

        // Tail segments
        for (let i = 0; i < 3; i++) {
            addPart(
                new THREE.BoxGeometry(0.4 - i * 0.05, 0.5 - i * 0.1, 0.3 - i * 0.05),
                { x: -0.7 - i * 0.45, y: 0, z: 0 }
            );
        }

        // Claws
        const leftClaw = addPart(new THREE.BoxGeometry(0.6, 0.2, 0.2), { x: 0.8, y: 0.4, z: 0 });
        leftClaw.name = 'lobster-left-claw';
        const rightClaw = addPart(new THREE.BoxGeometry(0.6, 0.2, 0.2), { x: 0.8, y: -0.4, z: 0 });
        rightClaw.name = 'lobster-right-claw';

        // Antennae
        const antennaMaterial = new THREE.MeshStandardMaterial({ color: 0xcc3333 });
        addPart(
            new THREE.CylinderGeometry(0.02, 0.02, 0.8),
            { x: 0.8, y: 0.15, z: 0.2 },
            { z: Math.PI / 6 },
            antennaMaterial
        );
        addPart(
            new THREE.CylinderGeometry(0.02, 0.02, 0.8),
            { x: 0.8, y: -0.15, z: 0.2 },
            { z: -Math.PI / 6 },
            antennaMaterial
        );

        // Signature weapon: visible hammer mounted on the right claw.
        const hammerPivot = new THREE.Group();
        hammerPivot.position.set(0.16, 0.04, 0.02);
        hammerPivot.rotation.set(0.2, -0.08, 0.45);
        const hammerMesh = createHammerModel();
        hammerMesh.scale.set(1.2, 1.2, 1.2);
        hammerPivot.add(hammerMesh);
        rightClaw.add(hammerPivot);

        return group;
    }

    createLobsterMesh(name) {
        const group = this.createLobsterModel();

        // Name label - positioned above the lobster
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 256;
        canvas.height = 64;
        context.fillStyle = 'rgba(0, 0, 0, 0.7)';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.font = 'Bold 24px Arial';
        context.fillStyle = '#00ffcc';
        context.textAlign = 'center';
        context.fillText(name, 128, 40);
        
        const texture = new THREE.CanvasTexture(canvas);
        const labelMaterial = new THREE.SpriteMaterial({ map: texture });
        const label = new THREE.Sprite(labelMaterial);
        label.position.set(0, 1.8, 0);
        label.scale.set(4, 1, 1);
        group.add(label);

        return group;
    }

    cleanupWikiAvatarRenderers() {
        this.wikiAvatarRenderers.forEach((rendererState) => {
            if (rendererState?.animationFrame) cancelAnimationFrame(rendererState.animationFrame);
            if (rendererState?.renderer) rendererState.renderer.dispose();
        });
        this.wikiAvatarRenderers = [];
    }

    createWikiAvatarRenderer(container, { rotationDeg = 0, autoSpin = false } = {}) {
        if (!container) return null;

        const width = Math.max(72, Math.floor(container.clientWidth || 100));
        const height = Math.max(72, Math.floor(container.clientHeight || 100));
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
        camera.position.set(2.8, 1.8, 2.8);
        camera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        container.innerHTML = '';
        container.appendChild(renderer.domElement);

        const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
        keyLight.position.set(4, 6, 5);
        scene.add(keyLight);
        scene.add(new THREE.AmbientLight(0x90b9ff, 0.8));

        const lobster = this.createLobsterModel();
        lobster.scale.set(1.15, 1.15, 1.15);
        lobster.rotation.y = (Number(rotationDeg) * Math.PI) / 180;
        scene.add(lobster);

        const state = {
            renderer,
            lobster,
            animationFrame: null,
            setRotation: (deg) => {
                lobster.rotation.y = (Number(deg || 0) * Math.PI) / 180;
                renderer.render(scene, camera);
            }
        };

        const renderFrame = () => {
            if (autoSpin) lobster.rotation.y += 0.008;
            renderer.render(scene, camera);
            state.animationFrame = requestAnimationFrame(renderFrame);
        };

        renderFrame();
        this.wikiAvatarRenderers.push(state);
        return state;
    }

    normalizeAgentLookupKey(value) {
        return String(value || '').trim().toLowerCase();
    }

    getViewPresetOffset(preset) {
        const key = String(preset || '').toLowerCase();
        const presetOffset = CAMERA_VIEW_PRESETS[key];
        if (!presetOffset) return null;
        return new THREE.Vector3(presetOffset.x, presetOffset.y, presetOffset.z);
    }

    getCurrentFollowOffset() {
        return this.followCameraOffset ? this.followCameraOffset.clone() : new THREE.Vector3(10, 8, 10);
    }

    findAgentByName(name) {
        const query = this.normalizeAgentLookupKey(name);
        if (!query) return null;

        for (const [agentId, agent] of this.agents.entries()) {
            const candidates = [
                agentId,
                agent?.data?.entityId,
                agent?.data?.entityName,
                agent?.data?.name
            ].map((value) => this.normalizeAgentLookupKey(value));
            if (candidates.includes(query)) {
                return { agentId, agent };
            }
        }
        return null;
    }

    transitionCameraTo(cameraPosition, targetPosition, durationMs = 0) {
        if (!this.camera || !this.controls || !cameraPosition || !targetPosition) {
            return Promise.resolve(false);
        }

        const safeDuration = Math.max(0, Number(durationMs) || 0);
        if (safeDuration <= 0) {
            this.camera.position.copy(cameraPosition);
            this.controls.target.copy(targetPosition);
            this.cameraTransitionUntilMs = Date.now();
            return Promise.resolve(true);
        }

        this.cameraTransitionUntilMs = Date.now() + safeDuration;
        const startPos = this.camera.position.clone();
        const startTarget = this.controls.target.clone();
        const startTime = Date.now();

        return new Promise((resolve) => {
            const animateMove = () => {
                const elapsed = Date.now() - startTime;
                const progress = Math.min(elapsed / safeDuration, 1);
                const easeProgress = progress < 0.5
                    ? 2 * progress * progress
                    : -1 + ((4 - 2 * progress) * progress);

                this.camera.position.lerpVectors(startPos, cameraPosition, easeProgress);
                this.controls.target.lerpVectors(startTarget, targetPosition, easeProgress);

                if (progress < 1) {
                    requestAnimationFrame(animateMove);
                    return;
                }

                this.camera.position.copy(cameraPosition);
                this.controls.target.copy(targetPosition);
                this.cameraTransitionUntilMs = Date.now();
                resolve(true);
            };

            requestAnimationFrame(animateMove);
        });
    }

    async waitForCameraSettled(options = {}) {
        const timeoutMs = Math.max(250, Number(options.timeoutMs) || 2500);
        const startTime = Date.now();
        while (Date.now() < startTime + timeoutMs) {
            if (Date.now() >= this.cameraTransitionUntilMs) break;
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        // Allow one extra render tick for Playwright screenshots.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    async setViewPreset(preset, options = {}) {
        const key = String(preset || '').toLowerCase();
        const offset = this.getViewPresetOffset(key);
        if (!offset) {
            throw new Error(`Unknown view preset: ${preset}`);
        }

        this.viewPreset = key;
        this.followCameraOffset.copy(offset);

        const durationMs = Number(options.durationMs);
        const shouldAnimate = options.animate !== false;
        const transitionMs = shouldAnimate ? (Number.isFinite(durationMs) ? durationMs : 450) : 0;

        if (this.followedAgentId) {
            const followed = this.agents.get(this.followedAgentId);
            if (!followed) return;
            const livePos = followed.mesh.position.clone();
            const desiredCamPos = livePos.clone().add(offset);
            await this.transitionCameraTo(desiredCamPos, livePos, transitionMs);
            return;
        }

        const target = this.controls?.target ? this.controls.target.clone() : new THREE.Vector3(50, 0, 50);
        const direction = offset.clone().normalize();
        const currentDistance = this.camera.position.distanceTo(target);
        const distance = clamp(currentDistance, 8, 260);
        const desiredCamPos = target.clone().addScaledVector(direction, distance);
        await this.transitionCameraTo(desiredCamPos, target, transitionMs);
    }

    async followAgentByName(name, options = {}) {
        const found = this.findAgentByName(name);
        if (!found) {
            return { ok: false, error: `Agent not found: ${name}` };
        }
        this.zoomToAgent(found.agentId, options);
        await this.waitForCameraSettled(options);
        return {
            ok: true,
            agentId: found.agentId,
            agentName: found.agent?.data?.name || found.agentId
        };
    }

    async executeAutomationCommand(commandText, options = {}) {
        const raw = String(commandText || '').trim();
        if (!raw) {
            return { ok: false, error: 'Command cannot be empty' };
        }

        const followMatch = raw.match(/^follow(?:-|\s+)(.+)$/i);
        if (followMatch) {
            return this.followAgentByName(followMatch[1], options);
        }

        const viewMatch = raw.match(/^(?:view|angle)(?:-|\s+)(isometric|dimetric|trimetric)$/i);
        if (viewMatch) {
            const preset = viewMatch[1].toLowerCase();
            await this.setViewPreset(preset, options);
            return { ok: true, preset };
        }

        return {
            ok: false,
            error: 'Unsupported command. Allowed: follow-<agent-name>, view-isometric, view-dimetric, view-trimetric'
        };
    }

    exposeAutomationApi() {
        if (typeof window === 'undefined') return;

        window.openbotAutomation = Object.freeze({
            execute: async (commandText, options = {}) => this.executeAutomationCommand(commandText, options),
            followByName: async (name, options = {}) => this.followAgentByName(name, options),
            setViewPreset: async (preset, options = {}) => {
                await this.setViewPreset(preset, options);
                return { ok: true, preset: this.viewPreset };
            },
            captureReady: async (options = {}) => {
                await this.waitForCameraSettled(options);
                return { ok: true };
            },
            listAgents: () => {
                const items = [];
                for (const [agentId, agent] of this.agents.entries()) {
                    items.push({
                        agentId,
                        name: agent?.data?.name || '',
                        entityId: agent?.data?.entityId || '',
                        entityName: agent?.data?.entityName || ''
                    });
                }
                return items;
            },
            getState: () => ({
                viewPreset: this.viewPreset,
                followedAgentId: this.followedAgentId
            })
        });
    }
    
    setupUIControls() {
        // Status panel minimize/close
        const statusToggle = document.getElementById('status-toggle');
        const statusContent = document.getElementById('status-content');
        statusToggle.addEventListener('click', () => {
            statusContent.classList.toggle('hidden');
            statusToggle.textContent = statusContent.classList.contains('hidden') ? '+' : '−';
        });
        
        // Agent list toggle
        const agentToggle = document.getElementById('status-agent-toggle');
        const agentList = document.getElementById('agent-list');
        agentToggle.addEventListener('click', () => {
            agentList.classList.toggle('visible');
        });
        
        // Chat panel close button
        const chatClose = document.getElementById('chat-close');
        if (chatClose) {
            chatClose.addEventListener('click', () => {
                const chatPanel = document.getElementById('chat-panel');
                if (chatPanel) chatPanel.style.display = 'none';
            });
        }

        // Chat panel maximize / restore
        const chatMaximizeBtn = document.getElementById('chat-maximize');
        const chatMaximizeModal = document.getElementById('chat-maximize-modal');
        const chatMaximizeRestore = document.getElementById('chat-maximize-restore');
        const chatPanel = document.getElementById('chat-panel');

        const openChatMaximize = () => {
            if (!chatMaximizeModal) return;
            // Mirror current active tab into the modal
            const activeTabBtn = document.querySelector('.chat-panel-tab.active');
            const activeTabName = activeTabBtn ? activeTabBtn.dataset.tab : 'chat';
            this._syncMaximizeTab(activeTabName);
            chatMaximizeModal.classList.add('visible');
        };

        const closeChatMaximize = () => {
            if (!chatMaximizeModal) return;
            chatMaximizeModal.classList.remove('visible');
        };

        if (chatMaximizeBtn) chatMaximizeBtn.addEventListener('click', openChatMaximize);
        if (chatMaximizeRestore) chatMaximizeRestore.addEventListener('click', closeChatMaximize);
        if (chatMaximizeModal) {
            chatMaximizeModal.addEventListener('click', (e) => {
                if (e.target === chatMaximizeModal) closeChatMaximize();
            });
        }

        // Maximize modal tab switching
        const maxTabButtons = document.querySelectorAll('#chat-maximize-content .chat-panel-tab');
        maxTabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tabName = btn.dataset.tab;
                maxTabButtons.forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                document.querySelectorAll('#chat-maximize-content .chat-tab-content').forEach(tc => {
                    tc.classList.remove('active');
                });
                const target = document.getElementById(tabName + '-tab-max');
                if (target) target.classList.add('active');
                if (tabName === 'activity-log') {
                    this._renderActivityLogInto('activity-log-content-max');
                } else {
                    this._mirrorChatMessages();
                }
            });
        });

        // Chat/Activity Log tab switching
        const tabButtons = document.querySelectorAll('#chat-panel .chat-panel-tab');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tabName = btn.dataset.tab;
                // Update tab button states
                tabButtons.forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                // Update tab content visibility
                document.querySelectorAll('#chat-panel .chat-tab-content').forEach(tc => {
                    tc.classList.remove('active');
                    tc.classList.remove('hidden');
                });
                const targetContent = document.getElementById(tabName + '-tab');
                if (targetContent) targetContent.classList.add('active');
                // Fetch activity log on first switch to that tab
                if (tabName === 'activity-log') {
                    // Always re-fetch when switching to the tab so stale data
                    // is never shown after AI summarization completes.
                    this.fetchActivityLog();
                }
            });
        });
        
        // Controls panel close
        const controlsClose = document.getElementById('controls-close');
        const controlsPanel = document.getElementById('controls-panel');
        const progressPanel = document.getElementById('progress-panel');
        const progressClose = document.getElementById('progress-close');
        if (window.matchMedia('(max-width: 768px)').matches && controlsPanel) {
            controlsPanel.style.display = 'none';
        }
        controlsClose.addEventListener('click', () => {
            controlsPanel.style.display = 'none';
        });
        if (progressClose) {
            progressClose.addEventListener('click', () => {
                progressPanel.style.display = 'none';
            });
        }
        
        // Sidebar button controls
        const clawhubBtn = document.getElementById('clawhub-btn');
        const clawhubModal = document.getElementById('clawhub-modal');
        const clawhubClose = document.getElementById('clawhub-close');
        
        clawhubBtn.addEventListener('click', () => {
            clawhubModal.classList.add('visible');
        });
        
        clawhubClose.addEventListener('click', () => {
            clawhubModal.classList.remove('visible');
        });
        
        clawhubModal.addEventListener('click', (e) => {
            if (e.target === clawhubModal) {
                clawhubModal.classList.remove('visible');
            }
        });
        
        // Sidebar panel toggles
        const statusPanel = document.getElementById('status-panel');
        
        const togglePanelVisibility = (panel, displayValue = 'block') => {
            if (!panel) return;
            const isHidden = panel.style.display === 'none' || getComputedStyle(panel).display === 'none';
            panel.style.display = isHidden ? displayValue : 'none';
        };

        document.getElementById('sidebar-status-btn').addEventListener('click', () => {
            togglePanelVisibility(statusPanel, 'block');
        });
        
        document.getElementById('sidebar-chat-btn').addEventListener('click', () => {
            togglePanelVisibility(chatPanel, 'block');
        });
        
        document.getElementById('sidebar-controls-btn').addEventListener('click', () => {
            togglePanelVisibility(controlsPanel, 'block');
        });
        document.getElementById('sidebar-progress-btn').addEventListener('click', () => {
            togglePanelVisibility(progressPanel, 'block');
        });
        
        // Chat scroll tracking for auto-scroll detection and lazy loading
        const chatDiv = document.getElementById('chat-messages');
        if (chatDiv) {
            chatDiv.addEventListener('scroll', () => {
                // Check if scrolled to bottom (with 10px tolerance)
                const isAtBottom = Math.abs(chatDiv.scrollHeight - chatDiv.scrollTop - chatDiv.clientHeight) < 10;
                this.chatIsAtBottom = isAtBottom;

                // Show/hide "↓ New messages" scroll-to-bottom button
                const scrollBtn = document.getElementById('chat-scroll-bottom');
                if (scrollBtn) scrollBtn.style.display = isAtBottom ? 'none' : 'flex';

                // Trigger history load when scrolled near the top
                if (chatDiv.scrollTop < 40 && this.chatHasMore && !this.chatIsLoading) {
                    this.loadOlderMessages();
                }
            });
        }

        // "↓ New messages" button scrolls back to live bottom
        const scrollBottomBtn = document.getElementById('chat-scroll-bottom');
        if (scrollBottomBtn) {
            scrollBottomBtn.addEventListener('click', () => {
                const cd = document.getElementById('chat-messages');
                if (cd) cd.scrollTop = cd.scrollHeight;
            });
        }

        const menuDetailsBtn = document.getElementById('lobster-menu-details');
        if (menuDetailsBtn) {
            menuDetailsBtn.addEventListener('click', () => {
                if (this.contextMenuAgentId) {
                    this.openWikiForAgent(this.contextMenuAgentId);
                }
                this.hideLobsterContextMenu();
            });
        }

        const wikiClose = document.getElementById('wiki-close');
        const wikiModal = document.getElementById('lobster-wiki-modal');
        if (wikiClose) wikiClose.addEventListener('click', () => this.closeWikiModal());

        const totalCreatedLink = document.getElementById('total-created-link');
        if (totalCreatedLink) {
            totalCreatedLink.addEventListener('click', (event) => {
                event.preventDefault();
                this.openWikiDirectory();
            });
        }
        if (wikiModal) {
            wikiModal.addEventListener('click', (e) => {
                if (e.target === wikiModal) this.closeWikiModal();
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideLobsterContextMenu();
                this.closeWikiModal();
            }
        });
    }
    
    setupKeyboardControls() {
        document.addEventListener('keydown', (e) => {
            const key = e.key.toLowerCase();
            if (key === 'arrowup') this.keysPressed.arrowUp = true;
            if (key === 'arrowdown') this.keysPressed.arrowDown = true;
            if (key === 'arrowleft') this.keysPressed.arrowLeft = true;
            if (key === 'arrowright') this.keysPressed.arrowRight = true;
            if (key === 'w') this.keysPressed.w = true;
            if (key === 'a') this.keysPressed.a = true;
            if (key === 's') this.keysPressed.s = true;
            if (key === 'd') this.keysPressed.d = true;
        });
        
        document.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            if (key === 'arrowup') this.keysPressed.arrowUp = false;
            if (key === 'arrowdown') this.keysPressed.arrowDown = false;
            if (key === 'arrowleft') this.keysPressed.arrowLeft = false;
            if (key === 'arrowright') this.keysPressed.arrowRight = false;
            if (key === 'w') this.keysPressed.w = false;
            if (key === 'a') this.keysPressed.a = false;
            if (key === 's') this.keysPressed.s = false;
            if (key === 'd') this.keysPressed.d = false;
        });
    }

    getAgentIdFromScreenPoint(clientX, clientY) {
        if (!this.renderer || !this.camera) return null;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((clientY - rect.top) / rect.height) * 2 + 1;
        this.mouse.x = x;
        this.mouse.y = y;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const agentMeshes = Array.from(this.agents.values()).map(agent => agent.mesh);
        const intersects = this.raycaster.intersectObjects(agentMeshes, true);
        if (!intersects.length) return null;

        const clickedObj = intersects[0].object;
        for (const [agentId, agent] of this.agents.entries()) {
            let node = clickedObj;
            while (node) {
                if (node === agent.mesh) return agentId;
                node = node.parent;
            }
        }
        return null;
    }

    showLobsterContextMenu(clientX, clientY, agentId) {
        const menu = document.getElementById('lobster-context-menu');
        if (!menu) return;
        this.contextMenuAgentId = agentId;

        const menuWidth = 190;
        const menuHeight = 54;
        const maxX = Math.max(4, window.innerWidth - menuWidth - 4);
        const maxY = Math.max(4, window.innerHeight - menuHeight - 4);
        const left = Math.max(4, Math.min(clientX, maxX));
        const top = Math.max(4, Math.min(clientY, maxY));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.classList.add('visible');
        this.contextMenuOpen = true;
    }

    hideLobsterContextMenu() {
        const menu = document.getElementById('lobster-context-menu');
        if (!menu) return;
        menu.classList.remove('visible');
        this.contextMenuOpen = false;
        this.contextMenuAgentId = null;
    }

    closeWikiModal() {
        const modal = document.getElementById('lobster-wiki-modal');
        if (!modal) return;
        this.cleanupWikiAvatarRenderers();
        modal.classList.remove('visible');
    }

    async openWikiForAgent(agentId) {
        const agent = this.agents.get(agentId);
        if (!agent) return;
        const entityId = agent.data.entityId || agent.data.entityName || agent.data.name;
        if (!entityId) return this.renderWikiError('No public entity id is available for this lobster.');
        return this.openWikiForEntity(entityId);
    }

    async openWikiForEntity(entityId, options = {}) {
        if (!entityId) return;
        const forceRefresh = Boolean(options.forceRefresh);

        const modal = document.getElementById('lobster-wiki-modal');
        if (!modal) return;
        modal.classList.add('visible');
        this.renderWikiLoading();

        try {
            let wiki = null;
            const cached = this.wikiCache.get(entityId);
            if (!forceRefresh && cached && (Date.now() - cached.ts) < this.wikiCacheTtlMs) {
                wiki = cached.data;
            } else {
                const query = forceRefresh ? '?refresh=1' : '';
                const response = await fetch(`${this.apiBase}/entity/${encodeURIComponent(entityId)}/wiki-public${query}`);
                if (!response.ok) {
                    throw new Error(`Failed to load wiki (${response.status})`);
                }
                const data = await response.json();
                wiki = data.wiki;
                this.wikiCache.set(entityId, { ts: Date.now(), data: wiki });
            }
            this.currentWiki = wiki;
            this.currentWikiEntityId = entityId;
            this.currentQuestEntityId = entityId;
            this.timelineFilter = 'all';
            this.renderWiki(wiki);
            this.fetchQuestProgress(entityId);
        } catch (error) {
            console.error('Wiki fetch error:', error);
            this.renderWikiError('Could not load lobster details right now.');
        }
    }

    async refreshWikiRuntime(entityId) {
        if (!entityId || !this.currentWiki || this.currentWikiEntityId !== entityId) return;
        try {
            const response = await fetch(`${this.apiBase}/entity/${encodeURIComponent(entityId)}/runtime-stats`);
            if (!response.ok) {
                throw new Error(`Failed to load runtime stats (${response.status})`);
            }

            const data = await response.json();
            const currentState = this.currentWiki.currentState && typeof this.currentWiki.currentState === 'object'
                ? this.currentWiki.currentState
                : {};
            currentState.online = Boolean(data.online);
            currentState.agentId = data.agentId || null;
            currentState.state = data.state || (data.online ? 'idle' : 'offline');
            currentState.lastAction = data.lastAction || null;
            currentState.runtime = data.runtime && typeof data.runtime === 'object' ? data.runtime : null;
            this.currentWiki.currentState = currentState;

            const cached = this.wikiCache.get(entityId);
            if (cached && cached.data) {
                cached.data.currentState = currentState;
                this.wikiCache.set(entityId, cached);
            }

            this.renderWiki(this.currentWiki);
        } catch (error) {
            console.error('Runtime stats refresh error:', error);
        }
    }

    async fetchQuestProgress(entityId, options = {}) {
        if (!entityId) return;
        const force = Boolean(options.force);
        if (!force && this.currentQuestEntityId === entityId && (Date.now() - this.lastQuestFetchAt) < 8000) {
            return;
        }
        try {
            const response = await fetch(`${this.apiBase}/entity/${encodeURIComponent(entityId)}/quests`);
            if (!response.ok) {
                throw new Error(`Failed to load quests (${response.status})`);
            }
            const data = await response.json();
            if (!data.success) return;
            this.currentQuestEntityId = entityId;
            this.questSummary = data;
            this.lastQuestFetchAt = Date.now();
            this.renderQuestProgress();
        } catch (error) {
            console.error('Quest progress fetch error:', error);
        }
    }

    renderQuestProgress() {
        const content = document.getElementById('progress-content');
        if (!content) return;

        if (!this.questSummary) {
            content.innerHTML = '<p>No quest data loaded yet.</p>';
            return;
        }

        const active = Array.isArray(this.questSummary.active) ? this.questSummary.active : [];
        const completed = Array.isArray(this.questSummary.completed) ? this.questSummary.completed : [];
        const claimed = Array.isArray(this.questSummary.claimed) ? this.questSummary.claimed : [];

        const renderQuestCard = (quest) => {
            const targetPairs = Object.entries(quest.target || {});
            const progressPairs = Object.entries(quest.progress || {});
            const targetText = targetPairs.length
                ? targetPairs.map(([k, v]) => `${k}: ${v}`).join(' • ')
                : 'No target';
            const progressText = progressPairs.length
                ? progressPairs.map(([k, v]) => `${k}: ${v}`).join(' • ')
                : 'No progress';
            return `
                <div class="progress-quest-item">
                    <strong>${this.escapeHtml(quest.title || quest.questId || 'Quest')}</strong>
                    <div>${this.escapeHtml(quest.description || '')}</div>
                    <div>🎯 ${this.escapeHtml(targetText)}</div>
                    <div>📌 ${this.escapeHtml(progressText)}</div>
                    <div>🏷️ ${this.escapeHtml(quest.status || 'active')}</div>
                </div>
            `;
        };

        content.innerHTML = `
            <p><strong>Entity:</strong> ${this.escapeHtml(this.currentQuestEntityId || 'unknown')}</p>
            <p><strong>Streak proxy:</strong> ${active.filter(q => q.questId === 'dynamic-reflection-consistency').length ? 'reflection tracked' : 'not tracked yet'}</p>
            <p><strong>Claimed rewards:</strong> ${claimed.length}</p>
            <div><strong>Active Quests (${active.length})</strong></div>
            ${active.map(renderQuestCard).join('') || '<p>No active quests.</p>'}
            <div style="margin-top:10px;"><strong>Completed Quests (${completed.length})</strong></div>
            ${completed.map(renderQuestCard).join('') || '<p>No completed quests yet.</p>'}
        `;
    }

    async fetchLobsterDirectory() {
        if ((Date.now() - this.wikiDirectoryCache.ts) < this.wikiCacheTtlMs && this.wikiDirectoryCache.data.length) {
            return this.wikiDirectoryCache.data;
        }

        const response = await fetch(`${this.apiBase}/entities?type=lobster`);
        if (!response.ok) throw new Error(`Failed to list entities (${response.status})`);
        const data = await response.json();
        const entities = Array.isArray(data.entities) ? data.entities : [];
        entities.sort((a, b) => Number(a.numeric_id || Number.MAX_SAFE_INTEGER) - Number(b.numeric_id || Number.MAX_SAFE_INTEGER));
        this.wikiDirectoryCache = { ts: Date.now(), data: entities };
        return entities;
    }

    renderWikiDirectory(entities) {
        this.cleanupWikiAvatarRenderers();
        const title = document.getElementById('wiki-title-text');
        const status = document.getElementById('wiki-status-badge');
        const body = document.getElementById('lobster-wiki-body');
        if (!body) return;
        if (title) title.textContent = 'Lobster Wiki Directory';
        if (status) {
            status.textContent = `${entities.length} Total`;
            status.classList.remove('online', 'offline');
        }

        const cards = entities.map(entity => {
            const rawEntityId = entity.entity_id || '';
            const label = this.escapeHtml(entity.entity_name || entity.entity_id || 'Unknown Lobster');
            const numeric = this.escapeHtml(entity.numeric_id ?? 'N/A');
            const created = this.escapeHtml(entity.created_at ? new Date(entity.created_at).toLocaleDateString() : 'Unknown');
            const safeEntityId = this.escapeHtml(rawEntityId);
            return `
                <button class="wiki-directory-card" data-entity-id="${safeEntityId}">
                    <div class="wiki-directory-avatar" data-avatar-entity-id="${safeEntityId}" aria-hidden="true"></div>
                    <div class="wiki-directory-id">ID ${numeric}</div>
                    <div class="wiki-directory-name">${label}</div>
                    <div class="wiki-directory-meta">Joined ${created}</div>
                </button>
            `;
        }).join('');

        body.innerHTML = `
            <section class="wiki-section">
                <h3>Lobster Directory</h3>
                <div class="wiki-directory-grid">
                    ${cards || '<div class="wiki-empty">No lobsters found yet.</div>'}
                </div>
            </section>
        `;

        body.querySelectorAll('.wiki-directory-card').forEach(card => {
            card.addEventListener('click', () => {
                this.openWikiForEntity(card.dataset.entityId);
            });
        });

        body.querySelectorAll('[data-avatar-entity-id]').forEach(avatarEl => {
            this.createWikiAvatarRenderer(avatarEl, { autoSpin: true });
        });
    }

    async openWikiDirectory() {
        const modal = document.getElementById('lobster-wiki-modal');
        if (!modal) return;
        modal.classList.add('visible');
        this.renderWikiLoading();
        this.currentWiki = null;
        this.currentWikiEntityId = null;

        try {
            const entities = await this.fetchLobsterDirectory();
            this.renderWikiDirectory(entities);
        } catch (error) {
            console.error('Wiki directory fetch error:', error);
            this.renderWikiError('Could not load lobster directory right now.');
        }
    }

    renderWikiLoading() {
        this.cleanupWikiAvatarRenderers();
        const body = document.getElementById('lobster-wiki-body');
        const title = document.getElementById('wiki-title-text');
        const status = document.getElementById('wiki-status-badge');
        if (title) title.textContent = 'Lobster Details';
        if (status) {
            status.textContent = 'Loading';
            status.classList.remove('online');
            status.classList.add('offline');
        }
        if (body) body.innerHTML = '<div class="wiki-loading">Loading lobster wiki...</div>';
    }

    renderWikiError(message) {
        this.cleanupWikiAvatarRenderers();
        const modal = document.getElementById('lobster-wiki-modal');
        if (modal) modal.classList.add('visible');
        const body = document.getElementById('lobster-wiki-body');
        if (body) body.innerHTML = `<div class="wiki-error">${this.escapeHtml(message)}</div>`;
    }

    renderRelationshipGraph(graph, selfId) {
        const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
        const edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
        if (!nodes.length || nodes.length <= 1) {
            return '<div class="wiki-empty">No relationship graph data yet.</div>';
        }

        const width = 1000;
        const height = 360;
        const cx = width / 2;
        const cy = height / 2;
        const partners = nodes.filter(n => n.id !== selfId);
        const radius = Math.min(140, 80 + partners.length * 8);
        const positionMap = new Map();
        positionMap.set(selfId, { x: cx, y: cy });

        partners.forEach((node, idx) => {
            const angle = (Math.PI * 2 * idx) / Math.max(1, partners.length);
            positionMap.set(node.id, {
                x: cx + Math.cos(angle) * radius,
                y: cy + Math.sin(angle) * radius
            });
        });

        const edgeSvg = edges.map(edge => {
            const a = positionMap.get(edge.source);
            const b = positionMap.get(edge.target);
            if (!a || !b) return '';
            const opacity = Math.max(0.45, Math.min(0.9, Number(edge.weight || 0.3)));
            const widthPx = (Number(edge.weight || 0.3) * 3 + 1).toFixed(2);
            return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="rgba(125,245,255,${opacity})" stroke-width="${widthPx}" />`;
        }).join('');

        const nodeSvg = nodes.map(node => {
            const p = positionMap.get(node.id);
            if (!p) return '';
            const isSelf = node.id === selfId;
            const r = isSelf ? 16 : 12;
            const fill = isSelf ? '#00ffcc' : '#0f3f57';
            const stroke = isSelf ? '#eaffff' : '#7df5ff';
            const textColor = '#d6ffff';
            const safeLabel = this.escapeHtml(node.label || node.id || '');
            const safeNodeId = this.escapeHtml(node.id || '');
            return `
                <g class="wiki-graph-node" data-node-id="${safeNodeId}">
                    <title>${safeLabel}</title>
                    <circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2" />
                    <text x="${p.x}" y="${p.y + 30}" text-anchor="middle" font-size="12" fill="${textColor}">${safeLabel}</text>
                </g>
            `;
        }).join('');

        return `
            <div class="wiki-graph-canvas">
                <svg class="wiki-graph-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Relationship graph" data-pan-x="0" data-pan-y="0" data-zoom="1"><g class="wiki-graph-viewport">${edgeSvg}${nodeSvg}</g></svg>
                <div class="wiki-graph-controls" aria-label="Social graph controls">
                    <button class="wiki-graph-btn" data-zoom-action="in" aria-label="Zoom in social graph">＋</button>
                    <button class="wiki-graph-btn" data-zoom-action="out" aria-label="Zoom out social graph">－</button>
                    <button class="wiki-graph-btn" data-zoom-action="reset" aria-label="Reset social graph view">⌂</button>
                </div>
            </div>
        `;
    }

    bindRelationshipGraphInteractions() {
        const graphWrap = document.querySelector('.wiki-graph-wrap');
        const svg = graphWrap?.querySelector('.wiki-graph-svg');
        const viewport = svg?.querySelector('.wiki-graph-viewport');
        if (!graphWrap || !svg || !viewport) return;

        let isDragging = false;
        let startX = 0;
        let startY = 0;

        const applyTransform = () => {
            const zoom = Number(svg.dataset.zoom || 1);
            const panX = Number(svg.dataset.panX || 0);
            const panY = Number(svg.dataset.panY || 0);
            viewport.setAttribute('transform', `translate(${panX}, ${panY}) scale(${zoom})`);
        };

        svg.onwheel = (event) => event.preventDefault();

        svg.onpointerdown = (event) => {
            isDragging = true;
            startX = event.clientX;
            startY = event.clientY;
            svg.setPointerCapture(event.pointerId);
        };

        svg.onpointermove = (event) => {
            if (!isDragging) return;
            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            startX = event.clientX;
            startY = event.clientY;
            svg.dataset.panX = String(Number(svg.dataset.panX || 0) + dx);
            svg.dataset.panY = String(Number(svg.dataset.panY || 0) + dy);
            applyTransform();
        };

        svg.onpointerup = (event) => {
            isDragging = false;
            if (svg.hasPointerCapture(event.pointerId)) {
                svg.releasePointerCapture(event.pointerId);
            }
        };

        svg.ongesturestart = (event) => event.preventDefault();
        svg.addEventListener('touchmove', (event) => {
            if (event.touches.length > 1) event.preventDefault();
        }, { passive: false });

        graphWrap.querySelectorAll('.wiki-graph-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.zoomAction;
                const currentZoom = Number(svg.dataset.zoom || 1);
                if (action === 'in') svg.dataset.zoom = String(Math.min(2.2, currentZoom + 0.2));
                if (action === 'out') svg.dataset.zoom = String(Math.max(0.6, currentZoom - 0.2));
                if (action === 'reset') {
                    svg.dataset.zoom = '1';
                    svg.dataset.panX = '0';
                    svg.dataset.panY = '0';
                }
                applyTransform();
            });
        });

        applyTransform();
    }

    renderTimelineItems(items) {
        if (!items.length) return '<div class="wiki-empty">No timeline events yet.</div>';
        return `<ul class="wiki-timeline">${items.map(item => {
            const title = this.escapeHtml(item.title || 'Event');
            const when = this.escapeHtml(item.ts ? new Date(item.ts).toLocaleString() : 'Unknown time');
            const type = this.escapeHtml(item.type || 'event');
            const detail = this.escapeHtml(item.detail || '');
            return `
            <li>
                <div><strong>${title}</strong></div>
                <div class="wiki-band">${when} • ${type}</div>
                <div>${detail}</div>
            </li>
        `;
        }).join('')}</ul>`;
    }

    bindTimelineFilters() {
        const buttons = document.querySelectorAll('.wiki-filter-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                this.timelineFilter = btn.dataset.filter;
                buttons.forEach(b => b.classList.toggle('active', b.dataset.filter === this.timelineFilter));
                if (this.currentWiki) this.renderWiki(this.currentWiki);
            });
        });
    }

    renderActionSequence(actionSequence) {
        if (!actionSequence || !Array.isArray(actionSequence.sequence) || actionSequence.sequence.length === 0) {
            return '<div class="wiki-empty">No queued action sequence.</div>';
        }

        const status = this.escapeHtml(actionSequence.status || 'unknown');
        const currentAction = this.escapeHtml(actionSequence.currentAction?.type || 'none');
        return `
            <div class="wiki-band">Queue: <strong>${status}</strong> • Current: <strong>${currentAction}</strong> • Remaining ticks: <strong>${Number(actionSequence.remainingTicks || 0)}</strong></div>
            <ul class="wiki-action-sequence-list">
                ${actionSequence.sequence.map(step => {
                    const stepType = this.escapeHtml(step.type || 'unknown');
                    const stepStatus = this.escapeHtml(step.status || 'pending');
                    const statusClass = this.safeClassToken(step.status || 'pending', 'pending');
                    const requiredTicks = Number(step.requiredTicks || 1);
                    return `
                    <li>
                        <span class="wiki-action-step-index">#${Number(step.index) + 1}</span>
                        <span><strong>${stepType}</strong> <span class="wiki-band">(${requiredTicks} tick${requiredTicks === 1 ? '' : 's'})</span></span>
                        <span class="wiki-action-status wiki-action-status-${statusClass}">${stepStatus}</span>
                    </li>
                `;
                }).join('')}
            </ul>
        `;
    }

    async trackRecommendationEvent(entityId, candidateEntityId, eventType, type = 'conversation') {
        if (!entityId || !candidateEntityId || !eventType) return;
        try {
            await fetch(`${this.apiBase}/entity/${encodeURIComponent(entityId)}/recommendations/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ candidateEntityId, eventType, type })
            });
        } catch (error) {
            console.warn('Recommendation event tracking failed:', error);
        }
    }

    renderWiki(wiki) {
        this.cleanupWikiAvatarRenderers();
        const body = document.getElementById('lobster-wiki-body');
        const title = document.getElementById('wiki-title-text');
        const status = document.getElementById('wiki-status-badge');
        if (!body || !wiki) return;

        const identity = wiki.identity || {};
        const currentState = wiki.currentState || {};
        const runtime = currentState.runtime && typeof currentState.runtime === 'object' ? currentState.runtime : null;
        const runtimeSkills = runtime && runtime.skills && typeof runtime.skills === 'object'
            ? runtime.skills
            : {};
        const cognition = wiki.cognition || {};
        const social = wiki.social || {};
        const relationships = Array.isArray(social.relationships) ? social.relationships : [];
        const suggestedConnections = Array.isArray(social.suggestedConnections) ? social.suggestedConnections : [];
        const recommendationType = social.recommendationType || "conversation";
        const timeline = Array.isArray(wiki.timeline) ? wiki.timeline : [];

        if (title) title.textContent = `${identity.entityName || identity.entityId || 'Lobster'} Wiki`;
        if (status) {
            status.textContent = currentState.online ? 'Online' : 'Offline';
            status.classList.toggle('online', Boolean(currentState.online));
            status.classList.toggle('offline', !currentState.online);
        }

        const filteredTimeline = this.timelineFilter === 'all'
            ? timeline
            : timeline.filter(t => t.type === this.timelineFilter);
        const initialAvatarRotation = Number(wiki.avatarRotationDeg || 0);
        const safeIdentityEntityId = this.escapeHtml(identity.entityId || 'Unknown');
        const safeIdentityName = this.escapeHtml(identity.entityName || 'Unknown');
        const safeIdentityNumericId = this.escapeHtml(identity.numericId ?? 'N/A');
        const safeIdentityType = this.escapeHtml(identity.entityType || 'lobster');
        const safeIdentityCreatedAt = this.escapeHtml(identity.createdAt ? new Date(identity.createdAt).toLocaleString() : 'Unknown');
        const safeIdentityLevel = this.escapeHtml(identity.level ?? 1);
        const safeIdentityXp = this.escapeHtml(identity.xp ?? 0);
        const badgeChips = (Array.isArray(identity.earnedBadges) ? identity.earnedBadges : []).map((badge) => {
            const key = this.escapeHtml(badge.badgeKey || 'badge');
            return `<span class="wiki-chip">🏅 ${key}</span>`;
        }).join('') || '<span class="wiki-empty">No badges yet.</span>';
        const safeState = this.escapeHtml(currentState.state || 'unknown');
        const safeAgentId = this.escapeHtml(currentState.agentId || 'N/A');
        const safeLastAction = this.escapeHtml(currentState.lastAction?.type || 'N/A');
        const safeRuntimeEnergy = runtime && Number.isFinite(Number(runtime.energy))
            ? this.escapeHtml(Number(runtime.energy).toFixed(1))
            : 'N/A';
        const safeRuntimeSleeping = runtime ? (runtime.sleeping ? 'Yes' : 'No') : 'N/A';
        const safeRuntimeCapturedAt = runtime && Number(runtime.capturedAt) > 0
            ? this.escapeHtml(new Date(Number(runtime.capturedAt)).toLocaleString())
            : 'N/A';
        const renderRuntimeSkill = (skillKey, label) => {
            const skill = runtimeSkills[skillKey];
            if (!skill || typeof skill !== 'object') {
                return `<li><strong>${label}:</strong> N/A</li>`;
            }
            const level = Math.max(1, Math.floor(Number(skill.level) || 1));
            const xp = Math.max(0, Math.floor(Number(skill.xp) || 0));
            const cooldown = Math.max(0, Number(skill.cooldown) || 0);
            return `<li><strong>${label}:</strong> L${level} / XP ${xp} / CD ${cooldown.toFixed(1)}s</li>`;
        };
        const runtimeSkillsList = [
            renderRuntimeSkill('scout', 'Scout'),
            renderRuntimeSkill('forage', 'Forage'),
            renderRuntimeSkill('shellGuard', 'Shell Guard'),
            renderRuntimeSkill('builder', 'Builder')
        ].join('');
        const interestChips = (cognition.interests || []).map(i => {
            const interest = this.escapeHtml(i.interest || 'Unknown');
            const weight = Number(i.weight || 0).toFixed(1);
            return `<span class="wiki-chip">${interest}<span class="wiki-chip-weight">${weight}%</span></span>`;
        }).join('') || '<span class="wiki-empty">No interests yet.</span>';
        const longTermGoals = (cognition.longTermGoals || []).map(g => {
            const label = this.escapeHtml(g.label || 'Untitled goal');
            const source = this.escapeHtml(g.source || 'derived');
            return `<li>${label} <span class="wiki-band">(${source})</span></li>`;
        }).join('') || '<li>No long-term goals inferred yet.</li>';
        const shortTermGoals = (cognition.shortTermGoals || []).map(g => {
            const label = this.escapeHtml(g.label || 'Untitled goal');
            const source = this.escapeHtml(g.source || 'derived');
            return `<li>${label} <span class="wiki-band">(${source})</span></li>`;
        }).join('') || '<li>No short-term goals inferred yet.</li>';
        const relationshipItems = relationships.map(r => {
            const entityId = this.escapeHtml(r.entityId || 'Unknown');
            const messageCount = Number(r.messagesExchanged || 0);
            const lastAt = this.escapeHtml(r.lastInteractionAt ? new Date(r.lastInteractionAt).toLocaleString() : 'N/A');
            return `
                        <li>
                            <div><strong>${entityId}</strong> <span class="wiki-band">score ${Number(r.score || 0).toFixed(2)}</span></div>
                            <div class="wiki-band">messages: ${messageCount} • last: ${lastAt}</div>
                        </li>
                    `;
        }).join('') || '<li>No relationship signals yet.</li>';
        const reputationValue = this.escapeHtml(social.reputationScore?.value ?? 0);
        const reputationBand = this.escapeHtml(social.reputationScore?.band || 'Low');
        const reputationExplain = this.escapeHtml(social.reputationScore?.explain || 'Derived from public behavior signals');

        body.innerHTML = `
            <div class="wiki-actions-row">
                <button class="wiki-nav-btn" id="wiki-back-directory">← Back to directory</button>
                <button class="wiki-nav-btn" id="wiki-refresh-current">↻ Refresh Live Stats</button>
            </div>

            <section class="wiki-section">
                <h3>Lobster Avatar</h3>
                <div class="wiki-avatar-rotator">
                    <div class="wiki-avatar-stage">
                        <div class="wiki-avatar-card" id="wiki-avatar-card"></div>
                    </div>
                    <div class="wiki-avatar-controls">
                        <button class="wiki-nav-btn" id="wiki-avatar-left">↺</button>
                        <input type="range" id="wiki-avatar-rotation" min="0" max="360" step="5" value="${initialAvatarRotation}" aria-label="Rotate lobster avatar" />
                        <button class="wiki-nav-btn" id="wiki-avatar-right">↻</button>
                    </div>
                </div>
            </section>

            <section class="wiki-section">
                <h3>Identity</h3>
                <div class="wiki-grid">
                    <div><span class="wiki-key">Entity ID:</span>${safeIdentityEntityId}</div>
                    <div><span class="wiki-key">Name:</span>${safeIdentityName}</div>
                    <div><span class="wiki-key">Numeric ID:</span>${safeIdentityNumericId}</div>
                    <div><span class="wiki-key">Type:</span>${safeIdentityType}</div>
                    <div><span class="wiki-key">Created:</span>${safeIdentityCreatedAt}</div>
                    <div><span class="wiki-key">Level:</span>${safeIdentityLevel}</div>
                    <div><span class="wiki-key">XP:</span>${safeIdentityXp}</div>
                </div>
                <div style="height:10px"></div>
                <div class="wiki-interest-chips">${badgeChips}</div>
            </section>

            <section class="wiki-section">
                <h3>Current State</h3>
                <div class="wiki-grid">
                    <div><span class="wiki-key">Online:</span>${currentState.online ? 'Yes' : 'No'}</div>
                    <div><span class="wiki-key">State:</span>${safeState}</div>
                    <div><span class="wiki-key">Agent ID:</span>${safeAgentId}</div>
                    <div><span class="wiki-key">Last Action:</span>${safeLastAction}</div>
                    <div><span class="wiki-key">Energy:</span>${safeRuntimeEnergy}</div>
                    <div><span class="wiki-key">Sleeping:</span>${safeRuntimeSleeping}</div>
                    <div><span class="wiki-key">Captured At:</span>${safeRuntimeCapturedAt}</div>
                </div>
                <div style="height:10px"></div>
                <div>
                    <strong>Runtime Skills</strong>
                    <ul class="wiki-relationship-list">
                        ${runtimeSkillsList}
                    </ul>
                </div>
                <div style="height:10px"></div>
                <div>
                    <strong>Action Sequence</strong>
                    ${this.renderActionSequence(currentState.actionSequence)}
                </div>
            </section>

            <section class="wiki-section">
                <h3>Cognition</h3>
                <div class="wiki-interest-chips">
                    ${interestChips}
                </div>
                <div style="height:10px"></div>
                <div class="wiki-grid">
                    <div>
                        <strong>Long-term goals</strong>
                        <ul class="wiki-goals">${longTermGoals}</ul>
                    </div>
                    <div>
                        <strong>Short-term goals</strong>
                        <ul class="wiki-goals">${shortTermGoals}</ul>
                    </div>
                </div>
            </section>

            <section class="wiki-section">
                <h3>Social</h3>
                <ul class="wiki-relationship-list">
                    ${relationshipItems}
                </ul>
                <div style="height:10px"></div>
                <div>
                    <strong>Suggested connections</strong>
                    <ul class="wiki-relationship-list">
                        ${suggestedConnections.map((c) => {
                            const cId = this.escapeHtml(c.entityId || 'unknown');
                            const cScore = Number(c.score || 0).toFixed(3);
                            const reasons = c.reasons && typeof c.reasons === 'object'
                                ? `interest ${Number(c.reasons.interestComplement || 0).toFixed(2)} • recency ${Number(c.reasons.lowRecencyPotential || 0).toFixed(2)} • centrality ${Number(c.reasons.mentionCentrality || 0).toFixed(2)}`
                                : 'No reason metadata';
                            return `<li>
                                <div><strong>${cId}</strong> <span class="wiki-band">score ${cScore}</span></div>
                                <div class="wiki-band">${this.escapeHtml(reasons)}</div>
                                <button class="wiki-nav-btn wiki-reco-inspect-btn" data-candidate-entity-id="${cId}">Inspect</button>
                            </li>`;
                        }).join('') || '<li class="wiki-empty">No suggestions yet.</li>'}
                    </ul>
                </div>
                <div style="height:10px"></div>
                <div class="wiki-graph-wrap">
                    ${this.renderRelationshipGraph(social.relationshipGraph, identity.entityId)}
                </div>
            </section>

            <section class="wiki-section">
                <h3>Reputation</h3>
                <div class="wiki-reputation">
                    <div class="wiki-score">${reputationValue}</div>
                    <div>
                        <div><strong>${reputationBand}</strong></div>
                        <div class="wiki-band">${reputationExplain}</div>
                    </div>
                </div>
            </section>

            <section class="wiki-section">
                <h3>Timeline</h3>
                <div class="wiki-timeline-filters">
                    <button class="wiki-filter-btn ${this.timelineFilter === 'all' ? 'active' : ''}" data-filter="all">All</button>
                    <button class="wiki-filter-btn ${this.timelineFilter === 'reflection' ? 'active' : ''}" data-filter="reflection">Reflection</button>
                    <button class="wiki-filter-btn ${this.timelineFilter === 'chat' ? 'active' : ''}" data-filter="chat">Chat</button>
                </div>
                ${this.renderTimelineItems(filteredTimeline)}
            </section>
        `;

        this.bindTimelineFilters();
        this.bindRelationshipGraphInteractions();

        body.querySelectorAll('.wiki-reco-inspect-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const candidateEntityId = btn.getAttribute('data-candidate-entity-id');
                const sourceEntityId = this.currentWikiEntityId || identity.entityId;
                if (!candidateEntityId || !sourceEntityId) return;
                await this.trackRecommendationEvent(sourceEntityId, candidateEntityId, 'accepted', recommendationType);
                await this.trackRecommendationEvent(sourceEntityId, candidateEntityId, 'follow_through', recommendationType);
                this.openWikiForEntity(candidateEntityId);
            });
        });

        const backBtn = document.getElementById('wiki-back-directory');
        if (backBtn) backBtn.addEventListener('click', () => this.openWikiDirectory());
        const refreshBtn = document.getElementById('wiki-refresh-current');
        if (refreshBtn) {
            refreshBtn.title = 'Fetch latest live stats without rebuilding full wiki';
            refreshBtn.addEventListener('click', async () => {
                const targetEntityId = this.currentWikiEntityId || identity.entityId;
                if (!targetEntityId) return;
                const originalText = refreshBtn.textContent;
                refreshBtn.disabled = true;
                refreshBtn.textContent = '↻ Refreshing...';
                await this.refreshWikiRuntime(targetEntityId);
                refreshBtn.disabled = false;
                refreshBtn.textContent = originalText;
            });
        }

        const avatarCard = document.getElementById('wiki-avatar-card');
        const avatarRange = document.getElementById('wiki-avatar-rotation');
        const avatarRendererState = this.createWikiAvatarRenderer(avatarCard, { rotationDeg: initialAvatarRotation });
        const rotateAvatar = (deg) => {
            if (!avatarRange) return;
            const normalized = ((deg % 360) + 360) % 360;
            if (avatarRendererState) avatarRendererState.setRotation(normalized);
            avatarRange.value = String(normalized);
            wiki.avatarRotationDeg = normalized;
        };

        if (avatarRange) {
            avatarRange.addEventListener('input', () => rotateAvatar(Number(avatarRange.value || 0)));
        }

        const leftBtn = document.getElementById('wiki-avatar-left');
        const rightBtn = document.getElementById('wiki-avatar-right');
        if (leftBtn) leftBtn.addEventListener('click', () => rotateAvatar(Number(avatarRange?.value || 0) - 45));
        if (rightBtn) rightBtn.addEventListener('click', () => rotateAvatar(Number(avatarRange?.value || 0) + 45));
    }

    cancelFollowMode() {
        if (!this.followedAgentId) return;
        this.followedAgentId = null;
        this.controls.enabled = true;
    }

    setupMouseControls() {
        document.addEventListener('mousedown', (event) => {
            this.isMouseDown = true;
            this.mouseDragStartX = event.clientX;
            this.mouseDragStartY = event.clientY;
        });
        
        document.addEventListener('mouseup', () => {
            this.isMouseDown = false;
        });
        
        document.addEventListener('mousemove', (event) => {
            if (!this.renderer.domElement) return;
            
            // Calculate mouse position in normalized device coordinates
            const rect = this.renderer.domElement.getBoundingClientRect();
            this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            
            // Update the picking ray with the camera and mouse position
            this.raycaster.setFromCamera(this.mouse, this.camera);
            
            // Calculate objects intersecting the picking ray
            const agentMeshes = Array.from(this.agents.values()).map(agent => agent.mesh);
            const intersects = this.raycaster.intersectObjects(agentMeshes, true);
            
            // Change cursor to pointer if hovering over a lobster
            if (intersects.length > 0) {
                document.body.style.cursor = 'pointer';
            } else {
                document.body.style.cursor = 'auto';
            }
            
            // Cancel follow only on mouse drag (not just movement)
            if (this.isMouseDown && this.followedAgentId) {
                const dragDistX = Math.abs(event.clientX - this.mouseDragStartX);
                const dragDistY = Math.abs(event.clientY - this.mouseDragStartY);
                
                if (dragDistX > this.mouseDragThreshold || dragDistY > this.mouseDragThreshold) {
                    this.cancelFollowMode();
                }
            }
        });

        document.addEventListener('contextmenu', (event) => {
            if (!this.renderer || !this.renderer.domElement) return;
            const inCanvas = this.renderer.domElement.contains(event.target);
            if (!inCanvas) return;
            const agentId = this.getAgentIdFromScreenPoint(event.clientX, event.clientY);
            if (!agentId) {
                this.hideLobsterContextMenu();
                return;
            }
            event.preventDefault();
            this.showLobsterContextMenu(event.clientX, event.clientY, agentId);
        });
        
        document.addEventListener('click', (event) => {
            const menu = document.getElementById('lobster-context-menu');
            if (this.contextMenuOpen && menu && !menu.contains(event.target)) {
                this.hideLobsterContextMenu();
            }

            if (this.suppressNextClick) {
                this.suppressNextClick = false;
                return;
            }

            const agentId = this.getAgentIdFromScreenPoint(event.clientX, event.clientY);
            if (agentId) {
                this.zoomToAgent(agentId);
            }
        });

        // Mobile long-press action sheet
        const canvas = this.renderer.domElement;
        if (canvas) {
            canvas.addEventListener('touchstart', (event) => {
                if (!event.touches || event.touches.length !== 1) return;
                const touch = event.touches[0];
                this.mouseDragStartX = touch.clientX;
                this.mouseDragStartY = touch.clientY;
                this.longPressMoved = false;
                this.longPressStart = { x: touch.clientX, y: touch.clientY };
                this.longPressTargetAgentId = this.getAgentIdFromScreenPoint(touch.clientX, touch.clientY);
                if (!this.longPressTargetAgentId) return;

                clearTimeout(this.longPressTimer);
                this.longPressTimer = setTimeout(() => {
                    if (!this.longPressMoved && this.longPressTargetAgentId) {
                        this.showLobsterContextMenu(touch.clientX, touch.clientY, this.longPressTargetAgentId);
                        this.suppressNextClick = true;
                    }
                }, this.longPressMs);
            }, { passive: true });

            canvas.addEventListener('touchmove', (event) => {
                if (!event.touches || !event.touches.length) return;
                const touch = event.touches[0];
                const dx = Math.abs(touch.clientX - this.longPressStart.x);
                const dy = Math.abs(touch.clientY - this.longPressStart.y);
                if (dx > this.longPressMoveThreshold || dy > this.longPressMoveThreshold) {
                    this.longPressMoved = true;
                    clearTimeout(this.longPressTimer);
                }

                if (this.followedAgentId) {
                    const dragDistX = Math.abs(touch.clientX - this.mouseDragStartX);
                    const dragDistY = Math.abs(touch.clientY - this.mouseDragStartY);
                    if (dragDistX > this.mouseDragThreshold || dragDistY > this.mouseDragThreshold) {
                        this.cancelFollowMode();
                    }
                }
            }, { passive: true });

            canvas.addEventListener('touchend', () => {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
                this.longPressTargetAgentId = null;
            }, { passive: true });
        }
    }
    
    updateKeyboardMovement() {
        if (!this.followedAgentId) {
            // Zoom in/out with W and S
            const zoomIn = this.keysPressed.w ? 1 : 0;
            const zoomOut = this.keysPressed.s ? 1 : 0;
            
            if (zoomIn !== 0 || zoomOut !== 0) {
                // Get direction from camera to target
                const direction = new THREE.Vector3();
                direction.subVectors(this.controls.target, this.camera.position);
                direction.normalize();
                
                // Zoom by moving camera towards or away from target
                const zoomAmount = (zoomIn - zoomOut) * this.keyboardSpeed * 2;
                this.camera.position.addScaledVector(direction, zoomAmount);
            }
            
            // Arrow up/down for zoom
            const zoomInArrow = this.keysPressed.arrowUp ? 1 : 0;
            const zoomOutArrow = this.keysPressed.arrowDown ? 1 : 0;
            
            if (zoomInArrow !== 0 || zoomOutArrow !== 0) {
                const direction = new THREE.Vector3();
                direction.subVectors(this.controls.target, this.camera.position);
                direction.normalize();
                const zoomAmount = (zoomInArrow - zoomOutArrow) * this.keyboardSpeed * 2;
                this.camera.position.addScaledVector(direction, zoomAmount);
            }
            
            // Left/Right movement with arrow keys and A/D
            const moveRight = (this.keysPressed.arrowRight || this.keysPressed.d) ? 1 : 0;
            const moveLeft = (this.keysPressed.arrowLeft || this.keysPressed.a) ? -1 : 0;
            const moveAmount = moveRight + moveLeft;
            
            if (moveAmount !== 0) {
                // Get camera's right vector
                const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
                right.y = 0; // Keep movement on horizontal plane
                right.normalize();
                
                // Move camera and controls target
                const movement = new THREE.Vector3();
                movement.addScaledVector(right, moveAmount * this.keyboardSpeed);
                
                this.camera.position.add(movement);
                this.controls.target.add(movement);
            }
        } else {
            // When following, if user presses any keyboard keys, cancel the follow
            if (this.keysPressed.arrowUp || this.keysPressed.arrowDown ||
                this.keysPressed.arrowLeft || this.keysPressed.arrowRight ||
                this.keysPressed.w || this.keysPressed.a ||
                this.keysPressed.s || this.keysPressed.d) {
                this.cancelFollowMode();
            }
        }
    }
    
    zoomToAgent(agentId, options = {}) {
        const agent = this.agents.get(agentId);
        if (!agent) return;

        // Toggle follow: clicking the same lobster again releases the camera
        if (this.followedAgentId === agentId) {
            this.cancelFollowMode();
            return;
        }

        this.followedAgentId = agentId;
        this.followedAgentInitialPos = this.camera.position.clone();
        this.controls.enabled = false; // Disable manual orbit while following

        const followOffset = this.getCurrentFollowOffset();
        const startPos = this.camera.position.clone();
        const startTime = Date.now();
        const duration = Math.max(0, Number(options.durationMs) || 1000);
        this.cameraTransitionUntilMs = Date.now() + duration;

        const animateMove = () => {
            if (this.followedAgentId !== agentId) return; // cancelled mid-flight
            const elapsed = Date.now() - startTime;
            const progress = duration <= 0 ? 1 : Math.min(elapsed / duration, 1);
            const easeProgress = progress < 0.5
                ? 2 * progress * progress
                : -1 + (4 - 2 * progress) * progress;

            const livePos = this.agents.get(agentId)?.mesh.position;
            if (!livePos) return;

            const camTargetX = livePos.x + followOffset.x;
            const camTargetY = livePos.y + followOffset.y;
            const camTargetZ = livePos.z + followOffset.z;

            this.camera.position.x = startPos.x + (camTargetX - startPos.x) * easeProgress;
            this.camera.position.y = startPos.y + (camTargetY - startPos.y) * easeProgress;
            this.camera.position.z = startPos.z + (camTargetZ - startPos.z) * easeProgress;

            this.controls.target.lerp(livePos, easeProgress);

            if (progress < 1) {
                requestAnimationFrame(animateMove);
            } else {
                this.cameraTransitionUntilMs = Date.now();
            }
        };

        animateMove();
    }
    
    startPolling() {
        // Initial connection test
        this.testConnection();

        document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
        
        // Start polling loops
        this.scheduleWorldPoll(0);
        this.scheduleChatPoll(0);
    }

    handleVisibilityChange() {
        this.isPageHidden = document.visibilityState === 'hidden';

        if (this.isPageHidden) {
            // Keep polling in background, but reduce frequency for efficiency.
            this.scheduleWorldPoll(this.hiddenPollIntervalMs);
            this.scheduleChatPoll(this.hiddenPollIntervalMs);
            return;
        }

        // Restore normal visible-tab cadence and fetch world state immediately.
        this.scheduleWorldPoll(this.pollInterval);
        this.scheduleChatPoll(this.pollInterval * 2);
        this.pollWorldState();
    }

    getAdaptivePollDelay(baseInterval, failureCount) {
        const hiddenInterval = this.isPageHidden ? this.hiddenPollIntervalMs : baseInterval;
        const backoffMultiplier = 2 ** failureCount;
        return Math.min(hiddenInterval * backoffMultiplier, this.maxPollBackoffMs);
    }

    scheduleWorldPoll(delayMs) {
        if (this.worldPollTimer) {
            clearTimeout(this.worldPollTimer);
        }
        this.worldPollTimer = setTimeout(() => this.pollWorldState(), Math.max(0, delayMs));
    }

    scheduleChatPoll(delayMs) {
        if (this.chatPollTimer) {
            clearTimeout(this.chatPollTimer);
        }
        this.chatPollTimer = setTimeout(() => this.pollChatMessages(), Math.max(0, delayMs));
    }
    
    async testConnection() {
        try {
            const response = await fetch(`${this.apiBase}/status`);
            if (response.ok) {
                const data = await response.json();
                console.log('Connected to server');
                this.connected = true;
                // Update server info from status endpoint
                this.updateWorldClockAnchorFromPayload(data);
                if (data.totalEntitiesCreated !== undefined) this.totalEntitiesCreated = data.totalEntitiesCreated;
                this.updateTickLabel();
                this.updateWorldClockLabel();
                this.updateStatus();
                this.maybeRefreshWorldProgress(true);
                // Trigger summarization check once on first successful connection
                this.triggerSummarizationCheck();
            }
        } catch (error) {
            console.error('Connection error:', error);
            this.connected = false;
            this.updateStatus();
        }
    }
    
    async pollWorldState() {
        if (this.worldPollInFlight) {
            return;
        }

        this.worldPollInFlight = true;

        if (!this.connected) {
            try {
                await this.testConnection();
                this.worldPollFailures = this.connected ? 0 : this.worldPollFailures + 1;
                return;
            } finally {
                this.worldPollInFlight = false;
                this.scheduleWorldPoll(this.getAdaptivePollDelay(this.pollInterval, this.worldPollFailures));
            }
        }

        try {
            const params = new URLSearchParams();
            if (this.worldDeltaEnabled && Number.isFinite(this.worldTick)) {
                params.set('sinceTick', String(this.worldTick));
                params.set('delta', 'true');
            }
            const url = `${this.apiBase}/world-state${params.toString() ? `?${params.toString()}` : ''}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                this.handleWorldState(data);
                if (this.currentQuestEntityId) {
                    this.fetchQuestProgress(this.currentQuestEntityId);
                }
                this.worldPollFailures = 0;
            } else {
                this.connected = false;
                this.worldPollFailures += 1;
                this.updateStatus();
            }
        } catch (error) {
            console.error('Poll error:', error);
            this.connected = false;
            this.worldPollFailures += 1;
            this.updateStatus();
        } finally {
            this.worldPollInFlight = false;
            this.scheduleWorldPoll(this.getAdaptivePollDelay(this.pollInterval, this.worldPollFailures));
        }
    }

    async pollChatMessages() {
        if (this.chatPollInFlight) {
            return;
        }

        if (!this.connected) {
            this.chatPollFailures = Math.max(this.chatPollFailures, 0);
            this.scheduleChatPoll(this.getAdaptivePollDelay(this.pollInterval * 2, this.chatPollFailures));
            return;
        }

        this.chatPollInFlight = true;
        
        try {
            const url = this.lastChatTimestamp === 0
                ? `${this.apiBase}/chat`
                : `${this.apiBase}/chat?since=${this.lastChatTimestamp}`;
            const response = await fetch(url);
            
            if (response.ok) {
                const data = await response.json();
                const messages = data.messages || [];
                this.chatPollFailures = 0;
                
                messages.forEach(msg => {
                    if (msg.timestamp > this.lastChatTimestamp) {
                        this.lastChatTimestamp = msg.timestamp;
                        if (String(msg.agentName || '').toLowerCase() === 'system') {
                            return;
                        }
                        this.addChatMessage(msg);
                    }
                });
            } else {
                this.chatPollFailures += 1;
            }
        } catch (error) {
            console.error('Chat poll error:', error);
            this.chatPollFailures += 1;
        } finally {
            this.chatPollInFlight = false;
            this.scheduleChatPoll(this.getAdaptivePollDelay(this.pollInterval * 2, this.chatPollFailures));
        }
    }
    
    handleMessage(message) {
        // This method is no longer used with HTTP polling
        // Keeping for potential compatibility
    }
    
    handleWorldState(data) {
        this.updateWorldClockAnchorFromPayload(data);
        this.worldTimeState = this.deriveWorldTimeState(data);
        this.applyWorldLighting(this.worldTimeState);
        this.updateWorldClockLabel(true);
        if (data.totalEntitiesCreated !== undefined) {
            this.totalEntitiesCreated = data.totalEntitiesCreated;
        }

        const payloadTick = Number.isFinite(Number(data.tick)) ? Number(data.tick) : null;
        if (payloadTick !== null) {
            this.worldTick = payloadTick;
            this.updateTickLabel();
        }

        const isDeltaPayload = data.isDelta === true;
        const deltaWindowMissed = data.deltaWindowMissed === true;
        const agents = Array.isArray(data.agents) ? data.agents : [];
        const objects = Array.isArray(data.objects) ? data.objects : [];
        const threats = Array.isArray(data.threats) ? data.threats : [];
        const combatEvents = Array.isArray(data.combatEvents) ? data.combatEvents : [];
        const events = Array.isArray(data.events) ? data.events : [];
        const expansionTiles = Array.isArray(data.expansionTiles) ? data.expansionTiles : [];

        if (objects.length > 0) {
            this.renderWorldObjects(objects);
        }
        this.syncThreats(threats);
        this.handleCombatEvents(combatEvents);
        this.worldEvents = events;
        this.updateEventOverlay();
        this.syncHazards(this.mapHazardEvents(events));
        this.syncExpansionTiles(expansionTiles);
        if (Number.isFinite(Number(data.mapExpansionLevel))) {
            this.latestExpansionStats.mapExpansionLevel = Math.max(0, Math.floor(Number(data.mapExpansionLevel)));
            this.updateExpansionHud();
        }
        this.maybeRefreshWorldProgress();

        if (isDeltaPayload && !deltaWindowMissed) {
            // Invariant: animation state updates must run in both delta + full-sync paths.
            agents.forEach(agent => {
                if (this.agents.has(agent.id)) {
                    this.emitEnergySystemTransitionIfNeeded(agent);
                    this.updateAgentPosition(agent.id, agent.position, agent.rotation);
                    this.updateAgentAnimationState(agent.id, agent);
                    this.agents.get(agent.id).data = agent;
                } else {
                    this.addAgent(agent);
                }
            });

            const removedAgentIds = Array.isArray(data.removedAgentIds) ? data.removedAgentIds : [];
            removedAgentIds.forEach(agentId => {
                if (this.agents.has(agentId)) {
                    this.removeAgent(agentId);
                }
            });
        } else {
            // Full sync (default path + fallback if delta window is missed)
            const serverAgentIds = new Set();
            agents.forEach(agent => {
                serverAgentIds.add(agent.id);

                if (this.agents.has(agent.id)) {
                    this.emitEnergySystemTransitionIfNeeded(agent);
                    this.updateAgentPosition(agent.id, agent.position, agent.rotation);
                    this.updateAgentAnimationState(agent.id, agent);
                    this.agents.get(agent.id).data = agent;
                } else {
                    this.addAgent(agent);
                }
            });

            const localAgentIds = Array.from(this.agents.keys());
            localAgentIds.forEach(agentId => {
                if (!serverAgentIds.has(agentId)) {
                    this.removeAgent(agentId);
                }
            });
        }

        // Enable delta polling after first successful full sync
        if (!isDeltaPayload || deltaWindowMissed) {
            this.worldDeltaEnabled = true;
        }

        if (this.showAnimationDiagnosticsInAgentList && this.followedAgentId) {
            this.updateAgentList();
        }

        this.updateStatus();
    }
    
    addAgent(agentData) {
        if (this.agents.has(agentData.id)) {
            return; // Agent already exists
        }
        
        const mesh = this.createLobsterMesh(agentData.name);
        mesh.position.set(agentData.position.x, 0.5, agentData.position.z);
        mesh.rotation.y = agentData.rotation || 0;
        this.scene.add(mesh);

        const animation = {
            animType: null,
            animStartMs: 0,
            animDurationMs: 0,
            baseY: mesh.position.y,
            yOffset: 0,
            painPhase: Math.random() * Math.PI * 2,
            painActive: Boolean(agentData?.pain?.active),
            painDamage: Number(agentData?.pain?.damage || 0),
            dancePhase: Math.random() * Math.PI * 2,
            baseYaw: agentData.rotation || 0,
            serverYawTarget: agentData.rotation || 0,
            movementTarget: new THREE.Vector3(agentData.position.x, 0, agentData.position.z),
            serverMovementTarget: new THREE.Vector3(agentData.position.x, 0, agentData.position.z),
            recoveryTarget: null,
            recoveryUntilMs: 0,
            stuckTimeMs: 0,
            lastProgressX: agentData.position.x,
            lastProgressZ: agentData.position.z,
            lastLocomotionFrameMs: Date.now(),
            lastActionType: null,
            lastState: null,
            lastExpandTileId: null,
            modelParts: {
                body: mesh.children[0] || null,
                frontRig: mesh.getObjectByName('frontRig') || null,
                leftClaw: null,
                rightClaw: null,
                leftAntenna: null,
                rightAntenna: null,
                painRing: null
            }
        };

        if (animation.modelParts.frontRig) {
            const rigChildren = animation.modelParts.frontRig.children;
            animation.modelParts.leftClaw = rigChildren[0] || null;
            animation.modelParts.rightClaw = rigChildren[1] || null;
            animation.modelParts.leftAntenna = rigChildren[2] || null;
            animation.modelParts.rightAntenna = rigChildren[3] || null;

            if (this.debugHead) {
                const helper = new THREE.ArrowHelper(
                    new THREE.Vector3(1, 0, 0),
                    new THREE.Vector3(0, 0, 0),
                    1.25,
                    0x00ff00,
                    0.25,
                    0.12
                );
                helper.name = 'frontRigForwardHelper';
                animation.modelParts.frontRig.add(helper);
            }
        }

        const painRing = new THREE.Mesh(
            new THREE.RingGeometry(0.62, 0.95, 36),
            new THREE.MeshBasicMaterial({
                color: 0xff6464,
                transparent: true,
                opacity: 0,
                side: THREE.DoubleSide,
                depthWrite: false
            })
        );
        painRing.rotation.x = -Math.PI / 2;
        painRing.position.y = 0.12;
        painRing.visible = false;
        animation.modelParts.painRing = painRing;
        mesh.add(painRing);
        
        this.agents.set(agentData.id, {
            mesh: mesh,
            data: agentData,
            animation
        });
        this.agentSleepStateById.set(agentData.id, Boolean(agentData.sleeping));

        this.updateAgentAnimationState(agentData.id, agentData);
        
        // Store agent name mapping for chat clicks
        this.agentNameMap.set(agentData.name, agentData.id);
        
        console.log('Agent joined:', agentData.name);
        this.updateAgentList();
    }
    
    removeAgent(agentId) {
        const agent = this.agents.get(agentId);
        if (agent) {
            if (this.chatBubbles.has(agentId)) {
                const { bubble } = this.chatBubbles.get(agentId);
                agent.mesh.remove(bubble);
                this.disposeBubble(bubble);
                this.chatBubbles.delete(agentId);
            }

            this.scene.remove(agent.mesh);
            this.agents.delete(agentId);
            this.agentSleepStateById.delete(agentId);
            
            // Remove from name map
            for (const [name, id] of this.agentNameMap.entries()) {
                if (id === agentId) {
                    this.agentNameMap.delete(name);
                    break;
                }
            }
            console.log('Agent left:', agentId);
            this.updateAgentList();
        }
    }
    
    updateAgentPosition(agentId, position, rotation) {
        const agent = this.agents.get(agentId);
        if (agent) {
            const anim = agent.animation;
            if (anim && position) {
                anim.serverMovementTarget.set(position.x, 0, position.z);
                if (!anim.recoveryTarget) {
                    anim.movementTarget.copy(anim.serverMovementTarget);
                }
            }
            if (rotation !== undefined) {
                if (anim) {
                    anim.baseYaw = rotation;
                    anim.serverYawTarget = rotation;
                }
            }
            if (anim) {
                anim.baseY = 0.5;
            }
            agent.data.position = position;
        }
    }

    shortestAngleDelta(from, to) {
        return Math.atan2(Math.sin(to - from), Math.cos(to - from));
    }

    clampToPlayableArea(position) {
        position.x = THREE.MathUtils.clamp(position.x, MAP_EDGE_BUFFER, 100 - MAP_EDGE_BUFFER);
        position.z = THREE.MathUtils.clamp(position.z, MAP_EDGE_BUFFER, 100 - MAP_EDGE_BUFFER);
    }

    clearRecoveryTarget(anim) {
        if (!anim) return;
        anim.recoveryTarget = null;
        anim.recoveryUntilMs = 0;
        anim.movementTarget.copy(anim.serverMovementTarget);
        anim.stuckTimeMs = 0;
        anim.lastProgressX = anim.movementTarget.x;
        anim.lastProgressZ = anim.movementTarget.z;
    }

    assignRecoveryTarget(agent, awayX, awayZ, nowMs) {
        const anim = agent?.animation;
        const mesh = agent?.mesh;
        if (!anim || !mesh) return;

        const magnitude = Math.hypot(awayX, awayZ);
        if (magnitude < 1e-5) {
            this.clearRecoveryTarget(anim);
            return;
        }

        const nx = awayX / magnitude;
        const nz = awayZ / magnitude;
        const target = new THREE.Vector3(
            mesh.position.x + (nx * RECOVERY_MOVE_DISTANCE),
            0,
            mesh.position.z + (nz * RECOVERY_MOVE_DISTANCE)
        );
        this.clampToPlayableArea(target);

        anim.recoveryTarget = target;
        anim.recoveryUntilMs = nowMs + RECOVERY_TIMEOUT_MS;
        anim.movementTarget.copy(target);
        anim.stuckTimeMs = 0;
        anim.lastProgressX = mesh.position.x;
        anim.lastProgressZ = mesh.position.z;
    }

    resolveEnvironmentCollisionForAgent(agent, nowMs) {
        const mesh = agent?.mesh;
        if (!mesh) return;

        let escapeX = 0;
        let escapeZ = 0;
        let collided = false;

        if (mesh.position.x < MAP_EDGE_BUFFER) {
            escapeX += 1;
            mesh.position.x = MAP_EDGE_BUFFER;
            collided = true;
        } else if (mesh.position.x > 100 - MAP_EDGE_BUFFER) {
            escapeX -= 1;
            mesh.position.x = 100 - MAP_EDGE_BUFFER;
            collided = true;
        }

        if (mesh.position.z < MAP_EDGE_BUFFER) {
            escapeZ += 1;
            mesh.position.z = MAP_EDGE_BUFFER;
            collided = true;
        } else if (mesh.position.z > 100 - MAP_EDGE_BUFFER) {
            escapeZ -= 1;
            mesh.position.z = 100 - MAP_EDGE_BUFFER;
            collided = true;
        }

        for (const obstacle of this.obstacles) {
            const dx = mesh.position.x - obstacle.x;
            const dz = mesh.position.z - obstacle.z;
            const minDistance = LOBSTER_COLLISION_RADIUS + obstacle.radius;
            const distSq = (dx * dx) + (dz * dz);
            if (distSq >= minDistance * minDistance) continue;

            const dist = Math.max(Math.sqrt(distSq), 0.0001);
            const overlap = (minDistance - dist) + COLLISION_PUSH_BUFFER;
            const nx = dx / dist;
            const nz = dz / dist;
            mesh.position.x += nx * overlap;
            mesh.position.z += nz * overlap;
            escapeX += nx;
            escapeZ += nz;
            collided = true;
        }

        if (!collided) return;

        this.clampToPlayableArea(mesh.position);
        this.assignRecoveryTarget(agent, escapeX, escapeZ, nowMs);
    }

    resolveAgentCollisions(nowMs) {
        const liveAgents = Array.from(this.agents.values());
        for (let i = 0; i < liveAgents.length; i += 1) {
            const a = liveAgents[i];
            for (let j = i + 1; j < liveAgents.length; j += 1) {
                const b = liveAgents[j];
                const dx = b.mesh.position.x - a.mesh.position.x;
                const dz = b.mesh.position.z - a.mesh.position.z;
                const minDistance = LOBSTER_COLLISION_RADIUS * 2;
                const distSq = (dx * dx) + (dz * dz);
                if (distSq >= minDistance * minDistance) continue;

                const dist = Math.max(Math.sqrt(distSq), 0.0001);
                const overlap = ((minDistance - dist) * 0.5) + COLLISION_PUSH_BUFFER;
                const nx = dx / dist;
                const nz = dz / dist;

                a.mesh.position.x -= nx * overlap;
                a.mesh.position.z -= nz * overlap;
                b.mesh.position.x += nx * overlap;
                b.mesh.position.z += nz * overlap;
                this.clampToPlayableArea(a.mesh.position);
                this.clampToPlayableArea(b.mesh.position);

                this.assignRecoveryTarget(a, -nx, -nz, nowMs);
                this.assignRecoveryTarget(b, nx, nz, nowMs);
            }
        }
    }

    updateAgentLocomotionFrame(agent, nowMs) {
        const anim = agent.animation;
        if (!anim) return;

        const mesh = agent.mesh;
        const lastFrameMs = Number(anim.lastLocomotionFrameMs || nowMs);
        const dt = Math.min(0.1, Math.max(0, (nowMs - lastFrameMs) / 1000));
        anim.lastLocomotionFrameMs = nowMs;
        if (dt <= 0) return;

        if (anim.recoveryTarget && nowMs >= anim.recoveryUntilMs) {
            this.clearRecoveryTarget(anim);
        }

        const target = anim.recoveryTarget || anim.serverMovementTarget || anim.movementTarget;
        if (!target) return;
        anim.movementTarget.copy(target);

        const toTargetX = target.x - mesh.position.x;
        const toTargetZ = target.z - mesh.position.z;
        const distance = Math.hypot(toTargetX, toTargetZ);

        if (distance > 0.01) {
            const desiredYaw = Math.atan2(toTargetZ, toTargetX);
            const yawDelta = this.shortestAngleDelta(mesh.rotation.y, desiredYaw);
            const maxTurn = LOBSTER_MAX_TURN_RATE * dt;
            mesh.rotation.y += THREE.MathUtils.clamp(yawDelta, -maxTurn, maxTurn);

            const headingError = Math.abs(this.shortestAngleDelta(mesh.rotation.y, desiredYaw));
            if (headingError <= LOBSTER_HEAD_ALIGNMENT_THRESHOLD) {
                const forwardStep = Math.min(distance, LOBSTER_MAX_FORWARD_SPEED * dt);
                mesh.position.x += Math.cos(mesh.rotation.y) * forwardStep;
                mesh.position.z += Math.sin(mesh.rotation.y) * forwardStep;
            }

            const progressDx = mesh.position.x - Number(anim.lastProgressX ?? mesh.position.x);
            const progressDz = mesh.position.z - Number(anim.lastProgressZ ?? mesh.position.z);
            const progressDistance = Math.hypot(progressDx, progressDz);
            if (progressDistance >= MOVE_PROGRESS_EPSILON) {
                anim.stuckTimeMs = 0;
                anim.lastProgressX = mesh.position.x;
                anim.lastProgressZ = mesh.position.z;
            } else if (headingError <= LOBSTER_HEAD_ALIGNMENT_THRESHOLD) {
                anim.stuckTimeMs = Number(anim.stuckTimeMs || 0) + (dt * 1000);
                if (anim.stuckTimeMs >= MOVE_STUCK_TIMEOUT_MS) {
                    if (anim.recoveryTarget) {
                        this.clearRecoveryTarget(anim);
                    } else {
                        anim.lastProgressX = mesh.position.x;
                        anim.lastProgressZ = mesh.position.z;
                        anim.movementTarget.copy(anim.serverMovementTarget);
                    }
                    anim.stuckTimeMs = 0;
                }
            }

            this.resolveEnvironmentCollisionForAgent(agent, nowMs);

            const remainingDistance = Math.hypot(target.x - mesh.position.x, target.z - mesh.position.z);
            if (remainingDistance <= 0.08) {
                mesh.position.x = target.x;
                mesh.position.z = target.z;
                if (anim.recoveryTarget) {
                    this.clearRecoveryTarget(anim);
                }
            }

            anim.baseYaw = mesh.rotation.y;
            return;
        }

        if (anim.recoveryTarget) {
            this.clearRecoveryTarget(anim);
        }

        const idleYawDelta = this.shortestAngleDelta(mesh.rotation.y, Number(anim.serverYawTarget || mesh.rotation.y));
        const idleTurn = LOBSTER_MAX_TURN_RATE * 0.75 * dt;
        mesh.rotation.y += THREE.MathUtils.clamp(idleYawDelta, -idleTurn, idleTurn);
        this.resolveEnvironmentCollisionForAgent(agent, nowMs);
        anim.baseYaw = mesh.rotation.y;
    }

    resolveAnimationType(agentData) {
        const actionType = String(agentData?.lastAction?.type || '').toLowerCase().trim();
        const state = String(agentData?.state || '').toLowerCase().trim();
        const painActive = Boolean(agentData?.pain?.active);

        const jumpAliases = ['jump', 'hop', 'leap', 'bounce'];
        const danceAliases = ['dance', 'dancing', 'groove', 'boogie', 'shimmy'];
        const emoteAliases = ['emote', 'wave', 'cheer', 'signal', 'pose', 'react', 'gesture'];
        const attackAliases = ['combat_attack', 'attack', 'hammer', 'strike'];
        const hurtAliases = ['hurt', 'pain', 'pain_react', 'combat_hit'];

        const actionTokens = actionType.split(/[^a-z0-9]+/).filter(Boolean);
        const stateTokens = state.split(/[^a-z0-9]+/).filter(Boolean);
        const hasAnyAlias = (aliases) => aliases.some(alias => (
            actionType === alias
            || state === alias
            || actionTokens.includes(alias)
            || stateTokens.includes(alias)
        ));

        if (hasAnyAlias(jumpAliases)) return 'jump';
        if (hasAnyAlias(danceAliases)) return 'dance';
        if (painActive || hasAnyAlias(hurtAliases)) return 'hurt';
        if (hasAnyAlias(emoteAliases)) return 'emote';
        if (hasAnyAlias(attackAliases)) return 'attack';
        return null;
    }

    maybeLogIgnoredAnimationState(agentId, agentData) {
        const actionType = String(agentData?.lastAction?.type || '').toLowerCase().trim();
        const state = String(agentData?.state || '').toLowerCase().trim();
        if (!actionType && !state) return;

        const key = `${actionType || 'none'}|${state || 'none'}`;
        const now = Date.now();
        const lastLoggedAt = this.ignoredAnimationStateLogs.get(key) || 0;
        if (now - lastLoggedAt < this.ignoredAnimationStateLogThrottleMs) {
            return;
        }

        this.ignoredAnimationStateLogs.set(key, now);
        console.info('[animation] ignored action/state combination (no matching animType)', {
            agentId,
            actionType: actionType || null,
            state: state || null
        });
    }

    getAnimationDurationMs(animType) {
        if (animType === 'jump') return 700;
        if (animType === 'dance') return 2200;
        if (animType === 'hurt') return 600;
        if (animType === 'emote') return 900;
        if (animType === 'attack') return 430;
        return 0;
    }

    updateAgentAnimationState(agentId, agentData) {
        const agent = this.agents.get(agentId);
        if (!agent?.animation) return;

        const anim = agent.animation;
        const nextAnimType = this.resolveAnimationType(agentData);
        const nextActionType = agentData?.lastAction?.type || null;
        const nextState = agentData?.state || null;
        anim.painActive = Boolean(agentData?.pain?.active);
        anim.painDamage = Number(agentData?.pain?.damage || 0);

        const actionChanged = nextActionType !== anim.lastActionType;
        const stateChanged = nextState !== anim.lastState;
        anim.lastActionType = nextActionType;
        anim.lastState = nextState;

        const isExpandAction = String(nextActionType || '').toLowerCase() === 'expand_map';
        const expandedTile = agentData?.lastAction?.tile;
        const expandedTileId = expandedTile?.id || null;
        if (isExpandAction && expandedTileId && anim.lastExpandTileId !== expandedTileId) {
            anim.lastExpandTileId = expandedTileId;
            this.spawnExpansionPulse(expandedTile);
        }

        if (!nextAnimType) {
            this.maybeLogIgnoredAnimationState(agentId, agentData);
            anim.animType = null;
            anim.animStartMs = 0;
            anim.animDurationMs = 0;
            anim.yOffset = 0;
            return;
        }

        if (actionChanged || stateChanged || anim.animType !== nextAnimType) {
            anim.animType = nextAnimType;
            anim.animStartMs = Date.now();
            anim.animDurationMs = this.getAnimationDurationMs(nextAnimType);
            anim.yOffset = 0;
        }
    }

    applyAgentAnimationFrame(agent, nowMs) {
        const anim = agent.animation;
        if (!anim) return;

        const { mesh } = agent;
        const baseY = anim.baseY ?? 0.5;
        const body = anim.modelParts.body;
        const frontRig = anim.modelParts.frontRig;
        const leftClaw = anim.modelParts.leftClaw;
        const rightClaw = anim.modelParts.rightClaw;
        const leftAntenna = anim.modelParts.leftAntenna;
        const rightAntenna = anim.modelParts.rightAntenna;
        const painRing = anim.modelParts.painRing;

        // Reset animated transforms each frame to avoid drift and stuck poses.
        if (frontRig) {
            frontRig.rotation.set(0, 0, 0);
        }
        if (body) body.scale.set(1, 1, 1);
        if (frontRig) frontRig.rotation.set(0, 0, 0);
        if (leftClaw) leftClaw.rotation.z = 0;
        if (rightClaw) rightClaw.rotation.z = 0;
        if (leftAntenna) leftAntenna.rotation.x = 0;
        if (rightAntenna) rightAntenna.rotation.x = 0;

        let yOffset = 0;
        if (anim.animType && anim.animDurationMs > 0) {
            const elapsed = nowMs - anim.animStartMs;
            const progress = elapsed / anim.animDurationMs;

            if (progress >= 1) {
                anim.animType = null;
                anim.animStartMs = 0;
                anim.animDurationMs = 0;
            } else if (anim.animType === 'jump') {
                const jumpHeight = 0.8;
                const sineArc = Math.sin(progress * Math.PI);
                yOffset = Math.max(0, jumpHeight * sineArc);
            } else if (anim.animType === 'dance') {
                const phase = anim.dancePhase + elapsed * 0.014;
                if (frontRig) {
                    frontRig.rotation.z = Math.sin(phase) * 0.16;
                    frontRig.rotation.y = Math.sin(phase * 0.6) * 0.08;
                }
                yOffset = Math.sin(phase * 1.4) * 0.1;
                if (frontRig) frontRig.rotation.y = Math.sin(phase * 1.2) * 0.18;
                if (leftClaw) leftClaw.rotation.z = Math.sin(phase * 1.8) * 0.45;
                if (rightClaw) rightClaw.rotation.z = -Math.sin(phase * 1.8) * 0.45;
            } else if (anim.animType === 'emote') {
                const pulse = Math.sin(progress * Math.PI * 4);
                yOffset = Math.max(0, Math.sin(progress * Math.PI)) * 0.15;
                if (frontRig) {
                    frontRig.rotation.y = 0.12 * pulse;
                }
                if (body) {
                    const scalePulse = 1 + 0.06 * pulse;
                    body.scale.set(scalePulse, scalePulse, scalePulse);
                }
                if (frontRig) frontRig.rotation.z = 0.12 * pulse;
                if (leftAntenna) leftAntenna.rotation.x = 0.35 * pulse;
                if (rightAntenna) rightAntenna.rotation.x = -0.35 * pulse;
                if (leftClaw) leftClaw.rotation.z = 0.25 * pulse;
                if (rightClaw) rightClaw.rotation.z = -0.25 * pulse;
            } else if (anim.animType === 'attack') {
                const strike = Math.sin(progress * Math.PI);
                yOffset = strike * 0.14;
                if (frontRig) frontRig.rotation.x = -0.12 * strike;
                if (leftClaw) leftClaw.rotation.z = 0.95 * strike;
                if (rightClaw) rightClaw.rotation.z = -0.95 * strike;
            } else if (anim.animType === 'hurt') {
                const flinch = Math.sin(progress * Math.PI);
                yOffset = flinch * 0.1;
                if (frontRig) frontRig.rotation.x = -0.18 * flinch;
                if (leftClaw) leftClaw.rotation.z = 0.42 * flinch;
                if (rightClaw) rightClaw.rotation.z = -0.42 * flinch;
            }
        }

        if (anim.painActive) {
            const painWave = (Math.sin((nowMs * 0.018) + anim.painPhase) + 1) * 0.5;
            const painIntensity = THREE.MathUtils.clamp(0.35 + (Number(anim.painDamage || 0) / 22), 0.35, 1.2);
            yOffset += 0.03 + (painWave * 0.05 * painIntensity);
            if (frontRig) frontRig.rotation.z += (Math.sin((nowMs * 0.042) + anim.painPhase) * 0.08 * painIntensity);
            if (leftAntenna) leftAntenna.rotation.x += (0.18 + painWave * 0.2) * painIntensity;
            if (rightAntenna) rightAntenna.rotation.x -= (0.18 + painWave * 0.2) * painIntensity;
            if (painRing) {
                painRing.visible = true;
                painRing.rotation.z += 0.02;
                painRing.scale.setScalar(0.9 + (painWave * 0.5 * painIntensity));
                painRing.material.opacity = THREE.MathUtils.clamp(0.22 + (painWave * 0.5), 0.2, 0.85);
            }
        } else if (painRing) {
            painRing.visible = false;
            painRing.material.opacity = 0;
            painRing.scale.setScalar(1);
        }

        anim.yOffset = yOffset;
        mesh.position.y = baseY + yOffset;
    }
    
    /**
     * Builds and returns a single chat message <div> element.
     * Stores data-timestamp so lazy-loading can find the oldest message in the DOM.
     */
    createChatMessageElement(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';
        messageDiv.dataset.timestamp = message.timestamp;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'chat-message-time';
        const msgDate = message.timestamp ? new Date(Number(message.timestamp)) : new Date();
        const timeStr = msgDate.toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        timeSpan.textContent = `[${timeStr}] `;

        const agentNameSpan = document.createElement('span');
        agentNameSpan.className = 'chat-message-agent';
        agentNameSpan.textContent = message.agentName;
        if (String(message.agentName || '').toLowerCase() !== 'system' && message.agentId) {
            agentNameSpan.style.cursor = 'pointer';
            agentNameSpan.addEventListener('click', () => this.zoomToAgent(message.agentId));
        }

        messageDiv.appendChild(timeSpan);
        messageDiv.appendChild(agentNameSpan);
        messageDiv.appendChild(document.createTextNode(`: ${message.message}`));
        return messageDiv;
    }

    addChatMessage(message, options = {}) {
        const chatDiv = document.getElementById('chat-messages');
        chatDiv.appendChild(this.createChatMessageElement(message));

        if (this.chatIsAtBottom) {
            // Live-stream mode: keep only the last 20 messages and stay scrolled to bottom
            while (chatDiv.children.length > 20) {
                chatDiv.removeChild(chatDiv.firstChild);
            }
            chatDiv.scrollTop = chatDiv.scrollHeight;
        } else {
            // User is reading older messages: don't prune the top, but cap total DOM nodes
            while (chatDiv.children.length > 100) {
                chatDiv.removeChild(chatDiv.firstChild);
            }
        }

        // Show chat bubble above lobster in 3D world
        if (!options.skipBubble) {
            this.showChatBubble(message.agentId, message.message);
        }
    }

    emitEnergySystemTransitionIfNeeded(agentData) {
        const previousSleeping = this.agentSleepStateById.get(agentData.id);
        const nextSleeping = Boolean(agentData.sleeping);

        if (typeof previousSleeping === 'boolean' && previousSleeping !== nextSleeping) {
            const message = nextSleeping
                ? `${agentData.name} is low on energy and fell asleep.`
                : `${agentData.name} woke up after recharging energy.`;

            this.addChatMessage({
                agentId: agentData.id,
                agentName: 'system',
                message,
                timestamp: Date.now()
            }, { skipBubble: true });
        }

        this.agentSleepStateById.set(agentData.id, nextSleeping);
    }

    /**
     * Fetches older chat messages from the server and prepends them to the
     * chat panel without jumping the user's scroll position.
     */
    async loadOlderMessages() {
        if (this.chatIsLoading || !this.chatHasMore) return;

        const chatDiv = document.getElementById('chat-messages');

        // Determine the oldest timestamp currently visible in the DOM
        let oldestTimestamp = null;
        for (const child of chatDiv.children) {
            const ts = parseInt(child.dataset.timestamp);
            if (!isNaN(ts) && (oldestTimestamp === null || ts < oldestTimestamp)) {
                oldestTimestamp = ts;
            }
        }
        if (oldestTimestamp === null) return;

        this.chatIsLoading = true;

        // Insert a loading indicator at the very top
        const loader = document.createElement('div');
        loader.id = 'chat-load-indicator';
        loader.className = 'chat-load-indicator';
        loader.textContent = '⏳ Loading older messages…';
        chatDiv.insertBefore(loader, chatDiv.firstChild);

        // Remember content height so we can restore scroll position after prepend
        const scrollHeightBefore = chatDiv.scrollHeight;
        const scrollTopBefore = chatDiv.scrollTop;

        try {
            const response = await fetch(`${this.apiBase}/chat?before=${oldestTimestamp}&limit=20`);

            // Remove loading indicator regardless of outcome
            const existingLoader = document.getElementById('chat-load-indicator');
            if (existingLoader) existingLoader.remove();

            if (response.ok) {
                const data = await response.json();
                // Filter out any messages that aren't actually older (safety check)
                const messages = (data.messages || []).filter(m => m.timestamp < oldestTimestamp);

                if (messages.length === 0) {
                    // No more history
                    this.chatHasMore = false;
                    const noMore = document.createElement('div');
                    noMore.className = 'chat-load-indicator';
                    noMore.textContent = '— Beginning of chat history —';
                    chatDiv.insertBefore(noMore, chatDiv.firstChild);
                } else {
                    // Prepend all older messages (they arrive oldest-first from server)
                    const fragment = document.createDocumentFragment();
                    messages.forEach(msg => fragment.appendChild(this.createChatMessageElement(msg)));
                    chatDiv.insertBefore(fragment, chatDiv.firstChild);

                    // Restore scroll so the user's view doesn't jump
                    chatDiv.scrollTop = scrollTopBefore + (chatDiv.scrollHeight - scrollHeightBefore);

                    // If the server returned fewer than the page size, there's nothing more
                    if (messages.length < 20) this.chatHasMore = false;
                }
            }
        } catch (err) {
            console.error('Error loading older chat messages:', err);
            const existingLoader = document.getElementById('chat-load-indicator');
            if (existingLoader) existingLoader.remove();
        }

        this.chatIsLoading = false;
    }
    
    showChatBubble(agentId, text) {
        const agent = this.agents.get(agentId);
        if (!agent) return;
        
        // Remove old bubble if exists
        if (this.chatBubbles.has(agentId)) {
            const oldBubble = this.chatBubbles.get(agentId).bubble;
            agent.mesh.remove(oldBubble);
            this.disposeBubble(oldBubble);
        }
        
        // Create canvas texture for chat bubble
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 512;
        canvas.height = 256;
        
        // Chat bubble background
        context.fillStyle = 'rgba(0, 0, 0, 0.85)';
        context.beginPath();
        context.roundRect(20, 20, 472, 216, 15);
        context.fill();
        
        // Text
        context.font = 'Bold 18px Arial';
        context.fillStyle = '#ffff00';
        context.textAlign = 'center';
        context.textBaseline = 'top';
        
        // Wrap text
        const maxWidth = 440;
        const words = text.split(' ');
        let lines = [];
        let currentLine = '';
        
        words.forEach(word => {
            const testLine = currentLine + (currentLine ? ' ' : '') + word;
            const metrics = context.measureText(testLine);
            if (metrics.width > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        });
        if (currentLine) lines.push(currentLine);
        
        // Limit to max 8 lines
        if (lines.length > 8) {
            lines = lines.slice(0, 7);
            lines.push('...');
        }
        
        const lineHeight = 28;
        const startY = 30;
        
        lines.forEach((line, index) => {
            context.fillText(line, 256, startY + index * lineHeight);
        });
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture });
        const bubble = new THREE.Sprite(material);
        bubble.position.set(0, 4.2, 0); // Higher than name tag (1.8) to not cover it
        bubble.scale.set(5, 2.5, 1);
        agent.mesh.add(bubble);
        
        this.chatBubbles.set(agentId, { bubble, createdAt: Date.now() });
    }

    disposeBubble(bubble) {
        if (!bubble?.material) {
            return;
        }

        if (bubble.material.map) {
            bubble.material.map.dispose();
        }

        bubble.material.dispose();
    }
    
    updateChatBubbles() {
        const now = Date.now();
        const bubbleTimeout = 5000; // 5 seconds
        
        for (const [agentId, data] of this.chatBubbles.entries()) {
            if (now - data.createdAt > bubbleTimeout) {
                const agent = this.agents.get(agentId);
                if (agent) {
                    agent.mesh.remove(data.bubble);
                }
                this.disposeBubble(data.bubble);
                this.chatBubbles.delete(agentId);
            }
        }
    }
    
    updateStatus() {
        const statusEl = document.getElementById('connection-status');
        statusEl.textContent = this.connected ? 'Online' : 'Offline';
        statusEl.className = this.connected ? 'status-connected' : 'status-disconnected';
        
        document.getElementById('agent-count').textContent = this.agents.size;
        
        // Update total entities created count (if available)
        const totalEl = document.getElementById('total-created-link');
        if (totalEl) totalEl.textContent = this.totalEntitiesCreated;
        this.updateWorldMomentumHud();
    }

    updateEventOverlay() {
        const summaryEl = document.getElementById('event-summary');
        const objectiveEl = document.getElementById('event-objective');
        if (!summaryEl || !objectiveEl) return;

        const active = this.worldEvents.filter((event) => event && event.status === 'active');
        if (!active.length) {
            summaryEl.textContent = 'No active events';
            objectiveEl.textContent = '—';
            return;
        }

        const labels = {
            hazard_zone: 'Hazard Zone',
            rescue_beacon: 'Rescue Beacon',
            migration_signal: 'Migration Signal'
        };

        const primary = active[0] || {};
        const eventType = String(primary.type || 'event');
        const eventLabel = labels[eventType] || eventType.replace(/_/g, ' ');
        const participants = primary.participants && typeof primary.participants === 'object'
            ? Object.keys(primary.participants).length
            : 0;

        summaryEl.textContent = `${active.length} active (${eventLabel}, ${participants} participants)`;
        objectiveEl.textContent = primary.objective?.description || primary.description || 'Complete event objective';
    }
    
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        const months = Math.floor(days / 30);
        
        const parts = [];
        if (months > 0) parts.push(`${months}mo`);
        if (days % 30 > 0) parts.push(`${days % 30}d`);
        if (hours % 24 > 0) parts.push(`${hours % 24}h`);
        if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
        parts.push(`${seconds % 60}s`);
        
        return parts.join(' ');
    }

    formatRelativeTimeAgo(msAgo) {
        if (msAgo < 2000) return 'just now';
        const seconds = Math.floor(msAgo / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    normalizeServerTimestamp(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string') {
            const numeric = Number(value);
            if (Number.isFinite(numeric) && value.trim() !== '') return numeric;
            const parsed = Date.parse(value);
            if (!Number.isNaN(parsed)) return parsed;
        }
        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return value.getTime();
        }
        return null;
    }

    updateWorldClockAnchorFromPayload(data = {}) {
        const worldCreatedAt = this.normalizeServerTimestamp(data.worldCreatedAt);
        const serverStartTime = this.normalizeServerTimestamp(data.serverStartTime);

        if (serverStartTime !== null && this.serverStartTime !== serverStartTime) {
            this.serverStartTime = serverStartTime;
            this.worldClockMinuteKey = '';
        }

        if (worldCreatedAt !== null && this.worldCreatedAt !== worldCreatedAt) {
            this.worldCreatedAt = worldCreatedAt;
            this.worldClockMinuteKey = '';
        }
    }

    loadCachedWorldDay() {
        try {
            const cached = Number(window.localStorage.getItem(this.worldDayCacheKey));
            // Ignore cached Day 1 to avoid sticky startup regressions from stale old logic.
            if (Number.isFinite(cached) && cached > 1) {
                this.cachedWorldDay = Math.floor(cached);
            }
        } catch (error) {
            // Ignore localStorage read failures (private mode, denied access, etc.).
        }
    }

    persistCachedWorldDay(day) {
        if (!Number.isFinite(day) || day < 1) return;
        const safeDay = Math.floor(day);
        this.cachedWorldDay = safeDay;
        try {
            window.localStorage.setItem(this.worldDayCacheKey, String(safeDay));
            window.localStorage.setItem(this.worldDayCacheTimestampKey, String(Date.now()));
        } catch (error) {
            // Ignore localStorage write failures.
        }
    }

    updateWorldClockLabel(force = false) {
        const now = Date.now();
        const minuteKey = Math.floor(now / 60_000);
        if (!force && minuteKey === this.worldClockMinuteKey) return;

        this.worldClockMinuteKey = minuteKey;
        if (!this.worldTimeState) {
            this.worldTimeState = this.deriveWorldTimeState();
        }
        if (this.worldTimeState) {
            this.applyWorldLighting(this.worldTimeState);
        }
        const hasWorldAnchor = Number.isFinite(this.worldCreatedAt) && this.worldCreatedAt > 0;
        const hasCachedDay = Number.isFinite(this.cachedWorldDay) && this.cachedWorldDay >= 1;
        const hasReliableDay = this.hasSyncedWorldDay || hasWorldAnchor || hasCachedDay;
        const dayValue = Number(this.worldTimeState?.day);
        const dayLabel = (hasReliableDay && Number.isFinite(dayValue) && dayValue >= 1)
            ? String(Math.floor(dayValue)).padStart(2, '0')
            : '--';
        const phase = String(this.worldTimeState?.dayPhase || 'day');
        const clockTime = this.formatVirtualTime(Number(this.worldTimeState?.timeHours));
        const label = `Day ${dayLabel} (${phase}) - ${clockTime}`;
        if (label === this.worldDayLabel) return;
        this.worldDayLabel = label;
        const el = document.getElementById('world-day-clock');
        if (el) el.textContent = label;
    }


    phaseFromHour(hour) {
        if (hour < 6) return 'night';
        if (hour < 12) return 'morning';
        if (hour < 18) return 'day';
        return 'dusk';
    }

    formatVirtualTime(timeHours) {
        if (!Number.isFinite(timeHours)) return '--:--';
        const normalizedHours = ((((timeHours % 24) + 24) % 24));
        const totalMinutes = Math.floor((normalizedHours * 60) + 1e-6) % (24 * 60);
        const hour24 = Math.floor(totalMinutes / 60);
        const minute = totalMinutes % 60;
        const ampm = hour24 >= 12 ? 'PM' : 'AM';
        const hour12 = (hour24 % 12) || 12;
        return `${String(hour12).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${ampm}`;
    }

    computeWorldTimeFromSync(nowMs = Date.now()) {
        if (!this.worldTimeSync) return null;
        const cycleSeconds = Number(this.worldTimeSync.cycleSeconds) || (24 * 60 * 60);
        const hoursPerSecond = 24 / cycleSeconds;
        const elapsedSinceSyncSec = Math.max(0, (nowMs - this.worldTimeSync.syncedAtMs) / 1000);
        const totalHours = this.worldTimeSync.baseTimeHours + (elapsedSinceSyncSec * hoursPerSecond);
        const dayAdvance = Math.floor(totalHours / 24);
        const wrappedHours = ((((totalHours % 24) + 24) % 24));
        const baseDay = Number(this.worldTimeSync.baseDay);
        const computedDay = Number.isFinite(baseDay) && baseDay >= 1
            ? Math.floor(baseDay) + Math.max(0, dayAdvance)
            : null;
        return {
            day: computedDay,
            cycleSeconds,
            timeHours: wrappedHours,
            dayProgress: wrappedHours / 24,
            dayPhase: this.phaseFromHour(wrappedHours),
            elapsedSeconds: wrappedHours * 60 * 60
        };
    }

    deriveWorldTimeState(data = {}) {
        const now = Date.now();
        if (data.worldTime && typeof data.worldTime === 'object') {
            const fromServer = data.worldTime;
            const serverCycle = Number(fromServer.cycleSeconds);
            const cycleSeconds = Number.isFinite(serverCycle) && serverCycle >= 60 ? serverCycle : (24 * 60 * 60);
            this.worldCycleSeconds = cycleSeconds;
            const serverHours = Number(fromServer.timeHours);
            const normalizedHours = Number.isFinite(serverHours) ? ((((serverHours % 24) + 24) % 24)) : 0;
            const serverDay = Number(fromServer.day);
            const hasValidServerDay = Number.isFinite(serverDay) && serverDay >= 1;
            const serverClockEpochMs = Number(fromServer.clockEpochMs);
            const referenceNowMs = Number.isFinite(serverClockEpochMs) && serverClockEpochMs > 0 ? serverClockEpochMs : now;
            const hasWorldAnchor = Number.isFinite(this.worldCreatedAt) && this.worldCreatedAt > 0;
            const anchorDay = hasWorldAnchor
                ? (Math.floor(Math.max(0, referenceNowMs - this.worldCreatedAt) / (cycleSeconds * 1000)) + 1)
                : null;
            const canonicalDay = Number.isFinite(anchorDay) && anchorDay >= 1
                ? anchorDay
                : (hasValidServerDay ? Math.floor(serverDay) : (Number.isFinite(this.cachedWorldDay) ? this.cachedWorldDay : null));

            if (hasValidServerDay) {
                this.hasSyncedWorldDay = true;
            }
            if (Number.isFinite(canonicalDay) && canonicalDay >= 1) {
                this.persistCachedWorldDay(canonicalDay);
            }
            this.worldTimeSync = {
                baseTimeHours: normalizedHours,
                baseDay: canonicalDay,
                cycleSeconds,
                syncedAtMs: now
            };
            return this.computeWorldTimeFromSync(now);
        }

        return this.computeWorldTimeFromSync(now);
    }

    applyWorldLighting(timeState, dtSeconds = 0) {
        if (!this.scene || !this.ambientLight || !this.directionalLight || !timeState) return;

        const hour = Number(timeState.timeHours);
        if (!Number.isFinite(hour)) return;
        const phase = String(timeState.dayPhase || this.phaseFromHour(hour) || 'day').toLowerCase();

        const sun = celestialPosition(hour, 0);
        const moon = celestialPosition(hour, 12);
        const sunStrength = clamp(sun.elevation, 0, 1);
        const moonStrength = clamp(moon.elevation, 0, 1);

        if (this.sunMesh) {
            this.sunMesh.position.set(sun.x, sun.y, sun.z);
            this.sunMesh.visible = sun.elevation > -0.22;
        }
        if (this.moonMesh) {
            this.moonMesh.position.set(moon.x, moon.y, moon.z);
            this.moonMesh.visible = moon.elevation > -0.3;
        }
        if (this.sunGlow) {
            this.sunGlow.position.set(sun.x, sun.y, sun.z);
            this.sunGlow.visible = sun.elevation > -0.22;
            this.sunGlow.material.opacity = 0.18 + (sunStrength * 0.8);
        }

        this.directionalLight.position.set(sun.x, Math.max(8, sun.y), sun.z);
        this._moonTargetVec.set(
            clamp(50 + ((50 - moon.x) * 0.42), 8, 92),
            GROUND_Y + 0.14,
            clamp(50 + ((50 - moon.z) * 0.42), 8, 92)
        );
        this._sunTargetVec.set(
            clamp(50 + ((50 - sun.x) * 0.35), 6, 94),
            GROUND_Y,
            clamp(50 + ((50 - sun.z) * 0.35), 6, 94)
        );
        this._moonPosVec.set(moon.x, moon.y, moon.z);
        this._sunPosVec.set(sun.x, sun.y, sun.z);

        if (this.moonLight) {
            this.moonLight.position.copy(this._moonPosVec);
            this.moonLight.target.position.copy(this._moonTargetVec);
        }
        if (this.moonDisc) this.moonDisc.position.set(this._moonTargetVec.x, 0.04, this._moonTargetVec.z);
        if (this.moonDiscCore) this.moonDiscCore.position.set(this._moonTargetVec.x, 0.055, this._moonTargetVec.z);
        if (this.moonBeam) positionBeamBetween(this.moonBeam, this._moonPosVec, this._moonTargetVec, 44);
        if (this.sunDisc) this.sunDisc.position.set(this._sunTargetVec.x, 0.05, this._sunTargetVec.z);
        if (this.sunDiscCore) this.sunDiscCore.position.set(this._sunTargetVec.x, 0.065, this._sunTargetVec.z);

        let skyHex = 0x77b5de;
        if (phase === 'night') {
            skyHex = 0x0b1a2e;
            this.ambientLight.intensity = 0.38 + (moonStrength * 0.35);
            this.directionalLight.intensity = 0.08 + (sunStrength * 0.25);
            if (this.sunGlow) this.sunGlow.material.opacity = 0.18;
            if (this.moonDisc) this.moonDisc.material.opacity = 0.18 + (moonStrength * 0.26);
            if (this.moonDiscCore) this.moonDiscCore.material.opacity = 0.08 + (moonStrength * 0.22);
            if (this.moonBeam) this.moonBeam.material.opacity = 0.04 + (moonStrength * 0.13);
            if (this.moonLight) this.moonLight.intensity = 1.2 + (moonStrength * 2.2);
            if (this.sunDisc) this.sunDisc.material.opacity = 0;
            if (this.sunDiscCore) this.sunDiscCore.material.opacity = 0;
        } else if (phase === 'dusk') {
            skyHex = 0x5c5470;
            this.ambientLight.intensity = 0.85 + (sunStrength * 0.75);
            this.directionalLight.intensity = 0.35 + (sunStrength * 0.75);
            if (this.sunGlow) this.sunGlow.material.opacity = 0.42 + (sunStrength * 0.2);
            if (this.moonDisc) this.moonDisc.material.opacity = 0.05 + (moonStrength * 0.16);
            if (this.moonDiscCore) this.moonDiscCore.material.opacity = 0.03 + (moonStrength * 0.09);
            if (this.moonBeam) this.moonBeam.material.opacity = 0.02 + (moonStrength * 0.06);
            if (this.moonLight) this.moonLight.intensity = moonStrength * 1.3;
            if (this.sunDisc) this.sunDisc.material.opacity = 0.08 + (sunStrength * 0.16);
            if (this.sunDiscCore) this.sunDiscCore.material.opacity = 0.05 + (sunStrength * 0.1);
        } else if (phase === 'morning') {
            skyHex = 0x6ba3d4;
            this.ambientLight.intensity = 1.8 + (sunStrength * 1.2);
            this.directionalLight.intensity = 0.65 + (sunStrength * 0.75);
            if (this.sunGlow) this.sunGlow.material.opacity = 0.7 + (sunStrength * 0.2);
            if (this.moonDisc) this.moonDisc.material.opacity = 0;
            if (this.moonDiscCore) this.moonDiscCore.material.opacity = 0;
            if (this.moonBeam) this.moonBeam.material.opacity = 0;
            if (this.moonLight) this.moonLight.intensity = 0;
            if (this.sunDisc) this.sunDisc.material.opacity = 0.15 + (sunStrength * 0.19);
            if (this.sunDiscCore) this.sunDiscCore.material.opacity = 0.09 + (sunStrength * 0.12);
        } else {
            skyHex = 0x77b5de;
            this.ambientLight.intensity = 2.4 + (sunStrength * 1.2);
            this.directionalLight.intensity = 0.8 + (sunStrength * 1.1);
            if (this.sunGlow) this.sunGlow.material.opacity = 0.82 + (sunStrength * 0.24);
            if (this.moonDisc) this.moonDisc.material.opacity = 0;
            if (this.moonDiscCore) this.moonDiscCore.material.opacity = 0;
            if (this.moonBeam) this.moonBeam.material.opacity = 0;
            if (this.moonLight) this.moonLight.intensity = 0;
            if (this.sunDisc) this.sunDisc.material.opacity = 0.24 + (sunStrength * 0.22);
            if (this.sunDiscCore) this.sunDiscCore.material.opacity = 0.14 + (sunStrength * 0.14);
        }

        this.scene.background.setHex(skyHex);
        if (this.scene.fog) this.scene.fog.color.setHex(skyHex);
        if (this.moonDisc) this.moonDisc.visible = this.moonDisc.material.opacity > 0.001;
        if (this.moonDiscCore) this.moonDiscCore.visible = this.moonDiscCore.material.opacity > 0.001;
        if (this.sunDisc) this.sunDisc.visible = this.sunDisc.material.opacity > 0.001;
        if (this.sunDiscCore) this.sunDiscCore.visible = this.sunDiscCore.material.opacity > 0.001;
        if (this.moonLight) this.moonLight.visible = this.moonLight.intensity > 0.01;
        if (this.moonBeam) {
            this.moonBeam.visible = this.camera.position.y >= (GROUND_Y - 0.05) && (!this.moonLight || this.moonLight.visible);
        }

        this.cloudUpdateAccumulator += dtSeconds;
        if (this.cloudUpdateAccumulator >= (1 / CLOUD_UPDATE_MAX_FPS)) {
            const cloudStep = this.cloudUpdateAccumulator;
            this.cloudUpdateAccumulator = 0;
            this.updateClouds(cloudStep, sunStrength);
        }
    }

    updateTickLabel() {
        const el = document.getElementById('uptime-display');
        if (!el) return;
        if (!Number.isFinite(this.worldTick)) {
            el.textContent = 'Waiting for data';
            return;
        }
        el.textContent = String(this.worldTick);
    }
    
    startUptimeTimer() {
        // Update uptime display every second locally (avoids waiting for server poll)
        setInterval(() => {
            this.updateWorldClockLabel();
            this.updateTickLabel();
        }, 1000);
    }

    /**
     * One-time call on page load: tells the server to check for unsummarized days.
     * The server handles locking so concurrent visitors don't trigger duplicate work.
     */
    async triggerSummarizationCheck() {
        if (this.summarizationTriggered) return;
        this.summarizationTriggered = true;

        try {
            const response = await fetch(`${this.apiBase}/activity-log/check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (response.ok) {
                const result = await response.json();
                console.log('[ActivityLog] Check result:', result.message);
                // If summarization was triggered, refresh the activity log
                // if the tab is currently being viewed
                // If summarization was queued, the polling in fetchActivityLog()
                // will automatically refresh once AI work completes.
            }
        } catch (err) {
            console.error('[ActivityLog] Summarization check error:', err);
        }
    }


    async triggerLeaderboardCheck() {
        if (this.leaderboardTriggered) return;
        this.leaderboardTriggered = true;

        try {
            await fetch(`${this.apiBase}/leaderboard/check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (err) {
            console.error('[Leaderboard] Trigger check error:', err);
        }
    }

    async fetchLeaderboard() {
        try {
            const response = await fetch(`${this.apiBase}/leaderboard/current?limit=10`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this._lastLeaderboard = data;
            return data;
        } catch (err) {
            console.error('[Leaderboard] Fetch error:', err);
            return null;
        }
    }

    async fetchWorldProgress(days = 7) {
        try {
            const response = await fetch(`${this.apiBase}/observer/telemetry/world-progress?days=${encodeURIComponent(days)}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this._lastWorldProgress = data;
            this.updateWorldMomentumHud();
            return data;
        } catch (err) {
            console.error('[WorldProgress] Fetch error:', err);
            return null;
        }
    }

    renderWorldProgressInto(container) {
        const data = this._lastWorldProgress;
        if (!data || data.success === false) return;

        const trend = Array.isArray(data.mapExpansionLevelTrend) ? data.mapExpansionLevelTrend : [];
        const trendText = trend.length > 0
            ? trend.slice(-7).map((row) => `${this.escapeHtml(String(row.date).slice(5))}:${Number(row.expansionCount || 0)}`).join(' · ')
            : 'No daily trend yet';
        const explorers = Array.isArray(data.topExplorers) ? data.topExplorers : [];
        const builders = Array.isArray(data.topBuilders) ? data.topBuilders : [];

        const panel = document.createElement('div');
        panel.className = 'activity-day';
        panel.innerHTML = `
            <div class="activity-day-header"><div><span class="activity-day-date">🌍 World Progress</span></div></div>
            <div class="activity-day-summary" style="font-size:11px;line-height:1.45;">
                <div>Expansion level: <strong>${Number(data.mapExpansionLevel || 0)}</strong> · Tiles: <strong>${Number(data.mapExpansionTiles || 0)}</strong></div>
                <div>Trend (MM-DD:expansions): ${trendText}</div>
                <div>Top explorers: ${explorers.slice(0, 3).map((r) => `${this.escapeHtml(r.entityId)} (${Number(r.uniqueGridCellsVisited || 0)})`).join(', ') || 'n/a'}</div>
                <div>Top builders: ${builders.slice(0, 3).map((r) => `${this.escapeHtml(r.entityId)} (${Number(r.expansionCount || 0)})`).join(', ') || 'n/a'}</div>
                <div>Idle-chat ratio: <strong>${(Number(data.idleChatRatio || 0) * 100).toFixed(1)}%</strong></div>
                <div>Objective action share: <strong>${(Number(data.objectiveActionShare || 0) * 100).toFixed(1)}%</strong> · Social pressure: <strong>${Number(data.socialOnlyPressure || 0).toFixed(3)}</strong></div>
                <div>Frontier gain/day: <strong>${Number(data.frontierGainPerDay || 0).toFixed(2)}</strong></div>
                <div>Rec follow-through: <strong>${(Number(data.recommendationEffectiveness?.followThroughRate || 0) * 100).toFixed(1)}%</strong> · Mission lift/FU: <strong>${Number(data.recommendationEffectiveness?.missionLiftPerFollowThrough || 0).toFixed(3)}</strong></div>
            </div>
        `;
        container.appendChild(panel);
    }

    renderLeaderboardInto(container) {
        const leaderboard = this._lastLeaderboard?.leaderboard || [];
        const seasonId = this._lastLeaderboard?.seasonId || 'N/A';
        if (!Array.isArray(leaderboard) || leaderboard.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'activity-no-data';
            empty.textContent = '🏁 Leaderboard is still warming up.';
            container.appendChild(empty);
            return;
        }

        const wrap = document.createElement('div');
        wrap.className = 'activity-day';
        wrap.innerHTML = `
            <div class="activity-day-header"><div><span class="activity-day-date">🏁 Current Leaderboard (${this.escapeHtml(seasonId)})</span></div></div>
            <div class="activity-day-summary">${leaderboard.map((row) => {
                const badges = Array.isArray(row.earnedBadges) ? row.earnedBadges.map((b) => `🏅${this.escapeHtml(b.badgeKey)}`).join(' ') : '';
                return `<div style="margin:4px 0;">#${Number(row.rank || 0)} <strong>${this.escapeHtml(row.entityName || row.entityId || 'unknown')}</strong> · score ${Number(row.score || 0)} · Lv ${Number(row.level || 1)} · XP ${Number(row.xp || 0)} <span style="opacity:.8">${badges}</span></div>`;
            }).join('')}</div>
        `;
        container.appendChild(wrap);
    }

    /**
     * Fetch activity log summaries from the server and render them.
     */
    async fetchActivityLog() {
        const container = document.getElementById('activity-log-content');
        if (!container) return;

        container.innerHTML = '<div class="activity-loading">⏳ Loading activity log...</div>';
        this.triggerLeaderboardCheck();

        try {
            const response = await fetch(`${this.apiBase}/activity-log?limit=14`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            this.activityLogFetched = true;

            if (!data.summaries || data.summaries.length === 0) {
                container.innerHTML = '<div class="activity-no-data">🧠 No activity summaries available yet.<br><span style="font-size:10px">Summaries are generated once a full day of activity completes.</span></div>';
                return;
            }

            this._lastActivitySummaries = data.summaries;
            await Promise.all([this.fetchLeaderboard(), this.fetchWorldProgress(7)]);
            this.renderActivityLog(data.summaries, container);

            // No client-side polling or auto-refresh. AI summaries are generated
            // server-side (triggered once per session). Users see "⏳ AI pending"
            // badges and get fresh data next time they switch back to this tab.
        } catch (err) {
            console.error('[ActivityLog] Fetch error:', err);
            container.innerHTML = '<div class="activity-no-data">⚠️ Could not load activity log.</div>';
        }
    }

    /**
     * Render activity summaries into the container.
     */
    renderActivityLog(summaries, container) {
        container.innerHTML = '';
        this.renderWorldProgressInto(container);
        this.renderLeaderboardInto(container);

        for (const summary of summaries) {
            const dayDiv = document.createElement('div');
            dayDiv.className = 'activity-day';

            // Parse date robustly — handle both "YYYY-MM-DD" and full ISO strings
            const raw = summary.date || '';
            const dateObj = raw.length > 10
                ? new Date(raw)                          // already a full ISO string
                : new Date(raw + 'T00:00:00Z');          // plain YYYY-MM-DD
            const dateStr = isNaN(dateObj.getTime())
                ? raw                                    // last-resort: show raw value
                : dateObj.toLocaleDateString(undefined, {
                    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
                  });

            // Day header (clickable to expand hourly details)
            const header = document.createElement('div');
            header.className = 'activity-day-header';

            const headerInfo = document.createElement('div');
            const dateSpan = document.createElement('span');
            dateSpan.className = 'activity-day-date';
            dateSpan.textContent = `📅 ${dateStr}`;
            const statsSpan = document.createElement('span');
            statsSpan.className = 'activity-day-stats';
            statsSpan.textContent = `💬 ${summary.chatCount} msgs · 🦞 ${summary.activeAgents} lobsters`;
            headerInfo.appendChild(dateSpan);
            headerInfo.appendChild(document.createTextNode(' '));
            headerInfo.appendChild(statsSpan);

            // Show a badge when AI summarization hasn't completed yet
            if (summary.aiCompleted === false) {
                const pendingBadge = document.createElement('span');
                pendingBadge.style.cssText = 'background:#4a3520;color:#ffcc66;font-size:9px;padding:1px 6px;border-radius:8px;margin-left:6px;';
                pendingBadge.textContent = '⏳ AI pending';
                headerInfo.appendChild(pendingBadge);
            }

            const toggleSpan = document.createElement('span');
            toggleSpan.className = 'activity-day-toggle';
            toggleSpan.textContent = '▶';

            header.appendChild(headerInfo);
            header.appendChild(toggleSpan);

            // Day summary — truncate at 250 chars with "... Read more ..."
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'activity-day-summary';
            const fullText = summary.dailySummary || '';
            const TRUNC_LIMIT = 250;
            if (fullText.length > TRUNC_LIMIT) {
                const truncated = fullText.slice(0, TRUNC_LIMIT).trimEnd();
                const textNode = document.createTextNode(truncated);
                const readMoreLink = document.createElement('span');
                readMoreLink.className = 'activity-read-more';
                readMoreLink.textContent = '... Read more ...';
                let expanded = false;
                readMoreLink.addEventListener('click', (e) => {
                    e.stopPropagation(); // don't trigger the day header toggle
                    expanded = !expanded;
                    if (expanded) {
                        textNode.textContent = fullText;
                        readMoreLink.textContent = ' Read less';
                    } else {
                        textNode.textContent = truncated;
                        readMoreLink.textContent = '... Read more ...';
                    }
                });
                summaryDiv.appendChild(textNode);
                summaryDiv.appendChild(readMoreLink);
            } else {
                summaryDiv.textContent = fullText;
            }

            // Hourly details (collapsed by default)
            const hoursDiv = document.createElement('div');
            hoursDiv.className = 'activity-hours';

            const hourlySummaries = summary.hourlySummaries || {};
            const sortedHours = Object.keys(hourlySummaries)
                .map(Number)
                .sort((a, b) => a - b);

            if (sortedHours.length > 0) {
                for (const hour of sortedHours) {
                    const hourDiv = document.createElement('div');
                    hourDiv.className = 'activity-hour';
                    const hourLabel = `${String(hour).padStart(2, '0')}:00`;
                    const labelSpan = document.createElement('span');
                    labelSpan.className = 'activity-hour-label';
                    labelSpan.textContent = `${hourLabel} UTC`;
                    hourDiv.appendChild(labelSpan);
                    hourDiv.appendChild(document.createTextNode(' ' + hourlySummaries[hour]));
                    hoursDiv.appendChild(hourDiv);
                }
            } else {
                const noDataDiv = document.createElement('div');
                noDataDiv.className = 'activity-hour';
                noDataDiv.style.cssText = 'color:#669999;font-style:italic;';
                noDataDiv.textContent = 'No hourly breakdown available';
                hoursDiv.appendChild(noDataDiv);
            }

            // Toggle hourly details on header click
            header.addEventListener('click', () => {
                hoursDiv.classList.toggle('expanded');
                const toggle = header.querySelector('.activity-day-toggle');
                toggle.textContent = hoursDiv.classList.contains('expanded') ? '▼' : '▶';
            });

            dayDiv.appendChild(header);
            dayDiv.appendChild(summaryDiv);
            dayDiv.appendChild(hoursDiv);
            container.appendChild(dayDiv);
        }
    }

    /**
     * Sync and open the maximize modal on a specific tab.
     */
    _syncMaximizeTab(tabName) {
        // Switch buttons
        document.querySelectorAll('#chat-maximize-content .chat-panel-tab').forEach(b => {
            const isTarget = b.dataset.tab === tabName;
            b.classList.toggle('active', isTarget);
            b.setAttribute('aria-selected', String(isTarget));
        });
        // Switch panels
        document.querySelectorAll('#chat-maximize-content .chat-tab-content').forEach(tc => {
            tc.classList.remove('active');
        });
        const target = document.getElementById(tabName + '-tab-max');
        if (target) target.classList.add('active');
        // Fill content
        if (tabName === 'activity-log') {
            this._renderActivityLogInto('activity-log-content-max');
        } else {
            this._mirrorChatMessages();
        }
    }

    /**
     * Copy chat messages into the maximize modal.
     */
    _mirrorChatMessages() {
        const src = document.getElementById('chat-messages');
        const dst = document.getElementById('chat-messages-max');
        if (!src || !dst) return;
        dst.innerHTML = src.innerHTML;
        dst.scrollTop = dst.scrollHeight;
    }

    /**
     * Render the cached activity log summaries into a given container id.
     */
    _renderActivityLogInto(containerId) {
        // Re-use fetchActivityLog data if already fetched, otherwise trigger fetch.
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!this._lastActivitySummaries) {
            container.innerHTML = '<div class="activity-loading">⏳ Loading activity log...</div>';
            this.fetchActivityLog().then(() => {
                if (this._lastActivitySummaries) {
                    this.renderActivityLog(this._lastActivitySummaries, container);
                }
            });
            return;
        }
        this.renderActivityLog(this._lastActivitySummaries, container);
    }

    updateAgentList() {
        const listEl = document.getElementById('agent-list');
        listEl.innerHTML = '';
        
        this.agents.forEach((agent, id) => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'agent-item';
            const idLabel = agent.data.numericId ? `#${agent.data.numericId} ` : '';
            const skillSummary = this.formatAgentSkillSummary(agent.data.skills);
            const energy = Number.isFinite(Number(agent.data.energy)) ? Math.round(Number(agent.data.energy)) : null;
            const energySummary = energy === null ? '' : ` · ⚡${energy}`;
            const sleepSummary = agent.data.sleeping ? ' · 😴sleeping' : '';
            const objectiveStreak = Math.max(0, Number(agent.data.objectiveStreak || 0));
            const objectiveSummary = objectiveStreak > 0 ? ` · 🎯${objectiveStreak}` : '';
            const lastMeaningful = typeof agent.data.lastMeaningfulAction === 'string' && agent.data.lastMeaningfulAction.trim()
                ? ` · last ${agent.data.lastMeaningfulAction.trim()}`
                : '';
            const objectiveGateSummary = agent.data.objectiveGateRequired ? ' · ⚠ objective required' : '';
            const summary = `🦞 ${idLabel}${agent.data.name} - ${agent.data.state}${energySummary}${sleepSummary}${skillSummary ? ` · ${skillSummary}` : ''}${objectiveSummary}${lastMeaningful}${objectiveGateSummary}`;
            const isSelected = this.followedAgentId === id;
            if (this.showAnimationDiagnosticsInAgentList && isSelected) {
                const anim = agent.animation || {};
                const animType = anim.animType || 'none';
                const baseYaw = Number(anim.baseYaw || 0).toFixed(2);
                const lastAction = agent.data?.lastAction?.type || anim.lastActionType || 'none';
                itemDiv.textContent = `${summary} [animType=${animType}, baseYaw=${baseYaw}, lastAction=${lastAction}]`;
            } else {
                itemDiv.textContent = summary;
            }
            itemDiv.style.cursor = 'pointer';
            itemDiv.addEventListener('click', () => this.zoomToAgent(id));
            listEl.appendChild(itemDiv);
        });
        this.updateExpansionHud();
    }

    formatAgentSkillSummary(skills) {
        if (!skills || typeof skills !== 'object') return '';
        const safeLevel = (value) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
        };

        const scout = safeLevel(skills.scout?.level);
        const forage = safeLevel(skills.forage?.level);
        const guard = safeLevel(skills.shellGuard?.level);
        const builder = safeLevel(skills.builder?.level);

        return `S${scout}/F${forage}/G${guard}/B${builder}`;
    }
    
    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        const nowMs = Date.now();
        const frameNow = performance.now();
        const dt = Math.min(0.1, Math.max(0, (frameNow - this.lastAnimationFrameMs) / 1000));
        this.lastAnimationFrameMs = frameNow;

        // Update keyboard movement
        this.updateKeyboardMovement();

        // Clean up expired chat bubbles
        this.updateChatBubbles();

        // Continuously follow the selected lobster
        if (this.followedAgentId) {
            const followed = this.agents.get(this.followedAgentId);
            if (followed) {
                const livePos = followed.mesh.position;
                // Softly glide the orbit target to the lobster's current position
                this.controls.target.lerp(livePos, 0.1);
                // Keep camera at a fixed offset above/behind the lobster
                const desiredCamPos = new THREE.Vector3(
                    livePos.x + this.followCameraOffset.x,
                    livePos.y + this.followCameraOffset.y,
                    livePos.z + this.followCameraOffset.z
                );
                this.camera.position.lerp(desiredCamPos, 0.1);
            } else {
                // Agent left the world — release follow
                this.followedAgentId = null;
                this.controls.enabled = true;
            }
        }

        this.agents.forEach((agent) => {
            this.updateAgentLocomotionFrame(agent, nowMs);
        });

        this.resolveAgentCollisions(nowMs);

        this.agents.forEach((agent) => {
            this.applyAgentAnimationFrame(agent, nowMs);
        });
        this.updateExpansionPulseEffects(frameNow);

        this.skyUpdateAccumulator += dt;
        if (this.skyUpdateAccumulator >= (1 / SKY_UPDATE_MAX_FPS)) {
            const skyStep = this.skyUpdateAccumulator;
            this.skyUpdateAccumulator = 0;
            const timeState = this.deriveWorldTimeState();
            if (timeState) {
                this.worldTimeState = timeState;
                this.applyWorldLighting(timeState, skyStep);
            }
        }

        if ((nowMs - this.lastThreatUpdateMs) >= (1000 / THREAT_UPDATE_MAX_FPS)) {
            this.lastThreatUpdateMs = nowMs;
            for (const record of this.threatMeshes.values()) {
                record.bobPhase += dt * 4.2;
                record.mesh.position.y = 0.6 + (Math.sin(record.bobPhase) * 0.08);
                record.mesh.rotation.y += dt * 0.85;
                record.mesh.children.forEach((child, idx) => {
                    if (!child.geometry || !(child.geometry.type || '').includes('CylinderGeometry')) return;
                    const phase = record.bobPhase + idx * 0.35;
                    child.rotation.x = (child.userData.baseRotationX || 0) + (Math.sin(phase) * 0.18);
                    child.rotation.z = (child.userData.baseRotationZ || 0) + (Math.cos(phase) * 0.18);
                });
                record.hpGroup.position.set(record.mesh.position.x, record.mesh.position.y + 2.4, record.mesh.position.z);
                record.hpGroup.lookAt(this.camera.position);
                record.hpGroup.visible = record.hpRatio > 0;
            }
        }

        this.updateCombatEffectsFrame(frameNow, dt);
        const hazardTimeSec = frameNow / 1000;
        for (const hazard of this.hazardVisuals.values()) {
            hazard.update(hazardTimeSec);
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

// Initialize the world when page loads
new OpenBotWorld();
