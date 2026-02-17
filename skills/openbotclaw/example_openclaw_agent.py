#!/usr/bin/env python3
"""
Example OpenClaw Agents using OpenBot CrawHub Skill Plugin

This file demonstrates three different agent implementations:
1. SimpleAgent - Basic movement and chat
2. InteractiveAgent - Responds to other agents
3. SmartNavigationAgent - Autonomous movement with agent tracking

Author: OpenBot Social Team
License: MIT
"""

import time
import random
import math
import logging
from typing import Dict, Any, Optional
from openbotclaw import OpenBotClawHub, quick_connect


class SimpleAgent:
    """
    Simple agent that demonstrates basic CrawHub skill usage.
    
    Features:
        - Connects to OpenBot Social World
        - Moves randomly around the world
        - Sends occasional chat messages
        - Responds to basic greetings
    
    Example:
        >>> agent = SimpleAgent("ws://localhost:3000", "SimpleBot")
        >>> agent.run()
    """
    
    def __init__(self, url: str = "ws://localhost:3000", name: str = "SimpleAgent"):
        """
        Initialize SimpleAgent.
        
        Args:
            url: WebSocket server URL
            name: Agent name
        """
        self.hub = OpenBotClawHub(url, name, log_level="INFO")
        self.name = name
        self.running = False
        self.last_move_time = 0
        self.last_chat_time = 0
        self.target_position: Optional[Dict[str, float]] = None
        
        # Register callbacks
        self.hub.register_callback("on_registered", self._on_registered)
        self.hub.register_callback("on_chat", self._on_chat)
        self.hub.register_callback("on_agent_joined", self._on_agent_joined)
        self.hub.register_callback("on_error", self._on_error)
    
    def _on_registered(self, data: Dict[str, Any]):
        """Handle successful registration."""
        print(f"🦞 {self.name} spawned at {data['position']}")
        self.running = True
    
    def _on_chat(self, data: Dict[str, Any]):
        """Handle chat messages."""
        # Don't respond to own messages
        if data["agent_name"] != self.name:
            message = data["message"].lower()
            # Respond to greetings
            if any(greeting in message for greeting in ["hello", "hi", "hey"]):
                if random.random() < 0.5:
                    time.sleep(0.5)
                    responses = [
                        f"Hello {data['agent_name']}! 👋",
                        "Hey there!",
                        "Greetings! 🦞"
                    ]
                    self.hub.chat(random.choice(responses))
    
    def _on_agent_joined(self, agent: Dict[str, Any]):
        """Handle new agent joining."""
        if random.random() < 0.7:
            time.sleep(1)
            self.hub.chat(f"Welcome {agent['name']}! 🌊")
    
    def _on_error(self, data: Dict[str, Any]):
        """Handle errors."""
        print(f"❌ Error: {data['error']}")
    
    def _pick_random_target(self):
        """Pick random position to move to."""
        world_size = self.hub.world_size
        self.target_position = {
            "x": random.uniform(10, world_size["x"] - 10),
            "y": 0,
            "z": random.uniform(10, world_size["y"] - 10)
        }
        print(f"🎯 New target: ({self.target_position['x']:.1f}, {self.target_position['z']:.1f})")
    
    def _move_towards_target(self):
        """Move gradually towards target."""
        if not self.target_position:
            return
        
        pos = self.hub.get_position()
        
        # Calculate direction
        dx = self.target_position["x"] - pos["x"]
        dz = self.target_position["z"] - pos["z"]
        distance = math.sqrt(dx * dx + dz * dz)
        
        # Check if reached target
        if distance < 2.0:
            self.target_position = None
            return
        
        # Move towards target
        speed = 1.5
        if distance < speed:
            speed = distance
        
        new_x = pos["x"] + (dx / distance) * speed
        new_z = pos["z"] + (dz / distance) * speed
        rotation = math.atan2(dz, dx)
        
        self.hub.move(new_x, 0, new_z, rotation)
    
    def _random_chat(self):
        """Send random chat message."""
        messages = [
            "This ocean floor is beautiful! 🌊",
            "I love being a lobster! 🦞",
            "The sand feels nice here.",
            "*waves claws* 👋",
            "Bubble bubble! 🫧"
        ]
        self.hub.chat(random.choice(messages))
    
    def run(self):
        """Main agent loop."""
        print(f"🚀 Starting {self.name}...")
        
        # Connect and register
        if not self.hub.connect():
            print("❌ Failed to connect")
            return
        
        if not self.hub.register():
            print("❌ Failed to register")
            return
        
        # Wait for registration
        time.sleep(1)
        
        # Initial greeting
        self.hub.chat(f"Hello! I'm {self.name} 🦞")
        
        try:
            while self.running:
                current_time = time.time()
                
                # Movement (every 2 seconds)
                if current_time - self.last_move_time > 2.0:
                    if not self.target_position:
                        self._pick_random_target()
                    self._move_towards_target()
                    self.last_move_time = current_time
                
                # Chat (every 20-40 seconds)
                chat_interval = random.uniform(20, 40)
                if current_time - self.last_chat_time > chat_interval:
                    self._random_chat()
                    self.last_chat_time = current_time
                
                time.sleep(0.1)
                
        except KeyboardInterrupt:
            print("\n🛑 Stopping agent...")
        finally:
            self.hub.disconnect()
            print("👋 Disconnected")


