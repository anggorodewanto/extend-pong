// Pong Game Configuration
// This file contains all configurable constants for the game and API

const CONFIG = {
  // API Configuration
  AGS_BASE_URL: 'https://abtestdewa-pong.internal.gamingservices.accelbyte.io',
  NAMESPACE: 'abtestdewa-pong',
  CLIENT_ID: 'd6bb5dd2cf6b4d23bd6d6400d7886b94', // Public OAuth client for headless login
  BACKEND_URL: window.location.origin + '/' + window.location.pathname.split('/')[1],

  // Game Canvas
  CANVAS_WIDTH: 800,
  CANVAS_HEIGHT: 600,

  // Paddle Configuration
  PADDLE_WIDTH: 10,
  PADDLE_HEIGHT: 100,
  PADDLE_SPEED: 8,
  PADDLE_MARGIN: 20, // Distance from edge

  // Ball Configuration
  BALL_SIZE: 10,
  BALL_INITIAL_SPEED: 5,
  BALL_MAX_SPEED: 12,
  BALL_SPEED_INCREMENT: 0.5, // Speed increase on paddle hit

  // Game Rules
  WINNING_SCORE: 11,

  // AI Configuration
  AI_DIFFICULTY: 0.7, // 0.0 (easy) to 1.0 (hard)
  AI_REACTION_DELAY: 50, // milliseconds
  AI_PREDICTION_ERROR: 30, // pixels of random error

  // Colors
  COLORS: {
    BACKGROUND: '#1a1a2e',
    PADDLE: '#00ff88',
    BALL: '#ffffff',
    NET: '#333333',
    SCORE: '#ffffff',
    TEXT: '#ffffff'
  },

  // Leaderboard
  LEADERBOARD_LIMIT: 10,
  LEADERBOARD_CACHE_TTL: 30000, // 30 seconds in milliseconds

  // Animation
  TARGET_FPS: 60
};

// Freeze config to prevent accidental modifications
Object.freeze(CONFIG);
Object.freeze(CONFIG.COLORS);
