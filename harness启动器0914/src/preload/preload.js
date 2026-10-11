'use strict'

/**
 * Preload bridge for the launcher splash screen.
 *
 * This preload is attached to the window for its entire life, which includes
 * the navigation to the Harness Web UI. The bridge is therefore withheld from
 * anything that is not the local splash document, and the main process checks
 * the sender frame again on every call rather than trusting this guard alone.
 */

const { contextBridge, ipcRenderer } = require('electron')

if (window.location.protocol === 'file:') {
  /** Invoke a launcher action and return its result. */
  const action = (name, value) => ipcRenderer.invoke('launcher:action', { action: name, value })

  contextBridge.exposeInMainWorld('launcher', {
    /** Read the latest launcher state. */
    getState: () => ipcRenderer.invoke('launcher:get-state'),
    /**
     * Subscribe to state updates.
     * @param {(state: object) => void} listener - Update handler.
     * @returns {() => void} Unsubscribe function.
     */
    onState: (listener) => {
      const handler = (_event, state) => { listener(state) }
      ipcRenderer.on('launcher:state', handler)
      return () => { ipcRenderer.removeListener('launcher:state', handler) }
    },
    /**
     * Subscribe to live log lines.
     * @param {(line: string) => void} listener - Line handler.
     * @returns {() => void} Unsubscribe function.
     */
    onLog: (listener) => {
      const handler = (_event, line) => { listener(String(line)) }
      ipcRenderer.on('launcher:log', handler)
      return () => { ipcRenderer.removeListener('launcher:log', handler) }
    },
    /** Retry startup with the current settings. */
    retry: () => action('retry'),
    /** Stop the owned service and start again. */
    restart: () => action('restart'),
    /**
     * Switch to another port and start again.
     * @param {string|number} port - New port.
     */
    changePort: (port) => action('change-port', port),
    /**
     * Open the UI with a pasted token URL.
     * @param {string} value - Token URL or bare token.
     */
    submitToken: (value) => action('submit-token', value),
    /**
     * Open a URL in the system browser.
     * @param {string} url - Target URL.
     */
    openExternal: (url) => action('open-external', url),
    /** Collect diagnostics text. */
    diagnostics: () => action('diagnostics'),
    /** Stop the owned service and quit. */
    quit: () => action('quit')
  })
}
