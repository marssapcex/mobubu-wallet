/**
 * Mobubu Monero Extension Content Script
 * Injects `window.mobubu` and `window.monero` providers into the web page context
 */

const inpageScript = `
(function() {
  if (window.mobubu) return;

  const mobubuProvider = {
    isMobubu: true,
    isMonero: true,
    version: '1.0.0',
    request: async function({ method, params }) {
      console.log('[window.mobubu] Request:', method, params);
      return new Promise((resolve, reject) => {
        const reqId = 'mobubu-' + Math.random().toString(36).substring(2);
        window.postMessage({
          type: 'MOBUBU_PROVIDER_REQUEST',
          id: reqId,
          method,
          params
        }, '*');

        const listener = (event) => {
          if (event.source !== window || !event.data || event.data.type !== 'MOBUBU_PROVIDER_RESPONSE' || event.data.id !== reqId) return;
          window.removeEventListener('message', listener);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.result);
        };
        window.addEventListener('message', listener);
      });
    }
  };

  window.mobubu = mobubuProvider;
  window.monero = mobubuProvider;

  console.log('[Mobubu] Injected window.mobubu & window.monero Web3 providers');
})();
`;

// Inject into DOM
const script = document.createElement('script');
script.textContent = inpageScript;
(document.head || document.documentElement).appendChild(script);
script.remove();
