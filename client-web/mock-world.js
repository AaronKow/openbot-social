import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const WORLD_SIZE = 100;
const HALF_WORLD = WORLD_SIZE / 2;
const FIXED_STEP_SECONDS = 1 / 60;
const GROUND_Y = 0;
const LOBSTER_COLLISION_RADIUS = 1.2;
const MAP_EDGE_BUFFER = LOBSTER_COLLISION_RADIUS + 0.35;
const WORLD_MARGIN = 8;
const MOVE_MIN_DISTANCE = 10;
const MOVE_MAX_DISTANCE = 22;
const COLLISION_PUSH_BUFFER = 0.35;
const ESCAPE_MOVE_DISTANCE = 14;
const TOTAL_MOCK_LOBSTERS = 2;
const MOVE_ARRIVAL_THRESHOLD = 0.12;
const MOVE_STUCK_TIMEOUT = 1.0;
const MOVE_PROGRESS_EPSILON = 0.04;
const HEAD_THRUST_ALIGNMENT_THRESHOLD = THREE.MathUtils.degToRad(2);

function createSeededRng(seedText) {
    const text = String(seedText || 'openbot-mock-default');
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i += 1) {
        h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return function nextRandom() {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
    };
}

class OfflineMockWorld {
    constructor() {
        const params = new URLSearchParams(window.location.search);
        this.seed = params.get('seed') || `openbot-mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.rng = createSeededRng(this.seed);

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.clock = new THREE.Clock();
        this.accumulator = 0;
        this.simulationTime = 0;
        this.lobsters = [];
        this.rocks = [];
        this.obstacles = [];

        this.metaEl = document.getElementById('mock-meta');

        this.initScene();
        this.createLobsters();
        this.updateMeta();
        window.addEventListener('resize', () => this.onResize());
        this.animate();
    }

    initScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x6ba3d4);
        this.scene.fog = new THREE.Fog(0x6ba3d4, 50, 200);

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(50, 50, -20);
        this.camera.lookAt(50, 0, 50);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        document.getElementById('canvas-container').appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(50, 0, 50);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 5;
        this.controls.maxDistance = 180;

        const ambientLight = new THREE.AmbientLight(0xffffff, 3.5);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
        directionalLight.position.set(50, 100, 50);
        directionalLight.castShadow = true;
        directionalLight.shadow.camera.left = -100;
        directionalLight.shadow.camera.right = 100;
        directionalLight.shadow.camera.top = 100;
        directionalLight.shadow.camera.bottom = -100;
        this.scene.add(directionalLight);

        const floorGeometry = new THREE.BoxGeometry(WORLD_SIZE, 3, WORLD_SIZE);
        const floorMaterial = new THREE.MeshStandardMaterial({
            color: 0xc2b280,
            roughness: 0.8,
            metalness: 0.2,
            side: THREE.DoubleSide
        });
        const floor = new THREE.Mesh(floorGeometry, floorMaterial);
        floor.position.set(50, -1.5, 50);
        floor.receiveShadow = true;
        this.scene.add(floor);

        this.addDecorations();
    }

    addDecorations() {
        this.rocks = [];
        this.obstacles = [];
        const spawnZones = [
            { x: 25, z: 25 },
            { x: 75, z: 75 }
        ];

        const isNearSpawnZone = (x, z, radius, extraClearance = 4) => (
            spawnZones.some((spawn) => {
                const dx = x - spawn.x;
                const dz = z - spawn.z;
                const minDistance = radius + LOBSTER_COLLISION_RADIUS + extraClearance;
                return (dx * dx) + (dz * dz) < minDistance * minDistance;
            })
        );

        for (let i = 0; i < 10; i += 1) {
            const radius = this.randomRange(0.8, 2.0);
            const rock = new THREE.Mesh(
                new THREE.DodecahedronGeometry(radius),
                new THREE.MeshStandardMaterial({ color: 0x575757, roughness: 0.9 })
            );
            let rockX = this.randomRange(WORLD_MARGIN, WORLD_SIZE - WORLD_MARGIN);
            let rockZ = this.randomRange(WORLD_MARGIN, WORLD_SIZE - WORLD_MARGIN);
            for (let attempt = 0; attempt < 8 && isNearSpawnZone(rockX, rockZ, radius + 0.45); attempt += 1) {
                rockX = this.randomRange(WORLD_MARGIN, WORLD_SIZE - WORLD_MARGIN);
                rockZ = this.randomRange(WORLD_MARGIN, WORLD_SIZE - WORLD_MARGIN);
            }
            rock.position.set(rockX, this.randomRange(0, 0.4), rockZ);
            rock.rotation.set(this.randomRange(0, Math.PI), this.randomRange(0, Math.PI), this.randomRange(0, Math.PI));
            rock.castShadow = true;
            rock.receiveShadow = true;
            this.scene.add(rock);
            this.rocks.push({
                x: rockX,
                z: rockZ,
                radius: radius + 0.45
            });
            this.obstacles.push({
                x: rockX,
                z: rockZ,
                radius: radius + 0.45
            });
        }

        for (let i = 0; i < 10; i += 1) {
            const height = this.randomRange(2, 6);
            let kelpX = this.randomRange(WORLD_MARGIN, WORLD_SIZE - WORLD_MARGIN);
            let kelpZ = this.randomRange(WORLD_MARGIN, WORLD_SIZE - WORLD_MARGIN);
            for (let attempt = 0; attempt < 8 && isNearSpawnZone(kelpX, kelpZ, 0.9, 3); attempt += 1) {
                kelpX = this.randomRange(WORLD_MARGIN, WORLD_SIZE - WORLD_MARGIN);
                kelpZ = this.randomRange(WORLD_MARGIN, WORLD_SIZE - WORLD_MARGIN);
            }
            const kelp = new THREE.Mesh(
                new THREE.CylinderGeometry(0.1, 0.2, height),
                new THREE.MeshStandardMaterial({ color: 0x2d5016, roughness: 0.7 })
            );
            kelp.position.set(kelpX, height / 2, kelpZ);
            this.scene.add(kelp);
            this.obstacles.push({
                x: kelpX,
                z: kelpZ,
                radius: 0.9
            });
        }
    }

    createLobsterMesh() {
        // Match production lobster model from client-web/client.js
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


    measureLobsterPhysics(mesh) {
        mesh.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(mesh);
        const baseY = Math.max(0.01, GROUND_Y - bounds.min.y + 0.02);
        return {
            baseY,
            collisionRadius: LOBSTER_COLLISION_RADIUS
        };
    }

    createLobsters() {
        const seedPreview = this.seed;
        const namePool = [
            'Coral', 'Current', 'Tide', 'Pebble', 'Drift', 'Brine',
            'Kelp', 'Spritz', 'Foam', 'Ripple', 'Barnacle', 'Marina'
        ];
        const chosenStarts = [];
        const lobsterSpecs = Array.from({ length: TOTAL_MOCK_LOBSTERS }, (_, index) => {
            const start = this.findSafeSpawnPosition(chosenStarts);
            chosenStarts.push(start.clone());
            return {
                id: `mock-lobster-${index + 1}`,
                name: namePool[index] || `Lobster ${index + 1}`,
                start
            };
        });

        this.lobsters = lobsterSpecs.map((spec, index) => {
            const mesh = this.createLobsterMesh();
            mesh.position.copy(spec.start);
            mesh.rotation.y = this.randomRange(0, Math.PI * 2);
            const physics = this.measureLobsterPhysics(mesh);
            mesh.position.y = physics.baseY;
            this.scene.add(mesh);

            const label = this.makeLabelSprite(`${spec.name} · idle`);
            label.position.set(0, 1.8, 0);
            mesh.add(label);

            return {
                ...spec,
                mesh,
                label,
                labelText: `${spec.name} · idle`,
                target: new THREE.Vector3(spec.start.x, 0, spec.start.z),
                speed: this.randomRange(2.2, 2.8),
                baseY: physics.baseY,
                collisionRadius: physics.collisionRadius,
                jumpActive: false,
                jumpPhase: 0,
                danceTimeLeft: 0,
                danceDirection: 1,
                emoteTimeLeft: 0,
                currentAction: 'idle',
                movePhase: 'idle',
                travelYaw: mesh.rotation.y,
                moveEndAt: 0,
                stuckTime: 0,
                lastProgressX: mesh.position.x,
                lastProgressZ: mesh.position.z,
                nextDecisionAt: index * 0.8,
                cooldowns: {
                    move: 0,
                    jump: this.randomRange(1.5, 2.2),
                    emote: this.randomRange(2.5, 4.0),
                    dance: this.randomRange(4.5, 6.5)
                }
            };
        });

        console.log(`Offline mock initialized. Seed=${seedPreview}`);
    }

    findSafeSpawnPosition(existingStarts) {
        for (let attempt = 0; attempt < 24; attempt += 1) {
            const x = this.randomRange(WORLD_MARGIN + 4, WORLD_SIZE - WORLD_MARGIN - 4);
            const z = this.randomRange(WORLD_MARGIN + 4, WORLD_SIZE - WORLD_MARGIN - 4);

            const blockedByObstacle = this.obstacles.some((obstacle) => {
                const dx = x - obstacle.x;
                const dz = z - obstacle.z;
                const minDistance = obstacle.radius + LOBSTER_COLLISION_RADIUS + 2.5;
                return (dx * dx) + (dz * dz) < minDistance * minDistance;
            });
            if (blockedByObstacle) continue;

            const blockedByLobster = existingStarts.some((start) => {
                const dx = x - start.x;
                const dz = z - start.z;
                const minDistance = (LOBSTER_COLLISION_RADIUS * 4);
                return (dx * dx) + (dz * dz) < minDistance * minDistance;
            });
            if (blockedByLobster) continue;

            return new THREE.Vector3(x, 0, z);
        }

        return new THREE.Vector3(
            this.randomRange(WORLD_MARGIN + 4, WORLD_SIZE - WORLD_MARGIN - 4),
            0,
            this.randomRange(WORLD_MARGIN + 4, WORLD_SIZE - WORLD_MARGIN - 4)
        );
    }

    makeLabelSprite(text) {
        const canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 84;
        const context = canvas.getContext('2d');

        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = 'rgba(0, 20, 40, 0.88)';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = '#00ffcc';
        context.lineWidth = 4;
        context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
        context.fillStyle = '#ffffff';
        context.font = 'bold 28px Arial';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, canvas.width / 2, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(8, 1.9, 1);
        return sprite;
    }

    setLabel(lobster, text) {
        if (lobster.labelText === text) return;
        lobster.labelText = text;
        const sprite = this.makeLabelSprite(text);
        lobster.mesh.remove(lobster.label);
        lobster.label.material.map.dispose();
        lobster.label.material.dispose();
        lobster.label = sprite;
        sprite.position.set(0, 1.8, 0);
        lobster.mesh.add(sprite);
    }

    chooseWeightedAction(lobster) {
        const now = this.simulationTime;
        const options = [];

        if (lobster.cooldowns.move <= now) options.push('move');
        if (lobster.cooldowns.jump <= now) options.push('jump');
        if (lobster.cooldowns.emote <= now) options.push('emote');
        if (lobster.cooldowns.dance <= now) options.push('dance');

        if (!options.length) return 'move';

        const index = Math.floor(this.rng() * options.length);
        return options[index];
    }

    scheduleAction(lobster, action) {
        const now = this.simulationTime;
        lobster.currentAction = action;

        if (action === 'move') {
            this.startRandomMove(lobster);
            lobster.cooldowns.move = now + this.randomRange(0.8, 1.8);
            lobster.nextDecisionAt = Number.POSITIVE_INFINITY;
            this.setLabel(lobster, `${lobster.name} · move`);
            return;
        }

        if (action === 'jump') {
            lobster.target.set(lobster.mesh.position.x, 0, lobster.mesh.position.z);
            lobster.jumpActive = true;
            lobster.jumpPhase = 0;
            lobster.movePhase = 'idle';
            lobster.moveEndAt = 0;
            lobster.cooldowns.jump = now + this.randomRange(3.6, 5.2);
            lobster.nextDecisionAt = now + this.randomRange(0.7, 1.4);
            this.setLabel(lobster, `${lobster.name} · jump`);
            return;
        }

        if (action === 'emote') {
            lobster.target.set(lobster.mesh.position.x, 0, lobster.mesh.position.z);
            lobster.emoteTimeLeft = this.randomRange(0.7, 1.4);
            lobster.movePhase = 'idle';
            lobster.moveEndAt = 0;
            lobster.cooldowns.emote = now + this.randomRange(4.2, 6.5);
            lobster.nextDecisionAt = now + this.randomRange(1.2, 1.8);
            const emotes = ['💬', '🫧', '✨', '🦞'];
            this.setLabel(lobster, `${lobster.name} · emote ${emotes[Math.floor(this.rng() * emotes.length)]}`);
            return;
        }

        lobster.target.set(lobster.mesh.position.x, 0, lobster.mesh.position.z);
        lobster.danceTimeLeft = this.randomRange(1.6, 2.8);
        lobster.danceDirection = this.rng() > 0.5 ? 1 : -1;
        lobster.movePhase = 'idle';
        lobster.moveEndAt = 0;
        lobster.cooldowns.dance = now + this.randomRange(6.2, 9.0);
        lobster.nextDecisionAt = now + this.randomRange(1.6, 2.2);
        this.setLabel(lobster, `${lobster.name} · dance`);
    }

    clampToWorld(position) {
        position.x = Math.max(0, Math.min(WORLD_SIZE, position.x));
        position.z = Math.max(0, Math.min(WORLD_SIZE, position.z));
    }

    clampToPlayableArea(position) {
        position.x = THREE.MathUtils.clamp(position.x, MAP_EDGE_BUFFER, WORLD_SIZE - MAP_EDGE_BUFFER);
        position.z = THREE.MathUtils.clamp(position.z, MAP_EDGE_BUFFER, WORLD_SIZE - MAP_EDGE_BUFFER);
    }

    shortestAngleDelta(from, to) {
        return Math.atan2(Math.sin(to - from), Math.cos(to - from));
    }

    assignMoveTarget(lobster, x, z) {
        lobster.target.set(x, 0, z);
        this.clampToPlayableArea(lobster.target);

        const dx = lobster.target.x - lobster.mesh.position.x;
        const dz = lobster.target.z - lobster.mesh.position.z;
        lobster.travelYaw = Math.atan2(dz, dx);
        lobster.movePhase = 'turn';
    }

    findSafeMoveTarget(originX, originZ, preferredYaw = null) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const distance = this.randomRange(MOVE_MIN_DISTANCE, MOVE_MAX_DISTANCE);
            const baseYaw = preferredYaw ?? this.randomRange(0, Math.PI * 2);
            const yawOffset = preferredYaw === null ? 0 : this.randomRange(-0.8, 0.8);
            const yaw = baseYaw + yawOffset;
            const targetX = THREE.MathUtils.clamp(
                originX + Math.cos(yaw) * distance,
                MAP_EDGE_BUFFER,
                WORLD_SIZE - MAP_EDGE_BUFFER
            );
            const targetZ = THREE.MathUtils.clamp(
                originZ + Math.sin(yaw) * distance,
                MAP_EDGE_BUFFER,
                WORLD_SIZE - MAP_EDGE_BUFFER
            );

            const blocked = this.obstacles.some((obstacle) => {
                const dx = targetX - obstacle.x;
                const dz = targetZ - obstacle.z;
                const minDistance = obstacle.radius + LOBSTER_COLLISION_RADIUS + 0.4;
                return (dx * dx) + (dz * dz) < minDistance * minDistance;
            });

            if (!blocked) {
                return { x: targetX, z: targetZ };
            }
        }

        return {
            x: THREE.MathUtils.clamp(originX, MAP_EDGE_BUFFER, WORLD_SIZE - MAP_EDGE_BUFFER),
            z: THREE.MathUtils.clamp(originZ, MAP_EDGE_BUFFER, WORLD_SIZE - MAP_EDGE_BUFFER)
        };
    }

    startRandomMove(lobster) {
        const safeTarget = this.findSafeMoveTarget(lobster.mesh.position.x, lobster.mesh.position.z);
        const targetX = safeTarget.x;
        const targetZ = safeTarget.z;

        this.assignMoveTarget(lobster, targetX, targetZ);
        const travelDistance = Math.hypot(targetX - lobster.mesh.position.x, targetZ - lobster.mesh.position.z);
        lobster.moveEndAt = this.simulationTime + (travelDistance / lobster.speed) + 1.0;
        lobster.stuckTime = 0;
        lobster.lastProgressX = lobster.mesh.position.x;
        lobster.lastProgressZ = lobster.mesh.position.z;
    }

    redirectLobsterFromCollision(lobster, awayX, awayZ) {
        const magnitude = Math.hypot(awayX, awayZ);
        if (magnitude < 1e-5) return;

        const nx = awayX / magnitude;
        const nz = awayZ / magnitude;
        let safeTarget = {
            x: lobster.mesh.position.x + (nx * ESCAPE_MOVE_DISTANCE),
            z: lobster.mesh.position.z + (nz * ESCAPE_MOVE_DISTANCE)
        };
        this.clampToPlayableArea(safeTarget);

        const blocked = this.obstacles.some((obstacle) => {
            const dx = safeTarget.x - obstacle.x;
            const dz = safeTarget.z - obstacle.z;
            const minDistance = obstacle.radius + LOBSTER_COLLISION_RADIUS + 0.4;
            return (dx * dx) + (dz * dz) < minDistance * minDistance;
        });

        if (blocked) {
            safeTarget = this.findSafeMoveTarget(
                lobster.mesh.position.x,
                lobster.mesh.position.z,
                Math.atan2(nz, nx)
            );
        }

        lobster.currentAction = 'move';
        lobster.jumpActive = false;
        lobster.jumpPhase = 0;
        lobster.emoteTimeLeft = 0;
        lobster.danceTimeLeft = 0;
        this.assignMoveTarget(lobster, safeTarget.x, safeTarget.z);
        const travelDistance = Math.hypot(safeTarget.x - lobster.mesh.position.x, safeTarget.z - lobster.mesh.position.z);
        const newMoveEndAt = this.simulationTime + (travelDistance / lobster.speed) + 1.2;
        lobster.moveEndAt = lobster.moveEndAt > this.simulationTime
            ? Math.min(lobster.moveEndAt, newMoveEndAt)
            : newMoveEndAt;
        lobster.stuckTime = 0;
        lobster.lastProgressX = lobster.mesh.position.x;
        lobster.lastProgressZ = lobster.mesh.position.z;
        lobster.nextDecisionAt = Number.POSITIVE_INFINITY;
        this.setLabel(lobster, `${lobster.name} · move`);
    }

    finishMove(lobster, delayMin = 0.2, delayMax = 0.6) {
        lobster.currentAction = 'idle';
        lobster.movePhase = 'idle';
        lobster.moveEndAt = 0;
        lobster.stuckTime = 0;
        lobster.nextDecisionAt = this.simulationTime + this.randomRange(delayMin, delayMax);
        this.setLabel(lobster, `${lobster.name} · idle`);
    }

    resolveEnvironmentCollisions(lobster) {
        const mesh = lobster.mesh;
        const minBound = lobster.collisionRadius;
        const maxBound = WORLD_SIZE - lobster.collisionRadius;
        let escapeX = 0;
        let escapeZ = 0;
        let collided = false;
        let hitMapEdge = false;

        if (mesh.position.x < MAP_EDGE_BUFFER) {
            escapeX += 1;
            mesh.position.x = MAP_EDGE_BUFFER;
            collided = true;
            hitMapEdge = true;
        } else if (mesh.position.x > WORLD_SIZE - MAP_EDGE_BUFFER) {
            escapeX -= 1;
            mesh.position.x = WORLD_SIZE - MAP_EDGE_BUFFER;
            collided = true;
            hitMapEdge = true;
        }

        if (mesh.position.z < MAP_EDGE_BUFFER) {
            escapeZ += 1;
            mesh.position.z = MAP_EDGE_BUFFER;
            collided = true;
            hitMapEdge = true;
        } else if (mesh.position.z > WORLD_SIZE - MAP_EDGE_BUFFER) {
            escapeZ -= 1;
            mesh.position.z = WORLD_SIZE - MAP_EDGE_BUFFER;
            collided = true;
            hitMapEdge = true;
        }

        for (const obstacle of this.obstacles) {
            const dx = mesh.position.x - obstacle.x;
            const dz = mesh.position.z - obstacle.z;
            const minDistance = lobster.collisionRadius + obstacle.radius;
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

        if (collided) {
            if (hitMapEdge) {
                this.clampToPlayableArea(mesh.position);
            } else {
                mesh.position.x = THREE.MathUtils.clamp(mesh.position.x, minBound, maxBound);
                mesh.position.z = THREE.MathUtils.clamp(mesh.position.z, minBound, maxBound);
            }
            this.redirectLobsterFromCollision(lobster, escapeX, escapeZ);
        }

        return collided;
    }

    resolveLobsterCollisions() {
        for (let i = 0; i < this.lobsters.length; i += 1) {
            const a = this.lobsters[i];
            for (let j = i + 1; j < this.lobsters.length; j += 1) {
                const b = this.lobsters[j];
                const dx = b.mesh.position.x - a.mesh.position.x;
                const dz = b.mesh.position.z - a.mesh.position.z;
                const minDistance = a.collisionRadius + b.collisionRadius;
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

                this.redirectLobsterFromCollision(a, -nx, -nz);
                this.redirectLobsterFromCollision(b, nx, nz);
            }
        }
    }

    updateLobster(lobster, dt) {
        if (this.simulationTime >= lobster.nextDecisionAt) {
            const action = this.chooseWeightedAction(lobster);
            this.scheduleAction(lobster, action);
        }

        const mesh = lobster.mesh;
        const dx = lobster.target.x - mesh.position.x;
        const dz = lobster.target.z - mesh.position.z;
        const distance = Math.hypot(dx, dz);

        if (lobster.currentAction === 'move') {
            if (distance <= MOVE_ARRIVAL_THRESHOLD || this.simulationTime >= lobster.moveEndAt) {
                this.finishMove(lobster);
            } else {
                const maxTurnRate = 5.0; // rad/s
                const maxTurnThisTick = maxTurnRate * dt;
                const yawDelta = this.shortestAngleDelta(mesh.rotation.y, lobster.travelYaw);
                const headingError = Math.abs(yawDelta);

                if (lobster.movePhase !== 'thrust') {
                    mesh.rotation.y += THREE.MathUtils.clamp(yawDelta, -maxTurnThisTick, maxTurnThisTick);

                    if (headingError <= HEAD_THRUST_ALIGNMENT_THRESHOLD) {
                        mesh.rotation.y = lobster.travelYaw;
                        lobster.movePhase = 'thrust';
                    }
                } else if (headingError > HEAD_THRUST_ALIGNMENT_THRESHOLD) {
                    lobster.movePhase = 'turn';
                } else {
                    const moveStep = Math.min(distance, lobster.speed * dt);
                    const forward = new THREE.Vector3(1, 0, 0).applyEuler(mesh.rotation).normalize();
                    mesh.position.x += forward.x * moveStep;
                    mesh.position.z += forward.z * moveStep;
                }

                const progressDx = mesh.position.x - lobster.lastProgressX;
                const progressDz = mesh.position.z - lobster.lastProgressZ;
                const progressDistance = Math.hypot(progressDx, progressDz);

                if (progressDistance >= MOVE_PROGRESS_EPSILON) {
                    lobster.stuckTime = 0;
                    lobster.lastProgressX = mesh.position.x;
                    lobster.lastProgressZ = mesh.position.z;
                } else if (lobster.movePhase === 'thrust') {
                    lobster.stuckTime += dt;
                    if (lobster.stuckTime >= MOVE_STUCK_TIMEOUT) {
                        this.finishMove(lobster, 0.05, 0.2);
                    }
                }
            }
        }

        if (lobster.jumpActive) {
            lobster.jumpPhase += dt * 6.5;
            mesh.position.y = lobster.baseY + Math.max(0, Math.sin(lobster.jumpPhase) * 1.25);
            if (lobster.jumpPhase >= Math.PI) {
                lobster.jumpActive = false;
                mesh.position.y = lobster.baseY;
                if (lobster.currentAction === 'jump') {
                    lobster.currentAction = 'idle';
                    this.setLabel(lobster, `${lobster.name} · idle`);
                }
            }
        }

        if (lobster.emoteTimeLeft > 0) {
            lobster.emoteTimeLeft -= dt;
            if (lobster.emoteTimeLeft <= 0 && lobster.currentAction === 'emote') {
                lobster.currentAction = 'idle';
                this.setLabel(lobster, `${lobster.name} · idle`);
            }
        }

        if (lobster.danceTimeLeft > 0) {
            lobster.danceTimeLeft -= dt;
            if (lobster.danceTimeLeft <= 0 && lobster.currentAction === 'dance') {
                lobster.currentAction = 'idle';
                this.setLabel(lobster, `${lobster.name} · idle`);
            }
        }

        this.keepLobsterAboveGround(lobster);
        this.resolveEnvironmentCollisions(lobster);

        if (
            lobster.currentAction === 'move'
            && (mesh.position.x <= 0 + 0.2 || mesh.position.x >= WORLD_SIZE - 0.2 || mesh.position.z <= 0 + 0.2 || mesh.position.z >= WORLD_SIZE - 0.2)
        ) {
            this.finishMove(lobster, 0.05, 0.2);
        }
    }


    keepLobsterAboveGround(lobster) {
        const minAllowedY = Math.max(lobster.baseY, GROUND_Y);
        lobster.mesh.position.y = Math.max(lobster.mesh.position.y, minAllowedY);
    }


    tick(dt) {
        this.simulationTime += dt;
        for (const lobster of this.lobsters) {
            this.updateLobster(lobster, dt);
        }
        this.resolveLobsterCollisions();
    }

    animate() {
        const frameDelta = Math.min(0.1, this.clock.getDelta());
        this.accumulator += frameDelta;

        while (this.accumulator >= FIXED_STEP_SECONDS) {
            this.tick(FIXED_STEP_SECONDS);
            this.accumulator -= FIXED_STEP_SECONDS;
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.updateMeta();
        requestAnimationFrame(() => this.animate());
    }

    updateMeta() {
        const rows = this.lobsters
            .map((lobster) => `${lobster.id} (${lobster.name}) → <code>${lobster.currentAction}</code>`)
            .join('<br>');

        this.metaEl.innerHTML = `
            <div><strong>Seed:</strong> <code>${this.seed}</code></div>
            <div><strong>Bounds:</strong> ${WORLD_SIZE}×${WORLD_SIZE}</div>
            <div><strong>Entities:</strong> ${this.lobsters.length} fake lobsters</div>
            <div style="margin-top: 6px;">${rows}</div>
        `;
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    randomRange(min, max) {
        return min + (max - min) * this.rng();
    }
}

new OfflineMockWorld();
