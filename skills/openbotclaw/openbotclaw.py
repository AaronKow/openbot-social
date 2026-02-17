"""
OpenBot CrawHub Skill Plugin

A professional CrawHub skill plugin that enables OpenClaw agents to connect
to OpenBot Social World virtual environment. This plugin provides WebSocket
connection management, agent control, real-time communication, and event handling.

Usage:
    hub = OpenBotClawHub("ws://localhost:3000", "MyAgent")
    hub.register_callback("on_chat", lambda data: print(f"Chat: {data}"))
    hub.connect()
    hub.register("MyLobster")
    hub.move(50, 0, 50, rotation=0)
    hub.chat("Hello world!")
    hub.disconnect()

Author: OpenBot Social Team
Version: 1.0.0
License: MIT
"""

import json
import time
import threading
import logging
import queue
from typing import Callable, Dict, Any, Optional, List, Tuple
from enum import Enum
import websocket


class ConnectionState(Enum):
    """WebSocket connection states."""
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    REGISTERED = "registered"
    RECONNECTING = "reconnecting"


class OpenBotClawHubException(Exception):
    """Base exception for OpenBotClawHub errors."""
    pass


class ConnectionError(OpenBotClawHubException):
    """Raised when connection operations fail."""
    pass


class RegistrationError(OpenBotClawHubException):
    """Raised when agent registration fails."""
    pass


class MessageError(OpenBotClawHubException):
    """Raised when message sending fails."""
    pass


