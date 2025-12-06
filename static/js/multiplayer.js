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

// P2P Connection Sub-states (for UI overlay)
const P2PState = {
  IDLE: 'IDLE',
  HOST_CHECK: 'HOST_CHECK',
  ICE_OFFER: 'ICE_OFFER',
  SDP_EXCHANGE: 'SDP_EXCHANGE',
  GATHERING: 'GATHERING',
  ESTABLISHING: 'ESTABLISHING',
  CONNECTED: 'CONNECTED',
  FAILED: 'FAILED'
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

      console.log('[Lobby] Received message:', JSON.stringify(message, null, 2));

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
  // Decode base64-encoded JSON payload from AGS notifications
  static decodePayload(data) {
    if (!data.payload) {
      return data;
    }

    try {
      const payloadStr = typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload);
      // Try base64 decode first
      const decoded = atob(payloadStr);
      return JSON.parse(decoded);
    } catch (e) {
      // Not base64, try direct JSON parse
      try {
        return typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
      } catch (e2) {
        // Return original data if parsing fails
        return data;
      }
    }
  }

  constructor() {
    this.state = MultiplayerState.IDLE;
    this.p2pState = P2PState.IDLE;
    this.lobby = null;
    this.currentTicketId = null;
    this.currentSessionId = null;
    this.currentSession = null;
    this.isHost = false;
    this.opponentInfo = null;
    this.peerConnection = null;
    this.dataChannel = null;

    // P2P signaling state
    this.pendingCandidates = [];
    this.isRemoteDescriptionSet = false;
    this.turnServer = null;
    this.turnCredentials = null;
    this.signalingTimeoutId = null;
    this.hostCheckRetries = 0;
    this.maxHostCheckRetries = 3;

    // Connection quality
    this.connectionInfo = {
      type: 'unknown',
      latency: 0
    };
    this.latencyMonitorInterval = null;

    // Event handlers
    this.onStateChange = null;
    this.onP2PStateChange = null;     // Called when P2P sub-state changes
    this.onMatchmakingStarted = null; // Called when matchmaking ticket is accepted
    this.onMatchFound = null;         // Called when a match is found
    this.onMatchmakingExpired = null; // Called when matchmaking ticket expires
    this.onMatchmakingCanceled = null;// Called when matchmaking is canceled
    this.onSessionJoined = null;
    this.onOpponentJoined = null;     // Called when opponent joins the session
    this.onOpponentLeft = null;       // Called when opponent leaves or is kicked
    this.onKicked = null;             // Called when we are kicked from session
    this.onP2PConnected = null;
    this.onP2PDisconnected = null;
    this.onGameStateReceived = null;
    this.onConnectionInfoUpdate = null; // Called when connection quality changes
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

  _setP2PState(newState) {
    const oldState = this.p2pState;
    this.p2pState = newState;
    console.log(`[Multiplayer] P2P State: ${oldState} -> ${newState}`);
    if (this.onP2PStateChange) {
      this.onP2PStateChange(newState, oldState);
    }
  }

  getState() {
    return this.state;
  }

  getP2PState() {
    return this.p2pState;
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
    // AGS Lobby sends two wrapper notification types with a 'topic' field for routing:
    // - messageNotif: general notifications (e.g., OnMatchFound)
    // - messageSessionNotif: session notifications (e.g., OnSessionJoined)
    this.lobby.on('messageNotif', (data) => this._handleNotification(data));
    this.lobby.on('messageSessionNotif', (data) => this._handleNotification(data));

    // P2P signaling via Lobby WebSocket
    this.lobby.on('signalingP2PNotif', (data) => this._handleSignalingMessage(data));

    // Connection events
    this.lobby.on('disconnected', (data) => this._handleLobbyDisconnect(data));

    // Catch-all for debugging unhandled messages
    this.lobby.on('message', (data) => {
      const type = data.type || data.code;
      const handledTypes = ['connectNotif', 'heartbeat', 'disconnected', 'messageNotif', 'messageSessionNotif', 'signalingP2PNotif'];
      if (type && !handledTypes.includes(type)) {
        console.warn('[Multiplayer] Unhandled message type:', type, data);
      }
    });
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

  _handleMatchmakingStarted(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] Matchmaking started:', payload);

    const ticketId = payload.TicketID || payload.ticketID || payload.ticketId;
    if (ticketId) {
      this.currentTicketId = ticketId;
    }

    if (this.state !== MultiplayerState.QUEUING) {
      this._setState(MultiplayerState.QUEUING);
    }

    if (this.onMatchmakingStarted) {
      this.onMatchmakingStarted(payload);
    }
  }

  _handleMatchFound(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] Match found:', payload);

    this._setState(MultiplayerState.MATCHED);
    this.currentTicketId = null;

    if (this.onMatchFound) {
      this.onMatchFound(payload);
    }
    // Session joined notification (OnSessionJoined) follows separately
  }

  _handleMatchmakingExpired(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] Matchmaking expired:', payload);

    this.currentTicketId = null;
    this._setState(MultiplayerState.LOBBY_CONNECTED);

    if (this.onMatchmakingExpired) {
      this.onMatchmakingExpired(payload);
    }
    if (this.onError) {
      this.onError('Matchmaking timed out. Please try again.');
    }
  }

  _handleMatchmakingCanceled(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] Matchmaking canceled:', payload);

    this.currentTicketId = null;

    if (this.state === MultiplayerState.QUEUING || this.state === MultiplayerState.MATCHED) {
      this._setState(MultiplayerState.LOBBY_CONNECTED);
    }

    if (this.onMatchmakingCanceled) {
      this.onMatchmakingCanceled(payload);
    }
  }

  // Unified notification handler - routes by topic field
  _handleNotification(data) {
    const topic = data.topic;
    console.log('[Multiplayer] Notification:', topic, data);

    switch (topic) {
      // Matchmaking
      case 'OnMatchFound':
        this._handleMatchFound(data);
        break;
      case 'OnMatchmakingStarted':
        this._handleMatchmakingStarted(data);
        break;
      case 'OnMatchmakingExpired':
      case 'OnTicketExpired':
        this._handleMatchmakingExpired(data);
        break;
      case 'OnMatchmakingCanceled':
        this._handleMatchmakingCanceled(data);
        break;

      // Session
      case 'OnSessionJoined':
        this._handleSessionJoined(data);
        break;
      case 'OnSessionInvited':
        this._handleSessionInvite(data);
        break;
      case 'OnSessionMembersChanged':
        this._handleSessionMembersChanged(data);
        break;
      case 'OnSessionUserJoined':
        this._handleUserJoinedSession(data);
        break;
      case 'OnSessionUserLeft':
        this._handleUserLeftSession(data);
        break;
      case 'OnSessionUserKicked':
        this._handleUserKickedFromSession(data);
        break;
      case 'OnSessionUpdated':
        this._handleSessionUpdated(data);
        break;

      default:
        console.log('[Multiplayer] Unhandled notification topic:', topic);
    }
  }

  // Session Management
  _handleSessionInvite(data) {
    console.log('[Multiplayer] Session invite received');
    const payload = PongMultiplayer.decodePayload(data);
    const sessionId = payload.SessionID || payload.sessionID || payload.sessionId;

    if (!sessionId) {
      console.warn('[Multiplayer] Session invite missing sessionId');
      return;
    }

    if (this.currentSessionId === sessionId) {
      console.log('[Multiplayer] Already in this session, ignoring invite');
      return;
    }

    if (this.isInSession()) {
      console.log('[Multiplayer] Already in a different session, ignoring invite');
      return;
    }

    this.joinSession(sessionId);
  }

  // Handle OnSessionJoined - when matchmaker adds us to a session
  _handleSessionJoined(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] Session joined:', payload);

    const sessionId = payload.SessionID || payload.sessionID || payload.sessionId;

    if (!sessionId) {
      console.warn('[Multiplayer] Session joined notification missing sessionId');
      return;
    }

    if (this.currentSessionId === sessionId) {
      return; // Already in this session
    }

    if (this.isInSession()) {
      return; // Already in a different session
    }

    this.joinSession(sessionId);
  }

  async joinSession(sessionId) {
    // Validate state
    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    if (this.state === MultiplayerState.JOINING_SESSION) {
      console.log('[Multiplayer] Already joining a session');
      return;
    }

    // If already in this session, just refresh info
    if (this.currentSessionId === sessionId && this.state === MultiplayerState.IN_SESSION) {
      console.log('[Multiplayer] Already in this session, refreshing info');
      await this.getSession(sessionId);
      return;
    }

    // If in a different session, leave first
    if (this.currentSessionId && this.currentSessionId !== sessionId) {
      console.log('[Multiplayer] Leaving current session before joining new one');
      await this.leaveSession();
    }

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

      // Handle specific error codes
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorCode = errorData.errorCode || response.status;
        const errorMessage = errorData.errorMessage || `Join session failed: ${response.status}`;

        // Handle common session join errors
        switch (errorCode) {
          case 20025: // Session full
            throw new Error('Session is full');
          case 20040: // Already in session
            console.log('[Multiplayer] Already in session, fetching session info');
            const session = await this.getSession(sessionId);
            this._onSessionJoinSuccess(session);
            return;
          case 20041: // Session not found
            throw new Error('Session not found or has expired');
          case 20042: // Session not joinable
            throw new Error('Session is not accepting new players');
          default:
            throw new Error(errorMessage);
        }
      }

      const session = await response.json();
      this._onSessionJoinSuccess(session);

    } catch (error) {
      console.error('[Multiplayer] Failed to join session:', error);
      this._cleanupSession();
      this._setState(MultiplayerState.ERROR);

      if (this.onError) {
        this.onError('Failed to join session: ' + error.message);
      }
      throw error;
    }
  }

  // Handle successful session join
  _onSessionJoinSuccess(session) {
    this.currentSession = session;

    // Update session info (host status, opponent)
    this._updateSessionInfo(session);

    console.log('[Multiplayer] Joined session:', {
      sessionId: session.id,
      isHost: this.isHost,
      opponent: this.opponentInfo,
      memberCount: (session.members || []).length
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
    const members = session.members || [];
    if (members.length >= CONFIG.MULTIPLAYER.MIN_PLAYERS) {
      this._initiateP2PConnection();
    }
  }

  _handleSessionMembersChanged(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] Session members changed:', payload);

    if (this.state === MultiplayerState.IN_SESSION || this.state === MultiplayerState.CONNECTING_P2P || this.state === MultiplayerState.PLAYING) {
      const members = payload.Members || payload.members || [];
      this.opponentInfo = members.find(m => (m.ID || m.id) !== pongAPI.userId);

      if (members.length >= 2 && !this.peerConnection) {
        this._initiateP2PConnection();
      }
    }
  }

  _handleUserJoinedSession(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] User joined session:', payload);

    const joinedUserId = payload.UserID || payload.userId || payload.ID || payload.id;

    if (joinedUserId === pongAPI.userId) {
      return; // Ignore our own join
    }

    this.opponentInfo = {
      id: joinedUserId,
      platformId: payload.PlatformID || payload.platformId,
      platformUserId: payload.PlatformUserID || payload.platformUserId
    };

    // Notify UI
    if (this.onOpponentJoined) {
      this.onOpponentJoined(this.opponentInfo);
    }

    // If we're waiting for opponent and now have one, initiate P2P
    if ((this.state === MultiplayerState.IN_SESSION || this.state === MultiplayerState.JOINING_SESSION) && !this.peerConnection) {
      this._initiateP2PConnection();
    }
  }

  _handleUserLeftSession(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] User left session:', payload);

    const leftUserId = payload.UserID || payload.userId || payload.ID || payload.id;

    if (leftUserId === pongAPI.userId) {
      return; // Ignore our own leave
    }

    if (this.opponentInfo && this.opponentInfo.id === leftUserId) {
      if (this.onOpponentLeft) {
        this.onOpponentLeft({ userId: leftUserId, reason: 'left' });
      }
      this._cleanupP2P();
      this.opponentInfo = null;
      this._setState(this.state === MultiplayerState.PLAYING ? MultiplayerState.FINISHED : MultiplayerState.IN_SESSION);
    }
  }

  _handleUserKickedFromSession(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] User kicked from session:', payload);

    const kickedUserId = payload.UserID || payload.userId || payload.ID || payload.id;

    if (kickedUserId === pongAPI.userId) {
      if (this.onKicked) {
        this.onKicked({ reason: payload.Reason || payload.reason || 'kicked' });
      }
      this._cleanupSession();
      this._setState(MultiplayerState.LOBBY_CONNECTED);
      return;
    }

    if (this.opponentInfo && this.opponentInfo.id === kickedUserId) {
      if (this.onOpponentLeft) {
        this.onOpponentLeft({ userId: kickedUserId, reason: 'kicked' });
      }

      this._cleanupP2P();
      this.opponentInfo = null;

      if (this.state === MultiplayerState.PLAYING) {
        this._setState(MultiplayerState.FINISHED);
      }
    }
  }

  _handleSessionUpdated(data) {
    const payload = PongMultiplayer.decodePayload(data);
    console.log('[Multiplayer] Session updated:', payload);

    if (!this.currentSessionId || !this.currentSession) {
      return;
    }

    // Merge updated data
    const attributes = payload.Attributes || payload.attributes;
    const members = payload.Members || payload.members;

    if (attributes) {
      this.currentSession.attributes = { ...this.currentSession.attributes, ...attributes };
    }
    if (members) {
      this.currentSession.members = members;
    }
  }

  async leaveSession(force = false) {
    if (!this.currentSessionId) {
      return;
    }

    const sessionId = this.currentSessionId;
    const wasPlaying = this.state === MultiplayerState.PLAYING;

    // Notify opponent if we're leaving during a game
    if (wasPlaying && this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.sendGameState({ type: 'player_left', reason: 'voluntary' });
      } catch (e) {
        // Ignore errors when sending leave message
      }
    }

    // Clean up local state first to prevent race conditions
    this._cleanupSession();

    try {
      const response = await fetch(
        `${CONFIG.AGS_BASE_URL}/session/v1/public/namespaces/${CONFIG.NAMESPACE}/gamesessions/${sessionId}/leave`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`
          }
        }
      );

      if (!response.ok && !force) {
        const errorData = await response.json().catch(() => ({}));
        console.warn('[Multiplayer] Leave session response:', errorData);
      }

      console.log('[Multiplayer] Left session');

    } catch (error) {
      console.error('[Multiplayer] Failed to leave session:', error);
      // Continue cleanup even if API call fails
    }

    this._setState(MultiplayerState.LOBBY_CONNECTED);
  }

  // Force leave session without waiting for API response
  forceLeaveSession() {
    console.log('[Multiplayer] Force leaving session');
    this._cleanupSession();
    this._setState(MultiplayerState.LOBBY_CONNECTED);

    // Try to leave via API in background (best effort)
    if (this.currentSessionId) {
      this.leaveSession(true).catch(() => {});
    }
  }

  // Fetch current session details
  async getSession(sessionId = null) {
    const targetSessionId = sessionId || this.currentSessionId;

    if (!targetSessionId) {
      throw new Error('No session ID provided');
    }

    try {
      const response = await fetch(
        `${CONFIG.AGS_BASE_URL}/session/v1/public/namespaces/${CONFIG.NAMESPACE}/gamesessions/${targetSessionId}`,
        {
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`
          }
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.errorMessage || `Failed to get session: ${response.status}`);
      }

      const session = await response.json();

      // Update current session if fetching our active session
      if (targetSessionId === this.currentSessionId) {
        this.currentSession = session;
        this._updateSessionInfo(session);
      }

      return session;

    } catch (error) {
      console.error('[Multiplayer] Failed to get session:', error);
      throw error;
    }
  }

  // Update session info from fetched data
  _updateSessionInfo(session) {
    // Update host status (AGS uses 'leaderID' field for session leader)
    const leaderId = session.leaderID || session.leaderId || session.leader;
    this.isHost = leaderId === pongAPI.userId;

    // Update opponent info
    const members = session.members || [];
    this.opponentInfo = members.find(m => m.id !== pongAPI.userId) || null;

    console.log('[Multiplayer] Session info updated:', {
      sessionId: session.id,
      leaderId: leaderId,
      myUserId: pongAPI.userId,
      isHost: this.isHost,
      opponent: this.opponentInfo,
      memberCount: members.length
    });
  }

  // Get current role (host or guest)
  getRole() {
    return this.isHost ? 'host' : 'guest';
  }

  // Check if currently in a session
  isInSession() {
    return this.currentSessionId !== null &&
           (this.state === MultiplayerState.IN_SESSION ||
            this.state === MultiplayerState.CONNECTING_P2P ||
            this.state === MultiplayerState.PLAYING);
  }

  // Get session info
  getSessionInfo() {
    return {
      sessionId: this.currentSessionId,
      session: this.currentSession,
      isHost: this.isHost,
      opponent: this.opponentInfo,
      role: this.getRole()
    };
  }

  // Clean up session state (internal helper)
  _cleanupSession() {
    this._cleanupP2P();
    this.currentSessionId = null;
    this.currentSession = null;
    this.opponentInfo = null;
    this.isHost = false;
  }

  // TURN Credentials - fetched via backend proxy to avoid CORS issues
  async getTurnServers() {
    try {
      const response = await fetch(
        `${CONFIG.BACKEND_URL}/turn-servers`,
        {
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`
          }
        }
      );

      if (!response.ok) {
        // TURN is optional - STUN fallback will be used
        console.log('[Multiplayer] TURN servers unavailable, using STUN fallback');
        return [];
      }

      return await response.json();

    } catch (error) {
      // TURN fetch failed (likely no proxy endpoint) - use STUN fallback silently
      console.log('[Multiplayer] TURN servers unavailable, using STUN fallback');
      return [];
    }
  }

  async getTurnCredentials(region, ip, port) {
    try {
      const response = await fetch(
        `${CONFIG.BACKEND_URL}/turn-credentials/${region}/${ip}/${port}`,
        {
          headers: {
            'Authorization': `Bearer ${pongAPI.accessToken}`
          }
        }
      );

      if (!response.ok) {
        return null;
      }

      return await response.json();

    } catch (error) {
      console.log('[Multiplayer] TURN credentials unavailable');
      return null;
    }
  }

  // P2P Connection via Lobby WebSocket Signaling (signalingP2PNotif)
  async _initiateP2PConnection() {
    if (this.state === MultiplayerState.CONNECTING_P2P || this.state === MultiplayerState.PLAYING) {
      return;
    }

    this._setState(MultiplayerState.CONNECTING_P2P);
    this._setP2PState(P2PState.HOST_CHECK);
    this.pendingCandidates = [];
    this.isRemoteDescriptionSet = false;
    this.hostCheckRetries = 0;

    try {
      // Get TURN servers and credentials
      const servers = await this.getTurnServers();
      let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // Fallback STUN

      if (servers && servers.length > 0) {
        this.turnServer = servers[0];
        this.turnCredentials = await this.getTurnCredentials(
          this.turnServer.region,
          this.turnServer.ip,
          this.turnServer.port
        );

        if (this.turnCredentials) {
          iceServers = [
            { urls: `stun:${this.turnServer.ip}:${this.turnServer.port}` },
            {
              urls: `turn:${this.turnServer.ip}:${this.turnServer.port}`,
              username: this.turnCredentials.username,
              credential: this.turnCredentials.password
            }
          ];
        }
      }

      console.log('[Multiplayer] ICE servers:', iceServers);

      // Create peer connection
      this.peerConnection = new RTCPeerConnection({ iceServers });
      this._setupPeerConnectionHandlers();

      // Set signaling timeout
      this._startSignalingTimeout();

      // Start the signaling flow based on role
      if (this.isHost) {
        // Host waits for guest's hosting check
        console.log('[Multiplayer] Host waiting for guest connection...');
      } else {
        // Guest initiates by checking if host is ready
        this._sendHostingCheck();
      }

    } catch (error) {
      console.error('[Multiplayer] P2P connection failed:', error);
      this._setP2PState(P2PState.FAILED);
      this._setState(MultiplayerState.ERROR);
      if (this.onError) {
        this.onError('P2P connection failed: ' + error.message);
      }
    }
  }

  _setupPeerConnectionHandlers() {
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this._sendSignalingViews('candidate', event.candidate.candidate);
      }
    };

    this.peerConnection.onicegatheringstatechange = () => {
      const gatheringState = this.peerConnection?.iceGatheringState;
      console.log('[Multiplayer] ICE gathering state:', gatheringState);

      if (gatheringState === 'gathering') {
        this._setP2PState(P2PState.GATHERING);
      } else if (gatheringState === 'complete') {
        this._sendSignalingViews('done', '');
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const connectionState = this.peerConnection?.connectionState;
      console.log('[Multiplayer] Connection state:', connectionState);

      switch (connectionState) {
        case 'connected':
          this._clearSignalingTimeout();
          this._setP2PState(P2PState.CONNECTED);
          this._setState(MultiplayerState.PLAYING);
          this._startLatencyMonitor();
          this._detectConnectionType();
          if (this.onP2PConnected) {
            this.onP2PConnected();
          }
          break;

        case 'disconnected':
          console.log('[Multiplayer] P2P connection disconnected, waiting for recovery...');
          if (this.onP2PDisconnected) {
            this.onP2PDisconnected({ recoverable: true });
          }
          break;

        case 'failed':
          console.log('[Multiplayer] P2P connection failed');
          this._setP2PState(P2PState.FAILED);
          if (this.onP2PDisconnected) {
            this.onP2PDisconnected({ recoverable: false });
          }

          if (this.state === MultiplayerState.PLAYING) {
            this._setState(MultiplayerState.FINISHED);
            if (this.onOpponentLeft) {
              this.onOpponentLeft({
                userId: this.opponentInfo?.id,
                reason: 'connection_failed'
              });
            }
          } else {
            this._setState(MultiplayerState.ERROR);
            if (this.onError) {
              this.onError('Failed to establish peer connection');
            }
          }
          break;

        case 'closed':
          console.log('[Multiplayer] P2P connection closed');
          break;
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      const iceState = this.peerConnection?.iceConnectionState;
      console.log('[Multiplayer] ICE connection state:', iceState);

      if (iceState === 'checking') {
        this._setP2PState(P2PState.ESTABLISHING);
      } else if (iceState === 'failed' && this.state === MultiplayerState.CONNECTING_P2P) {
        this._setP2PState(P2PState.FAILED);
        this._setState(MultiplayerState.ERROR);
        if (this.onError) {
          this.onError('ICE connection failed');
        }
      }
    };

    this.peerConnection.ondatachannel = (event) => {
      console.log('[Multiplayer] Data channel received');
      this.dataChannel = event.channel;
      this._setupDataChannel();
    };
  }

  _startSignalingTimeout() {
    this._clearSignalingTimeout();
    this.signalingTimeoutId = setTimeout(() => {
      if (this.state === MultiplayerState.CONNECTING_P2P) {
        console.error('[Multiplayer] Signaling timeout');
        this._setP2PState(P2PState.FAILED);
        this._setState(MultiplayerState.ERROR);
        if (this.onError) {
          this.onError('Connection timed out');
        }
      }
    }, CONFIG.MULTIPLAYER.CONNECTION_TIMEOUT_MS);
  }

  _clearSignalingTimeout() {
    if (this.signalingTimeoutId) {
      clearTimeout(this.signalingTimeoutId);
      this.signalingTimeoutId = null;
    }
  }

  // Signaling via Lobby WebSocket (signalingP2PNotif)
  _sendSignalingViews(type, data, turnServer = null) {
    if (!this.lobby || !this.lobby.isConnected || !this.opponentInfo) {
      console.warn('[Multiplayer] Cannot send signaling: no connection or opponent');
      return;
    }

    const peerId = this.opponentInfo.id;
    const message = {
      Type: type,
      Channel: 0,
      Data: data
    };

    // Include TURN server in ICE offer
    if (turnServer) {
      message.TurnServer = {
        Host: turnServer.ip,
        Port: turnServer.port,
        Username: this.turnCredentials?.username || '',
        Password: this.turnCredentials?.password || ''
      };
    }

    const jsonString = JSON.stringify(message);
    const base64Message = btoa(jsonString);
    const messageId = `signaling-${Date.now()}`;

    const rawMessage = [
      'type: signalingP2PNotif',
      `id: ${messageId}`,
      `destinationId: ${peerId}`,
      `message: ${base64Message}`
    ].join('\n');

    console.log(`[Multiplayer] Sending signaling: ${type} to ${peerId}`);
    this.lobby.ws.send(rawMessage);
  }

  // Handle incoming signaling message
  _handleSignalingMessage(data) {
    const peerId = data.destinationId;

    // Verify it's from our opponent
    if (this.opponentInfo && peerId !== this.opponentInfo.id) {
      // destinationId in received messages is the sender's ID
    }

    let decoded;
    try {
      decoded = JSON.parse(atob(data.message));
    } catch (e) {
      console.error('[Multiplayer] Failed to decode signaling message:', e);
      return;
    }

    console.log(`[Multiplayer] Received signaling: ${decoded.Type}`);

    switch (decoded.Type) {
      case 'hosting':
        this._handleHostingCheck(peerId);
        break;
      case 'hostingreply':
        this._handleHostingReply(peerId, decoded.Data, decoded.TurnServer);
        break;
      case 'ice':
        this._handleIceOffer(peerId, decoded);
        break;
      case 'sdp':
        this._handleSdpMessage(peerId, decoded.Data);
        break;
      case 'candidate':
        this._handleCandidateMessage(peerId, decoded.Data);
        break;
      case 'done':
        this._handleGatheringDone(peerId);
        break;
    }
  }

  // Step 1: Guest checks if host is ready
  _sendHostingCheck() {
    console.log('[Multiplayer] Sending hosting check');
    this._sendSignalingViews('hosting', '');

    // Retry if no response
    setTimeout(() => {
      if (this.p2pState === P2PState.HOST_CHECK && this.hostCheckRetries < this.maxHostCheckRetries) {
        this.hostCheckRetries++;
        console.log(`[Multiplayer] Retrying hosting check (${this.hostCheckRetries}/${this.maxHostCheckRetries})`);
        this._sendHostingCheck();
      }
    }, 3000);
  }

  // Host responds to hosting check
  _handleHostingCheck(peerId) {
    if (!this.isHost) return;

    console.log('[Multiplayer] Responding to hosting check');
    this._sendSignalingViews('hostingreply', 'hosting');
  }

  // Guest receives hosting reply
  async _handleHostingReply(peerId, status, turnServer) {
    if (this.isHost) return;
    if (status !== 'hosting') {
      console.warn('[Multiplayer] Host not ready:', status);
      return;
    }

    console.log('[Multiplayer] Host confirmed, sending ICE offer');
    this._setP2PState(P2PState.ICE_OFFER);

    // Send ICE offer with TURN credentials
    this._sendSignalingViews('ice', 'offer', this.turnServer);

    // Create and send SDP offer
    await this._createAndSendOffer();
  }

  // Host receives ICE offer from guest
  async _handleIceOffer(peerId, decoded) {
    if (!this.isHost) return;

    console.log('[Multiplayer] Received ICE offer from guest');
    this._setP2PState(P2PState.SDP_EXCHANGE);

    // Use guest's TURN server if provided
    if (decoded.TurnServer && decoded.TurnServer.Host) {
      const newIceServers = [
        { urls: `stun:${decoded.TurnServer.Host}:${decoded.TurnServer.Port}` },
        {
          urls: `turn:${decoded.TurnServer.Host}:${decoded.TurnServer.Port}`,
          username: decoded.TurnServer.Username,
          credential: decoded.TurnServer.Password
        }
      ];

      // Recreate peer connection with new ICE servers if needed
      if (this.peerConnection.iceConnectionState === 'new') {
        this.peerConnection.close();
        this.peerConnection = new RTCPeerConnection({ iceServers: newIceServers });
        this._setupPeerConnectionHandlers();
      }
    }

    // Host waits for guest's SDP offer
  }

  // Create and send SDP offer (guest)
  async _createAndSendOffer() {
    this._setP2PState(P2PState.SDP_EXCHANGE);

    // Create data channel (guest creates it)
    this.dataChannel = this.peerConnection.createDataChannel(
      CONFIG.MULTIPLAYER.DATA_CHANNEL_NAME,
      {
        ordered: CONFIG.MULTIPLAYER.ORDERED,
        maxRetransmits: CONFIG.MULTIPLAYER.MAX_RETRANSMITS
      }
    );
    this._setupDataChannel();

    // Create and send SDP offer
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    this._sendSignalingViews('sdp', offer.sdp);
  }

  // Handle received SDP message
  async _handleSdpMessage(peerId, sdp) {
    try {
      if (this.isHost) {
        // Host receives offer, creates answer
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
          type: 'offer',
          sdp: sdp
        }));
        this.isRemoteDescriptionSet = true;

        // Process queued candidates
        await this._processQueuedCandidates();

        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        this._sendSignalingViews('sdp', answer.sdp);
      } else {
        // Guest receives answer
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
          type: 'answer',
          sdp: sdp
        }));
        this.isRemoteDescriptionSet = true;

        // Process queued candidates
        await this._processQueuedCandidates();
      }
    } catch (error) {
      console.error('[Multiplayer] Failed to handle SDP:', error);
    }
  }

  // Handle received ICE candidate
  async _handleCandidateMessage(peerId, candidateString) {
    if (!candidateString) return;

    const candidate = new RTCIceCandidate({ candidate: candidateString, sdpMid: '0', sdpMLineIndex: 0 });

    if (this.isRemoteDescriptionSet) {
      try {
        await this.peerConnection.addIceCandidate(candidate);
      } catch (error) {
        console.error('[Multiplayer] Failed to add ICE candidate:', error);
      }
    } else {
      // Queue until remote description is set
      this.pendingCandidates.push(candidate);
    }
  }

  async _processQueuedCandidates() {
    for (const candidate of this.pendingCandidates) {
      try {
        await this.peerConnection.addIceCandidate(candidate);
      } catch (error) {
        console.error('[Multiplayer] Failed to add queued candidate:', error);
      }
    }
    this.pendingCandidates = [];
  }

  _handleGatheringDone(peerId) {
    console.log('[Multiplayer] Peer gathering done');
    // Connection should be established now
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

  // Connection quality monitoring
  _startLatencyMonitor() {
    this._stopLatencyMonitor();
    this.latencyMonitorInterval = setInterval(() => {
      this._updateConnectionInfo();
    }, 1000);
  }

  _stopLatencyMonitor() {
    if (this.latencyMonitorInterval) {
      clearInterval(this.latencyMonitorInterval);
      this.latencyMonitorInterval = null;
    }
  }

  async _updateConnectionInfo() {
    if (!this.peerConnection) return;

    try {
      const stats = await this.peerConnection.getStats();
      let latency = 0;
      let connectionType = 'unknown';

      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          latency = report.currentRoundTripTime
            ? Math.round(report.currentRoundTripTime * 1000)
            : 0;
        }

        if (report.type === 'local-candidate' && report.isRemote === false) {
          connectionType = report.candidateType || connectionType;
        }
      });

      this.connectionInfo = { type: connectionType, latency };

      if (this.onConnectionInfoUpdate) {
        this.onConnectionInfoUpdate(this.connectionInfo);
      }
    } catch (error) {
      // Ignore stats errors
    }
  }

  async _detectConnectionType() {
    try {
      const stats = await this.peerConnection.getStats();
      stats.forEach(report => {
        if (report.type === 'local-candidate') {
          this.connectionInfo.type = report.candidateType || 'unknown';
        }
      });
    } catch (error) {
      // Ignore
    }
  }

  // Get connection info
  getConnectionInfo() {
    return this.connectionInfo;
  }

  _cleanupP2P() {
    this._clearSignalingTimeout();
    this._stopLatencyMonitor();

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.pendingCandidates = [];
    this.isRemoteDescriptionSet = false;
    this._setP2PState(P2PState.IDLE);
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
