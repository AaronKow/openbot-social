import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

class OpenBotWorld {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.agents = new Map(); // agentId -> { mesh, data }
        this.chatBubbles = new Map(); // agentId -> { bubble, createdAt }
        this.connected = false;
        this.pollInterval = 500; // Poll every 500ms
        this.lastChatTimestamp = 0;
        // Use ?server= query parameter to point to a remote backend, or fallback to same-origin /api
        const params = new URLSearchParams(window.location.search);
        const serverUrl = params.get('server') || '';
        if (serverUrl && /^https?:\/\/.+/.test(serverUrl)) {
            this.apiBase = `${serverUrl.replace(/\/+$/, '')}/api`;
        } else {
            this.apiBase = '/api';
        }
        
        this.init();
        this.startPolling();
        this.animate();
    }
    
    init() {
        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x6ba3d4);
        this.scene.fog = new THREE.Fog(0x6ba3d4, 50, 200);
        
        // Camera
        this.camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        this.camera.position.set(50, 30, 50);
        this.camera.lookAt(50, 0, 50);
        
        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        document.getElementById('canvas-container').appendChild(this.renderer.domElement);
        
        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 0.1;
        this.controls.maxDistance = 500;
        
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
        // Sand floor - smooth and even
        const floorGeometry = new THREE.PlaneGeometry(100, 100);
        const floorMaterial = new THREE.MeshStandardMaterial({
            color: 0xc2b280,
            roughness: 0.8,
            metalness: 0.2
        });
        
        const floor = new THREE.Mesh(floorGeometry, floorMaterial);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(50, 0, 50);
        floor.receiveShadow = true;
        this.scene.add(floor);
        
        // Grid helper for reference
        const gridHelper = new THREE.GridHelper(100, 20, 0x00ffcc, 0x006666);
        gridHelper.position.set(50, 0.1, 50);
        this.scene.add(gridHelper);
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
    
    startPolling() {
        // Initial connection test
        this.testConnection();
        
        // Start polling for world state
        setInterval(() => this.pollWorldState(), this.pollInterval);
        
        // Poll for chat messages slightly less frequently
        setInterval(() => this.pollChatMessages(), this.pollInterval * 2);
        
        // Update chat bubbles
        setInterval(() => this.updateChatBubbles(), 100);
    }
    
    async testConnection() {
        try {
            const response = await fetch(`${this.apiBase}/ping`);
            if (response.ok) {
                console.log('Connected to server');
                this.connected = true;
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
        // Update tick count
        if (data.tick) {
            document.getElementById('tick-count').textContent = data.tick;
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
        
        console.log('Agent joined:', agentData.name);
        this.updateAgentList();
    }
    
    removeAgent(agentId) {
        const agent = this.agents.get(agentId);
        if (agent) {
            this.scene.remove(agent.mesh);
            this.agents.delete(agentId);
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
    
    addChatMessage(message) {
        const chatDiv = document.getElementById('chat-messages');
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';
        messageDiv.textContent = `${message.agentName}: ${message.message}`;
        chatDiv.appendChild(messageDiv);
        
        // Keep only last 20 messages
        while (chatDiv.children.length > 20) {
            chatDiv.removeChild(chatDiv.firstChild);
        }
        
        // Scroll to bottom
        chatDiv.scrollTop = chatDiv.scrollHeight;
        
        // Show chat bubble above lobster
        this.showChatBubble(message.agentId, message.message);
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
        context.fillStyle = 'rgba(0, 0, 0, 0.8)';
        context.beginPath();
        context.roundRect(20, 20, 472, 180, 15);
        context.fill();
        
        // Text
        context.font = 'Bold 28px Arial';
        context.fillStyle = '#ffff00';
        context.textAlign = 'center';
        
        // Wrap text
        const maxWidth = 450;
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
        
        const lineHeight = 40;
        const startY = 60;
        lines.forEach((line, index) => {
            context.fillText(line, 256, startY + index * lineHeight);
        });
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture });
        const bubble = new THREE.Sprite(material);
        bubble.position.set(0, 3.5, 0);
        bubble.scale.set(6, 3, 1);
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
        statusEl.textContent = this.connected ? 'Connected' : 'Disconnected';
        statusEl.className = this.connected ? 'status-connected' : 'status-disconnected';
        
        document.getElementById('agent-count').textContent = this.agents.size;
    }
    
    updateAgentList() {
        const listEl = document.getElementById('agent-list');
        listEl.innerHTML = '';
        
        this.agents.forEach((agent, id) => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'agent-item';
            itemDiv.textContent = `🦞 ${agent.data.name} - ${agent.data.state}`;
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
        
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

// Initialize the world when page loads
new OpenBotWorld();
