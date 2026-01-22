/**
 * Network utilities for mrmd-electron
 *
 * Shared functions for port management used by main process and services.
 */

import net from 'net';
import {
  DEFAULT_HOST,
  PORT_WAIT_TIMEOUT,
  PORT_CHECK_INTERVAL,
  SOCKET_TIMEOUT,
} from '../config.js';

/**
 * Find a free port on the local machine
 *
 * @param {string} host - Host to bind to (default: 127.0.0.1)
 * @returns {Promise<number>} Available port number
 */
export function findFreePort(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on('error', (err) => {
      reject(new Error(`Failed to find free port: ${err.message}`));
    });

    server.listen(0, host, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Wait for a port to become available (accepting connections)
 *
 * @param {number} port - Port to wait for
 * @param {object} options - Options
 * @param {string} options.host - Host to connect to (default: 127.0.0.1)
 * @param {number} options.timeout - Total timeout in ms (default: 10000)
 * @param {number} options.interval - Check interval in ms (default: 200)
 * @returns {Promise<void>} Resolves when port is ready
 */
export function waitForPort(port, options = {}) {
  const {
    host = DEFAULT_HOST,
    timeout = PORT_WAIT_TIMEOUT,
    interval = PORT_CHECK_INTERVAL,
  } = options;

  return new Promise((resolve, reject) => {
    const start = Date.now();

    function check() {
      if (Date.now() - start > timeout) {
        reject(new Error(`Port ${port} not ready after ${timeout}ms`));
        return;
      }

      const socket = new net.Socket();
      socket.setTimeout(SOCKET_TIMEOUT);

      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.on('error', () => {
        socket.destroy();
        setTimeout(check, interval);
      });

      socket.on('timeout', () => {
        socket.destroy();
        setTimeout(check, interval);
      });

      socket.connect(port, host);
    }

    check();
  });
}

/**
 * Check if a port is currently in use
 *
 * @param {number} port - Port to check
 * @param {string} host - Host to check (default: 127.0.0.1)
 * @returns {Promise<boolean>} True if port is in use
 */
export function isPortInUse(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(SOCKET_TIMEOUT);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}
