// Pong Multiplayer Game Engine
// Extends the base game to support networked play with P2P synchronization

// P2P Connection Sub-states (for UI overlay)
const P2PConnectionState = {
  HOST_CHECK: 'HOST_CHECK',
  ICE_OFFER: 'ICE_OFFER',
  SDP_EXCHANGE: 'SDP_EXCHANGE',
  GATHERING: 'GATHERING',
  ESTABLISHING: 'ESTABLISHING',
  CONNECTED: 'CONNECTED',
  FAILED: 'FAILED'
};

// Connection types (determined from ICE candidate)
const ConnectionType = {
  DIRECT: 'host',
  STUN: 'srflx',
  RELAY: 'relay'
};

// Ball authority states for split authority model
// Each player is authoritative for their own paddle's collision detection
const BallAuthority = {
  HOST: 'host',   // Ball moving toward host's paddle - host detects collision
  GUEST: 'guest'  // Ball moving toward guest's paddle - guest detects collision
};

class MultiplayerGame {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');

    // Set canvas size
    this.canvas.width = CONFIG.CANVAS_WIDTH;
    this.canvas.height = CONFIG.CANVAS_HEIGHT;

    // Game state
    this.state = 'waiting'; // waiting, countdown, playing, paused, finished
    this.gameStartTime = null;
    this.isHost = false;

    // Countdown state
    this.countdownValue = 0;
    this.countdownStartTime = null;
    this.countdownDuration = CONFIG.MULTIPLAYER.COUNTDOWN_SECONDS || 3;

    // Scores
    this.localScore = 0;
    this.remoteScore = 0;

    // Initialize game objects
    this._initPaddles();
    this._initBall();

    // Input state
    this.keys = {
      up: false,
      down: false
    };

    // Network state
    this.sendInterval = null;
    this.lastSendTime = 0;
    this.sequence = 0;

    // Remote state buffer for interpolation
    this.remoteStates = [];
    this.lastRemoteState = null;

    // Split authority model: each player is authoritative for their own paddle collisions
    // Authority is determined by ball direction - whoever the ball is moving toward has authority
    this.ballAuthority = BallAuthority.HOST; // Start with host authority
    this.lastAuthorityChange = 0; // Timestamp of last authority change
    this.authoritySequence = 0; // Increments on each authority change for conflict resolution

    // Collision event tracking
    this.lastCollisionEvent = null; // Last collision event we sent
    this.lastReceivedCollisionSeq = -1; // Last collision sequence we processed from peer
    this.lastCollisionTime = 0; // Timestamp of last collision (sent or received) for cooldown
    this.collisionCooldownMs = 100; // Prevent double-detection

    // Connection info
    this.connectionInfo = {
      type: 'unknown',
      latency: 0
    };

    // Animation
    this.lastFrameTime = 0;
    this.animationId = null;

    // Event callbacks
    this.onScoreUpdate = null;
    this.onGameOver = null;
    this.onConnectionInfoUpdate = null;

    // Game end reason (null, 'opponent_left', 'score')
    this.gameEndReason = null;

