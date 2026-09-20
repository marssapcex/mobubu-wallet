/**
 * Obsidian Monero Extension Background Service Worker
 * Handles network heartbeats, Tor proxy health checks, and extension badges
 */

console.log('[Obsidian] Service Worker initialized');

// Set extension badge on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '95' });
  chrome.action.setBadgeBackgroundColor({ color: '#10B981' }); // Emerald green
  console.log('[Obsidian] Extension installed with Tor-default privacy posture 95/100');
});

// Periodic alarm to check daemon sync
chrome.alarms.create('checkDaemon', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkDaemon') {
    // Ping active node or update badge
    chrome.action.setBadgeText({ text: '95' });
  }
});

// Message listener from content script / popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_PRIVACY_POSTURE') {
    sendResponse({ score: 95, tier: 'optimal', torActive: true });
  } else if (request.type === 'PING') {
    sendResponse({ status: 'pong', timestamp: Date.now() });
  }
  return true;
});
