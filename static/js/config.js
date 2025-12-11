// Pong Game Configuration
// This file contains all configurable constants for the game and API

const CONFIG = {
  // API Configuration
  AGS_BASE_URL: 'https://abtestdewa-pong.internal.gamingservices.accelbyte.io',
  NAMESPACE: 'abtestdewa-pong',
  CLIENT_ID: 'd6bb5dd2cf6b4d23bd6d6400d7886b94', // Public OAuth client for headless login
  BACKEND_URL: window.location.origin + '/' + window.location.pathname.split('/')[1],

  // Game Canvas
  CANVAS_WIDTH: 640,
  CANVAS_HEIGHT: 480,

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
  TARGET_FPS: 60,

  // Win condition
  WINNING_SCORE: 11,

  // Multiplayer Configuration
  MULTIPLAYER: {
    // Matchmaking
    MATCH_POOL: 'pong-1v1',
    TICKET_TIMEOUT_SEC: 120,

    // Session
    SESSION_TEMPLATE: 'pong-p2p-session',
    MIN_PLAYERS: 2,
    MAX_PLAYERS: 2,

    // Countdown before game starts
    COUNTDOWN_SECONDS: 3,

    // Networking
    TICK_RATE: 60,              // Game simulation rate (Hz)
    SEND_RATE: 30,              // Network update rate (Hz)
    INTERPOLATION_DELAY_MS: 50, // Buffer for smooth interpolation

    // Lag compensation
    LAG_COMPENSATION_ENABLED: true,   // Rewind remote paddle for fair collision detection
    MAX_LAG_COMPENSATION_MS: 200,     // Base maximum rewind time
    MAX_LAG_COMPENSATION_MS_RELAY: 350, // Extended max for RELAY connections (high latency expected)
    ADAPTIVE_LAG_COMPENSATION: true,  // Dynamically adjust based on measured latency

    // WebRTC DataChannel
    DATA_CHANNEL_NAME: 'pong-game',
    ORDERED: false,             // Unordered for lowest latency
    MAX_RETRANSMITS: 0,         // No retransmits for real-time

    // Reconnection
    MAX_RECONNECT_ATTEMPTS: 3,
    RECONNECT_DELAY_MS: 1000,

    // Timeouts
    SIGNALING_TIMEOUT_MS: 10000,
    ICE_GATHERING_TIMEOUT_MS: 5000,
    CONNECTION_TIMEOUT_MS: 15000,

    // Lobby WebSocket
    LOBBY_RECONNECT_DELAY_MS: 1000,
    LOBBY_MAX_RECONNECT_ATTEMPTS: 5
  }
};

// Freeze config to prevent accidental modifications
Object.freeze(CONFIG);
Object.freeze(CONFIG.COLORS);
Object.freeze(CONFIG.MULTIPLAYER);
