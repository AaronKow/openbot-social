import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { config } from './config.js';

class OpenBotWorld {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.agents = new Map(); // agentId -> { mesh, data }
        this.chatBubbles = new Map(); // agentId -> { bubble, createdAt }
        this.connected = false;
        this.pollInterval = config.pollInterval;
        this.lastChatTimestamp = 0;
        this.agentNameMap = new Map(); // agentName -> agentId
        this.serverStartTime = null; // Server start time for uptime
        this.totalEntitiesCreated = 0; // Total entities ever created
        this.followedAgentId = null; // Agent currently being followed by camera
        this.followedAgentInitialPos = null; // Initial position when started following
        
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
        
        // API URL configuration (priority order):
        // 1. Query parameter: ?server=https://your-api.com
        // 2. config.js defaultApiUrl (set via environment or manual edit)
        // 3. Fallback: '' (same-origin, for local development)
        const params = new URLSearchParams(window.location.search);
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
        this.startPolling();
        this.startUptimeTimer();
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
        this.camera.position.set(50, 50, -30);
        this.camera.lookAt(50, 0, 50);
        
        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        document.getElementById('canvas-container').appendChild(this.renderer.domElement);
        
        // Controls - completely free zoom
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(50, 0, 50);  // Center orbit around world center
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 0;  // No minimum distance
        this.controls.maxDistance = Infinity;  // No maximum distance
        
        // Lights
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
        
        // Ocean floor
        this.createOceanFloor();
        
        // Add some decorative elements
        this.addDecorations();
        
        // Handle window resize
        window.addEventListener('resize', () => this.onWindowResize());
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
        // Add some rocks
        for (let i = 0; i < 20; i++) {
            const rockGeometry = new THREE.DodecahedronGeometry(Math.random() * 2 + 0.5);
            const rockMaterial = new THREE.MeshStandardMaterial({
                color: 0x555555,
                roughness: 0.9
            });
            const rock = new THREE.Mesh(rockGeometry, rockMaterial);
            rock.position.set(
                Math.random() * 100,
                Math.random() * 0.5,
                Math.random() * 100
            );
            rock.rotation.set(
                Math.random() * Math.PI,
                Math.random() * Math.PI,
                Math.random() * Math.PI
            );
            rock.castShadow = true;
            rock.receiveShadow = true;
            this.scene.add(rock);
        }
        
