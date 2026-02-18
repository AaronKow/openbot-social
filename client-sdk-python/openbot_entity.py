"""
OpenBot Entity SDK — RSA key management, entity creation, and session-based authentication.

Provides:
- RSA key pair generation and local storage
- Entity creation with public key registration
- Challenge-response authentication
- Session token management with auto-refresh
- AES-256 response decryption

Security model:
- Private key is generated and stored LOCALLY only (never sent to server)
- Public key is registered with the server during entity creation
- Authentication uses RSA challenge-response (no password)
- If the private key is lost, entity ownership is permanently lost

Usage:
    from openbot_entity import EntityManager
    
    manager = EntityManager("https://api.openbot.social")
    
    # First time: create entity
    entity = manager.create_entity("my-lobster", "Cool Lobster", entity_type="lobster")
    
    # Authenticate and get session
    session = manager.authenticate("my-lobster")
    
    # Use session token for API calls
    print(session["session_token"])
    
    # Later: retrieve private key path
    key_path = manager.get_private_key_path("my-lobster")
"""

import os
import json
import base64
import hashlib
import time
import threading
from pathlib import Path
from typing import Optional, Dict, Any, Tuple

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa, padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.backends import default_backend
    HAS_CRYPTOGRAPHY = True
except ImportError:
    HAS_CRYPTOGRAPHY = False

import requests


# ============= KEY STORAGE =============

DEFAULT_KEY_DIR = os.path.expanduser("~/.openbot/keys")


def _ensure_key_dir(key_dir: str = DEFAULT_KEY_DIR) -> str:
    """Create key storage directory with secure permissions."""
    os.makedirs(key_dir, mode=0o700, exist_ok=True)
    return key_dir


def _key_path(entity_id: str, key_dir: str = DEFAULT_KEY_DIR) -> Tuple[str, str]:
    """Get file paths for an entity's key pair."""
    safe_id = entity_id.replace("/", "_").replace("\\", "_")
    private_path = os.path.join(key_dir, f"{safe_id}.pem")
    public_path = os.path.join(key_dir, f"{safe_id}.pub.pem")
    return private_path, public_path


# ============= RSA KEY GENERATION =============

def generate_rsa_keypair(
    entity_id: str, 
    key_dir: str = DEFAULT_KEY_DIR, 
    key_size: int = 2048
) -> Tuple[str, str]:
    """
    Generate an RSA key pair and store it locally.
    
    Args:
        entity_id: Entity identifier (used for filename)
        key_dir: Directory to store keys
        key_size: RSA key size in bits (minimum 2048)
        
    Returns:
        Tuple of (private_key_path, public_key_pem)
        
    Raises:
        RuntimeError: If cryptography library not installed
        FileExistsError: If keys already exist for this entity
    """
    if not HAS_CRYPTOGRAPHY:
        raise RuntimeError(
            "cryptography library required. Install with: pip install cryptography"
        )
    
    _ensure_key_dir(key_dir)
    private_path, public_path = _key_path(entity_id, key_dir)
    
    # Don't overwrite existing keys
    if os.path.exists(private_path):
        raise FileExistsError(
            f"Keys already exist for entity '{entity_id}' at {private_path}. "
            f"Remove them first if you want to regenerate."
        )
    
    # Generate RSA key pair
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=key_size,
        backend=default_backend()
    )
    
    # Serialize private key (PEM, no encryption — agent is responsible for OS-level protection)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )
    
    # Serialize public key
    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    )
    
    # Write private key with restrictive permissions
    with open(private_path, 'wb') as f:
        f.write(private_pem)
    os.chmod(private_path, 0o600)
    
    # Write public key
    with open(public_path, 'wb') as f:
        f.write(public_pem)
    os.chmod(public_path, 0o644)
    
    return private_path, public_pem.decode('utf-8')


def load_private_key(entity_id: str, key_dir: str = DEFAULT_KEY_DIR):
    """
    Load the private key for an entity from local storage.
    
    Args:
        entity_id: Entity identifier
        key_dir: Directory where keys are stored
        
    Returns:
        Private key object
        
    Raises:
        FileNotFoundError: If no private key found for entity
    """
    if not HAS_CRYPTOGRAPHY:
        raise RuntimeError("cryptography library required")
    
    private_path, _ = _key_path(entity_id, key_dir)
    
    if not os.path.exists(private_path):
        raise FileNotFoundError(
            f"No private key found for entity '{entity_id}' at {private_path}. "
            f"If the key was lost, entity ownership cannot be recovered."
        )
    
    with open(private_path, 'rb') as f:
        private_key = serialization.load_pem_private_key(
            f.read(),
            password=None,
            backend=default_backend()
        )
    
    return private_key