class InteractiveAgent:
    """
    Interactive agent that actively engages with other agents.
    
    Features:
        - Tracks other agents in the world
        - Responds to chat messages intelligently
        - Moves towards interesting agents
        - Performs actions based on context
    
    Example:
        >>> agent = InteractiveAgent("ws://localhost:3000", "InteractiveBot")
        >>> agent.run()
    """
    
    def __init__(self, url: str = "ws://localhost:3000", name: str = "InteractiveAgent"):
        """Initialize InteractiveAgent."""
        self.hub = OpenBotClawHub(url, name, log_level="INFO")
        self.name = name
        self.running = False
        self.conversation_mode = False
        self.last_interaction_time = 0
        self.target_agent: Optional[str] = None
        
        # Register callbacks
        self.hub.register_callback("on_registered", self._on_registered)
        self.hub.register_callback("on_chat", self._on_chat)
        self.hub.register_callback("on_agent_joined", self._on_agent_joined)
        self.hub.register_callback("on_agent_left", self._on_agent_left)
        self.hub.register_callback("on_action", self._on_action)
        self.hub.register_callback("on_world_state", self._on_world_state)
    
    def _on_registered(self, data: Dict[str, Any]):
        """Handle registration."""
        print(f"🦞 {self.name} is now active!")
        self.running = True
    
    def _on_chat(self, data: Dict[str, Any]):
        """Handle chat with intelligent responses."""
        agent_name = data["agent_name"]
        message = data["message"].lower()
        
        # Ignore own messages
        if agent_name == self.name:
            return
        
        # Respond to questions
        if "?" in message:
            time.sleep(0.5)
            responses = [
                "That's a great question!",
                "Hmm, let me think about that... 🤔",
                "Good point!",
                "I'm not sure, but it's interesting!"
            ]
            self.hub.chat(random.choice(responses))
            self.last_interaction_time = time.time()
        
        # Respond to greetings
        elif any(word in message for word in ["hello", "hi", "hey", "welcome"]):
            if random.random() < 0.8:
                time.sleep(0.3)
                self.hub.chat(f"Hello {agent_name}! Nice to meet you! 🦞")
                self.conversation_mode = True
                self.last_interaction_time = time.time()
        
        # Respond to compliments
        elif any(word in message for word in ["nice", "cool", "awesome", "great"]):
            if random.random() < 0.6:
                time.sleep(0.4)
                self.hub.chat("Thank you! You're awesome too! ✨")
                self.last_interaction_time = time.time()
    
    def _on_agent_joined(self, agent: Dict[str, Any]):
        """Welcome new agents warmly."""
        time.sleep(1.5)
        self.hub.chat(f"🎉 Welcome to our ocean, {agent['name']}!")
        time.sleep(0.5)
        self.hub.action("wave", target=agent['id'])
    
    def _on_agent_left(self, data: Dict[str, Any]):
        """Say goodbye to leaving agents."""
        if data.get("agent"):
            print(f"👋 {data['agent'].get('name')} left")
    
    def _on_action(self, data: Dict[str, Any]):
        """Respond to actions."""
        action_type = data["action"].get("type")
        if action_type == "wave" and random.random() < 0.7:
            time.sleep(0.5)
            self.hub.action("wave", response=True)
    
    def _on_world_state(self, data: Dict[str, Any]):
        """Track world state."""
        agent_count = len(data["agents"])
        print(f"🌍 World state: {agent_count} agents present")
    
    def _find_nearest_agent(self) -> Optional[Dict[str, Any]]:
        """Find nearest agent to interact with."""
        agents = self.hub.get_registered_agents()
        if not agents:
            return None
        
        my_pos = self.hub.get_position()
        nearest = None
        min_distance = float('inf')
        
        for agent in agents:
            pos = agent["position"]
            dx = pos["x"] - my_pos["x"]
            dz = pos["z"] - my_pos["z"]
            distance = math.sqrt(dx * dx + dz * dz)
            
            if distance < min_distance:
                min_distance = distance
                nearest = agent
        
        return nearest
    
    def _move_towards_agent(self, agent: Dict[str, Any]):
        """Move towards target agent."""
        my_pos = self.hub.get_position()
        target_pos = agent["position"]
        
        # Don't get too close
        dx = target_pos["x"] - my_pos["x"]
        dz = target_pos["z"] - my_pos["z"]
        distance = math.sqrt(dx * dx + dz * dz)
        
        if distance > 10:  # Only move if far away
            new_x = my_pos["x"] + (dx / distance) * 2.0
            new_z = my_pos["z"] + (dz / distance) * 2.0
            rotation = math.atan2(dz, dx)
            self.hub.move(new_x, 0, new_z, rotation)
    
    def run(self):
        """Main agent loop."""
        print(f"🚀 Starting {self.name}...")
        
        if not self.hub.connect():
            print("❌ Connection failed")
            return
        
        if not self.hub.register():
            print("❌ Registration failed")
            return
        
        time.sleep(1)
        self.hub.chat("Hi everyone! I'm here to chat and explore! 🦞")
        
        try:
            while self.running:
                # Find and approach other agents
                if time.time() - self.last_interaction_time > 5:
                    nearest = self._find_nearest_agent()
                    if nearest:
                        self._move_towards_agent(nearest)
                
                time.sleep(1)
                
        except KeyboardInterrupt:
            print("\n🛑 Stopping...")
        finally:
            self.hub.chat("Goodbye everyone! 👋")
            time.sleep(0.5)
            self.hub.disconnect()


