// Pong Game API Client
// Handles AGS IAM headless login and backend API communication

class PongAPI {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.userId = null;
    this.displayName = null;
    this.tokenExpiry = null;
    this.leaderboardCache = null;
    this.leaderboardCacheTime = null;
    this._refreshTimeoutId = null;
    this._onTokenRefreshCallbacks = [];

    // Restore session from storage
    this._restoreSession();
  }

  // Device ID Management
  getDeviceId() {
    let deviceId = localStorage.getItem('pong_device_id');
    if (!deviceId) {
      deviceId = 'pong_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      localStorage.setItem('pong_device_id', deviceId);
    }
    return deviceId;
  }

  // Session Management
  _restoreSession() {
    const token = sessionStorage.getItem('pong_access_token');
    const refreshToken = sessionStorage.getItem('pong_refresh_token');
    const expiry = sessionStorage.getItem('pong_token_expiry');
    const userId = sessionStorage.getItem('pong_user_id');
    const displayName = sessionStorage.getItem('pong_display_name');

    if (token && expiry && new Date(expiry) > new Date()) {
      this.accessToken = token;
      this.refreshToken = refreshToken;
      this.tokenExpiry = new Date(expiry);
      this.userId = userId;
      this.displayName = displayName;
      this._scheduleTokenRefresh();
    } else if (refreshToken) {
      // Token expired but we have a refresh token - try to refresh
      this.refreshToken = refreshToken;
      this.userId = userId;
      this.displayName = displayName;
      this._refreshAccessToken();
    }
  }

  _saveSession(tokenData) {
    const expiryDate = new Date(Date.now() + (tokenData.expires_in * 1000));

    this.accessToken = tokenData.access_token;
    this.refreshToken = tokenData.refresh_token || this.refreshToken;
    this.tokenExpiry = expiryDate;
    this.userId = tokenData.user_id || this.userId;
    this.displayName = tokenData.display_name || this.displayName || `Player_${this.userId.substring(0, 6)}`;

    sessionStorage.setItem('pong_access_token', this.accessToken);
    if (this.refreshToken) {
      sessionStorage.setItem('pong_refresh_token', this.refreshToken);
    }
    sessionStorage.setItem('pong_token_expiry', expiryDate.toISOString());
    sessionStorage.setItem('pong_user_id', this.userId);
    sessionStorage.setItem('pong_display_name', this.displayName);

    this._scheduleTokenRefresh();
  }

  _clearSession() {
    this._cancelScheduledRefresh();
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    this.userId = null;
    this.displayName = null;

    sessionStorage.removeItem('pong_access_token');
    sessionStorage.removeItem('pong_refresh_token');
    sessionStorage.removeItem('pong_token_expiry');
    sessionStorage.removeItem('pong_user_id');
    sessionStorage.removeItem('pong_display_name');
  }

  // Token Refresh Management
  _scheduleTokenRefresh() {
    this._cancelScheduledRefresh();

    if (!this.tokenExpiry || !this.refreshToken) {
      return;
    }

    // Refresh 60 seconds before expiry
    const refreshBuffer = 60 * 1000;
    const timeUntilExpiry = this.tokenExpiry.getTime() - Date.now();
    const refreshDelay = Math.max(timeUntilExpiry - refreshBuffer, 0);

    console.log(`[API] Token refresh scheduled in ${Math.round(refreshDelay / 1000)}s`);

    this._refreshTimeoutId = setTimeout(() => {
      this._refreshAccessToken();
    }, refreshDelay);
  }

  _cancelScheduledRefresh() {
    if (this._refreshTimeoutId) {
      clearTimeout(this._refreshTimeoutId);
      this._refreshTimeoutId = null;
    }
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) {
      console.warn('[API] No refresh token available');
      return false;
    }

    const credentials = btoa(`${CONFIG.CLIENT_ID}:`);

    try {
      console.log('[API] Refreshing access token...');

      const response = await fetch(`${CONFIG.AGS_BASE_URL}/iam/v3/oauth/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          'grant_type': 'refresh_token',
          'refresh_token': this.refreshToken
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[API] Token refresh failed:', errorData);
        this._clearSession();
        return false;
      }

      const data = await response.json();
      this._saveSession(data);

      console.log('[API] Token refreshed successfully');

      // Notify all registered callbacks
      this._notifyTokenRefresh(this.accessToken);

      return true;
    } catch (error) {
      console.error('[API] Token refresh error:', error);
      this._clearSession();
      return false;
    }
  }

  // Register a callback to be notified when the token is refreshed
  onTokenRefresh(callback) {
    this._onTokenRefreshCallbacks.push(callback);
  }

  // Unregister a token refresh callback
  offTokenRefresh(callback) {
    const index = this._onTokenRefreshCallbacks.indexOf(callback);
    if (index !== -1) {
      this._onTokenRefreshCallbacks.splice(index, 1);
    }
  }

  _notifyTokenRefresh(newToken) {
    for (const callback of this._onTokenRefreshCallbacks) {
      try {
        callback(newToken);
      } catch (error) {
        console.error('[API] Token refresh callback error:', error);
      }
    }
  }

  isLoggedIn() {
    return this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry;
  }

  // AGS IAM Headless Login (Direct to AGS)
  async headlessLogin() {
    // Check if already logged in with valid token
    if (this.isLoggedIn()) {
      console.log('Already logged in, reusing session');
      return {
        access_token: this.accessToken,
        user_id: this.userId,
        display_name: this.displayName
      };
    }

    const deviceId = this.getDeviceId();

    // For public clients, the secret is empty
    const credentials = btoa(`${CONFIG.CLIENT_ID}:`);

    try {
      const response = await fetch(`${CONFIG.AGS_BASE_URL}/iam/v3/oauth/platforms/device/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          'device_id': deviceId,
          'namespace': CONFIG.NAMESPACE
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error_description || `Login failed: ${response.status}`);
      }

      const data = await response.json();
      this._saveSession(data);

      console.log('Headless login successful', { userId: this.userId, displayName: this.displayName });
      return data;
    } catch (error) {
      console.error('Headless login error:', error);
      throw error;
    }
  }

  // Logout
  logout() {
    this._clearSession();
    console.log('Logged out');
  }

  // Submit Score to Backend
  async submitScore(score, metadata = {}) {
    if (!this.isLoggedIn()) {
      throw new Error('Must be logged in to submit score');
    }

    try {
      const response = await fetch(`${CONFIG.BACKEND_URL}/v1/public/scores`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          user_id: this.userId,
          score: score,
          metadata: metadata
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        // Handle token expiry
        if (response.status === 401) {
          this._clearSession();
          throw new Error('Session expired, please refresh');
        }

        throw new Error(errorData.message || `Submit failed: ${response.status}`);
      }

      const data = await response.json();
      console.log('Score submitted:', data);

      // Invalidate leaderboard cache
      this.leaderboardCache = null;
      this.leaderboardCacheTime = null;

      return data;
    } catch (error) {
      console.error('Submit score error:', error);
      throw error;
    }
  }

  // Get Leaderboard from Backend (Public - no auth required)
  async getLeaderboard(limit = CONFIG.LEADERBOARD_LIMIT, offset = 0, leaderboardCode = '') {
    // Use different cache keys for different leaderboards
    const cacheKey = leaderboardCode || 'default';

    // Check cache
    const now = Date.now();
    if (!this._leaderboardCaches) {
      this._leaderboardCaches = {};
    }

    const cachedData = this._leaderboardCaches[cacheKey];
    if (cachedData &&
        cachedData.time &&
        (now - cachedData.time) < CONFIG.LEADERBOARD_CACHE_TTL) {
      console.log(`Returning cached leaderboard for ${cacheKey}`);
      return cachedData.data;
    }

    try {
      const url = new URL(`${CONFIG.BACKEND_URL}/v1/public/leaderboard`);
      url.searchParams.set('limit', limit.toString());
      url.searchParams.set('offset', offset.toString());
      if (leaderboardCode) {
        url.searchParams.set('leaderboard_code', leaderboardCode);
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Fetch failed: ${response.status}`);
      }

      const data = await response.json();
      console.log(`Leaderboard fetched (${cacheKey}):`, data);

      // Update cache
      this._leaderboardCaches[cacheKey] = { data, time: now };

      // Also update legacy cache for backwards compatibility
      if (!leaderboardCode) {
        this.leaderboardCache = data;
        this.leaderboardCacheTime = now;
      }

      return data;
    } catch (error) {
      console.error('Get leaderboard error:', error);

      // Return cached data if available on error
      const cached = this._leaderboardCaches[cacheKey];
      if (cached) {
        console.log(`Returning stale cached leaderboard for ${cacheKey} due to error`);
        return cached.data;
      }

      throw error;
    }
  }

  // Get Multiplayer Wins Leaderboard
  async getMultiplayerLeaderboard(limit = CONFIG.LEADERBOARD_LIMIT, offset = 0) {
    return this.getLeaderboard(limit, offset, 'pong-mp-wins-leaderboard');
  }

  // Clear all leaderboard caches
  clearLeaderboardCache() {
    this.leaderboardCache = null;
    this.leaderboardCacheTime = null;
    this._leaderboardCaches = {};
  }

  // Get current user info
  getUserInfo() {
    return {
      userId: this.userId,
      displayName: this.displayName,
      isLoggedIn: this.isLoggedIn()
    };
  }

  // Submit multiplayer match result to backend
  async submitMultiplayerResult(won, opponentId = '', localScore = 0, opponentScore = 0, matchDurationSeconds = 0) {
    if (!this.isLoggedIn()) {
      throw new Error('Must be logged in to submit multiplayer result');
    }

    try {
      const response = await fetch(`${CONFIG.BACKEND_URL}/v1/public/multiplayer/results`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          user_id: this.userId,
          won: won,
          opponent_id: opponentId,
          local_score: localScore,
          opponent_score: opponentScore,
          match_duration_seconds: matchDurationSeconds
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        if (response.status === 401) {
          this._clearSession();
          throw new Error('Session expired, please refresh');
        }

        throw new Error(errorData.message || `Submit failed: ${response.status}`);
      }

      const data = await response.json();
      console.log('Multiplayer result submitted:', data);
      return data;
    } catch (error) {
      console.error('Submit multiplayer result error:', error);
      throw error;
    }
  }
}

// Create singleton instance
const pongAPI = new PongAPI();
