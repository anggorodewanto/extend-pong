// Pong Multiplayer Module
// Handles AGS Lobby WebSocket, Matchmaking, Sessions, and P2P connection

// Multiplayer State Machine
const MultiplayerState = {
  IDLE: 'idle',
  CONNECTING_LOBBY: 'connecting_lobby',
  LOBBY_CONNECTED: 'lobby_connected',
  QUEUING: 'queuing',
  MATCHED: 'matched',
  JOINING_SESSION: 'joining_session',
  IN_SESSION: 'in_session',
  CONNECTING_P2P: 'connecting_p2p',
  PLAYING: 'playing',
  RECONNECTING: 'reconnecting',
  FINISHED: 'finished',
  ERROR: 'error'
};

class LobbyWebSocket {
  constructor(baseUrl, namespace, accessToken) {
    this.baseUrl = baseUrl;
    this.namespace = namespace;
    this.accessToken = accessToken;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.handlers = new Map();
    this.isConnected = false;
    this.pingInterval = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Convert https to wss
      const wsUrl = this.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      const url = `${wsUrl}/lobby`;

      console.log('[Lobby] Connecting to WebSocket...');
      // Pass token via Sec-WebSocket-Protocol header (lobby server extracts it for auth)
      this.ws = new WebSocket(url, this.accessToken);

      const timeout = setTimeout(() => {
        if (!this.isConnected) {
          this.ws.close();
          reject(new Error('Lobby connection timeout'));
        }
      }, CONFIG.MULTIPLAYER.CONNECTION_TIMEOUT_MS);

      this.ws.onopen = () => {
        console.log('[Lobby] WebSocket connected');
        clearTimeout(timeout);
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this._startPing();
        resolve();
      };

      this.ws.onmessage = (event) => {
        this._handleMessage(event.data);
      };

      this.ws.onerror = (error) => {
        console.error('[Lobby] WebSocket error:', error);
        clearTimeout(timeout);
        reject(error);
      };

      this.ws.onclose = (event) => {
        console.log('[Lobby] WebSocket closed:', event.code, event.reason);
        this.isConnected = false;
        this._stopPing();
        this._emit('disconnected', { code: event.code, reason: event.reason });
      };
    });
  }

  disconnect() {
    this._stopPing();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.isConnected = false;
  }

  on(eventType, handler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType).push(handler);
  }

  off(eventType, handler) {
    if (this.handlers.has(eventType)) {
      const handlers = this.handlers.get(eventType);
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  _emit(eventType, data) {
    if (this.handlers.has(eventType)) {
      this.handlers.get(eventType).forEach(handler => {
        try {
          handler(data);
        } catch (err) {
          console.error(`[Lobby] Handler error for ${eventType}:`, err);
        }
      });
    }
  }

  _handleMessage(rawData) {
    try {
      // AGS Lobby messages can be in different formats
      // Try JSON first, then handle text-based protocol
      let message;
      try {
        message = JSON.parse(rawData);
      } catch {
        // Handle text-based AGS lobby protocol
        message = this._parseTextMessage(rawData);
      }

      if (!message) {
        console.warn('[Lobby] Unknown message format:', rawData);
        return;
      }

      console.log('[Lobby] Received:', message.type || message.code, message);

      // Emit based on message type
      const type = message.type || message.code;
      this._emit(type, message);
      this._emit('message', message);

    } catch (err) {
      console.error('[Lobby] Failed to handle message:', err, rawData);
    }
  }

  _parseTextMessage(data) {
    // AGS Lobby uses a text protocol like: type: value\nkey: value\n...
    const lines = data.split('\n');
    const message = {};

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        message[key] = value;
      }
    }

    return Object.keys(message).length > 0 ? message : null;
  }

  _startPing() {
    this._stopPing();
    // Send heartbeat every 30 seconds to keep connection alive
    // Lobby server expects: type, messageID, userID fields
    // Server read timeout is 60s, ping at 50s, so 30s is safe
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
        const messageId = Date.now().toString();
        this.ws.send(`type: heartbeat\nmessageID: ${messageId}`);
      }
    }, 30000);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  send(message) {
    if (!this.isConnected || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    if (typeof message === 'object') {
      // Convert to AGS text protocol format
      const lines = Object.entries(message).map(([key, value]) => `${key}: ${value}`);
      this.ws.send(lines.join('\n'));
    } else {
      this.ws.send(message);
    }
  }
}

