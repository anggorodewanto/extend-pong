// Pong Game API Client
// Handles AGS IAM headless login and backend API communication

class PongAPI {
  constructor() {
    this.accessToken = null;
    this.userId = null;
    this.displayName = null;
    this.tokenExpiry = null;
    this.leaderboardCache = null;
    this.leaderboardCacheTime = null;

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
    const expiry = sessionStorage.getItem('pong_token_expiry');
    const userId = sessionStorage.getItem('pong_user_id');
    const displayName = sessionStorage.getItem('pong_display_name');

    if (token && expiry && new Date(expiry) > new Date()) {
      this.accessToken = token;
      this.tokenExpiry = new Date(expiry);
      this.userId = userId;
      this.displayName = displayName;
    }
  }

  _saveSession(tokenData) {
    const expiryDate = new Date(Date.now() + (tokenData.expires_in * 1000));

    this.accessToken = tokenData.access_token;
    this.tokenExpiry = expiryDate;
    this.userId = tokenData.user_id;
    this.displayName = tokenData.display_name || `Player_${tokenData.user_id.substring(0, 6)}`;

    sessionStorage.setItem('pong_access_token', this.accessToken);
    sessionStorage.setItem('pong_token_expiry', expiryDate.toISOString());
    sessionStorage.setItem('pong_user_id', this.userId);
    sessionStorage.setItem('pong_display_name', this.displayName);
  }

  _clearSession() {
    this.accessToken = null;
    this.tokenExpiry = null;
    this.userId = null;
    this.displayName = null;

    sessionStorage.removeItem('pong_access_token');
    sessionStorage.removeItem('pong_token_expiry');
    sessionStorage.removeItem('pong_user_id');
    sessionStorage.removeItem('pong_display_name');
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
  async getLeaderboard(limit = CONFIG.LEADERBOARD_LIMIT, offset = 0) {
    // Check cache
    const now = Date.now();
    if (this.leaderboardCache &&
        this.leaderboardCacheTime &&
        (now - this.leaderboardCacheTime) < CONFIG.LEADERBOARD_CACHE_TTL) {
      console.log('Returning cached leaderboard');
      return this.leaderboardCache;
    }

    try {
      const url = new URL(`${CONFIG.BACKEND_URL}/v1/public/leaderboard`);
      url.searchParams.set('limit', limit.toString());
      url.searchParams.set('offset', offset.toString());

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
      console.log('Leaderboard fetched:', data);

      // Update cache
      this.leaderboardCache = data;
      this.leaderboardCacheTime = now;

      return data;
    } catch (error) {
      console.error('Get leaderboard error:', error);

      // Return cached data if available on error
      if (this.leaderboardCache) {
        console.log('Returning stale cached leaderboard due to error');
        return this.leaderboardCache;
      }

      throw error;
    }
  }

  // Get current user info
  getUserInfo() {
    return {
      userId: this.userId,
      displayName: this.displayName,
      isLoggedIn: this.isLoggedIn()
    };
  }
}

// Create singleton instance
const pongAPI = new PongAPI();
