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
      case 'Escape':
        if (this.state === 'playing') {
          this.pause();
        }
        e.preventDefault();
        break;
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
    this.sequence = 0;
    this.remoteStates = [];
    this.lastRemoteState = null;

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

    // Guest receives authoritative ball state from host
    if (!this.isHost && state.ball) {
      this._reconcileBallState(state.ball);
    }

    // Update scores from host
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

  _reconcileBallState(serverBall) {
    // Calculate difference from predicted position
    const dx = Math.abs(this.ball.x - serverBall.x);
    const dy = Math.abs(this.ball.y - serverBall.y);

    // If significant desync, snap to server state
    if (dx > 20 || dy > 20) {
      this.ball.x = serverBall.x;
      this.ball.y = serverBall.y;
      this.ball.vx = serverBall.vx;
      this.ball.vy = serverBall.vy;
      this.ball.speed = serverBall.speed;
    } else {
      // Smooth interpolation for minor differences
      this.ball.x = this._lerp(this.ball.x, serverBall.x, 0.3);
      this.ball.y = this._lerp(this.ball.y, serverBall.y, 0.3);
      this.ball.vx = serverBall.vx;
      this.ball.vy = serverBall.vy;
      this.ball.speed = serverBall.speed;
    }
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

    // Update ball (host is authoritative)
    if (this.isHost) {
      this._updateBall(timeScale);
      this._checkScoring();
    } else {
      // Guest predicts ball locally for smooth rendering
      this._predictBall(timeScale);
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

  _updateBall(timeScale) {
    // Move ball
    this.ball.x += this.ball.vx * timeScale;
    this.ball.y += this.ball.vy * timeScale;

    // Top/bottom wall collision
    if (this.ball.y - this.ball.size / 2 <= 0) {
      this.ball.y = this.ball.size / 2;
      this.ball.vy = Math.abs(this.ball.vy);
    }
    if (this.ball.y + this.ball.size / 2 >= CONFIG.CANVAS_HEIGHT) {
      this.ball.y = CONFIG.CANVAS_HEIGHT - this.ball.size / 2;
      this.ball.vy = -Math.abs(this.ball.vy);
    }

    // Paddle collision
    // Host's local paddle is on left, remote on right
    this._checkPaddleCollision(this.localPaddle, -1);
    this._checkPaddleCollision(this.remotePaddle, 1);
  }

  _predictBall(timeScale) {
    // Guest does local prediction for smooth rendering
    // Actual ball state comes from host
    this.ball.x += this.ball.vx * timeScale;
    this.ball.y += this.ball.vy * timeScale;

    // Wall collision prediction
    if (this.ball.y - this.ball.size / 2 <= 0 ||
        this.ball.y + this.ball.size / 2 >= CONFIG.CANVAS_HEIGHT) {
      this.ball.vy = -this.ball.vy;
    }
  }

  _checkPaddleCollision(paddle, direction) {
    const ballLeft = this.ball.x - this.ball.size / 2;
    const ballRight = this.ball.x + this.ball.size / 2;
    const ballTop = this.ball.y - this.ball.size / 2;
    const ballBottom = this.ball.y + this.ball.size / 2;

    const paddleLeft = paddle.x;
    const paddleRight = paddle.x + paddle.width;
    const paddleTop = paddle.y;
    const paddleBottom = paddle.y + paddle.height;

    if (ballRight >= paddleLeft && ballLeft <= paddleRight &&
        ballBottom >= paddleTop && ballTop <= paddleBottom) {

      const hitPos = ((this.ball.y - paddle.y) / paddle.height) * 2 - 1;
      this.ball.speed = Math.min(this.ball.speed + CONFIG.BALL_SPEED_INCREMENT, CONFIG.BALL_MAX_SPEED);

      const maxAngle = 60 * Math.PI / 180;
      const angle = hitPos * maxAngle;

      this.ball.vx = Math.cos(angle) * this.ball.speed * (-direction);
      this.ball.vy = Math.sin(angle) * this.ball.speed;

      if (direction === -1) {
        this.ball.x = paddleRight + this.ball.size / 2;
      } else {
        this.ball.x = paddleLeft - this.ball.size / 2;
      }
    }
  }

  _checkScoring() {
    // Ball went past left edge (host's side - remote scores)
    if (this.ball.x + this.ball.size / 2 < 0) {
      this.remoteScore++;
      this._onScore(false);
      this._resetBall(1);
    }

    // Ball went past right edge (remote's side - host scores)
    if (this.ball.x - this.ball.size / 2 > CONFIG.CANVAS_WIDTH) {
      this.localScore++;
      this._onScore(true);
      this._resetBall(-1);
    }

    // Check for win condition
    if (this.localScore >= CONFIG.WINNING_SCORE || this.remoteScore >= CONFIG.WINNING_SCORE) {
      this._endGame();
    }
  }

  _onScore(localScored) {
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

    const won = this.localScore > this.remoteScore;

    ctx.fillStyle = won ? '#00ff88' : '#ff4444';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(won ? 'YOU WIN!' : 'GAME OVER', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 30);

    ctx.fillStyle = CONFIG.COLORS.TEXT;
    ctx.font = '24px sans-serif';
    ctx.fillText(`${this.localScore} - ${this.remoteScore}`, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 20);
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