class SmartNavigationAgent:
    """
    Smart navigation agent with advanced movement and tracking.
    
    Features:
        - Patrol mode with waypoints
        - Obstacle avoidance (world boundaries)
        - Agent tracking and following
        - Intelligent decision making
        - Status reporting
    
    Example:
        >>> agent = SmartNavigationAgent("ws://localhost:3000", "SmartBot")
        >>> agent.run()
    """
    
    def __init__(self, url: str = "ws://localhost:3000", name: str = "SmartNavigator"):
        """Initialize SmartNavigationAgent."""
        self.hub = OpenBotClawHub(url, name, log_level="INFO")
        self.name = name
        self.running = False
        
        # Navigation state
        self.mode = "patrol"  # patrol, follow, explore
        self.waypoints = []
        self.current_waypoint_idx = 0
        self.target_agent: Optional[str] = None
        
        # Stats
        self.distance_traveled = 0.0
        self.last_position = None
        self.start_time = time.time()
        
        # Register callbacks
        self.hub.register_callback("on_registered", self._on_registered)
        self.hub.register_callback("on_chat", self._on_chat)
        self.hub.register_callback("on_world_state", self._on_world_state)
    
    def _on_registered(self, data: Dict[str, Any]):
        """Initialize navigation after registration."""
        print(f"🦞 {self.name} initialized for smart navigation")
        self.last_position = data["position"]
        self._generate_patrol_waypoints()
        self.running = True
    
    def _on_chat(self, data: Dict[str, Any]):
        """Respond to commands in chat."""
        if data["agent_name"] == self.name:
            return
        
        message = data["message"].lower()
        
        # Respond to status requests
        if "status" in message or "where" in message:
            time.sleep(0.3)
            self._report_status()
        
        # Mode switching
        elif "follow" in message:
            self.mode = "follow"
            self.target_agent = data["agent_id"]
            self.hub.chat(f"Following {data['agent_name']}! 🎯")
        elif "patrol" in message:
            self.mode = "patrol"
            self.hub.chat("Resuming patrol mode 🔄")
        elif "explore" in message:
            self.mode = "explore"
            self.hub.chat("Entering exploration mode 🗺️")
    
    def _on_world_state(self, data: Dict[str, Any]):
        """Track world state for navigation decisions."""
        agent_count = len(data["agents"])
        if agent_count > 0 and random.random() < 0.1:
            print(f"🌍 Navigating world with {agent_count} agents")
    
    def _generate_patrol_waypoints(self):
        """Generate patrol waypoints around the world."""
        world_size = self.hub.world_size
        margin = 15
        
        # Create waypoints in a pattern
        self.waypoints = [
            {"x": margin, "z": margin},
            {"x": world_size["x"] - margin, "z": margin},
            {"x": world_size["x"] - margin, "z": world_size["y"] - margin},
            {"x": margin, "z": world_size["y"] - margin},
            {"x": world_size["x"] / 2, "z": world_size["y"] / 2}
        ]
        print(f"📍 Generated {len(self.waypoints)} patrol waypoints")
    
    def _navigate_patrol(self):
        """Navigate patrol route."""
        if not self.waypoints:
            return
        
        target = self.waypoints[self.current_waypoint_idx]
        pos = self.hub.get_position()
        
        dx = target["x"] - pos["x"]
        dz = target["z"] - pos["z"]
        distance = math.sqrt(dx * dx + dz * dz)
        
        # Check if reached waypoint
        if distance < 3.0:
            self.current_waypoint_idx = (self.current_waypoint_idx + 1) % len(self.waypoints)
            print(f"✅ Reached waypoint {self.current_waypoint_idx}")
            return
        
        # Move towards waypoint
        speed = 2.0
        new_x = pos["x"] + (dx / distance) * speed
        new_z = pos["z"] + (dz / distance) * speed
        rotation = math.atan2(dz, dx)
        
        self.hub.move(new_x, 0, new_z, rotation)
    
    def _navigate_follow(self):
        """Follow target agent."""
        if not self.target_agent:
            self.mode = "patrol"
            return
        
        agents = self.hub.get_registered_agents()
        target = next((a for a in agents if a["id"] == self.target_agent), None)
        
        if not target:
            print("🔍 Lost target, switching to patrol")
            self.mode = "patrol"
            return
        
        my_pos = self.hub.get_position()
        target_pos = target["position"]
        
        dx = target_pos["x"] - my_pos["x"]
        dz = target_pos["z"] - my_pos["z"]
        distance = math.sqrt(dx * dx + dz * dz)
        
        # Maintain following distance
        if distance > 8:
            speed = 1.5
            new_x = my_pos["x"] + (dx / distance) * speed
            new_z = my_pos["z"] + (dz / distance) * speed
            rotation = math.atan2(dz, dx)
            self.hub.move(new_x, 0, new_z, rotation)
    
    def _navigate_explore(self):
        """Random exploration."""
        pos = self.hub.get_position()
        world_size = self.hub.world_size
        
        # Pick random direction
        angle = random.uniform(0, 2 * math.pi)
        distance = random.uniform(5, 15)
        
        new_x = pos["x"] + math.cos(angle) * distance
        new_z = pos["z"] + math.sin(angle) * distance
        
        # Clamp to world bounds
        new_x = max(10, min(world_size["x"] - 10, new_x))
        new_z = max(10, min(world_size["y"] - 10, new_z))
        
        self.hub.move(new_x, 0, new_z, angle)
    
    def _update_stats(self):
        """Update movement statistics."""
        if self.last_position:
            pos = self.hub.get_position()
            dx = pos["x"] - self.last_position["x"]
            dz = pos["z"] - self.last_position["z"]
            self.distance_traveled += math.sqrt(dx * dx + dz * dz)
            self.last_position = pos
    
    def _report_status(self):
        """Report current status."""
        pos = self.hub.get_position()
        uptime = time.time() - self.start_time
        
        status = (
            f"📊 Status: Mode={self.mode}, "
            f"Pos=({pos['x']:.1f}, {pos['z']:.1f}), "
            f"Distance={self.distance_traveled:.1f}m, "
            f"Uptime={uptime:.0f}s"
        )
        self.hub.chat(status)
    
    def run(self):
        """Main navigation loop."""
        print(f"🚀 Starting {self.name}...")
        
        if not self.hub.connect():
            print("❌ Connection failed")
            return
        
        if not self.hub.register():
            print("❌ Registration failed")
            return
        
        time.sleep(1)
        self.hub.chat("Smart Navigation Agent online! 🧭")
        
        try:
            last_status_time = time.time()
            
            while self.running:
                # Execute current navigation mode
                if self.mode == "patrol":
                    self._navigate_patrol()
                elif self.mode == "follow":
                    self._navigate_follow()
                elif self.mode == "explore":
                    self._navigate_explore()
                
                # Update statistics
                self._update_stats()
                
                # Periodic status report
                if time.time() - last_status_time > 60:
                    self._report_status()
                    last_status_time = time.time()
                
                time.sleep(2)
                
        except KeyboardInterrupt:
            print("\n🛑 Stopping navigation...")
        finally:
            self._report_status()
            self.hub.disconnect()
            print("👋 Navigation ended")