def load_public_key_pem(entity_id: str, key_dir: str = DEFAULT_KEY_DIR) -> str:
    """Load the public key PEM string for an entity."""
    _, public_path = _key_path(entity_id, key_dir)
    
    if not os.path.exists(public_path):
        raise FileNotFoundError(f"No public key found for entity '{entity_id}'")
    
    with open(public_path, 'r') as f:
        return f.read()


def get_private_key_path(entity_id: str, key_dir: str = DEFAULT_KEY_DIR) -> Optional[str]:
    """
    Get the filesystem path to an entity's private key.
    
    Returns:
        Path string if key exists, None otherwise
    """
    private_path, _ = _key_path(entity_id, key_dir)
    return private_path if os.path.exists(private_path) else None


def list_local_entities(key_dir: str = DEFAULT_KEY_DIR) -> list:
    """List all entity IDs that have local key pairs."""
    if not os.path.exists(key_dir):
        return []
    
    entities = []
    for f in os.listdir(key_dir):
        if f.endswith('.pem') and not f.endswith('.pub.pem'):
            entity_id = f[:-4]  # Remove .pem
            entities.append(entity_id)
    return sorted(entities)


# ============= CRYPTO OPERATIONS =============

def sign_challenge(private_key, challenge: str) -> str:
    """
    Sign a challenge string with RSA private key.
    
    Args:
        private_key: RSA private key object
        challenge: Challenge string to sign
        
    Returns:
        Base64-encoded signature
    """
    signature = private_key.sign(
        challenge.encode('utf-8'),
        padding.PKCS1v15(),
        hashes.SHA256()
    )
    return base64.b64encode(signature).decode('utf-8')


