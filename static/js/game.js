// Pong Game Engine
// Canvas-based single-player Pong game with AI opponent

class PongGame {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');

    // Set canvas size
    this.canvas.width = CONFIG.CANVAS_WIDTH;
    this.canvas.height = CONFIG.CANVAS_HEIGHT;

    // Game state
    this.state = 'waiting'; // waiting, playing, paused
    this.gameStartTime = null;

    // Scores
    this.playerScore = 0;
    this.aiScore = 0;

    // Initialize game objects
    this._initPaddles();
    this._initBall();

    // Input state
    this.keys = {
      up: false,
      down: false
    };

    // AI state
    this.aiTargetY = CONFIG.CANVAS_HEIGHT / 2;
    this.aiLastUpdate = 0;

    // Animation
    this.lastFrameTime = 0;
    this.animationId = null;

    // Event callbacks
    this.onScoreUpdate = null;
    this.onPlayerScore = null;

    // Bind event handlers
    this._bindEvents();
  }

  _initPaddles() {
    // Player paddle (left)
    this.player = {
      x: CONFIG.PADDLE_MARGIN,
      y: (CONFIG.CANVAS_HEIGHT - CONFIG.PADDLE_HEIGHT) / 2,
      width: CONFIG.PADDLE_WIDTH,
      height: CONFIG.PADDLE_HEIGHT,
      speed: CONFIG.PADDLE_SPEED
    };

    // AI paddle (right)
    this.ai = {
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
    document.addEventListener('keydown', (e) => this._handleKeyDown(e));
    document.addEventListener('keyup', (e) => this._handleKeyUp(e));

    // Touch events for mobile
    this.canvas.addEventListener('touchstart', (e) => this._handleTouch(e));
    this.canvas.addEventListener('touchmove', (e) => this._handleTouch(e));
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
      case ' ':
        if (this.state === 'waiting') {
          this.start();
        } else if (this.state === 'playing') {
          this.pause();
        } else if (this.state === 'paused') {
          this.resume();
        }
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

    // Move paddle towards touch position
    const paddleCenter = this.player.y + this.player.height / 2;
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

  // Game Control Methods
  start() {
    this.state = 'playing';
    this.gameStartTime = Date.now();
    this._resetBall(Math.random() > 0.5 ? 1 : -1);

    if (!this.animationId) {
      this._gameLoop();
    }
  }

  pause() {
    if (this.state === 'playing') {
      this.state = 'paused';
    }
  }

  resume() {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.lastFrameTime = performance.now();
    }
  }

  reset() {
    this.state = 'waiting';
    this.playerScore = 0;
    this.aiScore = 0;
    this.gameStartTime = null;

    this._initPaddles();
    this._initBall();

    if (this.onScoreUpdate) {
      this.onScoreUpdate(this.playerScore, this.aiScore);
    }
  }

  // Game Loop
  _gameLoop(currentTime = 0) {
    this.animationId = requestAnimationFrame((t) => this._gameLoop(t));

    // Calculate delta time
    const deltaTime = currentTime - this.lastFrameTime;
    this.lastFrameTime = currentTime;

    // Skip if delta is too large (tab was inactive)
    if (deltaTime > 100) {
      return;
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

    // Update player paddle
    this._updatePlayerPaddle(timeScale);

    // Update AI paddle
    this._updateAIPaddle(timeScale);

    // Update ball
    this._updateBall(timeScale);

    // Check for scoring
    this._checkScoring();
  }

  _updatePlayerPaddle(timeScale) {
    if (this.keys.up) {
      this.player.y -= this.player.speed * timeScale;
    }
    if (this.keys.down) {
      this.player.y += this.player.speed * timeScale;
    }

    // Clamp paddle position
    this.player.y = Math.max(0, Math.min(CONFIG.CANVAS_HEIGHT - this.player.height, this.player.y));
  }

  _updateAIPaddle(timeScale) {
    const now = performance.now();

    // Update AI target periodically
    if (now - this.aiLastUpdate > CONFIG.AI_REACTION_DELAY) {
      this.aiLastUpdate = now;

      // Predict where ball will be when it reaches AI paddle
      if (this.ball.vx > 0) {
        const timeToReach = (this.ai.x - this.ball.x) / this.ball.vx;
        let predictedY = this.ball.y + this.ball.vy * timeToReach;

        // Account for bounces
        while (predictedY < 0 || predictedY > CONFIG.CANVAS_HEIGHT) {
          if (predictedY < 0) {
            predictedY = -predictedY;
          }
          if (predictedY > CONFIG.CANVAS_HEIGHT) {
            predictedY = 2 * CONFIG.CANVAS_HEIGHT - predictedY;
          }
        }

        // Add some randomness based on difficulty
        const error = (1 - CONFIG.AI_DIFFICULTY) * CONFIG.AI_PREDICTION_ERROR;
        predictedY += (Math.random() - 0.5) * 2 * error;

        this.aiTargetY = predictedY;
      } else {
        // Ball moving away, return to center
        this.aiTargetY = CONFIG.CANVAS_HEIGHT / 2;
      }
    }

    // Move towards target
    const paddleCenter = this.ai.y + this.ai.height / 2;
    const diff = this.aiTargetY - paddleCenter;
    const moveAmount = Math.min(Math.abs(diff), this.ai.speed * CONFIG.AI_DIFFICULTY * timeScale);

    if (diff > 0) {
      this.ai.y += moveAmount;
    } else if (diff < 0) {
      this.ai.y -= moveAmount;
    }

    // Clamp paddle position
    this.ai.y = Math.max(0, Math.min(CONFIG.CANVAS_HEIGHT - this.ai.height, this.ai.y));
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
    this._checkPaddleCollision(this.player, -1);
    this._checkPaddleCollision(this.ai, 1);
  }

  _checkPaddleCollision(paddle, direction) {
    // Check if ball overlaps paddle
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

      // Calculate hit position (-1 to 1, where 0 is center)
      const hitPos = ((this.ball.y - paddle.y) / paddle.height) * 2 - 1;

      // Increase speed slightly
      this.ball.speed = Math.min(this.ball.speed + CONFIG.BALL_SPEED_INCREMENT, CONFIG.BALL_MAX_SPEED);

      // Calculate new angle based on hit position (max 60 degrees)
      const maxAngle = 60 * Math.PI / 180;
      const angle = hitPos * maxAngle;

      // Set new velocity
      this.ball.vx = Math.cos(angle) * this.ball.speed * (-direction);
      this.ball.vy = Math.sin(angle) * this.ball.speed;

      // Move ball outside paddle to prevent sticking
      if (direction === -1) {
        this.ball.x = paddleRight + this.ball.size / 2;
      } else {
        this.ball.x = paddleLeft - this.ball.size / 2;
      }
    }
  }

  _checkScoring() {
    // Ball went past left edge (AI scores)
    if (this.ball.x + this.ball.size / 2 < 0) {
      this.aiScore++;
      this._onScore();
      this._resetBall(1); // Ball goes towards player
    }

    // Ball went past right edge (Player scores)
    if (this.ball.x - this.ball.size / 2 > CONFIG.CANVAS_WIDTH) {
      this.playerScore++;
      this._onScore();
      this._onPlayerScore();
      this._resetBall(-1); // Ball goes towards AI
    }
  }

  _onScore() {
    if (this.onScoreUpdate) {
      this.onScoreUpdate(this.playerScore, this.aiScore);
    }
  }

  _onPlayerScore() {
    if (this.onPlayerScore) {
      this.onPlayerScore();
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
    this._drawPaddle(this.player);
    this._drawPaddle(this.ai);

    // Draw ball
    this._drawBall();

    // Draw scores
    this._drawScores();

    // Draw state-specific overlays
    if (this.state === 'waiting') {
      this._drawWaitingOverlay();
    } else if (this.state === 'paused') {
      this._drawPausedOverlay();
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

  _drawPaddle(paddle) {
    const ctx = this.ctx;
    ctx.fillStyle = CONFIG.COLORS.PADDLE;

    // Draw with rounded corners
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

    // Player score (left)
    ctx.fillText(this.playerScore.toString(), CONFIG.CANVAS_WIDTH / 4, 20);

    // AI score (right)
    ctx.fillText(this.aiScore.toString(), (CONFIG.CANVAS_WIDTH / 4) * 3, 20);
  }

  _drawWaitingOverlay() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

    ctx.fillStyle = CONFIG.COLORS.TEXT;
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PONG', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 60);

    ctx.font = '20px sans-serif';
    ctx.fillText('Press SPACE or click START to play', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2);
    ctx.fillText('Use W/S or Arrow keys to move', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 40);
    ctx.fillText('Score points to climb the leaderboard!', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 80);
  }

  _drawPausedOverlay() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);

    ctx.fillStyle = CONFIG.COLORS.TEXT;
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 20);

    ctx.font = '20px sans-serif';
    ctx.fillText('Press SPACE to resume', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 20);
  }

  // Getters
  getState() {
    return this.state;
  }

  getScores() {
    return {
      player: this.playerScore,
      ai: this.aiScore
    };
  }

  getGameDuration() {
    if (!this.gameStartTime) {
      return 0;
    }
    return Math.floor((Date.now() - this.gameStartTime) / 1000);
  }
}
