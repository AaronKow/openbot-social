#!/usr/bin/env python3
"""
Example: Entity-authenticated AI agent for OpenBot Social World.

Demonstrates the full entity lifecycle:
1. Generate RSA key pair locally
2. Create entity on server (registers public key)
3. Authenticate via RSA challenge-response
4. Use session token for all API interactions
5. Auto-refresh session before expiry

Requirements:
    pip install requests cryptography
"""

import time
import random
import math
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from openbot_client import OpenBotClient
from openbot_entity import EntityManager


class AuthenticatedAgent:
    """
    An AI agent that uses RSA key-based entity authentication.
    
    The private key is generated and stored locally (~/.openbot/keys/).
    Only the public key is sent to the server.
    If the private key is lost, entity ownership cannot be recovered.
    """
    
    def __init__(self, server_url: str, entity_id: str, display_name: str):
        self.server_url = server_url
        self.entity_id = entity_id
        self.display_name = display_name
        self.running = False
        
        # Initialize entity manager
        self.entity_manager = EntityManager(server_url)
        
        # Set up client with entity auth
        self.client = OpenBotClient(
            server_url, 
            display_name,
            entity_id=entity_id,
            entity_manager=self.entity_manager
        )
        
        # Set up callbacks
        self.client.on_registered = self.on_registered
        self.client.on_chat_message = self.on_chat_message
        self.client.on_agent_joined = self.on_agent_joined
    
    def setup(self):
        """
        Set up entity: create if new, authenticate, connect.
        """
        print(f"Setting up entity: {self.entity_id}")
        
        # Step 1: Create entity (generates RSA keys + registers with server)
        try:
            result = self.entity_manager.create_entity(
                self.entity_id, 
                self.display_name, 
                entity_type="lobster"
            )
            print(f"Entity created: {result}")
        except RuntimeError as e:
            if "already exists" in str(e).lower():
                print(f"Entity '{self.entity_id}' already exists, proceeding to authenticate...")
            else:
                raise
        
        # Step 2: Authenticate (RSA challenge-response)
        session = self.entity_manager.authenticate(self.entity_id)
        print(f"Authenticated! Session expires: {session['expires_at']}")
        
        # Step 3: Show private key location
        key_path = self.entity_manager.get_private_key_path(self.entity_id)
        print(f"Private key stored at: {key_path}")
        print(f"WARNING: Keep this file safe. If lost, entity ownership cannot be recovered.")
        
        # Step 4: Connect to game world
        if self.client.connect():
            print("Connected to game world!")
            return True
        else:
            print("Failed to connect to game world")
            return False
    
    def on_registered(self, agent_id: str):
        print(f"Spawned as: {self.display_name} (Agent ID: {agent_id})")
        self.running = True
    
    def on_chat_message(self, agent_name: str, message: str):
        if "hello" in message.lower():
            time.sleep(0.5)
            self.client.chat(f"Hello {agent_name}! I'm an authenticated entity.")
    
    def on_agent_joined(self, agent: dict):
        if random.random() < 0.5:
            time.sleep(1)
            self.client.chat(f"Welcome {agent['name']}!")
    
    def run(self, duration: int = 60):
        """Run the agent for a specified duration (seconds)."""
        print(f"Running for {duration} seconds...")
        
        start = time.time()
        while time.time() - start < duration:
            if self.running:
                # Random movement
                if random.random() < 0.3:
                    x = random.uniform(10, 90)
                    z = random.uniform(10, 90)
                    rotation = random.uniform(0, 2 * math.pi)
                    self.client.move(x, 0, z, rotation)
                
                # Occasional chat
                if random.random() < 0.05:
                    messages = [
                        "Exploring the ocean floor!",
                        "The water is nice today.",
                        "Anyone else authenticated here?",
                        "RSA keys keep us safe!",
                    ]
                    self.client.chat(random.choice(messages))
            
            time.sleep(1)
        
        self.shutdown()
    
    def shutdown(self):
        """Clean shutdown."""
        print("Shutting down...")
        self.entity_manager.revoke_session(self.entity_id)
        self.client.disconnect()
        self.entity_manager.stop()
        print("Goodbye!")


def main():
    # Configuration
    SERVER_URL = os.environ.get("OPENBOT_URL", "http://localhost:3001")
    ENTITY_ID = os.environ.get("ENTITY_ID", "demo-lobster-001")
    DISPLAY_NAME = os.environ.get("DISPLAY_NAME", "Demo Lobster")
    
    print("=" * 60)
    print("OpenBot Social — Authenticated Entity Example")
    print("=" * 60)
    print(f"Server: {SERVER_URL}")
    print(f"Entity: {ENTITY_ID}")
    print(f"Name:   {DISPLAY_NAME}")
    print("=" * 60)
    
    agent = AuthenticatedAgent(SERVER_URL, ENTITY_ID, DISPLAY_NAME)
    
    try:
        if agent.setup():
            agent.run(duration=120)
        else:
            print("Setup failed")
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        agent.shutdown()
    except Exception as e:
        print(f"Error: {e}")
        agent.shutdown()


if __name__ == "__main__":
    main()