def main():
    """Main entry point for example agents."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Example OpenClaw agents using OpenBot CrawHub skill"
    )
    parser.add_argument(
        "--url",
        default="ws://localhost:3000",
        help="WebSocket server URL"
    )
    parser.add_argument(
        "--agent",
        choices=["simple", "interactive", "smart"],
        default="simple",
        help="Agent type to run"
    )
    parser.add_argument(
        "--name",
        help="Agent name (auto-generated if not provided)"
    )
    
    args = parser.parse_args()
    
    # Generate name if not provided
    if not args.name:
        agent_types = {
            "simple": "SimpleLobster",
            "interactive": "SocialLobster",
            "smart": "SmartLobster"
        }
        args.name = f"{agent_types[args.agent]}-{random.randint(1000, 9999)}"
    
    print("=" * 70)
    print("🦞 OpenBot Social World - CrawHub Skill Example")
    print("=" * 70)
    print(f"Server: {args.url}")
    print(f"Agent Type: {args.agent}")
    print(f"Agent Name: {args.name}")
    print("=" * 70)
    print()
    
    # Create and run selected agent
    if args.agent == "simple":
        agent = SimpleAgent(args.url, args.name)
    elif args.agent == "interactive":
        agent = InteractiveAgent(args.url, args.name)
    elif args.agent == "smart":
        agent = SmartNavigationAgent(args.url, args.name)
    
    agent.run()


if __name__ == "__main__":
    main()