    // Bind event handlers
    this._bindEvents();
  }

  _initPaddles() {
    // Local paddle (left when host, right when guest)
    this.localPaddle = {
      x: CONFIG.PADDLE_MARGIN,
      y: (CONFIG.CANVAS_HEIGHT - CONFIG.PADDLE_HEIGHT) / 2,
      width: CONFIG.PADDLE_WIDTH,
      height: CONFIG.PADDLE_HEIGHT,
      speed: CONFIG.PADDLE_SPEED
    };

    // Remote paddle
    this.remotePaddle = {
      x: CONFIG.CANVAS_WIDTH - CONFIG.PADDLE_MARGIN - CONFIG.PADDLE_WIDTH,
      y: (CONFIG.CANVAS_HEIGHT - CONFIG.PADDLE_HEIGHT) / 2,
      width: CONFIG.PADDLE_WIDTH,
      height: CONFIG.PADDLE_HEIGHT,
      speed: CONFIG.PADDLE_SPEED
    };
  }

  _initBall() {
    this.ball = {
      x: CONFIG.CANVAS_WIDTH / 2,
      y: CONFIG.CANVAS_HEIGHT / 2,
      size: CONFIG.BALL_SIZE,
      speed: CONFIG.BALL_INITIAL_SPEED,
      vx: 0,
      vy: 0
    };
  }

  _resetBall(direction = 1) {
    this.ball.x = CONFIG.CANVAS_WIDTH / 2;
    this.ball.y = CONFIG.CANVAS_HEIGHT / 2;
    this.ball.speed = CONFIG.BALL_INITIAL_SPEED;

    // Random angle between -45 and 45 degrees
    const angle = (Math.random() * 90 - 45) * Math.PI / 180;
    this.ball.vx = Math.cos(angle) * this.ball.speed * direction;
    this.ball.vy = Math.sin(angle) * this.ball.speed;
  }

  _bindEvents() {
    // Keyboard events
    this._keyDownHandler = (e) => this._handleKeyDown(e);
    this._keyUpHandler = (e) => this._handleKeyUp(e);
    document.addEventListener('keydown', this._keyDownHandler);
    document.addEventListener('keyup', this._keyUpHandler);

    // Touch events for mobile
    this._touchHandler = (e) => this._handleTouch(e);
    this.canvas.addEventListener('touchstart', this._touchHandler);
    this.canvas.addEventListener('touchmove', this._touchHandler);
  }

  _unbindEvents() {
    document.removeEventListener('keydown', this._keyDownHandler);
    document.removeEventListener('keyup', this._keyUpHandler);
    this.canvas.removeEventListener('touchstart', this._touchHandler);
    this.canvas.removeEventListener('touchmove', this._touchHandler);
  }

  _handleKeyDown(e) {
    switch (e.key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        this.keys.up = true;
        e.preventDefault();
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        this.keys.down = true;
        e.preventDefault();
        break;
      // Note: Pause is disabled in multiplayer mode
    }
  }

  _handleKeyUp(e) {
    switch (e.key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        this.keys.up = false;
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        this.keys.down = false;
        break;
    }
  }

  _handleTouch(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = this.canvas.getBoundingClientRect();
    const touchY = touch.clientY - rect.top;

    const paddleCenter = this.localPaddle.y + this.localPaddle.height / 2;
    if (touchY < paddleCenter - 10) {
      this.keys.up = true;
      this.keys.down = false;
    } else if (touchY > paddleCenter + 10) {
      this.keys.up = false;
      this.keys.down = true;
    } else {
      this.keys.up = false;
      this.keys.down = false;
    }
  }

  // Configure for multiplayer session
  setRole(isHost) {
    this.isHost = isHost;

    // Position paddles based on role
    if (isHost) {
      // Host plays on left side
      this.localPaddle.x = CONFIG.PADDLE_MARGIN;
      this.remotePaddle.x = CONFIG.CANVAS_WIDTH - CONFIG.PADDLE_MARGIN - CONFIG.PADDLE_WIDTH;
    } else {
      // Guest plays on right side
      this.localPaddle.x = CONFIG.CANVAS_WIDTH - CONFIG.PADDLE_MARGIN - CONFIG.PADDLE_WIDTH;
      this.remotePaddle.x = CONFIG.PADDLE_MARGIN;
    }
  }

  // Start the multiplayer game (begins with countdown)
  start() {
    if (this.state === 'playing' || this.state === 'countdown') return;

    this.localScore = 0;
    this.remoteScore = 0;

    // Start countdown
    this._startCountdown();

    // Start game loop if not already running
    if (!this.animationId) {
      this.lastFrameTime = performance.now();
      this._gameLoop();
    }

    if (this.onScoreUpdate) {
      this.onScoreUpdate(this.localScore, this.remoteScore);
    }
  }

  // Start the countdown phase
  _startCountdown() {
    this.state = 'countdown';
    this.countdownValue = this.countdownDuration;
    this.countdownStartTime = Date.now();

    // Host sends countdown sync to guest
    if (this.isHost && pongMultiplayer && pongMultiplayer.sendGameState) {
      pongMultiplayer.sendGameState({
        type: 'countdown_start',
        duration: this.countdownDuration,
        timestamp: this.countdownStartTime
      });
    }

    // Start network updates during countdown for paddle sync
    this._startNetworkUpdates();
  }

  // Called when countdown finishes
  _onCountdownComplete() {
    this.state = 'playing';
    this.gameStartTime = Date.now();

    // Only host controls ball
    if (this.isHost) {
      this._resetBall(Math.random() > 0.5 ? 1 : -1);

      // Send game start with ball state
      if (pongMultiplayer && pongMultiplayer.sendGameState) {
        pongMultiplayer.sendGameState({
          type: 'game_start',
          ball: {
            x: this.ball.x,
            y: this.ball.y,
            vx: this.ball.vx,
            vy: this.ball.vy,
            speed: this.ball.speed
          }
        });
      }
    }
  }

  // Update countdown value
  _updateCountdown() {
    if (this.state !== 'countdown') return;

    const elapsed = Date.now() - this.countdownStartTime;
    const remaining = this.countdownDuration - Math.floor(elapsed / 1000);

    if (remaining !== this.countdownValue) {
      this.countdownValue = remaining;
    }

    if (remaining <= 0) {
      this._onCountdownComplete();
    }
  }

  pause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      this._stopNetworkUpdates();
    }
  }

  resume() {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.lastFrameTime = performance.now();
      this._startNetworkUpdates();
    }
  }

  reset() {
    this.state = 'waiting';
    this.localScore = 0;
    this.remoteScore = 0;
    this.gameStartTime = null;
    this.gameEndReason = null;
    this.sequence = 0;
    this.remoteStates = [];
    this.lastRemoteState = null;
    // Reset split authority state
    this.ballAuthority = BallAuthority.HOST;
    this.lastAuthorityChange = 0;
    this.authoritySequence = 0;
    this.lastCollisionEvent = null;
    this.lastReceivedCollisionSeq = -1;
    this.lastCollisionTime = 0;

    // Reset countdown state
    this.countdownValue = 0;
    this.countdownStartTime = null;

    this._initPaddles();
    this._initBall();
    this._stopNetworkUpdates();

    // Re-apply role positioning
    this.setRole(this.isHost);

    if (this.onScoreUpdate) {
      this.onScoreUpdate(this.localScore, this.remoteScore);
    }
  }

  destroy() {
    this._unbindEvents();
    this._stopNetworkUpdates();
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  // Network update methods
  _startNetworkUpdates() {
    const sendRate = 1000 / CONFIG.MULTIPLAYER.SEND_RATE;
    this.sendInterval = setInterval(() => {
      if (this.state === 'playing') {
        this._sendGameState();
      }
    }, sendRate);
  }

  _stopNetworkUpdates() {
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }
  }

  _sendGameState() {
    const state = this._buildGameState();
    if (pongMultiplayer && pongMultiplayer.sendGameState) {
      pongMultiplayer.sendGameState(state);
    }
  }

  _buildGameState() {
    this.sequence++;
    const state = {
      type: 'game_state',
      timestamp: Date.now(),
      sequence: this.sequence,
      paddle: {
        y: this.localPaddle.y
      }
    };

    // Host sends authoritative ball state
    if (this.isHost) {
      state.ball = {
        x: this.ball.x,
        y: this.ball.y,
        vx: this.ball.vx,
        vy: this.ball.vy,
        speed: this.ball.speed
      };
      state.score = {
        host: this.localScore,
        guest: this.remoteScore
      };
    }

    return state;
  }

  // Receive game state from peer
  receiveGameState(state) {
    if (state.type === 'game_state') {
      this._handleGameState(state);
    } else if (state.type === 'countdown_start') {
      this._handleCountdownStart(state);
    } else if (state.type === 'game_start') {
      this._handleGameStart(state);
    } else if (state.type === 'collision_event') {
      this._handleCollisionEvent(state);
    } else if (state.type === 'authority_sync') {
      this._handleAuthoritySync(state);
    } else if (state.type === 'score_reset') {
      this._handleScoreReset(state);
    } else if (state.type === 'score') {
      this._handleScoreUpdate(state);
    } else if (state.type === 'game_over') {
      this._handleGameOver(state);
    } else if (state.type === 'player_left') {
      this._handlePlayerLeft(state);
    } else if (state.type === 'ping') {
      this._handlePing(state);
    } else if (state.type === 'pong') {
      this._handlePong(state);
    }
  }

  _handleCountdownStart(state) {
    // Guest receives countdown start from host
    if (this.isHost) return;

    this.countdownDuration = state.duration || 3;
    this.countdownStartTime = Date.now(); // Use local time for smooth countdown
    this.countdownValue = this.countdownDuration;
    this.state = 'countdown';

    // Start game loop if not already running
    if (!this.animationId) {
      this.lastFrameTime = performance.now();
      this._gameLoop();
    }

    // Start network updates during countdown
    this._startNetworkUpdates();
  }

  _handleGameState(state) {
    // Update remote paddle position
    if (state.paddle) {
      // Add to interpolation buffer
      this.remoteStates.push({
        timestamp: state.timestamp,
        paddleY: state.paddle.y
      });

      // Keep buffer size manageable
      while (this.remoteStates.length > 20) {
        this.remoteStates.shift();
      }
    }

    // SPLIT AUTHORITY: Ball state sync is now for drift correction only
    // Collision events handle the primary ball state changes
    if (state.ball) {
      this._syncBallDrift(state.ball);
    }

    // Update scores from host (host is still authoritative for scoring)
    if (!this.isHost && state.score) {
      const hostScore = state.score.host;
      const guestScore = state.score.guest;

      // As guest, our local score is guest score
      if (this.remoteScore !== hostScore || this.localScore !== guestScore) {
        this.remoteScore = hostScore;
        this.localScore = guestScore;
        if (this.onScoreUpdate) {
          this.onScoreUpdate(this.localScore, this.remoteScore);
        }
      }
    }

    this.lastRemoteState = state;
  }

  // SPLIT AUTHORITY: Gentle drift correction to keep both clients roughly in sync
  // This is NOT authoritative - collision events are the source of truth for ball direction changes
  _syncBallDrift(peerBall) {
    const now = Date.now();
    const latency = this.connectionInfo.latency || 50;

    // If we recently handled a collision (sent or received), don't let drift correction interfere
    // Use a longer window than collisionCooldownMs to account for network delays
    const collisionProtectionWindow = Math.max(this.collisionCooldownMs * 2, latency * 3);
    if (now - this.lastCollisionTime < collisionProtectionWindow) {
      return;
    }

    // Also protect if we have a pending collision event we sent
    if (this.lastCollisionEvent && (now - this.lastCollisionEvent.timestamp) < latency * 2) {
      return;
    }

    // Forward-predict where peer's ball should be now
    const predictedBall = this._forwardPredictBall(peerBall, latency);

    // Calculate drift
    const dx = Math.abs(this.ball.x - predictedBall.x);
    const dy = Math.abs(this.ball.y - predictedBall.y);

    // Only correct significant drift (>30px) to avoid constant micro-adjustments
    const driftThreshold = 30;

    // If directions match, do gentle position interpolation
    if (Math.sign(this.ball.vx) === Math.sign(peerBall.vx)) {
      if (dx > driftThreshold || dy > driftThreshold) {
        // Larger drift - faster correction
        const lerpFactor = 0.15;
        this.ball.x = this._lerp(this.ball.x, predictedBall.x, lerpFactor);
        this.ball.y = this._lerp(this.ball.y, predictedBall.y, lerpFactor);
      } else if (dx > 10 || dy > 10) {
        // Minor drift - very gentle correction
        const lerpFactor = 0.05;
        this.ball.x = this._lerp(this.ball.x, predictedBall.x, lerpFactor);
        this.ball.y = this._lerp(this.ball.y, predictedBall.y, lerpFactor);
      }
      // Also gently sync velocity to prevent drift from accumulating
      this.ball.vy = this._lerp(this.ball.vy, peerBall.vy, 0.1);
    }
    // If directions don't match, a collision event should be arriving soon
    // Don't fight with collision events - let them take precedence
  }

  // Forward-predict where the ball should be NOW given its state from latency ms ago
  _forwardPredictBall(serverBall, latencyMs) {
    if (latencyMs <= 0) {
      return serverBall;
    }

    // Calculate how many "frames" worth of movement to predict
    // Assuming ~16.67ms per frame at 60fps
    const frameTime = 1000 / CONFIG.TARGET_FPS;
    const framesToPredict = latencyMs / frameTime;

    let x = serverBall.x;
    let y = serverBall.y;
    let vx = serverBall.vx;
    let vy = serverBall.vy;

    // Simple forward prediction with wall bounces
    for (let i = 0; i < framesToPredict; i++) {
      x += vx;
      y += vy;

      // Wall bounces
      if (y - CONFIG.BALL_SIZE / 2 <= 0) {
        y = CONFIG.BALL_SIZE / 2;
        vy = Math.abs(vy);
      }
      if (y + CONFIG.BALL_SIZE / 2 >= CONFIG.CANVAS_HEIGHT) {
        y = CONFIG.CANVAS_HEIGHT - CONFIG.BALL_SIZE / 2;
        vy = -Math.abs(vy);
      }
    }

    return { x, y, vx, vy, speed: serverBall.speed };
  }

  _handleGameStart(state) {
    // Guest receives game_start from host after countdown completes
    if (!this.isHost) {
      // Transition to playing state (countdown should have completed by now)
      if (this.state === 'countdown' || this.state === 'waiting') {
        this.state = 'playing';
        this.gameStartTime = Date.now();
      }

      // Sync ball state from host
      if (state.ball) {
        this.ball.x = state.ball.x;
        this.ball.y = state.ball.y;
        this.ball.vx = state.ball.vx;
        this.ball.vy = state.ball.vy;
        this.ball.speed = state.ball.speed;
      }
    }
  }

  _handleScoreUpdate(state) {
    if (state.localScored !== undefined) {
      // Remote player scored against us
      this.remoteScore++;
      if (this.onScoreUpdate) {
        this.onScoreUpdate(this.localScore, this.remoteScore);
      }
    }
  }

  _handleGameOver(state) {
    this.state = 'finished';
    this._stopNetworkUpdates();

    // Sync final scores from game_over message to ensure accuracy
    if (state.score) {
      if (this.isHost) {
        this.localScore = state.score.host;
        this.remoteScore = state.score.guest;
      } else {
        // Guest: localScore is our score (guest), remoteScore is opponent (host)
        this.localScore = state.score.guest;
        this.remoteScore = state.score.host;
      }

      // Update UI with final scores
      if (this.onScoreUpdate) {
        this.onScoreUpdate(this.localScore, this.remoteScore);
      }
    }

    if (this.onGameOver) {
      this.onGameOver({
        won: state.winner === (this.isHost ? 'host' : 'guest'),
        localScore: this.localScore,
        remoteScore: this.remoteScore
      });
    }
  }

  _handlePlayerLeft(state) {
    this.state = 'finished';
    this.gameEndReason = 'opponent_left';
    this._stopNetworkUpdates();

    if (this.onGameOver) {
      this.onGameOver({
        won: true, // Win by forfeit
        localScore: this.localScore,
        remoteScore: this.remoteScore,
        reason: 'opponent_left'
      });
    }
  }

  // Split Authority: Handle collision event from peer
  // The peer detected a collision with their paddle and is reporting the result
  _handleCollisionEvent(event) {
    // Ignore if we already processed this or a newer collision
    if (event.sequence <= this.lastReceivedCollisionSeq) {
      return;
    }

    const now = Date.now();
    const eventAge = now - event.timestamp;
    const latency = this.connectionInfo.latency || 50;

    // CONFLICT RESOLUTION: Check if we also sent a collision event recently
    if (this.lastCollisionEvent) {
      const ourEventAge = now - this.lastCollisionEvent.timestamp;

      // If both sides sent collision events within a small window, resolve conflict
      if (ourEventAge < latency * 3 && eventAge < latency * 3) {
        // HOST WINS: If we're host, ignore peer's event. If peer is host, accept theirs.
        if (this.isHost) {
          // We're host, our collision takes precedence - ignore peer's event
          console.log('[Split Authority] Conflict: Host wins, ignoring guest collision event');
          this.lastReceivedCollisionSeq = event.sequence;
          return;
        }
        // We're guest, host's event takes precedence - fall through to accept it
        console.log('[Split Authority] Conflict: Host wins, accepting host collision event');
      }
    }

    // Validate the collision event is reasonable
    // Allow events that are within acceptable latency window
    const maxAcceptableAge = Math.max(latency * 4, 400);
    if (eventAge > maxAcceptableAge) {
      console.log('[Split Authority] Rejecting stale collision event, age:', eventAge);
      return;
    }

    // Accept the collision event - apply the new ball state
    this.ball.x = event.ball.x;
    this.ball.y = event.ball.y;
    this.ball.vx = event.ball.vx;
    this.ball.vy = event.ball.vy;
    this.ball.speed = event.ball.speed;

    // Update authority based on new ball direction
    this._updateBallAuthority();

    // Track that we processed this event
    this.lastReceivedCollisionSeq = event.sequence;

    // Set collision cooldown to prevent drift correction from overwriting
    // and to prevent our own collision detection from triggering
    this.lastCollisionTime = now;

    // Clear our own pending collision event since we're accepting peer's state
    this.lastCollisionEvent = null;
  }

  // Split Authority: Handle authority synchronization from host
  _handleAuthoritySync(state) {
    // Only guests accept authority sync from host
    if (this.isHost) return;

    // Host is telling us the current authority state
    if (state.authority && state.authoritySequence > this.authoritySequence) {
      this.ballAuthority = state.authority;
      this.authoritySequence = state.authoritySequence;
      this.lastAuthorityChange = Date.now();

      // Also sync ball state if provided
      if (state.ball) {
        this.ball.x = state.ball.x;
        this.ball.y = state.ball.y;
        this.ball.vx = state.ball.vx;
        this.ball.vy = state.ball.vy;
        this.ball.speed = state.ball.speed;
      }
    }
  }

  // Split Authority: Send a collision event to peer
  _sendCollisionEvent(ball, paddleY) {
    this.authoritySequence++;
    const event = {
      type: 'collision_event',
      timestamp: Date.now(),
      sequence: this.authoritySequence,
      fromHost: this.isHost,
      ball: {
        x: ball.x,
        y: ball.y,
        vx: ball.vx,
        vy: ball.vy,
        speed: ball.speed
      },
      paddleY: paddleY
    };

    this.lastCollisionEvent = event;

    if (pongMultiplayer && pongMultiplayer.sendGameState) {
      pongMultiplayer.sendGameState(event);
    }
  }

  // Split Authority: Update ball authority based on current ball direction
  _updateBallAuthority() {
    const newAuthority = this.ball.vx < 0 ? BallAuthority.HOST : BallAuthority.GUEST;

    if (newAuthority !== this.ballAuthority) {
      this.ballAuthority = newAuthority;
      this.lastAuthorityChange = Date.now();

      // Host sends authority sync to guest to ensure both are aligned
      if (this.isHost && pongMultiplayer && pongMultiplayer.sendGameState) {
        pongMultiplayer.sendGameState({
          type: 'authority_sync',
          authority: this.ballAuthority,
          authoritySequence: this.authoritySequence,
          ball: {
            x: this.ball.x,
            y: this.ball.y,
            vx: this.ball.vx,
            vy: this.ball.vy,
            speed: this.ball.speed
          }
        });
      }
    }
  }

  // Split Authority: Check if we have authority over the ball
  _hasLocalAuthority() {
    if (this.isHost) {
      return this.ballAuthority === BallAuthority.HOST;
    }
    return this.ballAuthority === BallAuthority.GUEST;
  }

  // Split Authority: Handle score reset from host (after a goal)
  _handleScoreReset(state) {
    // Only guests accept score reset from host
    if (this.isHost) return;

    // Update scores
    if (state.score) {
      this.remoteScore = state.score.host;
      this.localScore = state.score.guest;
      if (this.onScoreUpdate) {
        this.onScoreUpdate(this.localScore, this.remoteScore);
      }
    }

    // Reset ball state to match host
    if (state.ball) {
      this.ball.x = state.ball.x;
      this.ball.y = state.ball.y;
      this.ball.vx = state.ball.vx;
      this.ball.vy = state.ball.vy;
      this.ball.speed = state.ball.speed;
    }

    // Update authority
    if (state.authority) {
      this.ballAuthority = state.authority;
      this.authoritySequence = state.authoritySequence || this.authoritySequence;
      this.lastAuthorityChange = Date.now();
    }

    // Clear any pending collision events
    this.lastCollisionEvent = null;

    // Check for win condition on guest side
    if (this.localScore >= CONFIG.WINNING_SCORE || this.remoteScore >= CONFIG.WINNING_SCORE) {
      // Host will send game_over, but we can prepare for it
    }
  }

  // Latency measurement
  _handlePing(state) {
    // Respond to ping with pong
    if (pongMultiplayer && pongMultiplayer.sendGameState) {
      pongMultiplayer.sendGameState({
        type: 'pong',
        pingTimestamp: state.timestamp
      });
    }
  }

  _handlePong(state) {
    // Calculate round trip time
    const rtt = Date.now() - state.pingTimestamp;
    this.connectionInfo.latency = Math.round(rtt / 2);

    if (this.onConnectionInfoUpdate) {
      this.onConnectionInfoUpdate(this.connectionInfo);
    }
  }

  // Send ping to measure latency
  sendPing() {
    if (pongMultiplayer && pongMultiplayer.sendGameState) {
      pongMultiplayer.sendGameState({
        type: 'ping',
        timestamp: Date.now()
      });
    }
  }

  // Game loop
  _gameLoop(currentTime = 0) {
    this.animationId = requestAnimationFrame((t) => this._gameLoop(t));

    const deltaTime = currentTime - this.lastFrameTime;
    this.lastFrameTime = currentTime;

    // Skip if delta is too large (tab was inactive)
    if (deltaTime > 100) {
      return;
    }

    // Update countdown
    if (this.state === 'countdown') {
      this._updateCountdown();
      // Allow paddle movement during countdown
      const timeScale = deltaTime / (1000 / CONFIG.TARGET_FPS);
      this._updateLocalPaddle(timeScale);
      this._interpolateRemotePaddle();
    }

    // Update game state
    if (this.state === 'playing') {
      this._update(deltaTime);
    }

    // Render
    this._render();
  }

  _update(deltaTime) {
    const timeScale = deltaTime / (1000 / CONFIG.TARGET_FPS);

    // Update local paddle (always controlled by player)
    this._updateLocalPaddle(timeScale);

    // Interpolate remote paddle
    this._interpolateRemotePaddle();

    // SPLIT AUTHORITY: Both players run ball physics locally
    // Each player is authoritative for their own paddle's collision detection
    this._updateBallSplitAuthority(timeScale);

    // Only host checks scoring (to avoid double-counting)
    if (this.isHost) {
      this._checkScoring();
    }
  }

  _updateLocalPaddle(timeScale) {
    if (this.keys.up) {
      this.localPaddle.y -= this.localPaddle.speed * timeScale;
    }
    if (this.keys.down) {
      this.localPaddle.y += this.localPaddle.speed * timeScale;
    }

    // Clamp paddle position
    this.localPaddle.y = Math.max(0, Math.min(CONFIG.CANVAS_HEIGHT - this.localPaddle.height, this.localPaddle.y));
  }

  _interpolateRemotePaddle() {
    if (this.remoteStates.length < 2) {
      return;
    }

    const renderTime = Date.now() - CONFIG.MULTIPLAYER.INTERPOLATION_DELAY_MS;

    // Find two states to interpolate between
    let before = null;
    let after = null;

    for (let i = 0; i < this.remoteStates.length; i++) {
      if (this.remoteStates[i].timestamp <= renderTime) {
        before = this.remoteStates[i];
      } else {
        after = this.remoteStates[i];
        break;
      }
    }

    if (before && after) {
      const t = (renderTime - before.timestamp) / (after.timestamp - before.timestamp);
      this.remotePaddle.y = this._lerp(before.paddleY, after.paddleY, Math.max(0, Math.min(1, t)));
    } else if (before) {
      this.remotePaddle.y = before.paddleY;
    } else if (after) {
      this.remotePaddle.y = after.paddleY;
    }

    // Clean up old states
    while (this.remoteStates.length > 0 && this.remoteStates[0].timestamp < renderTime - 1000) {
      this.remoteStates.shift();
    }
  }

  // SPLIT AUTHORITY: Both players run ball physics
  // Each player detects and handles collisions with their OWN paddle
  // Collision events are sent to the peer when we hit the ball
  _updateBallSplitAuthority(timeScale) {
    const now = Date.now();

    // Move ball
    this.ball.x += this.ball.vx * timeScale;
    this.ball.y += this.ball.vy * timeScale;

    // Wall collision (both players handle this identically)
    if (this.ball.y - this.ball.size / 2 <= 0) {
      this.ball.y = this.ball.size / 2;
      this.ball.vy = Math.abs(this.ball.vy);
    }
    if (this.ball.y + this.ball.size / 2 >= CONFIG.CANVAS_HEIGHT) {
      this.ball.y = CONFIG.CANVAS_HEIGHT - this.ball.size / 2;
      this.ball.vy = -Math.abs(this.ball.vy);
    }

    // Collision cooldown - don't detect new collisions too soon after one was handled
    // This prevents double-bounces and race conditions
    if (now - this.lastCollisionTime < this.collisionCooldownMs) {
      return;
    }

    // Check collision with LOCAL paddle (we have authority for our own paddle)
    // Host's local paddle is on left (ball moving left = vx < 0)
    // Guest's local paddle is on right (ball moving right = vx > 0)
    const ballMovingTowardUs = this.isHost ? this.ball.vx < 0 : this.ball.vx > 0;

    if (ballMovingTowardUs) {
      const collision = this._checkLocalPaddleCollisionSplitAuthority();
      if (collision) {
        // We detected a collision with our paddle - apply it and notify peer
        this._applyCollision(collision);
        this._sendCollisionEvent(this.ball, this.localPaddle.y);
        this._updateBallAuthority();
        this.lastCollisionTime = now;
      }
    } else {
      // Ball is moving toward peer's paddle - we don't have authority
      // But we do a LOCAL visual prediction to prevent ball going through visually
      // The real collision event from peer will override this when it arrives
      this._predictRemotePaddleCollisionVisual();
    }
  }

  // Visual-only prediction for remote paddle collision
  // This doesn't send events - it just prevents the ball from visually going through
  // while we wait for the authoritative collision event from peer
  _predictRemotePaddleCollisionVisual() {
    // Don't predict if we recently had a collision (prevents double-bounce)
    const now = Date.now();
    if (now - this.lastCollisionTime < this.collisionCooldownMs) {
      return;
    }

    const paddle = this.remotePaddle;
    const ballLeft = this.ball.x - this.ball.size / 2;
    const ballRight = this.ball.x + this.ball.size / 2;
    const ballTop = this.ball.y - this.ball.size / 2;
    const ballBottom = this.ball.y + this.ball.size / 2;

    const paddleLeft = paddle.x;
    const paddleRight = paddle.x + paddle.width;
    const paddleTop = paddle.y;
    const paddleBottom = paddle.y + paddle.height;

    // Check collision with remote paddle
    if (ballRight >= paddleLeft && ballLeft <= paddleRight &&
        ballBottom >= paddleTop && ballTop <= paddleBottom) {

      // Calculate bounce angle based on hit position
      const hitPos = ((this.ball.y - paddle.y) / paddle.height) * 2 - 1;
      const newSpeed = Math.min(this.ball.speed + CONFIG.BALL_SPEED_INCREMENT, CONFIG.BALL_MAX_SPEED);

      const maxAngle = 60 * Math.PI / 180;
      const angle = hitPos * maxAngle;

      // Direction: if we're host, remote is on right, ball bounces left (negative)
      //            if we're guest, remote is on left, ball bounces right (positive)
      const bounceDirection = this.isHost ? -1 : 1;

      this.ball.vx = Math.cos(angle) * newSpeed * bounceDirection;
      this.ball.vy = Math.sin(angle) * newSpeed;
      this.ball.speed = newSpeed;

      // Move ball outside paddle
      if (this.isHost) {
        // Remote paddle is on right, bounce left
        this.ball.x = paddleLeft - this.ball.size / 2;
      } else {
        // Remote paddle is on left, bounce right
        this.ball.x = paddleRight + this.ball.size / 2;
      }

      // Set collision time to prevent repeated predictions and drift interference
      // The real collision event from peer will update this again when it arrives
      this.lastCollisionTime = now;

      // We don't send an event - peer is authoritative for their paddle
    }
  }

  // Check collision with our local paddle and return collision data if hit
  _checkLocalPaddleCollisionSplitAuthority() {
    const paddle = this.localPaddle;
    const ballLeft = this.ball.x - this.ball.size / 2;
    const ballRight = this.ball.x + this.ball.size / 2;
    const ballTop = this.ball.y - this.ball.size / 2;
    const ballBottom = this.ball.y + this.ball.size / 2;

    const paddleLeft = paddle.x;
    const paddleRight = paddle.x + paddle.width;
    const paddleTop = paddle.y;
    const paddleBottom = paddle.y + paddle.height;

    // Check collision
    if (ballRight >= paddleLeft && ballLeft <= paddleRight &&
        ballBottom >= paddleTop && ballTop <= paddleBottom) {

      // Calculate bounce angle based on hit position
      const hitPos = ((this.ball.y - paddle.y) / paddle.height) * 2 - 1;
      const newSpeed = Math.min(this.ball.speed + CONFIG.BALL_SPEED_INCREMENT, CONFIG.BALL_MAX_SPEED);

      const maxAngle = 60 * Math.PI / 180;
      const angle = hitPos * maxAngle;

      // Direction: host bounces right (positive), guest bounces left (negative)
      const bounceDirection = this.isHost ? 1 : -1;

      return {
        vx: Math.cos(angle) * newSpeed * bounceDirection,
        vy: Math.sin(angle) * newSpeed,
        speed: newSpeed,
        // New X position outside paddle to prevent sticking
        newX: this.isHost
          ? paddleRight + this.ball.size / 2
          : paddleLeft - this.ball.size / 2
      };
    }

    return null;
  }

  // Apply collision result to ball
  _applyCollision(collision) {
    this.ball.vx = collision.vx;
    this.ball.vy = collision.vy;
    this.ball.speed = collision.speed;
    this.ball.x = collision.newX;
  }

  _checkScoring() {
    // Ball went past left edge (host's side - remote scores)
    if (this.ball.x + this.ball.size / 2 < 0) {
      this.remoteScore++;
      this._onScore();
      this._resetBallWithSync(1);
      return; // Don't check both conditions in same frame
    }

    // Ball went past right edge (remote's side - host scores)
    if (this.ball.x - this.ball.size / 2 > CONFIG.CANVAS_WIDTH) {
      this.localScore++;
      this._onScore();
      this._resetBallWithSync(-1);
      return;
    }

    // Check for win condition
    if (this.localScore >= CONFIG.WINNING_SCORE || this.remoteScore >= CONFIG.WINNING_SCORE) {
      this._endGame();
    }
  }

  // Reset ball and sync state to peer (split authority)
  _resetBallWithSync(direction) {
    this._resetBall(direction);

    // Update authority based on new ball direction
    this._updateBallAuthority();

    // Clear any pending collision events since we're resetting
    this.lastCollisionEvent = null;

    // Send score update with new ball state to peer
    if (pongMultiplayer && pongMultiplayer.sendGameState) {
      pongMultiplayer.sendGameState({
        type: 'score_reset',
        score: {
          host: this.localScore,
          guest: this.remoteScore
        },
        ball: {
          x: this.ball.x,
          y: this.ball.y,
          vx: this.ball.vx,
          vy: this.ball.vy,
          speed: this.ball.speed
        },
        authority: this.ballAuthority,
        authoritySequence: this.authoritySequence
      });
    }
  }

  _onScore() {
    if (this.onScoreUpdate) {
      this.onScoreUpdate(this.localScore, this.remoteScore);
    }
  }

  _endGame() {
    this.state = 'finished';
    this._stopNetworkUpdates();

    const winner = this.localScore > this.remoteScore ? 'host' : 'guest';

    // Notify peer
    if (pongMultiplayer && pongMultiplayer.sendGameState) {
      pongMultiplayer.sendGameState({
        type: 'game_over',
        winner: winner,
        score: {
          host: this.localScore,
          guest: this.remoteScore
        }
      });
    }

    if (this.onGameOver) {
      this.onGameOver({
        won: winner === 'host',
        localScore: this.localScore,
        remoteScore: this.remoteScore
      });
    }
  }

  // Rendering
  _render() {
    const ctx = this.ctx;

    // Clear canvas
    ctx.fillStyle = CONFIG.COLORS.BACKGROUND;
    ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

    // Draw center line
    this._drawNet();

    // Draw paddles
    this._drawPaddle(this.localPaddle, CONFIG.COLORS.PADDLE);
    this._drawPaddle(this.remotePaddle, '#00cc66'); // Slightly different color for remote

    // Draw ball
    this._drawBall();

    // Draw scores
    this._drawScores();

    // Draw state-specific overlays
    if (this.state === 'waiting') {
      this._drawWaitingOverlay();
    } else if (this.state === 'countdown') {
      this._drawCountdownOverlay();
    } else if (this.state === 'paused') {
      this._drawPausedOverlay();
    } else if (this.state === 'finished') {
      this._drawFinishedOverlay();
    }
  }

  _drawNet() {
    const ctx = this.ctx;
    ctx.setLineDash([10, 10]);
    ctx.strokeStyle = CONFIG.COLORS.NET;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CONFIG.CANVAS_WIDTH / 2, 0);
    ctx.lineTo(CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawPaddle(paddle, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;

    const radius = paddle.width / 2;
    ctx.beginPath();
    ctx.roundRect(paddle.x, paddle.y, paddle.width, paddle.height, radius);
    ctx.fill();
  }

  _drawBall() {
    const ctx = this.ctx;
    ctx.fillStyle = CONFIG.COLORS.BALL;
    ctx.beginPath();
    ctx.arc(this.ball.x, this.ball.y, this.ball.size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawScores() {
    const ctx = this.ctx;
    ctx.fillStyle = CONFIG.COLORS.SCORE;
    ctx.font = 'bold 48px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Local score (left for host, right for guest)
    const leftScore = this.isHost ? this.localScore : this.remoteScore;
    const rightScore = this.isHost ? this.remoteScore : this.localScore;

    ctx.fillText(leftScore.toString(), CONFIG.CANVAS_WIDTH / 4, 20);
    ctx.fillText(rightScore.toString(), (CONFIG.CANVAS_WIDTH / 4) * 3, 20);

    // Draw role indicators
    ctx.font = '12px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    const leftLabel = this.isHost ? 'YOU' : 'THEM';
    const rightLabel = this.isHost ? 'THEM' : 'YOU';
    ctx.fillText(leftLabel, CONFIG.CANVAS_WIDTH / 4, 75);
    ctx.fillText(rightLabel, (CONFIG.CANVAS_WIDTH / 4) * 3, 75);
  }

  _drawWaitingOverlay() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

    ctx.fillStyle = CONFIG.COLORS.TEXT;
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MULTIPLAYER', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 50);

    ctx.font = '18px sans-serif';
    ctx.fillText(`First to ${CONFIG.WINNING_SCORE} wins!`, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2);

    ctx.font = '14px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('Waiting for game to start...', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 35);
    ctx.fillText(`You are the ${this.isHost ? 'HOST' : 'GUEST'}`, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 60);
  }

  _drawCountdownOverlay() {
    const ctx = this.ctx;

    // Semi-transparent background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

    // Calculate scale animation based on time within current second
    const elapsed = Date.now() - this.countdownStartTime;
    const currentSecondProgress = (elapsed % 1000) / 1000;
    const scale = 1 + (1 - currentSecondProgress) * 0.3; // Pulse effect

    ctx.save();
    ctx.translate(CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2);
    ctx.scale(scale, scale);

    // Draw countdown number or "GO!"
    if (this.countdownValue > 0) {
      ctx.fillStyle = '#00ff88';
      ctx.font = 'bold 120px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.countdownValue.toString(), 0, 0);
    } else {
      ctx.fillStyle = '#ffcc00';
      ctx.font = 'bold 80px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GO!', 0, 0);
    }

    ctx.restore();

    // Draw "Get Ready!" text above countdown
    ctx.fillStyle = CONFIG.COLORS.TEXT;
    ctx.font = '24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Get Ready!', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 100);

    // Draw role indicator below
    ctx.font = '16px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(`You are the ${this.isHost ? 'HOST' : 'GUEST'}`, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 100);
  }

  _drawPausedOverlay() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

    ctx.fillStyle = CONFIG.COLORS.TEXT;
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2);
  }

  _drawFinishedOverlay() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

    const won = this.localScore > this.remoteScore || this.gameEndReason === 'opponent_left';

    ctx.fillStyle = won ? '#00ff88' : '#ff4444';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(won ? 'YOU WIN!' : 'GAME OVER', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 40);

    // Show reason subtitle
    if (this.gameEndReason === 'opponent_left') {
      ctx.fillStyle = '#ffaa00';
      ctx.font = '20px sans-serif';
      ctx.fillText('Opponent left the match', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2);
    }

    ctx.fillStyle = CONFIG.COLORS.TEXT;
    ctx.font = '24px sans-serif';
    const scoreY = this.gameEndReason === 'opponent_left' ? CONFIG.CANVAS_HEIGHT / 2 + 35 : CONFIG.CANVAS_HEIGHT / 2 + 10;
    ctx.fillText(`${this.localScore} - ${this.remoteScore}`, CONFIG.CANVAS_WIDTH / 2, scoreY);
  }

  // Utility
  _lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Getters
  getState() {
    return this.state;
  }

  getScores() {
    return {
      local: this.localScore,
      remote: this.remoteScore
    };
  }

  getGameDuration() {
    if (!this.gameStartTime) {
      return 0;
    }
    return Math.floor((Date.now() - this.gameStartTime) / 1000);
  }

  setConnectionInfo(info) {
    this.connectionInfo = info;
    if (this.onConnectionInfoUpdate) {
      this.onConnectionInfoUpdate(info);
    }
  }
}
