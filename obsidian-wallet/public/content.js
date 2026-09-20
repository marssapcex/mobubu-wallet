/**
 * Obsidian Monero Extension Content Script
 * Injects `window.monero` provider into the web page context
 */

const inpageScript = `
(function() {
  if (window.monero) return;

  window.monero = {
    isObsidian: true,
    version: '1.0.0',
    request: async function({ method, params }) {
      console.log('[window.monero] Request:', method, params);
      return new Promise((resolve, reject) => {
        window.postMessage({
          type: 'OBSIDIAN_PROVIDER_REQUEST',
          id: Math.random().toString(36).substring(2),
          method,
          params
        }, '*');

        const listener = (event) => {
          if (event.source !== window || !event.data || event.data.type !== 'OBSIDIAN_PROVIDER_RESPONSE') return;
          window.removeEventListener('message', listener);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.result);
        };
        window.addEventListener('message', listener);
      });
    }
  };

  console.log('[Obsidian] Injected window.monero Web3 provider');
})();
`;

// Inject into DOM
const script = document.createElement('script');
script.textContent = inpageScript;
(document.head || document.documentElement).appendChild(script);
script.remove();