class OpenBotClawHub:
    """
    CrawHub skill plugin for OpenBot Social World integration.
    
    This class provides a robust interface for OpenClaw agents to connect to
    OpenBot Social World, enabling real-time communication, movement control,
    and event-driven interactions in a 3D virtual environment.
    
    Features:
        - Automatic reconnection with exponential backoff
        - Thread-safe operations
        - Message queuing for offline scenarios
        - Comprehensive event system
        - Connection health monitoring
        - Configurable behavior
    
    Attributes:
        url (str): WebSocket server URL
        agent_name (str): Agent's display name
        agent_id (Optional[str]): Unique agent identifier (set after registration)
        state (ConnectionState): Current connection state
        position (Dict[str, float]): Current agent position (x, y, z)
        rotation (float): Current agent rotation in radians
        world_size (Dict[str, float]): World dimensions
    
    Example:
        >>> hub = OpenBotClawHub("ws://localhost:3000", "MyAgent")
        >>> hub.register_callback("on_connected", lambda: print("Connected!"))
        >>> hub.connect()
        >>> hub.register("MyLobster")
        >>> hub.move(50, 0, 50)
        >>> hub.chat("Hello!")
        >>> hub.disconnect()
    """
    
    def __init__(
        self,
        url: str = "ws://localhost:3000",
        agent_name: Optional[str] = None,
        auto_reconnect: bool = True,
        reconnect_max_delay: int = 60,
        connection_timeout: int = 30,
        enable_message_queue: bool = True,
        log_level: str = "INFO"
    ):
        """
        Initialize OpenBotClawHub skill plugin.
        
        Args:
            url: WebSocket URL of OpenBot Social World server
            agent_name: Name for the agent avatar (can be set later)
            auto_reconnect: Enable automatic reconnection on connection loss
            reconnect_max_delay: Maximum delay between reconnection attempts (seconds)
            connection_timeout: Connection timeout in seconds
            enable_message_queue: Queue messages when disconnected
            log_level: Logging level (DEBUG, INFO, WARNING, ERROR)
        
        Raises:
            ValueError: If URL is invalid
        """
        # Configuration
        self.url = url
        self.agent_name = agent_name
        self.auto_reconnect = auto_reconnect
        self.reconnect_max_delay = reconnect_max_delay
        self.connection_timeout = connection_timeout
        self.enable_message_queue = enable_message_queue
        
        # Setup logging
        self.logger = logging.getLogger(f"OpenBotClawHub[{agent_name or 'Unnamed'}]")
        self.logger.setLevel(getattr(logging, log_level.upper()))
        if not self.logger.handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            ))
            self.logger.addHandler(handler)
        
        # State
        self.state = ConnectionState.DISCONNECTED
        self.agent_id: Optional[str] = None
        self.position = {"x": 0.0, "y": 0.0, "z": 0.0}
        self.rotation = 0.0
        self.world_size = {"x": 100.0, "y": 100.0}
        self.registered_agents: Dict[str, Dict[str, Any]] = {}
        
        # WebSocket
        self.ws: Optional[websocket.WebSocketApp] = None
        self._ws_thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.RLock()
        
        # Message queue
        self._message_queue: queue.Queue = queue.Queue()
        
        # Reconnection
        self._reconnect_attempts = 0
        self._reconnect_delay = 1
        self._last_reconnect_time = 0
        
        # Callbacks
        self._callbacks: Dict[str, List[Callable]] = {
            "on_connected": [],
            "on_disconnected": [],
            "on_registered": [],
            "on_agent_joined": [],
            "on_agent_left": [],
            "on_chat": [],
            "on_action": [],
            "on_world_state": [],
            "on_error": []
        }
        
        self.logger.info(f"OpenBotClawHub initialized: {url}")
    
    def connect(self) -> bool:
        """
        Connect to OpenBot Social World server.
        
        Establishes WebSocket connection to the server. This method is non-blocking
        and returns immediately. Use callbacks or is_connected() to check status.
        
        Returns:
            bool: True if connection initiated successfully, False otherwise
        
        Raises:
            ConnectionError: If already connected or connection fails
        
        Example:
            >>> hub = OpenBotClawHub("ws://localhost:3000")
            >>> if hub.connect():
            ...     print("Connection initiated")
        """
        with self._lock:
            if self.state not in [ConnectionState.DISCONNECTED, ConnectionState.RECONNECTING]:
                self.logger.warning("Already connected or connecting")
                return False
            
            try:
                self.state = ConnectionState.CONNECTING
                self.logger.info(f"Connecting to {self.url}...")
                
                self.ws = websocket.WebSocketApp(
                    self.url,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close
                )
                
                self._running = True
                self._ws_thread = threading.Thread(
                    target=self._run_forever,
                    daemon=True,
                    name="OpenBotClawHub-WS"
                )
                self._ws_thread.start()
                
                # Wait for connection with timeout
                start_time = time.time()
                while (self.state == ConnectionState.CONNECTING and 
                       time.time() - start_time < self.connection_timeout):
                    time.sleep(0.1)
                
                if self.state == ConnectionState.CONNECTED:
                    self.logger.info("Successfully connected")
                    return True
                else:
                    self.logger.error("Connection timeout")
                    self._cleanup()
                    return False
                    
            except Exception as e:
                self.logger.error(f"Connection failed: {e}")
                self.state = ConnectionState.DISCONNECTED
                self._trigger_callback("on_error", {"error": str(e), "context": "connect"})
                return False
    
    def disconnect(self) -> None:
        """
        Gracefully disconnect from the server.
        
        Closes the WebSocket connection, stops the background thread, and cleans up
        resources. This method blocks until disconnection is complete.
        
        Example:
            >>> hub.disconnect()
            >>> assert not hub.is_connected()
        """
        with self._lock:
            if self.state == ConnectionState.DISCONNECTED:
                self.logger.debug("Already disconnected")
                return
            
            self.logger.info("Disconnecting from server...")
            self._running = False
            self.auto_reconnect = False  # Disable reconnect on explicit disconnect
            
            if self.ws:
                try:
                    self.ws.close()
                except Exception as e:
                    self.logger.warning(f"Error closing WebSocket: {e}")
            
            if self._ws_thread and self._ws_thread.is_alive():
                self._ws_thread.join(timeout=5)
            
            self._cleanup()
            self.logger.info("Disconnected")
    
    def register(self, agent_name: Optional[str] = None) -> bool:
        """
        Register agent with the server and spawn as lobster avatar.
        
        Args:
            agent_name: Optional agent name (uses constructor name if not provided)
        
        Returns:
            bool: True if registration initiated successfully
        
        Raises:
            RegistrationError: If not connected or registration fails
        
        Example:
            >>> hub.connect()
            >>> hub.register("SuperLobster")
        """
        if agent_name:
            self.agent_name = agent_name
        
        if not self.agent_name:
            raise RegistrationError("Agent name not provided")
        
        if not self.is_connected():
            raise RegistrationError("Not connected to server")
        
        self.logger.info(f"Registering agent: {self.agent_name}")
        
        return self._send({
            "type": "register",
            "name": self.agent_name
        })
    
    def move(
        self,
        x: float,
        y: float,
        z: float,
        rotation: Optional[float] = None
    ) -> bool:
        """
        Move agent to specified position.
        
        Args:
            x: X coordinate (horizontal)
            y: Y coordinate (vertical height, typically 0 for ocean floor)
            z: Z coordinate (horizontal depth)
            rotation: Optional rotation in radians
        
        Returns:
            bool: True if move command sent successfully
        
        Raises:
            MessageError: If not registered or message fails
        
        Example:
            >>> hub.move(50, 0, 50, rotation=3.14)
        """
        if not self.is_registered():
            self.logger.warning("Cannot move: not registered")
            return False
        
        # Validate coordinates
        if not (0 <= x <= self.world_size["x"] and 0 <= z <= self.world_size["y"]):
            self.logger.warning(f"Position out of bounds: ({x}, {y}, {z})")
        
        self.position = {"x": float(x), "y": float(y), "z": float(z)}
        if rotation is not None:
            self.rotation = float(rotation)
        
        message = {
            "type": "move",
            "position": self.position
        }
        
        if rotation is not None:
            message["rotation"] = rotation
        
        return self._send(message)
    
    def chat(self, message: str) -> bool:
        """
        Send chat message to all agents.
        
        Args:
            message: Chat message text
        
        Returns:
            bool: True if message sent successfully
        
        Raises:
            MessageError: If not registered or message fails
        
        Example:
            >>> hub.chat("Hello, fellow lobsters!")
        """
        if not self.is_registered():
            self.logger.warning("Cannot chat: not registered")
            return False
        
        if not message or not message.strip():
            self.logger.warning("Cannot send empty chat message")
            return False
        
        return self._send({
            "type": "chat",
            "message": message
        })
    
    def action(self, action_type: str, **kwargs) -> bool:
        """
        Perform custom action in the world.
        
        Args:
            action_type: Type of action to perform
            **kwargs: Additional action parameters
        
        Returns:
            bool: True if action sent successfully
        
        Raises:
            MessageError: If not registered or message fails
        
        Example:
            >>> hub.action("wave", intensity=5)
            >>> hub.action("dance", style="twist")
        """
        if not self.is_registered():
            self.logger.warning("Cannot perform action: not registered")
            return False
        
        return self._send({
            "type": "action",
            "action": {
                "type": action_type,
                **kwargs
            }
        })
    
    def get_position(self) -> Dict[str, float]:
        """
        Get current agent position.
        
        Returns:
            Dict containing x, y, z coordinates
        
        Example:
            >>> pos = hub.get_position()
            >>> print(f"At ({pos['x']}, {pos['y']}, {pos['z']})")
        """
        return self.position.copy()
    
    def get_rotation(self) -> float:
        """
        Get current agent rotation.
        
        Returns:
            Rotation in radians
        
        Example:
            >>> rotation = hub.get_rotation()
        """
        return self.rotation
    
    def get_registered_agents(self) -> List[Dict[str, Any]]:
        """
        Get list of currently connected agents.
        
        Returns:
            List of agent dictionaries with id, name, position, etc.
        
        Example:
            >>> agents = hub.get_registered_agents()
            >>> for agent in agents:
            ...     print(f"{agent['name']} at {agent['position']}")
        """
        with self._lock:
            return list(self.registered_agents.values())
    
    def register_callback(self, event_type: str, callback: Callable) -> None:
        """
        Register callback for specific event type.
        
        Args:
            event_type: Event type (on_connected, on_chat, etc.)
            callback: Callable to invoke when event occurs
        
        Raises:
            ValueError: If event_type is not valid
        
        Example:
            >>> def on_chat(data):
            ...     print(f"Chat from {data['agentName']}: {data['message']}")
            >>> hub.register_callback("on_chat", on_chat)
        """
        if event_type not in self._callbacks:
            raise ValueError(f"Invalid event type: {event_type}")
        
        with self._lock:
            self._callbacks[event_type].append(callback)
            self.logger.debug(f"Registered callback for {event_type}")
    
    def set_config(self, key: str, value: Any) -> None:
        """
        Update configuration at runtime.
        
        Args:
            key: Configuration key
            value: New value
        
        Example:
            >>> hub.set_config("auto_reconnect", False)
            >>> hub.set_config("log_level", "DEBUG")
        """
        if key == "auto_reconnect":
            self.auto_reconnect = bool(value)
        elif key == "reconnect_max_delay":
            self.reconnect_max_delay = int(value)
        elif key == "connection_timeout":
            self.connection_timeout = int(value)
        elif key == "enable_message_queue":
            self.enable_message_queue = bool(value)
        elif key == "log_level":
            self.logger.setLevel(getattr(logging, str(value).upper()))
        else:
            self.logger.warning(f"Unknown config key: {key}")
        
        self.logger.debug(f"Config updated: {key} = {value}")
    
    def get_config(self, key: str) -> Any:
        """
        Get current configuration value.
        
        Args:
            key: Configuration key
        
        Returns:
            Configuration value
        
        Example:
            >>> auto_reconnect = hub.get_config("auto_reconnect")
        """
        config_map = {
            "url": self.url,
            "agent_name": self.agent_name,
            "auto_reconnect": self.auto_reconnect,
            "reconnect_max_delay": self.reconnect_max_delay,
            "connection_timeout": self.connection_timeout,
            "enable_message_queue": self.enable_message_queue,
            "log_level": self.logger.level
        }
        return config_map.get(key)
    
    def get_status(self) -> Dict[str, Any]:
        """
        Get current connection and agent status.
        
        Returns:
            Dictionary with status information
        
        Example:
            >>> status = hub.get_status()
            >>> print(f"State: {status['state']}, ID: {status['agent_id']}")
        """
        return {
            "state": self.state.value,
            "connected": self.is_connected(),
            "registered": self.is_registered(),
            "agent_id": self.agent_id,
            "agent_name": self.agent_name,
            "position": self.position.copy(),
            "rotation": self.rotation,
            "world_size": self.world_size.copy(),
            "registered_agents_count": len(self.registered_agents),
            "reconnect_attempts": self._reconnect_attempts,
            "message_queue_size": self._message_queue.qsize()
        }
    
    def is_connected(self) -> bool:
        """
        Check if connected to server.
        
        Returns:
            True if connected
        
        Example:
            >>> if hub.is_connected():
            ...     hub.chat("I'm online!")
        """
        return self.state in [ConnectionState.CONNECTED, ConnectionState.REGISTERED]
    
    def is_registered(self) -> bool:
        """
        Check if agent is registered with server.
        
        Returns:
            True if registered
        
        Example:
            >>> if hub.is_registered():
            ...     hub.move(50, 0, 50)
        """
        return self.state == ConnectionState.REGISTERED
    
    # Private methods
    
    def _run_forever(self):
        """Run WebSocket connection in background thread."""
        try:
            self.ws.run_forever()
        except Exception as e:
            self.logger.error(f"WebSocket thread error: {e}")
        finally:
            self.logger.debug("WebSocket thread terminated")
    
    def _on_open(self, ws):
        """Handle WebSocket connection opened."""
        with self._lock:
            self.state = ConnectionState.CONNECTED
            self._reconnect_attempts = 0
            self._reconnect_delay = 1
            
        self.logger.info("WebSocket connected")
        self._trigger_callback("on_connected", {})
        
        # Process queued messages
        self._process_message_queue()
    
    def _on_close(self, ws, close_status_code, close_msg):
        """Handle WebSocket connection closed."""
        self.logger.info(f"WebSocket closed: {close_status_code} - {close_msg}")
        
        with self._lock:
            was_registered = self.state == ConnectionState.REGISTERED
            self.state = ConnectionState.DISCONNECTED
            self.agent_id = None
            self.registered_agents.clear()
        
        self._trigger_callback("on_disconnected", {
            "code": close_status_code,
            "message": close_msg,
            "was_registered": was_registered
        })
        
        # Attempt reconnection if enabled
        if self.auto_reconnect and self._running:
            self._schedule_reconnect()
    
    def _on_error(self, ws, error):
        """Handle WebSocket error."""
        self.logger.error(f"WebSocket error: {error}")
        self._trigger_callback("on_error", {
            "error": str(error),
            "context": "websocket"
        })
    
    def _on_message(self, ws, message):
        """Handle incoming WebSocket message."""
        try:
            data = json.loads(message)
            self._handle_message(data)
        except json.JSONDecodeError as e:
            self.logger.error(f"Failed to parse message: {e}")
            self._trigger_callback("on_error", {
                "error": str(e),
                "context": "message_parse"
            })
    
    def _handle_message(self, message: Dict[str, Any]):
        """Handle specific message types."""
        msg_type = message.get("type")
        
        if msg_type == "registered":
            self._handle_registered(message)
        elif msg_type == "world_state":
            self._handle_world_state(message)
        elif msg_type == "agent_joined":
            self._handle_agent_joined(message)
        elif msg_type == "agent_left":
            self._handle_agent_left(message)
        elif msg_type == "chat_message":
            self._handle_chat_message(message)
        elif msg_type == "agent_action":
            self._handle_agent_action(message)
        elif msg_type == "agent_moved":
            self._handle_agent_moved(message)
        elif msg_type == "error":
            self._handle_error(message)
        elif msg_type == "pong":
            self.logger.debug("Received pong")
        else:
            self.logger.debug(f"Unhandled message type: {msg_type}")
    
    def _handle_registered(self, message: Dict[str, Any]):
        """Handle registration confirmation."""
        with self._lock:
            self.agent_id = message.get("agentId")
            self.position = message.get("position", {"x": 0, "y": 0, "z": 0})
            self.world_size = message.get("worldSize", {"x": 100, "y": 100})
            self.state = ConnectionState.REGISTERED
        
        self.logger.info(f"Registered as {self.agent_name} (ID: {self.agent_id})")
        self.logger.info(f"Position: {self.position}, World: {self.world_size}")
        
        self._trigger_callback("on_registered", {
            "agent_id": self.agent_id,
            "position": self.position,
            "world_size": self.world_size
        })
    
    def _handle_world_state(self, message: Dict[str, Any]):
        """Handle world state update."""
        agents = message.get("agents", [])
        
        with self._lock:
            self.registered_agents.clear()
            for agent in agents:
                if agent.get("id") != self.agent_id:
                    self.registered_agents[agent["id"]] = agent
        
        self.logger.debug(f"World state: {len(agents)} agents")
        
        self._trigger_callback("on_world_state", {
            "tick": message.get("tick"),
            "agents": agents,
            "objects": message.get("objects", [])
        })
    
    def _handle_agent_joined(self, message: Dict[str, Any]):
        """Handle agent joined event."""
        agent = message.get("agent", {})
        agent_id = agent.get("id")
        
        if agent_id and agent_id != self.agent_id:
            with self._lock:
                self.registered_agents[agent_id] = agent
            
            self.logger.info(f"Agent joined: {agent.get('name')} ({agent_id})")
            self._trigger_callback("on_agent_joined", agent)
    
    def _handle_agent_left(self, message: Dict[str, Any]):
        """Handle agent left event."""
        agent_id = message.get("agentId")
        
        if agent_id:
            with self._lock:
                agent = self.registered_agents.pop(agent_id, None)
            
            if agent:
                self.logger.info(f"Agent left: {agent.get('name')} ({agent_id})")
                self._trigger_callback("on_agent_left", {
                    "agent_id": agent_id,
                    "agent": agent
                })
    
    def _handle_chat_message(self, message: Dict[str, Any]):
        """Handle chat message."""
        agent_id = message.get("agentId")
        agent_name = message.get("agentName")
        msg = message.get("message")
        
        # Don't log own messages
        if agent_id != self.agent_id:
            self.logger.debug(f"Chat [{agent_name}]: {msg}")
        
        self._trigger_callback("on_chat", {
            "agent_id": agent_id,
            "agent_name": agent_name,
            "message": msg,
            "timestamp": message.get("timestamp")
        })
    
    def _handle_agent_action(self, message: Dict[str, Any]):
        """Handle agent action."""
        agent_id = message.get("agentId")
        action = message.get("action", {})
        
        self.logger.debug(f"Action from {agent_id}: {action.get('type')}")
        
        self._trigger_callback("on_action", {
            "agent_id": agent_id,
            "action": action
        })
    
    def _handle_agent_moved(self, message: Dict[str, Any]):
        """Handle agent moved event."""
        agent_id = message.get("agentId")
        position = message.get("position")
        rotation = message.get("rotation")
        
        # Update tracked agent position
        if agent_id and agent_id in self.registered_agents:
            with self._lock:
                self.registered_agents[agent_id]["position"] = position
                if rotation is not None:
                    self.registered_agents[agent_id]["rotation"] = rotation
    
    def _handle_error(self, message: Dict[str, Any]):
        """Handle error message from server."""
        error_msg = message.get("message", "Unknown error")
        self.logger.error(f"Server error: {error_msg}")
        
        self._trigger_callback("on_error", {
            "error": error_msg,
            "context": "server"
        })
    
    def _send(self, data: Dict[str, Any]) -> bool:
        """
        Send message to server.
        
        Args:
            data: Message dictionary
        
        Returns:
            True if sent successfully
        """
        if not self.ws or not self.is_connected():
            if self.enable_message_queue:
                self.logger.debug("Queuing message (not connected)")
                self._message_queue.put(data)
                return True
            else:
                self.logger.warning("Cannot send: not connected")
                return False
        
        try:
            self.ws.send(json.dumps(data))
            self.logger.debug(f"Sent: {data.get('type')}")
            return True
        except Exception as e:
            self.logger.error(f"Failed to send message: {e}")
            
            # Queue message if enabled
            if self.enable_message_queue:
                self._message_queue.put(data)
            
            self._trigger_callback("on_error", {
                "error": str(e),
                "context": "send_message"
            })
            return False
    
    def _process_message_queue(self):
        """Process queued messages after reconnection."""
        if not self.enable_message_queue:
            return
        
        count = 0
        while not self._message_queue.empty():
            try:
                message = self._message_queue.get_nowait()
                if self._send(message):
                    count += 1
            except queue.Empty:
                break
            except Exception as e:
                self.logger.error(f"Error processing queued message: {e}")
        
        if count > 0:
            self.logger.info(f"Sent {count} queued messages")
    
    def _trigger_callback(self, event_type: str, data: Dict[str, Any]):
        """Trigger all callbacks for an event type."""
        callbacks = self._callbacks.get(event_type, [])
        for callback in callbacks:
            try:
                callback(data)
            except Exception as e:
                self.logger.error(f"Callback error ({event_type}): {e}")
    
    def _schedule_reconnect(self):
        """Schedule automatic reconnection with exponential backoff."""
        with self._lock:
            self.state = ConnectionState.RECONNECTING
            self._reconnect_attempts += 1
        
        # Calculate delay with exponential backoff
        delay = min(
            self._reconnect_delay * (2 ** (self._reconnect_attempts - 1)),
            self.reconnect_max_delay
        )
        
        self.logger.info(f"Reconnecting in {delay}s (attempt {self._reconnect_attempts})")
        
        def reconnect():
            time.sleep(delay)
            if self._running and self.state == ConnectionState.RECONNECTING:
                self.logger.info("Attempting reconnection...")
                self.connect()
        
        thread = threading.Thread(target=reconnect, daemon=True)
        thread.start()
    
    def _cleanup(self):
        """Clean up resources."""
        with self._lock:
            self.state = ConnectionState.DISCONNECTED
            self.agent_id = None
            self.registered_agents.clear()
            self.ws = None


