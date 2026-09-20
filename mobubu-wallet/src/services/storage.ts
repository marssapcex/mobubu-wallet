/**
 * WebExtension + LocalStorage compatible storage layer for Mobubu Wallet
 */

declare const chrome: any;

const STORAGE_PREFIX = 'mobubu_';

export const StorageService = {
  async get<T>(key: string): Promise<T | null> {
    const fullKey = `${STORAGE_PREFIX}${key}`;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
          chrome.storage.local.get([fullKey], (result: Record<string, any>) => {
            resolve(result && result[fullKey] !== undefined ? (result[fullKey] as T) : null);
          });
        });
      }
    } catch {
      // Fall through to localStorage
    }

    try {
      const item = localStorage.getItem(fullKey);
      return item ? (JSON.parse(item) as T) : null;
    } catch {
      return null;
    }
  },

  async set<T>(key: string, value: T): Promise<void> {
    const fullKey = `${STORAGE_PREFIX}${key}`;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
          chrome.storage.local.set({ [fullKey]: value }, () => resolve());
        });
      }
    } catch {
      // Fall through to localStorage
    }

    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch (e) {
      console.error('Storage set error:', e);
    }
  },

  async remove(key: string): Promise<void> {
    const fullKey = `${STORAGE_PREFIX}${key}`;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
          chrome.storage.local.remove([fullKey], () => resolve());
        });
      }
    } catch {
      // Fall through
    }

    try {
      localStorage.removeItem(fullKey);
    } catch (e) {
      console.error('Storage remove error:', e);
    }
  },
};
