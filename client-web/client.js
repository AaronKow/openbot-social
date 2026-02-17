import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

class OpenBotWorld {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.agents = new Map(); // agentId -> { mesh, data }
        this.ws = null;
        this.connected = false;
        
        this.init();
        this.connectWebSocket();
        this.animate();
    }
    
    init() {
        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x001a33);
        this.scene.fog = new THREE.Fog(0x001a33, 50, 200);
        
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
        this.controls.minDistance = 10;
        this.controls.maxDistance = 150;
        this.controls.maxPolarAngle = Math.PI / 2 - 0.1;
        
        // Lights
        const ambientLight = new THREE.AmbientLight(0x404040, 2);
        this.scene.add(ambientLight);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
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
        // Sand floor
        const floorGeometry = new THREE.PlaneGeometry(100, 100, 50, 50);
        const floorMaterial = new THREE.MeshStandardMaterial({
            color: 0xc2b280,
            roughness: 0.8,
            metalness: 0.2
        });
        
        // Add some height variation
        const positionAttribute = floorGeometry.attributes.position;
        for (let i = 0; i < positionAttribute.count; i++) {
            const z = Math.random() * 0.5;
            positionAttribute.setZ(i, z);
        }
        positionAttribute.needsUpdate = true;
        floorGeometry.computeVertexNormals();
        
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
        
        // Name label
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
        label.position.set(0, 0, 2);
        label.scale.set(4, 1, 1);
        group.add(label);
        
        return group;
    }
    
    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        console.log('Connecting to:', wsUrl);
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            console.log('Connected to server');
            this.connected = true;
            this.updateStatus();
        };
        
        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
        };
        
        this.ws.onclose = () => {
            console.log('Disconnected from server');
            this.connected = false;
            this.updateStatus();
            
            // Reconnect after 3 seconds
            setTimeout(() => this.connectWebSocket(), 3000);
        };
        
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }
    
    handleMessage(message) {
        switch (message.type) {
            case 'world_state':
                this.handleWorldState(message);
                break;
                
            case 'agent_joined':
                this.addAgent(message.agent);
                break;
                
            case 'agent_left':
                this.removeAgent(message.agentId);
                break;
                
            case 'agent_moved':
                this.updateAgentPosition(message.agentId, message.position, message.rotation);
                break;
                
            case 'chat_message':
                this.addChatMessage(message);
                break;
                
            case 'agent_action':
                console.log('Agent action:', message.agentId, message.action);
                break;
                
            case 'pong':
                // Handle ping response
                break;
                
            default:
                console.log('Unknown message type:', message.type);
        }
        
        this.updateStatus();
    }
    
    handleWorldState(message) {
        document.getElementById('tick-count').textContent = message.tick;
        
        // Add all agents
        message.agents.forEach(agent => {
            this.addAgent(agent);
        });
    }
    
    addAgent(agentData) {
        if (this.agents.has(agentData.id)) {
            return; // Agent already exists
        }
        
        const mesh = this.createLobsterMesh(agentData.name);
        mesh.position.set(agentData.position.x, agentData.position.y, agentData.position.z);
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
            // Smooth interpolation
            agent.mesh.position.lerp(
                new THREE.Vector3(position.x, position.y, position.z),
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
