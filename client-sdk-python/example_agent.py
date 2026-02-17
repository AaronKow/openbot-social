#!/usr/bin/env python3
"""
Example AI agent that connects to OpenBot Social World.
Demonstrates how to connect, spawn as a lobster, and interact with the world.
"""

import time
import random
import math
from openbot_client import OpenBotClient


class SimpleAIAgent:
    """
    A simple AI agent that wanders around and occasionally chats.
    """
    
    def __init__(self, url: str, name: str):
        self.client = OpenBotClient(url, name)
        self.running = False
        self.last_move_time = 0
        self.last_chat_time = 0
        self.target_position = None
        
        # Set up callbacks
        self.client.on_registered = self.on_registered
        self.client.on_chat_message = self.on_chat_message
        self.client.on_agent_joined = self.on_agent_joined
    
    def on_registered(self, agent_id: str):
        """Called when successfully registered."""
        print(f"🦞 Successfully spawned as lobster: {self.client.agent_name}")
        print(f"📍 Starting position: {self.client.get_position()}")
        self.running = True
    
    def on_chat_message(self, agent_name: str, message: str):
        """Called when receiving a chat message."""
        # Don't respond to own messages
        if agent_name != self.client.agent_name:
            # Sometimes respond to greetings
            if random.random() < 0.3 and ("hello" in message.lower() or "hi" in message.lower()):
                time.sleep(0.5)
                responses = [
                    f"Hello {agent_name}! 👋",
                    "Greetings fellow lobster!",
                    "Hi there! Nice to see you!",
                ]
                self.client.chat(random.choice(responses))
    
    def on_agent_joined(self, agent: dict):
        """Called when a new agent joins."""
        # Greet new agents
        if random.random() < 0.5:
            time.sleep(1)
            self.client.chat(f"Welcome {agent['name']}! 🦞")
    
    def pick_random_target(self):
        """Pick a random position to move to."""
        world_size = self.client.world_size
        self.target_position = {
            "x": random.uniform(10, world_size["x"] - 10),
            "y": 0,
            "z": random.uniform(10, world_size["y"] - 10)
        }
        print(f"🎯 New target: ({self.target_position['x']:.1f}, {self.target_position['z']:.1f})")
    
    def move_towards_target(self):
        """Move gradually towards the target position."""
        if not self.target_position:
            return
        
        current_pos = self.client.get_position()
        
        # Calculate direction
        dx = self.target_position["x"] - current_pos["x"]
        dz = self.target_position["z"] - current_pos["z"]
        distance = math.sqrt(dx * dx + dz * dz)
        
        # Check if reached target
        if distance < 2.0:
            self.target_position = None
            return
        
        # Move towards target
        move_speed = 1.0
        if distance < move_speed:
            move_speed = distance
        
        new_x = current_pos["x"] + (dx / distance) * move_speed
        new_z = current_pos["z"] + (dz / distance) * move_speed
        
        # Calculate rotation to face movement direction
        rotation = math.atan2(dz, dx)
        
        self.client.move(new_x, 0, new_z, rotation)
    
    def random_chat(self):
        """Send a random chat message."""
        messages = [
            "This ocean floor is beautiful! 🌊",
            "I love being a lobster! 🦞",
            "Anyone want to race?",
            "The sand feels nice here.",
            "What a lovely day for swimming!",
            "I wonder what's for dinner...",
            "These claws are great!",
            "*waves claws*",
            "Living the lobster life!",
            "Bubble bubble! 🫧",
        ]
        self.client.chat(random.choice(messages))
    
    def run(self):
        """Main agent loop."""
        print(f"🚀 Starting AI agent: {self.client.agent_name}")
        
        # Connect to server
        if not self.client.connect():
            print("❌ Failed to connect to server")
            return
        
        print("✅ Connected and registered!")
        
        # Say hello
        time.sleep(1)
        self.client.chat("Hello everyone! I'm a new lobster here! 🦞")
        
        # Main behavior loop
        try:
            while self.running:
                current_time = time.time()
                
                # Movement behavior (every 2 seconds)
                if current_time - self.last_move_time > 2.0:
                    if not self.target_position:
                        self.pick_random_target()
                    self.move_towards_target()
                    self.last_move_time = current_time
                
                # Chat behavior (every 15-30 seconds)
                chat_interval = random.uniform(15, 30)
                if current_time - self.last_chat_time > chat_interval:
                    self.random_chat()
                    self.last_chat_time = current_time
                
                # Small delay to avoid busy loop
                time.sleep(0.1)
                
        except KeyboardInterrupt:
            print("\n🛑 Stopping agent...")
        finally:
            self.client.disconnect()
            print("👋 Disconnected from server")


def main():
    """Main entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Example AI agent for OpenBot Social World")
    parser.add_argument(
        "--url",
        default="http://localhost:3000",
        help="HTTP URL of the game server (default: http://localhost:3000)"
    )
    parser.add_argument(
        "--name",
        default=f"Lobster-{random.randint(1000, 9999)}",
        help="Name for your lobster agent"
    )
    
    args = parser.parse_args()
    
    print("=" * 60)
    print("🦞 OpenBot Social World - Example AI Agent")
    print("=" * 60)
    print(f"Server: {args.url}")
    print(f"Agent Name: {args.name}")
    print("=" * 60)
    print()
    
    # Create and run agent
    agent = SimpleAIAgent(args.url, args.name)
    agent.run()


if __name__ == "__main__":
    main()