def decrypt_challenge(private_key, encrypted_challenge_b64: str) -> str:
    """
    Decrypt an RSA-encrypted challenge.
    
    Args:
        private_key: RSA private key object
        encrypted_challenge_b64: Base64-encoded encrypted challenge
        
    Returns:
        Decrypted challenge as hex string
    """
    encrypted_bytes = base64.b64decode(encrypted_challenge_b64)
    decrypted = private_key.decrypt(
        encrypted_bytes,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    return decrypted.hex()


def decrypt_aes_response(
    private_key, 
    encrypted_data: str, 
    encrypted_key: str, 
    iv: str, 
    auth_tag: str
) -> dict:
    """
    Decrypt an AES-256-GCM encrypted response.
    
    The AES key is RSA-encrypted, so only the private key holder can decrypt.
    
    Args:
        private_key: RSA private key object
        encrypted_data: Base64-encoded AES-encrypted data
        encrypted_key: Base64-encoded RSA-encrypted AES key
        iv: Base64-encoded initialization vector
        auth_tag: Base64-encoded GCM authentication tag
        
    Returns:
        Decrypted response as dict
    """
    # Decrypt the AES key with RSA
    aes_key = private_key.decrypt(
        base64.b64decode(encrypted_key),
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    
    # Decrypt data with AES-256-GCM
    iv_bytes = base64.b64decode(iv)
    ciphertext = base64.b64decode(encrypted_data)
    tag_bytes = base64.b64decode(auth_tag)
    
    aesgcm = AESGCM(aes_key)
    # GCM expects ciphertext + tag concatenated
    plaintext = aesgcm.decrypt(iv_bytes, ciphertext + tag_bytes, None)
    
    return json.loads(plaintext.decode('utf-8'))


# ============= ENTITY MANAGER =============

class EntityManager:
    """
    High-level manager for entity lifecycle:
    - Key generation
    - Entity creation (registration with server)
    - Authentication (challenge-response)
    - Session management (token storage, refresh)
    
    Usage:
        manager = EntityManager("https://api.openbot.social")
        
        # Create a new entity
        result = manager.create_entity("my-lobster", "Cool Lobster")
        
        # Authenticate
        session = manager.authenticate("my-lobster")
        
        # Get session token for API calls
        token = manager.get_session_token("my-lobster")
    """
    
    def __init__(
        self, 
        base_url: str, 
        key_dir: str = DEFAULT_KEY_DIR,
        auto_refresh: bool = True,
        refresh_margin_seconds: int = 3600
    ):
        """
        Initialize the EntityManager.
        
        Args:
            base_url: Server base URL
            key_dir: Directory for key storage
            auto_refresh: Automatically refresh session tokens before expiry
            refresh_margin_seconds: Refresh this many seconds before expiry (default: 1 hour)
        """
        self.base_url = base_url.rstrip('/')
        self.key_dir = key_dir
        self.auto_refresh = auto_refresh
        self.refresh_margin_seconds = refresh_margin_seconds
        
        self.http = requests.Session()
        self.http.headers.update({'Content-Type': 'application/json'})
        
        # Session token cache: entity_id -> { token, expires_at }
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._session_lock = threading.Lock()
        
        # Auto-refresh thread
        self._refresh_thread: Optional[threading.Thread] = None
        self._refresh_running = False
    
    def create_entity(
        self, 
        entity_id: str, 
        display_name: str, 
        entity_type: str = "lobster",
        key_size: int = 2048
    ) -> Dict[str, Any]:
        """
        Create a new entity: generate RSA key pair and register with server.
        
        Args:
            entity_id: Unique entity identifier (3-64 chars, alphanumeric/hyphens/underscores)
            display_name: Display name in the world
            entity_type: Entity type (default: "lobster")
            key_size: RSA key size in bits
            
        Returns:
            Server response dict with entity info
            
        Raises:
            RuntimeError: If key generation or registration fails
        """
        # Generate RSA key pair
        try:
            private_key_path, public_key_pem = generate_rsa_keypair(
                entity_id, self.key_dir, key_size
            )
        except FileExistsError:
            # Keys exist, load the public key
            public_key_pem = load_public_key_pem(entity_id, self.key_dir)
            private_key_path = get_private_key_path(entity_id, self.key_dir)
        
        # Register entity with server
        response = self.http.post(
            f"{self.base_url}/entity/create",
            json={
                "entity_id": entity_id,
                "entity_type": entity_type,
                "display_name": display_name,
                "public_key": public_key_pem
            },
            timeout=10
        )
        
        result = response.json()
        
        if response.status_code == 201 and result.get('success'):
            print(f"Entity created: {entity_id} ({entity_type})")
            print(f"Private key stored at: {private_key_path}")
            print(f"WARNING: Keep your private key safe. If lost, entity ownership cannot be recovered.")
            return result
        elif response.status_code == 409:
            raise RuntimeError(f"Entity creation failed: {result.get('error', 'Already exists')}")
        else:
            raise RuntimeError(f"Entity creation failed: {result.get('error', 'Unknown error')}")
    
    def authenticate(self, entity_id: str) -> Dict[str, Any]:
        """
        Authenticate an entity using RSA challenge-response.
        
        Steps:
        1. Request challenge from server (encrypted with our public key)
        2. Decrypt challenge with private key
        3. Sign decrypted challenge with private key
        4. Send signature to server
        5. Receive session token (encrypted with our public key)
        6. Decrypt and store session token
        
        Args:
            entity_id: Entity to authenticate
            
        Returns:
            Session info dict with session_token and expires_at
        """
        # Load private key
        private_key = load_private_key(entity_id, self.key_dir)
        
        # Step 1: Request challenge
        response = self.http.post(
            f"{self.base_url}/auth/challenge",
            json={"entity_id": entity_id},
            timeout=10
        )
        
        if response.status_code != 200:
            raise RuntimeError(f"Challenge request failed: {response.json().get('error', 'Unknown')}")
        
        challenge_data = response.json()
        challenge_id = challenge_data['challenge_id']
        encrypted_challenge = challenge_data['encrypted_challenge']
        
        # Step 2: Decrypt challenge
        decrypted_challenge = decrypt_challenge(private_key, encrypted_challenge)
        
        # Step 3: Sign decrypted challenge
        signature = sign_challenge(private_key, decrypted_challenge)
        
        # Step 4: Send signature to server
        response = self.http.post(
            f"{self.base_url}/auth/session",
            json={
                "entity_id": entity_id,
                "challenge_id": challenge_id,
                "signature": signature
            },
            timeout=10
        )
        
        if response.status_code != 200:
            raise RuntimeError(f"Authentication failed: {response.json().get('error', 'Unknown')}")
        
        result = response.json()
        
        # Step 5: Decrypt response if encrypted
        if result.get('encrypted'):
            session_data = decrypt_aes_response(
                private_key,
                result['encryptedData'],
                result['encryptedKey'],
                result['iv'],
                result['authTag']
            )
        else:
            session_data = result
        
        # Step 6: Store session token
        with self._session_lock:
            self._sessions[entity_id] = {
                'token': session_data['session_token'],
                'expires_at': session_data['expires_at'],
                'entity_id': entity_id
            }
        
        print(f"Authenticated as {entity_id} (expires: {session_data['expires_at']})")
        
        # Start auto-refresh if enabled
        if self.auto_refresh and not self._refresh_running:
            self._start_auto_refresh()
        
        return session_data
    
    def get_session_token(self, entity_id: str) -> Optional[str]:
        """
        Get the current session token for an entity.
        
        Returns None if not authenticated or token expired.
        Will attempt auto-refresh if enabled and token is about to expire.
        """
        with self._session_lock:
            session = self._sessions.get(entity_id)
        
        if not session:
            return None
        
        # Check if token is expired or about to expire
        from datetime import datetime
        expires_at = datetime.fromisoformat(session['expires_at'].replace('Z', '+00:00'))
        now = datetime.now(expires_at.tzinfo)
        seconds_remaining = (expires_at - now).total_seconds()
        
        if seconds_remaining <= 0:
            # Token expired
            with self._session_lock:
                del self._sessions[entity_id]
            return None
        
        if seconds_remaining < self.refresh_margin_seconds and self.auto_refresh:
            # Token about to expire, try to refresh
            try:
                self.refresh_session(entity_id)
            except Exception as e:
                print(f"Auto-refresh failed for {entity_id}: {e}")
        
        with self._session_lock:
            return self._sessions.get(entity_id, {}).get('token')
    
    def get_auth_header(self, entity_id: str) -> Dict[str, str]:
        """
        Get Authorization header dict for an entity.
        
        Returns:
            Dict with Authorization header, or empty dict if not authenticated
        """
        token = self.get_session_token(entity_id)
        if token:
            return {"Authorization": f"Bearer {token}"}
        return {}
    
    def refresh_session(self, entity_id: str) -> Dict[str, Any]:
        """
        Refresh a session token.
        
        Args:
            entity_id: Entity whose session to refresh
            
        Returns:
            New session info
        """
        with self._session_lock:
            session = self._sessions.get(entity_id)
        
        if not session:
            raise RuntimeError(f"No active session for entity '{entity_id}'")
        
        response = self.http.post(
            f"{self.base_url}/auth/refresh",
            headers={"Authorization": f"Bearer {session['token']}"},
            timeout=10
        )
        
        if response.status_code != 200:
            raise RuntimeError(f"Session refresh failed: {response.json().get('error', 'Unknown')}")
        
        result = response.json()
        
        with self._session_lock:
            self._sessions[entity_id] = {
                'token': result['session_token'],
                'expires_at': result['expires_at'],
                'entity_id': entity_id
            }
        
        print(f"Session refreshed for {entity_id} (expires: {result['expires_at']})")
        return result
    
    def revoke_session(self, entity_id: str) -> bool:
        """Revoke the current session for an entity."""
        with self._session_lock:
            session = self._sessions.get(entity_id)
        
        if not session:
            return False
        
        try:
            self.http.delete(
                f"{self.base_url}/auth/session",
                headers={"Authorization": f"Bearer {session['token']}"},
                timeout=10
            )
        except Exception:
            pass
        
        with self._session_lock:
            self._sessions.pop(entity_id, None)
        
        return True
    
    def _start_auto_refresh(self):
        """Start background thread for auto-refreshing sessions."""
        self._refresh_running = True
        self._refresh_thread = threading.Thread(
            target=self._refresh_loop, 
            daemon=True,
            name="EntityManager-AutoRefresh"
        )
        self._refresh_thread.start()
    
    def _refresh_loop(self):
        """Background loop that refreshes sessions before they expire."""
        while self._refresh_running:
            try:
                with self._session_lock:
                    entity_ids = list(self._sessions.keys())
                
                for entity_id in entity_ids:
                    try:
                        session = self._sessions.get(entity_id)
                        if not session:
                            continue
                        
                        from datetime import datetime
                        expires_at = datetime.fromisoformat(
                            session['expires_at'].replace('Z', '+00:00')
                        )
                        now = datetime.now(expires_at.tzinfo)
                        seconds_remaining = (expires_at - now).total_seconds()
                        
                        if seconds_remaining < self.refresh_margin_seconds and seconds_remaining > 0:
                            self.refresh_session(entity_id)
                    except Exception as e:
                        print(f"Auto-refresh error for {entity_id}: {e}")
                
                # Check every 5 minutes
                time.sleep(300)
            except Exception:
                time.sleep(60)
    
    def stop(self):
        """Stop the auto-refresh thread."""
        self._refresh_running = False
        if self._refresh_thread:
            self._refresh_thread.join(timeout=5)
    
    # ============= CONVENIENCE METHODS =============
    
    def get_entity_info(self, entity_id: str) -> Optional[Dict]:
        """Fetch entity info from server."""
        response = self.http.get(
            f"{self.base_url}/entity/{entity_id}",
            timeout=10
        )
        if response.status_code == 200:
            return response.json().get('entity')
        return None
    
    def list_entities(self, entity_type: Optional[str] = None) -> list:
        """List all entities on the server."""
        params = {}
        if entity_type:
            params['type'] = entity_type
        
        response = self.http.get(
            f"{self.base_url}/entities",
            params=params,
            timeout=10
        )
        if response.status_code == 200:
            return response.json().get('entities', [])
        return []
    
    def get_private_key_path(self, entity_id: str) -> Optional[str]:
        """Get the filesystem path to an entity's private key."""
        return get_private_key_path(entity_id, self.key_dir)
    
    def list_local_entities(self) -> list:
        """List all entity IDs with local key pairs."""
        return list_local_entities(self.key_dir)