class PongMultiplayer {
  constructor() {
    this.state = MultiplayerState.IDLE;
    this.lobby = null;
    this.currentTicketId = null;
    this.currentSessionId = null;
    this.currentSession = null;
    this.isHost = false;
    this.opponentInfo = null;
    this.peerConnection = null;
    this.dataChannel = null;

    // Event handlers
    this.onStateChange = null;
    this.onMatchFound = null;
    this.onSessionJoined = null;
    this.onP2PConnected = null;
    this.onP2PDisconnected = null;
    this.onGameStateReceived = null;
    this.onError = null;
  }

  // State Management
  _setState(newState) {
    const oldState = this.state;
    this.state = newState;
    console.log(`[Multiplayer] State: ${oldState} -> ${newState}`);
    if (this.onStateChange) {
      this.onStateChange(newState, oldState);
    }
  }

  getState() {
    return this.state;
  }

  // Lobby Connection
  async connectLobby() {
    if (!pongAPI.isLoggedIn()) {
      throw new Error('Must be logged in to connect to lobby');
    }

    if (this.state !== MultiplayerState.IDLE && this.state !== MultiplayerState.ERROR) {
      console.log('[Multiplayer] Already connected or connecting');
      return;
    }

    this._setState(MultiplayerState.CONNECTING_LOBBY);

    try {
      this.lobby = new LobbyWebSocket(
        CONFIG.AGS_BASE_URL,
        CONFIG.NAMESPACE,
        pongAPI.accessToken
      );

      this._setupLobbyHandlers();
      await this.lobby.connect();
      this._setState(MultiplayerState.LOBBY_CONNECTED);

    } catch (error) {
      console.error('[Multiplayer] Lobby connection failed:', error);
      this._setState(MultiplayerState.ERROR);
      if (this.onError) {
        this.onError('Failed to connect to lobby: ' + error.message);
      }
      throw error;
    }
  }

  _setupLobbyHandlers() {
    // Matchmaking notifications
    this.lobby.on('matchmakingMatchFound', (data) => this._handleMatchFound(data));
    this.lobby.on('OnMatchFound', (data) => this._handleMatchFound(data));

    // Session notifications
    this.lobby.on('sessionV2InvitedUserToGameSession', (data) => this._handleSessionInvite(data));
    this.lobby.on('OnSessionInvited', (data) => this._handleSessionInvite(data));
    this.lobby.on('sessionV2MembersChanged', (data) => this._handleSessionMembersChanged(data));
    this.lobby.on('OnSessionMembersChanged', (data) => this._handleSessionMembersChanged(data));

    // Signaling messages (for WebRTC)
    this.lobby.on('sessionV2DSStatusChanged', (data) => this._handleSessionUpdate(data));
    this.lobby.on('sessionV2AttributesChanged', (data) => this._handleSessionAttributesChanged(data));

    // Connection events
    this.lobby.on('disconnected', (data) => this._handleLobbyDisconnect(data));
  }

  async disconnectLobby() {
    if (this.lobby) {
      this.lobby.disconnect();
      this.lobby = null;
    }
    this._setState(MultiplayerState.IDLE);
  }

