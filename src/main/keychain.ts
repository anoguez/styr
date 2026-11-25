import { safeStorage } from 'electron'
import type { SecretBox } from '@host/remoteAccess/accessStore.js'

/**
 * Private keys (the host's, and this desktop's for the computers it paired with) are sealed with `safeStorage` (the macOS Keychain, DPAPI, libsecret) once
 * they are there. Linux without a keyring falls back to a fixed key, which is no better than the file,
 * so a key then stays as it was: plaintext, 0600.
 */
export function keychain(): SecretBox | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return undefined
  }
  return {
    seal: (plain) => safeStorage.encryptString(plain).toString('base64'),
    open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  }
}