        // Add some kelp/seaweed
        for (let i = 0; i < 15; i++) {
            const kelpGeometry = new THREE.CylinderGeometry(0.1, 0.2, Math.random() * 5 + 2);
            const kelpMaterial = new THREE.MeshStandardMaterial({
                color: 0x2d5016,
                roughness: 0.7
            });
            const kelp = new THREE.Mesh(kelpGeometry, kelpMaterial);
            kelp.position.set(
                Math.random() * 100,
                Math.random() * 2.5 + 1.25,
                Math.random() * 100
            );
            this.scene.add(kelp);
        }
    }
    
    createLobsterMesh(name) {
        // Lobster body - simplified representation
        const group = new THREE.Group();
        
        // Main body
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
        
        // Tail segments
        for (let i = 0; i < 3; i++) {
            const segmentGeometry = new THREE.BoxGeometry(0.4 - i * 0.05, 0.5 - i * 0.1, 0.3 - i * 0.05);
            const segment = new THREE.Mesh(segmentGeometry, bodyMaterial);
            segment.position.set(-0.7 - i * 0.45, 0, 0);
            segment.castShadow = true;
            group.add(segment);
        }
        
        // Claws
        const clawGeometry = new THREE.BoxGeometry(0.6, 0.2, 0.2);
        const leftClaw = new THREE.Mesh(clawGeometry, bodyMaterial);
        leftClaw.position.set(0.8, 0.4, 0);
        leftClaw.castShadow = true;
        group.add(leftClaw);
        
        const rightClaw = new THREE.Mesh(clawGeometry, bodyMaterial);
        rightClaw.position.set(0.8, -0.4, 0);
        rightClaw.castShadow = true;
        group.add(rightClaw);
        
        // Antennae
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
        
        // Chat panel minimize/close
        const chatToggle = document.getElementById('chat-toggle');
        const chatMessages = document.getElementById('chat-messages');
        chatToggle.addEventListener('click', () => {
            chatMessages.classList.toggle('hidden');
            chatToggle.textContent = chatMessages.classList.contains('hidden') ? '+' : '−';
        });
        
        // Controls panel close
        const controlsClose = document.getElementById('controls-close');
        const controlsPanel = document.getElementById('controls-panel');
        controlsClose.addEventListener('click', () => {
            controlsPanel.style.display = 'none';
        });
        
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
        const chatPanel = document.getElementById('chat-panel');
        
        document.getElementById('sidebar-status-btn').addEventListener('click', () => {
            statusPanel.style.display = statusPanel.style.display === 'none' ? 'block' : 'none';
        });
        
        document.getElementById('sidebar-chat-btn').addEventListener('click', () => {
            chatPanel.style.display = chatPanel.style.display === 'none' ? 'block' : 'none';
        });
        
        document.getElementById('sidebar-controls-btn').addEventListener('click', () => {
            controlsPanel.style.display = controlsPanel.style.display === 'none' ? 'block' : 'none';
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
    
    setupMouseControls() {
        let lastMouseX = 0;
        let lastMouseY = 0;
        
        document.addEventListener('mousedown', (event) => {
            this.isMouseDown = true;
            this.mouseDragStartX = event.clientX;
            this.mouseDragStartY = event.clientY;
            lastMouseX = event.clientX;
            lastMouseY = event.clientY;
        });
        
        document.addEventListener('mouseup', (event) => {
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
                    this.followedAgentId = null;
                    this.controls.enabled = true;
                }
            }
        });
        
        document.addEventListener('click', (event) => {
            // Calculate mouse position in normalized device coordinates
            const rect = this.renderer.domElement.getBoundingClientRect();
            this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            
            // Update the picking ray with the camera and mouse position
            this.raycaster.setFromCamera(this.mouse, this.camera);
            
            // Calculate objects intersecting the picking ray
            const agentMeshes = Array.from(this.agents.values()).map(agent => agent.mesh);
            const intersects = this.raycaster.intersectObjects(agentMeshes, true);
            
            if (intersects.length > 0) {
                // Find which agent was clicked
                const clickedMesh = intersects[0].object.parent; // Get the parent group (lobster)
                for (const [agentId, agent] of this.agents.entries()) {
                    if (agent.mesh === clickedMesh) {
                        this.zoomToAgent(agentId);
                        break;
                    }
                }
            }
        });
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
                this.followedAgentId = null;
                this.controls.enabled = true;
            }
        }
    }
    
    zoomToAgent(agentId) {
        const agent = this.agents.get(agentId);
        if (!agent) return;

        // Toggle follow: clicking the same lobster again releases the camera
        if (this.followedAgentId === agentId) {
            this.followedAgentId = null;
            this.controls.enabled = true;
            return;
        }

        this.followedAgentId = agentId;
        this.followedAgentInitialPos = this.camera.position.clone();
        this.controls.enabled = false; // Disable manual orbit while following

        const targetPos = agent.mesh.position.clone();

        // Animate fly-in
        const startPos = this.camera.position.clone();
        const startTarget = this.controls.target.clone();
        const startTime = Date.now();
        const duration = 1000;

        const animateMove = () => {
            if (this.followedAgentId !== agentId) return; // cancelled mid-flight
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeProgress = progress < 0.5
                ? 2 * progress * progress
                : -1 + (4 - 2 * progress) * progress;

            const livePos = this.agents.get(agentId)?.mesh.position;
            if (!livePos) return;

            const camTargetX = livePos.x + 10;
            const camTargetY = livePos.y + 8;
            const camTargetZ = livePos.z + 10;

            this.camera.position.x = startPos.x + (camTargetX - startPos.x) * easeProgress;
            this.camera.position.y = startPos.y + (camTargetY - startPos.y) * easeProgress;
            this.camera.position.z = startPos.z + (camTargetZ - startPos.z) * easeProgress;

            this.controls.target.lerp(livePos, easeProgress);

            if (progress < 1) {
                requestAnimationFrame(animateMove);
            }
        };

        animateMove();
    }
    
    startPolling() {
        // Initial connection test
        this.testConnection();
        
        // Start polling for world state
        setInterval(() => this.pollWorldState(), this.pollInterval);
        
        // Poll for chat messages slightly less frequently
        setInterval(() => this.pollChatMessages(), this.pollInterval * 2);
    }
    
    async testConnection() {
        try {
            const response = await fetch(`${this.apiBase}/status`);
            if (response.ok) {
                const data = await response.json();
                console.log('Connected to server');
                this.connected = true;
                // Update server info from status endpoint
                if (data.serverStartTime) this.serverStartTime = data.serverStartTime;
                if (data.totalEntitiesCreated !== undefined) this.totalEntitiesCreated = data.totalEntitiesCreated;
                if (data.uptimeMs !== undefined) {
                    document.getElementById('uptime-display').textContent = this.formatUptime(data.uptimeMs);
                }
                this.updateStatus();
            }
        } catch (error) {
            console.error('Connection error:', error);
            this.connected = false;
            this.updateStatus();
        }
    }
    
    async pollWorldState() {
        if (!this.connected) {
            await this.testConnection();
            return;
        }
        
        try {
            const response = await fetch(`${this.apiBase}/world-state`);
            if (response.ok) {
                const data = await response.json();
                this.handleWorldState(data);
            } else {
                this.connected = false;
                this.updateStatus();
            }
        } catch (error) {
            console.error('Poll error:', error);
            this.connected = false;
            this.updateStatus();
        }
    }
    
    async pollChatMessages() {
        if (!this.connected) return;
        
        try {
            const url = `${this.apiBase}/chat?since=${this.lastChatTimestamp}`;
            const response = await fetch(url);
            
            if (response.ok) {
                const data = await response.json();
                const messages = data.messages || [];
                
                messages.forEach(msg => {
                    if (msg.timestamp > this.lastChatTimestamp) {
                        this.lastChatTimestamp = msg.timestamp;
                        this.addChatMessage(msg);
                    }
                });
            }
        } catch (error) {
            console.error('Chat poll error:', error);
        }
    }
    
    handleMessage(message) {
        // This method is no longer used with HTTP polling
        // Keeping for potential compatibility
    }
    
    handleWorldState(data) {
        // Update uptime display
        if (data.uptimeMs !== undefined) {
            document.getElementById('uptime-display').textContent = this.formatUptime(data.uptimeMs);
        } else if (data.uptimeFormatted) {
            document.getElementById('uptime-display').textContent = data.uptimeFormatted;
        }
        
        if (data.serverStartTime) {
            this.serverStartTime = data.serverStartTime;
        }
        
        // Get current agent IDs from the server
        const serverAgentIds = new Set();
        data.agents.forEach(agent => {
            serverAgentIds.add(agent.id);
            
            if (this.agents.has(agent.id)) {
                // Update existing agent
                this.updateAgentPosition(agent.id, agent.position, agent.rotation);
                this.agents.get(agent.id).data = agent;
            } else {
                // Add new agent
                this.addAgent(agent);
            }
        });
        
        // Remove agents that are no longer on the server
        const localAgentIds = Array.from(this.agents.keys());
        localAgentIds.forEach(agentId => {
            if (!serverAgentIds.has(agentId)) {
                this.removeAgent(agentId);
            }
        });
        
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
        
        this.agents.set(agentData.id, {
            mesh: mesh,
            data: agentData
        });
        
        // Store agent name mapping for chat clicks
        this.agentNameMap.set(agentData.name, agentData.id);
        
        console.log('Agent joined:', agentData.name);
        this.updateAgentList();
    }
    
    removeAgent(agentId) {
        const agent = this.agents.get(agentId);
        if (agent) {
            this.scene.remove(agent.mesh);
            this.agents.delete(agentId);
            
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
            // Smooth interpolation - keep y fixed at floor level (0.5)
            agent.mesh.position.lerp(
                new THREE.Vector3(position.x, 0.5, position.z),
                0.3
            );
            if (rotation !== undefined) {
                agent.mesh.rotation.y = rotation;
            }
            agent.data.position = position;
        }
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
        agentNameSpan.style.cursor = 'pointer';
        agentNameSpan.addEventListener('click', () => this.zoomToAgent(message.agentId));

        messageDiv.appendChild(timeSpan);
        messageDiv.appendChild(agentNameSpan);
        messageDiv.appendChild(document.createTextNode(`: ${message.message}`));
        return messageDiv;
    }

    addChatMessage(message) {
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
        this.showChatBubble(message.agentId, message.message);
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
    
    updateChatBubbles() {
        const now = Date.now();
        const bubbleTimeout = 5000; // 5 seconds
        
        for (const [agentId, data] of this.chatBubbles.entries()) {
            if (now - data.createdAt > bubbleTimeout) {
                const agent = this.agents.get(agentId);
                if (agent) {
                    agent.mesh.remove(data.bubble);
                }
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
        const totalEl = document.getElementById('total-entities');
        if (totalEl && this.totalEntitiesCreated > 0) {
            totalEl.textContent = this.totalEntitiesCreated;
        }
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
    
    startUptimeTimer() {
        // Update uptime display every second locally (avoids waiting for server poll)
        setInterval(() => {
            if (this.serverStartTime && this.connected) {
                const uptimeMs = Date.now() - this.serverStartTime;
                document.getElementById('uptime-display').textContent = this.formatUptime(uptimeMs);
            }
        }, 1000);
    }
    
    updateAgentList() {
        const listEl = document.getElementById('agent-list');
        listEl.innerHTML = '';
        
        this.agents.forEach((agent, id) => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'agent-item';
            const idLabel = agent.data.numericId ? `#${agent.data.numericId} ` : '';
            itemDiv.textContent = `🦞 ${idLabel}${agent.data.name} - ${agent.data.state}`;
            itemDiv.style.cursor = 'pointer';
            itemDiv.addEventListener('click', () => this.zoomToAgent(id));
            listEl.appendChild(itemDiv);
        });
    }
    
    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());

        // Update keyboard movement
        this.updateKeyboardMovement();

        // Continuously follow the selected lobster
        if (this.followedAgentId) {
            const followed = this.agents.get(this.followedAgentId);
            if (followed) {
                const livePos = followed.mesh.position;
                // Softly glide the orbit target to the lobster's current position
                this.controls.target.lerp(livePos, 0.1);
                // Keep camera at a fixed offset above/behind the lobster
                const desiredCamPos = new THREE.Vector3(
                    livePos.x + 10,
                    livePos.y + 8,
                    livePos.z + 10
                );
                this.camera.position.lerp(desiredCamPos, 0.1);
            } else {
                // Agent left the world — release follow
                this.followedAgentId = null;
                this.controls.enabled = true;
            }
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

// Initialize the world when page loads
new OpenBotWorld();
