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
        this.worldTick = null; // Last successfully applied world tick
        this.worldDeltaEnabled = false; // Switch to incremental polling after first full sync
        this.lastChatTimestamp = 0;
        this.agentNameMap = new Map(); // agentName -> agentId
        this.serverStartTime = null; // World clock anchor (worldCreatedAt preferred, serverStartTime fallback)
        this.totalEntitiesCreated = 0; // Total entities ever created
        this.followedAgentId = null; // Agent currently being followed by camera
        this.followedAgentInitialPos = null; // Initial position when started following
        this.activityLogFetched = false; // Whether the activity log has been loaded for this tab visit
        this.summarizationTriggered = false; // Whether we've sent the one-time check this session
        
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
        this.timelineFilter = 'all';
        this.wikiAvatarRenderers = [];
        this.lastWorldUpdateAt = null;
        this.worldDayLabel = '';
        this.worldClockMinuteKey = '';
        this.utcClockFormatter = new Intl.DateTimeFormat('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: 'UTC'
        });
        
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
    
    createLobsterModel() {
        // Lobster body - simplified representation
        const group = new THREE.Group();

        const frontRig = new THREE.Group();
        frontRig.name = 'frontRig';
        group.add(frontRig);
        
        // Main body
        const bodyGeometry = new THREE.CapsuleGeometry(0.3, 1.2, 8, 16);
        const bodyMaterial = new THREE.MeshStandardMaterial({
            color: 0xff4444,
            roughness: 0.5,
            metalness: 0.3
        });
        const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
        body.name = 'lobsterBody';
        body.rotation.z = Math.PI / 2;
        body.castShadow = true;
        group.add(body);

        // Front rig keeps all face-facing parts under one orientation parent.
        const frontRig = new THREE.Group();
        frontRig.name = 'frontRig';
        frontRig.position.set(0.8, 0, 0);
        group.add(frontRig);

        // Dedicated head at the front of the body.
        const headGeometry = new THREE.SphereGeometry(0.22, 12, 12);
        const head = new THREE.Mesh(headGeometry, bodyMaterial);
        head.name = 'head';
        head.castShadow = true;
        frontRig.add(head);
        
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
        leftClaw.name = 'leftClaw';
        leftClaw.position.set(0.28, 0.4, 0);
        leftClaw.castShadow = true;
        frontRig.add(leftClaw);
        
        const rightClaw = new THREE.Mesh(clawGeometry, bodyMaterial);
        rightClaw.name = 'rightClaw';
        rightClaw.position.set(0.28, -0.4, 0);
        rightClaw.castShadow = true;
        frontRig.add(rightClaw);
        
        // Antennae
        const antennaGeometry = new THREE.CylinderGeometry(0.02, 0.02, 0.8);
        const antennaMaterial = new THREE.MeshStandardMaterial({ color: 0xcc3333 });
        const leftAntenna = new THREE.Mesh(antennaGeometry, antennaMaterial);
        leftAntenna.name = 'leftAntenna';
        leftAntenna.position.set(0.25, 0.15, 0.2);
        leftAntenna.rotation.z = Math.PI / 6;
        frontRig.add(leftAntenna);
        
        const rightAntenna = new THREE.Mesh(antennaGeometry, antennaMaterial);
        rightAntenna.name = 'rightAntenna';
        rightAntenna.position.set(0.25, -0.15, 0.2);
        rightAntenna.rotation.z = -Math.PI / 6;
        frontRig.add(rightAntenna);
        
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
        if (window.matchMedia('(max-width: 768px)').matches && controlsPanel) {
            controlsPanel.style.display = 'none';
        }
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

    async openWikiForEntity(entityId) {
        if (!entityId) return;

        const modal = document.getElementById('lobster-wiki-modal');
        if (!modal) return;
        modal.classList.add('visible');
        this.renderWikiLoading();

        try {
            let wiki = null;
            const cached = this.wikiCache.get(entityId);
            if (cached && (Date.now() - cached.ts) < this.wikiCacheTtlMs) {
                wiki = cached.data;
            } else {
                const response = await fetch(`${this.apiBase}/entity/${encodeURIComponent(entityId)}/wiki-public`);
                if (!response.ok) {
                    throw new Error(`Failed to load wiki (${response.status})`);
                }
                const data = await response.json();
                wiki = data.wiki;
                this.wikiCache.set(entityId, { ts: Date.now(), data: wiki });
            }
            this.currentWiki = wiki;
            this.currentWikiEntityId = entityId;
            this.timelineFilter = 'all';
            this.renderWiki(wiki);
        } catch (error) {
            console.error('Wiki fetch error:', error);
            this.renderWikiError('Could not load lobster details right now.');
        }
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

    renderWiki(wiki) {
        this.cleanupWikiAvatarRenderers();
        const body = document.getElementById('lobster-wiki-body');
        const title = document.getElementById('wiki-title-text');
        const status = document.getElementById('wiki-status-badge');
        if (!body || !wiki) return;

        const identity = wiki.identity || {};
        const currentState = wiki.currentState || {};
        const cognition = wiki.cognition || {};
        const social = wiki.social || {};
        const relationships = Array.isArray(social.relationships) ? social.relationships : [];
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
        const safeState = this.escapeHtml(currentState.state || 'unknown');
        const safeAgentId = this.escapeHtml(currentState.agentId || 'N/A');
        const safeLastAction = this.escapeHtml(currentState.lastAction?.type || 'N/A');
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
                </div>
            </section>

            <section class="wiki-section">
                <h3>Current State</h3>
                <div class="wiki-grid">
                    <div><span class="wiki-key">Online:</span>${currentState.online ? 'Yes' : 'No'}</div>
                    <div><span class="wiki-key">State:</span>${safeState}</div>
                    <div><span class="wiki-key">Agent ID:</span>${safeAgentId}</div>
                    <div><span class="wiki-key">Last Action:</span>${safeLastAction}</div>
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

        const backBtn = document.getElementById('wiki-back-directory');
        if (backBtn) backBtn.addEventListener('click', () => this.openWikiDirectory());

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
    
    zoomToAgent(agentId) {
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
                if (data.uptimeMs !== undefined || data.uptimeFormatted) {
                    this.lastWorldUpdateAt = Date.now();
                    this.updateLastUpdateLabel();
                }
                this.updateWorldClockLabel();
                this.updateStatus();
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
        this.lastWorldUpdateAt = Date.now();
        this.updateLastUpdateLabel();

        this.updateWorldClockAnchorFromPayload(data);
        this.updateWorldClockLabel();
        if (data.totalEntitiesCreated !== undefined) {
            this.totalEntitiesCreated = data.totalEntitiesCreated;
        }

        const payloadTick = Number.isFinite(Number(data.tick)) ? Number(data.tick) : null;
        if (payloadTick !== null) {
            this.worldTick = payloadTick;
        }

        const isDeltaPayload = data.isDelta === true;
        const deltaWindowMissed = data.deltaWindowMissed === true;
        const agents = Array.isArray(data.agents) ? data.agents : [];

        if (isDeltaPayload && !deltaWindowMissed) {
            agents.forEach(agent => {
                if (this.agents.has(agent.id)) {
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
            dancePhase: Math.random() * Math.PI * 2,
            baseYaw: agentData.rotation || 0,
            lastActionType: null,
            lastState: null,
            modelParts: {
                body: mesh.children[0] || null,
                frontRig: mesh.getObjectByName('frontRig') || null,
                leftClaw: null,
                rightClaw: null,
                leftAntenna: null,
                rightAntenna: null
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
        
        this.agents.set(agentData.id, {
            mesh: mesh,
            data: agentData,
            animation
        });

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
            // Smooth interpolation on x/z only, preserving temporary animated y offsets.
            agent.mesh.position.x += (position.x - agent.mesh.position.x) * 0.3;
            agent.mesh.position.z += (position.z - agent.mesh.position.z) * 0.3;
            const anim = agent.animation;
            if (rotation !== undefined) {
                if (anim) {
                    anim.baseYaw = rotation;
                }
                agent.mesh.rotation.y = rotation;
            }
            if (anim) {
                anim.baseY = 0.5;
            }
            agent.data.position = position;
        }
    }

    resolveAnimationType(agentData) {
        const actionType = String(agentData?.lastAction?.type || '').toLowerCase();
        const state = String(agentData?.state || '').toLowerCase();
        const combined = `${actionType} ${state}`;

        if (/jump|hop|leap/.test(combined)) return 'jump';
        if (/dance|dancing|groove|boogie/.test(combined)) return 'dance';
        if (/emote|wave|cheer|signal|pose|react/.test(combined)) return 'emote';
        return null;
    }

    getAnimationDurationMs(animType) {
        if (animType === 'jump') return 700;
        if (animType === 'dance') return 2200;
        if (animType === 'emote') return 900;
        return 0;
    }

    updateAgentAnimationState(agentId, agentData) {
        const agent = this.agents.get(agentId);
        if (!agent?.animation) return;

        const anim = agent.animation;
        const nextAnimType = this.resolveAnimationType(agentData);
        const nextActionType = agentData?.lastAction?.type || null;
        const nextState = agentData?.state || null;

        const actionChanged = nextActionType !== anim.lastActionType;
        const stateChanged = nextState !== anim.lastState;
        anim.lastActionType = nextActionType;
        anim.lastState = nextState;

        if (!nextAnimType) {
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
            }
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

        if (worldCreatedAt !== null) {
            if (this.serverStartTime !== worldCreatedAt) {
                this.serverStartTime = worldCreatedAt;
                this.worldClockMinuteKey = '';
            }
            return;
        }

        if (this.serverStartTime === null && serverStartTime !== null) {
            this.serverStartTime = serverStartTime;
            this.worldClockMinuteKey = '';
        }
    }

    updateWorldClockLabel() {
        if (!this.serverStartTime) return;
        const now = Date.now();
        const minuteKey = Math.floor(now / 60_000);
        if (minuteKey === this.worldClockMinuteKey) return;

        this.worldClockMinuteKey = minuteKey;
        const elapsedMs = Math.max(0, now - this.serverStartTime);
        const day = Math.floor(elapsedMs / 86_400_000) + 1;
        const utcTime = this.utcClockFormatter.format(new Date(now));
        const label = `Day ${String(day).padStart(2, '0')} - ${utcTime}`;
        if (label === this.worldDayLabel) return;
        this.worldDayLabel = label;
        const el = document.getElementById('world-day-clock');
        if (el) el.textContent = label;
    }

    updateLastUpdateLabel() {
        const el = document.getElementById('uptime-display');
        if (!el) return;
        if (!this.lastWorldUpdateAt) {
            el.textContent = 'Waiting for data';
            return;
        }
        el.textContent = this.formatRelativeTimeAgo(Date.now() - this.lastWorldUpdateAt);
    }
    
    startUptimeTimer() {
        // Update uptime display every second locally (avoids waiting for server poll)
        setInterval(() => {
            this.updateWorldClockLabel();
            this.updateLastUpdateLabel();
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

    /**
     * Fetch activity log summaries from the server and render them.
     */
    async fetchActivityLog() {
        const container = document.getElementById('activity-log-content');
        if (!container) return;

        container.innerHTML = '<div class="activity-loading">⏳ Loading activity log...</div>';

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
        const nowMs = Date.now();

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

        this.agents.forEach((agent) => {
            this.applyAgentAnimationFrame(agent, nowMs);
        });

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

// Initialize the world when page loads
new OpenBotWorld();
