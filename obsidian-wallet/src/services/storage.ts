/**
 * WebExtension + LocalStorage compatible storage layer
 */

declare const chrome: any;

export const StorageService = {
  async get<T>(key: string): Promise<T | null> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
          chrome.storage.local.get([key], (result: Record<string, any>) => {
            resolve(result && result[key] !== undefined ? (result[key] as T) : null);
          });
        });
      }
    } catch {
      // Fall through to localStorage
    }

    try {
      const item = localStorage.getItem(`obsidian_${key}`);
      return item ? (JSON.parse(item) as T) : null;
    } catch {
      return null;
    }
  },

  async set<T>(key: string, value: T): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
          chrome.storage.local.set({ [key]: value }, () => resolve());
        });
      }
    } catch {
      // Fall through to localStorage
    }

    try {
      localStorage.setItem(`obsidian_${key}`, JSON.stringify(value));
    } catch (e) {
      console.error('Storage set error:', e);
    }
  },

  async remove(key: string): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
          chrome.storage.local.remove([key], () => resolve());
        });
      }
    } catch {
      // Fall through
    }

    try {
      localStorage.removeItem(`obsidian_${key}`);
    } catch (e) {
      console.error('Storage remove error:', e);
    }
  },
};