  // Matchmaking
  async startMatchmaking() {
    if (this.state !== MultiplayerState.LOBBY_CONNECTED) {
      if (this.state === MultiplayerState.IDLE || this.state === MultiplayerState.ERROR) {
        await this.connectLobby();
      } else {
        throw new Error('Invalid state for matchmaking: ' + this.state);
      }
    }

    this._setState(MultiplayerState.QUEUING);

    try {
      const response = await fetch(
        `${CONFIG.AGS_BASE_URL}/match2/v1/namespaces/${CONFIG.NAMESPACE}/match-tickets`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            matchPool: CONFIG.MULTIPLAYER.MATCH_POOL,
            attributes: {}
          })
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || `Matchmaking failed: ${response.status}`);
      }

      const data = await response.json();
      this.currentTicketId = data.matchTicketID;
      console.log('[Multiplayer] Matchmaking ticket created:', this.currentTicketId);

      return this.currentTicketId;

    } catch (error) {
      console.error('[Multiplayer] Failed to start matchmaking:', error);
      this._setState(MultiplayerState.LOBBY_CONNECTED);
      if (this.onError) {
        this.onError('Failed to start matchmaking: ' + error.message);
      }
      throw error;
    }
  }

  async cancelMatchmaking() {
    if (!this.currentTicketId) {
      console.log('[Multiplayer] No active matchmaking ticket');
      return;
    }

    try {
      await fetch(
        `${CONFIG.AGS_BASE_URL}/match2/v1/namespaces/${CONFIG.NAMESPACE}/match-tickets/${this.currentTicketId}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`
          }
        }
      );

      console.log('[Multiplayer] Matchmaking cancelled');
      this.currentTicketId = null;
      this._setState(MultiplayerState.LOBBY_CONNECTED);

    } catch (error) {
      console.error('[Multiplayer] Failed to cancel matchmaking:', error);
      // Still clear local state
      this.currentTicketId = null;
      this._setState(MultiplayerState.LOBBY_CONNECTED);
    }
  }

  _handleMatchFound(data) {
    console.log('[Multiplayer] Match found:', data);
    this._setState(MultiplayerState.MATCHED);

    if (this.onMatchFound) {
      this.onMatchFound(data);
    }

    // Match found notification includes session info
    // We'll receive a session invite separately
  }

  // Session Management
  _handleSessionInvite(data) {
    console.log('[Multiplayer] Session invite received:', data);
    const sessionId = data.sessionID || data.sessionId;

    if (sessionId) {
      this.joinSession(sessionId);
    }
  }

  async joinSession(sessionId) {
    this._setState(MultiplayerState.JOINING_SESSION);
    this.currentSessionId = sessionId;

    try {
      // Join the game session
      const response = await fetch(
        `${CONFIG.AGS_BASE_URL}/session/v1/public/namespaces/${CONFIG.NAMESPACE}/gamesessions/${sessionId}/join`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || `Join session failed: ${response.status}`);
      }

      const session = await response.json();
      this.currentSession = session;

      // Determine if we're the host (session leader)
      this.isHost = session.leaderId === pongAPI.userId;

      // Find opponent
      const members = session.members || [];
      this.opponentInfo = members.find(m => m.id !== pongAPI.userId);

      console.log('[Multiplayer] Joined session:', {
        sessionId: session.id,
        isHost: this.isHost,
        opponent: this.opponentInfo
      });

      this._setState(MultiplayerState.IN_SESSION);

      if (this.onSessionJoined) {
        this.onSessionJoined({
          session: session,
          isHost: this.isHost,
          opponent: this.opponentInfo
        });
      }

      // If both players are in, start P2P connection
      if (members.length >= 2) {
        this._initiateP2PConnection();
      }

    } catch (error) {
      console.error('[Multiplayer] Failed to join session:', error);
      this._setState(MultiplayerState.ERROR);
      if (this.onError) {
        this.onError('Failed to join session: ' + error.message);
      }
      throw error;
    }
  }

  _handleSessionMembersChanged(data) {
    console.log('[Multiplayer] Session members changed:', data);

    // Update opponent info if new member joined
    if (this.state === MultiplayerState.IN_SESSION) {
      const members = data.members || [];
      this.opponentInfo = members.find(m => m.id !== pongAPI.userId);

      if (members.length >= 2 && !this.peerConnection) {
        this._initiateP2PConnection();
      }
    }
  }

  _handleSessionUpdate(data) {
    console.log('[Multiplayer] Session update:', data);
  }

  _handleSessionAttributesChanged(data) {
    console.log('[Multiplayer] Session attributes changed:', data);
    // Handle WebRTC signaling messages stored in session attributes
    this._processSignalingFromAttributes(data.attributes);
  }

  async leaveSession() {
    if (!this.currentSessionId) {
      return;
    }

    try {
      await fetch(
        `${CONFIG.AGS_BASE_URL}/session/v1/public/namespaces/${CONFIG.NAMESPACE}/gamesessions/${this.currentSessionId}/leave`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`
          }
        }
      );

      console.log('[Multiplayer] Left session');

    } catch (error) {
      console.error('[Multiplayer] Failed to leave session:', error);
    }

    this._cleanupP2P();
    this.currentSessionId = null;
    this.currentSession = null;
    this.opponentInfo = null;
    this._setState(MultiplayerState.LOBBY_CONNECTED);
  }

  // TURN Credentials
  async getTurnServers() {
    try {
      const response = await fetch(
        `${CONFIG.AGS_BASE_URL}/turnmanager/turn`,
        {
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get TURN servers: ${response.status}`);
      }

      return await response.json();

    } catch (error) {
      console.error('[Multiplayer] Failed to get TURN servers:', error);
      return [];
    }
  }

  async getTurnCredentials(region, ip, port) {
    try {
      const response = await fetch(
        `${CONFIG.AGS_BASE_URL}/turnmanager/turn/secret/${region}/${ip}/${port}`,
        {
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get TURN credentials: ${response.status}`);
      }

      return await response.json();

    } catch (error) {
      console.error('[Multiplayer] Failed to get TURN credentials:', error);
      return null;
    }
  }

  // P2P Connection
  async _initiateP2PConnection() {
    if (this.state === MultiplayerState.CONNECTING_P2P || this.state === MultiplayerState.PLAYING) {
      return;
    }

    this._setState(MultiplayerState.CONNECTING_P2P);

    try {
      // Get TURN servers and credentials
      const servers = await this.getTurnServers();
      let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // Fallback STUN

      if (servers && servers.length > 0) {
        const server = servers[0];
        const credentials = await this.getTurnCredentials(server.region, server.ip, server.port);

        if (credentials) {
          iceServers = [
            { urls: `stun:${server.ip}:${server.port}` },
            {
              urls: `turn:${server.ip}:${server.port}`,
              username: credentials.username,
              credential: credentials.password
            }
          ];
        }
      }

      console.log('[Multiplayer] ICE servers:', iceServers);

      // Create peer connection
      this.peerConnection = new RTCPeerConnection({ iceServers });

      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          this._sendSignaling({
            type: 'ice-candidate',
            candidate: event.candidate.toJSON()
          });
        }
      };

      this.peerConnection.onconnectionstatechange = () => {
        console.log('[Multiplayer] Connection state:', this.peerConnection.connectionState);

        if (this.peerConnection.connectionState === 'connected') {
          this._setState(MultiplayerState.PLAYING);
          if (this.onP2PConnected) {
            this.onP2PConnected();
          }
        } else if (this.peerConnection.connectionState === 'failed' ||
                   this.peerConnection.connectionState === 'disconnected') {
          if (this.onP2PDisconnected) {
            this.onP2PDisconnected();
          }
        }
      };

      this.peerConnection.ondatachannel = (event) => {
        console.log('[Multiplayer] Data channel received');
        this.dataChannel = event.channel;
        this._setupDataChannel();
      };

      // Host creates offer, guest waits for offer
      if (this.isHost) {
        await this._createOffer();
      }

    } catch (error) {
      console.error('[Multiplayer] P2P connection failed:', error);
      this._setState(MultiplayerState.ERROR);
      if (this.onError) {
        this.onError('P2P connection failed: ' + error.message);
      }
    }
  }

  async _createOffer() {
    // Create data channel (host only)
    this.dataChannel = this.peerConnection.createDataChannel(
      CONFIG.MULTIPLAYER.DATA_CHANNEL_NAME,
      {
        ordered: CONFIG.MULTIPLAYER.ORDERED,
        maxRetransmits: CONFIG.MULTIPLAYER.MAX_RETRANSMITS
      }
    );
    this._setupDataChannel();

    // Create and send offer
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    this._sendSignaling({
      type: 'offer',
      sdp: offer.sdp
    });
  }

  async _handleOffer(offer) {
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
      type: 'offer',
      sdp: offer.sdp
    }));

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    this._sendSignaling({
      type: 'answer',
      sdp: answer.sdp
    });
  }

  async _handleAnswer(answer) {
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
      type: 'answer',
      sdp: answer.sdp
    }));
  }

  async _handleIceCandidate(candidate) {
    if (candidate && this.peerConnection) {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  _setupDataChannel() {
    if (!this.dataChannel) return;

    this.dataChannel.onopen = () => {
      console.log('[Multiplayer] Data channel open');
    };

    this.dataChannel.onclose = () => {
      console.log('[Multiplayer] Data channel closed');
    };

    this.dataChannel.onmessage = (event) => {
      try {
        const gameState = JSON.parse(event.data);
        if (this.onGameStateReceived) {
          this.onGameStateReceived(gameState);
        }
      } catch (err) {
        console.error('[Multiplayer] Invalid game state:', err);
      }
    };
  }

  // Send game state to peer
  sendGameState(state) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(state));
    }
  }

  // Signaling via session attributes
  async _sendSignaling(message) {
    if (!this.currentSessionId) return;

    const signalingKey = `signaling_${pongAPI.userId}`;

    try {
      await fetch(
        `${CONFIG.AGS_BASE_URL}/session/v1/public/namespaces/${CONFIG.NAMESPACE}/gamesessions/${this.currentSessionId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            attributes: {
              [signalingKey]: JSON.stringify(message)
            }
          })
        }
      );
    } catch (error) {
      console.error('[Multiplayer] Failed to send signaling:', error);
    }
  }

  async _processSignalingFromAttributes(attributes) {
    if (!attributes || !this.opponentInfo) return;

    const signalingKey = `signaling_${this.opponentInfo.id}`;
    const signalingData = attributes[signalingKey];

    if (!signalingData) return;

    try {
      const message = JSON.parse(signalingData);
      console.log('[Multiplayer] Received signaling:', message.type);

      switch (message.type) {
        case 'offer':
          await this._handleOffer(message);
          break;
        case 'answer':
          await this._handleAnswer(message);
          break;
        case 'ice-candidate':
          await this._handleIceCandidate(message.candidate);
          break;
      }
    } catch (error) {
      console.error('[Multiplayer] Failed to process signaling:', error);
    }
  }

  // Polling for signaling (fallback if WebSocket notifications don't work)
  async pollSignaling() {
    if (!this.currentSessionId || !this.opponentInfo) return;

    try {
      const response = await fetch(
        `${CONFIG.AGS_BASE_URL}/session/v1/public/namespaces/${CONFIG.NAMESPACE}/gamesessions/${this.currentSessionId}`,
        {
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`
          }
        }
      );

      if (response.ok) {
        const session = await response.json();
        this._processSignalingFromAttributes(session.attributes);
      }
    } catch (error) {
      console.error('[Multiplayer] Failed to poll signaling:', error);
    }
  }

  _cleanupP2P() {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }

  _handleLobbyDisconnect(data) {
    console.log('[Multiplayer] Lobby disconnected:', data);

    if (this.state === MultiplayerState.PLAYING) {
      // Try to maintain P2P connection
      this._setState(MultiplayerState.RECONNECTING);
      this._attemptReconnect();
    } else {
      this._cleanup();
      this._setState(MultiplayerState.IDLE);
    }
  }

  async _attemptReconnect() {
    const maxAttempts = CONFIG.MULTIPLAYER.LOBBY_MAX_RECONNECT_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[Multiplayer] Reconnect attempt ${attempt}/${maxAttempts}`);

      try {
        await this.connectLobby();
        console.log('[Multiplayer] Reconnected to lobby');

        // Check if still in session
        if (this.currentSessionId) {
          const response = await fetch(
            `${CONFIG.AGS_BASE_URL}/session/v1/public/namespaces/${CONFIG.NAMESPACE}/gamesessions/${this.currentSessionId}`,
            {
              headers: {
                'Authorization': `Bearer ${pongAPI.accessToken}`
              }
            }
          );

          if (response.ok) {
            this._setState(MultiplayerState.PLAYING);
            return;
          }
        }

        this._setState(MultiplayerState.LOBBY_CONNECTED);
        return;

      } catch (error) {
        console.error(`[Multiplayer] Reconnect attempt ${attempt} failed:`, error);
        await new Promise(r => setTimeout(r, CONFIG.MULTIPLAYER.LOBBY_RECONNECT_DELAY_MS));
      }
    }

    console.error('[Multiplayer] All reconnect attempts failed');
    this._cleanup();
    this._setState(MultiplayerState.ERROR);
    if (this.onError) {
      this.onError('Lost connection to server');
    }
  }

  _cleanup() {
    this._cleanupP2P();
    this.currentTicketId = null;
    this.currentSessionId = null;
    this.currentSession = null;
    this.opponentInfo = null;
    this.isHost = false;
  }

  // Full cleanup
  async cleanup() {
    await this.cancelMatchmaking();
    await this.leaveSession();
    this.disconnectLobby();
    this._cleanup();
    this._setState(MultiplayerState.IDLE);
  }
}

// Create singleton instance
const pongMultiplayer = new PongMultiplayer();