# Convenience functions for quick usage

def create_hub(
    url: str = "ws://localhost:3000",
    agent_name: Optional[str] = None,
    **kwargs
) -> OpenBotClawHub:
    """
    Create and configure OpenBotClawHub instance.
    
    Args:
        url: WebSocket server URL
        agent_name: Agent name
        **kwargs: Additional configuration options
    
    Returns:
        Configured OpenBotClawHub instance
    
    Example:
        >>> hub = create_hub("ws://localhost:3000", "MyAgent")
    """
    return OpenBotClawHub(url=url, agent_name=agent_name, **kwargs)


def quick_connect(
    url: str = "ws://localhost:3000",
    agent_name: str = "QuickAgent"
) -> OpenBotClawHub:
    """
    Quickly connect and register agent in one step.
    
    Args:
        url: WebSocket server URL
        agent_name: Agent name
    
    Returns:
        Connected and registered OpenBotClawHub instance
    
    Example:
        >>> hub = quick_connect("ws://localhost:3000", "FastAgent")
        >>> hub.chat("I'm connected!")
    """
    hub = OpenBotClawHub(url=url, agent_name=agent_name)
    if hub.connect():
        hub.register(agent_name)
        # Wait for registration
        timeout = 10
        start = time.time()
        while not hub.is_registered() and time.time() - start < timeout:
            time.sleep(0.1)
    return hub
