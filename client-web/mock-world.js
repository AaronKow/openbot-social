import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const WORLD_SIZE = 100;
const HALF_WORLD = WORLD_SIZE / 2;
const FIXED_STEP_SECONDS = 1 / 60;
const GROUND_Y = 0;
const LOBSTER_COLLISION_RADIUS = 1.2;

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
        this.seed = params.get('seed') || 'openbot-mock-default';
        this.rng = createSeededRng(this.seed);

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.clock = new THREE.Clock();
        this.accumulator = 0;
        this.simulationTime = 0;
        this.lobsters = [];

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
        for (let i = 0; i < 10; i += 1) {
            const rock = new THREE.Mesh(
                new THREE.DodecahedronGeometry(this.randomRange(0.5, 1.6)),
                new THREE.MeshStandardMaterial({ color: 0x575757, roughness: 0.9 })
            );
            rock.position.set(this.randomRange(0, WORLD_SIZE), this.randomRange(0, 0.4), this.randomRange(0, WORLD_SIZE));
            rock.rotation.set(this.randomRange(0, Math.PI), this.randomRange(0, Math.PI), this.randomRange(0, Math.PI));
            rock.castShadow = true;
            rock.receiveShadow = true;
            this.scene.add(rock);
        }

        for (let i = 0; i < 10; i += 1) {
            const height = this.randomRange(2, 6);
            const kelp = new THREE.Mesh(
                new THREE.CylinderGeometry(0.1, 0.2, height),
                new THREE.MeshStandardMaterial({ color: 0x2d5016, roughness: 0.7 })
            );
            kelp.position.set(this.randomRange(0, WORLD_SIZE), height / 2, this.randomRange(0, WORLD_SIZE));
            this.scene.add(kelp);
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
        const lobsterSpecs = [
            { id: 'mock-lobster-1', name: 'Coral', start: new THREE.Vector3(25, 0, 25) },
            { id: 'mock-lobster-2', name: 'Current', start: new THREE.Vector3(75, 0, 75) }
        ];

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

        if (lobster.cooldowns.move <= now) options.push({ type: 'move', weight: 0.58 });
        if (lobster.cooldowns.jump <= now) options.push({ type: 'jump', weight: 0.18 });
        if (lobster.cooldowns.emote <= now) options.push({ type: 'emote', weight: 0.14 });
        if (lobster.cooldowns.dance <= now) options.push({ type: 'dance', weight: 0.10 });

        if (!options.length) return 'move';

        const total = options.reduce((sum, opt) => sum + opt.weight, 0);
        let pick = this.rng() * total;
        for (const opt of options) {
            pick -= opt.weight;
            if (pick <= 0) return opt.type;
        }
        return options[options.length - 1].type;
    }

    scheduleAction(lobster, action) {
        const now = this.simulationTime;
        lobster.currentAction = action;

        if (action === 'move') {
            lobster.target.set(this.randomRange(5, 95), 0, this.randomRange(5, 95));
            lobster.cooldowns.move = now + this.randomRange(0.6, 1.5);
            lobster.nextDecisionAt = now + this.randomRange(0.8, 1.7);
            this.setLabel(lobster, `${lobster.name} · move`);
            return;
        }

        if (action === 'jump') {
            lobster.target.set(lobster.mesh.position.x, 0, lobster.mesh.position.z);
            lobster.jumpActive = true;
            lobster.jumpPhase = 0;
            lobster.cooldowns.jump = now + this.randomRange(3.6, 5.2);
            lobster.nextDecisionAt = now + this.randomRange(0.7, 1.4);
            this.setLabel(lobster, `${lobster.name} · jump`);
            return;
        }

        if (action === 'emote') {
            lobster.target.set(lobster.mesh.position.x, 0, lobster.mesh.position.z);
            lobster.emoteTimeLeft = this.randomRange(0.7, 1.4);
            lobster.cooldowns.emote = now + this.randomRange(4.2, 6.5);
            lobster.nextDecisionAt = now + this.randomRange(1.2, 1.8);
            const emotes = ['💬', '🫧', '✨', '🦞'];
            this.setLabel(lobster, `${lobster.name} · emote ${emotes[Math.floor(this.rng() * emotes.length)]}`);
            return;
        }

        lobster.target.set(lobster.mesh.position.x, 0, lobster.mesh.position.z);
        lobster.danceTimeLeft = this.randomRange(1.6, 2.8);
        lobster.danceDirection = this.rng() > 0.5 ? 1 : -1;
        lobster.cooldowns.dance = now + this.randomRange(6.2, 9.0);
        lobster.nextDecisionAt = now + this.randomRange(1.6, 2.2);
        this.setLabel(lobster, `${lobster.name} · dance`);
    }

    clampToWorld(position) {
        position.x = Math.max(0, Math.min(WORLD_SIZE, position.x));
        position.z = Math.max(0, Math.min(WORLD_SIZE, position.z));
    }

    shortestAngleDelta(from, to) {
        return Math.atan2(Math.sin(to - from), Math.cos(to - from));
    }

    updateLobster(lobster, dt) {
        if (this.simulationTime >= lobster.nextDecisionAt) {
            const action = this.chooseWeightedAction(lobster);
            this.scheduleAction(lobster, action);
        }

        const mesh = lobster.mesh;
        const flatPos = new THREE.Vector3(mesh.position.x, 0, mesh.position.z);
        const direction = lobster.target.clone().sub(flatPos);
        const distance = direction.length();

        if (distance > 0.12) {
            direction.normalize();
            const targetYaw = Math.atan2(direction.z, direction.x);
            const yawDelta = this.shortestAngleDelta(mesh.rotation.y, targetYaw);

            // Rotate toward target with shortest-angle turn.
            const maxTurnRate = 5.0; // rad/s
            const maxTurnThisTick = maxTurnRate * dt;
            const clampedTurn = THREE.MathUtils.clamp(yawDelta, -maxTurnThisTick, maxTurnThisTick);
            mesh.rotation.y += clampedTurn;

            // Translate only during "move" so other actions don't produce side/tail drift.
            if (lobster.currentAction === 'move') {
                const headingError = Math.abs(this.shortestAngleDelta(mesh.rotation.y, targetYaw));
                const forwardMoveThreshold = THREE.MathUtils.degToRad(12);
                if (headingError <= forwardMoveThreshold) {
                    const alignmentScale = THREE.MathUtils.clamp(1 - headingError / forwardMoveThreshold, 0.25, 1);
                    const moveStep = lobster.speed * dt * alignmentScale;
                    const forwardX = Math.cos(mesh.rotation.y);
                    const forwardZ = Math.sin(mesh.rotation.y);
                    mesh.position.x += forwardX * moveStep;
                    mesh.position.z += forwardZ * moveStep;
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
        this.clampToWorld(mesh.position);

        if (mesh.position.x <= 0 + 0.2 || mesh.position.x >= WORLD_SIZE - 0.2 || mesh.position.z <= 0 + 0.2 || mesh.position.z >= WORLD_SIZE - 0.2) {
            lobster.target.set(this.randomRange(10, 90), 0, this.randomRange(10, 90));
        }
    }


    keepLobsterAboveGround(lobster) {
        const minAllowedY = Math.max(lobster.baseY, GROUND_Y);
        lobster.mesh.position.y = Math.max(lobster.mesh.position.y, minAllowedY);
    }


    alignHeadingToVelocity(lobster, dt) {
        const previous = lobster.previousPosition;
        if (!previous) return;

        const vx = lobster.mesh.position.x - previous.x;
        const vz = lobster.mesh.position.z - previous.z;
        const speedSq = vx * vx + vz * vz;
        if (speedSq < 1e-7) return;

        const velocityYaw = Math.atan2(vz, vx);
        const yawDelta = this.shortestAngleDelta(lobster.mesh.rotation.y, velocityYaw);
        const maxAlignRate = 9.0; // rad/s, faster than steering so visible motion always head-first
        const maxAlignThisTick = maxAlignRate * dt;
        lobster.mesh.rotation.y += THREE.MathUtils.clamp(yawDelta, -maxAlignThisTick, maxAlignThisTick);
    }

    resolveLobsterCollisions() {
        for (let i = 0; i < this.lobsters.length; i += 1) {
            const a = this.lobsters[i];
            for (let j = i + 1; j < this.lobsters.length; j += 1) {
                const b = this.lobsters[j];
                const dx = b.mesh.position.x - a.mesh.position.x;
                const dz = b.mesh.position.z - a.mesh.position.z;
                const distSq = dx * dx + dz * dz;
                const minDist = a.collisionRadius + b.collisionRadius;
                if (distSq >= minDist * minDist) continue;

                const dist = Math.max(Math.sqrt(distSq), 0.0001);
                const overlap = minDist - dist;
                const nx = dx / dist;
                const nz = dz / dist;
                const push = overlap * 0.5;

                a.mesh.position.x -= nx * push;
                a.mesh.position.z -= nz * push;
                b.mesh.position.x += nx * push;
                b.mesh.position.z += nz * push;

                this.clampToWorld(a.mesh.position);
                this.clampToWorld(b.mesh.position);
            }
        }
    }

    tick(dt) {
        this.simulationTime += dt;
        for (const lobster of this.lobsters) {
            lobster.previousPosition = {
                x: lobster.mesh.position.x,
                z: lobster.mesh.position.z
            };
            this.updateLobster(lobster, dt);
        }
        this.resolveLobsterCollisions();
        for (const lobster of this.lobsters) {
            this.alignHeadingToVelocity(lobster, dt);
        }
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
            <div><strong>Entities:</strong> 2 fake lobsters</div>
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
