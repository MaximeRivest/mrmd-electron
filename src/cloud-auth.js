/**
 * Cloud Auth for mrmd-electron
 *
 * Handles sign-in to markco.dev from the desktop app.
 * Opens a browser window for OAuth, captures the session token,
 * stores it in settings, and provides the token for background sync.
 *
 * Usage:
 *   import { CloudAuth } from './cloud-auth.js';
 *   const auth = new CloudAuth(settingsService);
 *   await auth.signIn();     // Opens OAuth window
 *   auth.getToken();         // Returns stored token or null
 *   auth.getUser();          // Returns cached user info or null
 *   await auth.signOut();    // Clears token
 */

import { BrowserWindow } from 'electron';

const DEFAULT_CLOUD_URL = 'https://markco.dev';

export class CloudAuth {
  /**
   * @param {import('./services/settings-service.js').default} settingsService
   * @param {object} [opts]
   * @param {string} [opts.cloudUrl] - markco.dev base URL
   * @param {function} [opts.log]
   */
  constructor(settingsService, opts = {}) {
    this.settings = settingsService;
    this.cloudUrl = opts.cloudUrl || process.env.MARKCO_CLOUD_URL || DEFAULT_CLOUD_URL;
    this.log = opts.log || console.log;
    this._user = null;
  }

  /**
   * Get the stored session token, or null if not signed in.
   */
  getToken() {
    this.settings.load();
    return this.settings.get('cloud.token', null);
  }

  /**
   * Get cached user info, or null.
   */
  getUser() {
    if (this._user) return this._user;
    this.settings.load();
    return this.settings.get('cloud.user', null);
  }

  /**
   * Check if signed in (has token). Does NOT validate remotely.
   */
  isSignedIn() {
    return Boolean(this.getToken());
  }

  /**
   * Open OAuth window, wait for sign-in, store token.
   * @returns {Promise<{user: object, token: string}>}
   */
  signIn() {
    return new Promise((resolve, reject) => {
      const loginUrl = `${this.cloudUrl}/login/github?electron=1`;
      const successPrefix = `${this.cloudUrl}/auth/electron/success`;

      this.log('[cloud-auth] Opening sign-in window:', loginUrl);

      const authWindow = new BrowserWindow({
        width: 600,
        height: 700,
        show: true,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
        title: 'Sign in to MarkCo',
      });

      let completed = false;

      // Watch for navigation to the success page
      const handleNav = async (url) => {
        if (completed) return;
        if (!url.startsWith(successPrefix)) return;

        completed = true;

        // Extract token from URL
        const parsed = new URL(url);
        const token = parsed.searchParams.get('token');

        if (!token) {
          authWindow.close();
          return reject(new Error('No token in callback URL'));
        }

        this.log('[cloud-auth] Got token, validating...');

        // Validate token and get user info
        try {
          const user = await this._validateToken(token);

          // Store in settings
          this.settings.set('cloud.token', token);
          this.settings.set('cloud.user', user);
          this._user = user;

          this.log(`[cloud-auth] Signed in as ${user.name || user.email}`);
          authWindow.close();
          resolve({ user, token });
        } catch (err) {
          authWindow.close();
          reject(new Error(`Token validation failed: ${err.message}`));
        }
      };

      authWindow.webContents.on('will-navigate', (_event, url) => handleNav(url));
      authWindow.webContents.on('did-navigate', (_event, url) => handleNav(url));
      authWindow.webContents.on('will-redirect', (_event, url) => handleNav(url));

      authWindow.on('closed', () => {
        if (!completed) {
          reject(new Error('Sign-in window was closed'));
        }
      });

      authWindow.loadURL(loginUrl);
    });
  }

  /**
   * Validate a token against markco.dev and return user info.
   * Throws with a `status` property on HTTP errors so callers can
   * distinguish auth failures (401/403) from transient network issues.
   */
  async _validateToken(token) {
    const res = await fetch(`${this.cloudUrl}/auth/validate`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const err = new Error(`Validation failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const { user } = await res.json();
    return user;
  }

  /**
   * Validate the stored token. Returns user if valid, null if expired.
   * Only clears stored token on definitive auth failures (401/403).
   * Transient errors (network, timeout, 5xx) preserve the token so the
   * user doesn't have to re-sign-in after a momentary hiccup.
   */
  async validate() {
    const token = this.getToken();
    if (!token) return null;

    try {
      const user = await this._validateToken(token);
      this._user = user;
      this.settings.set('cloud.user', user);
      return user;
    } catch (err) {
      const status = err?.status;

      if (status === 401 || status === 403) {
        // Definitive rejection — token is expired or revoked
        this.log('[cloud-auth] Stored token is invalid, clearing');
        this.settings.set('cloud.token', null);
        this.settings.set('cloud.user', null);
        this._user = null;
        return null;
      }

      // Transient error (network, timeout, 5xx) — keep the token and
      // return the cached user so cloud sync can still attempt to connect.
      this.log(`[cloud-auth] Validation failed (transient): ${err.message} — keeping token`);
      const cachedUser = this.getUser();
      if (cachedUser) {
        this._user = cachedUser;
        return cachedUser;
      }
      return null;
    }
  }

  /**
   * Sign out: clear stored token and user info.
   */
  async signOut() {
    const token = this.getToken();

    // Best-effort logout on server
    if (token) {
      try {
        await fetch(`${this.cloudUrl}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
      } catch { /* ignore */ }
    }

    this.settings.set('cloud.token', null);
    this.settings.set('cloud.user', null);
    this._user = null;
    this.log('[cloud-auth] Signed out');
  }
}

export default CloudAuth;
