/**
 * Cloudflare Worker Proxy for Polymarket CLOB API
 * 
 * This worker proxies requests to clob.polymarket.com to bypass
 * Cloudflare IP blocking on cloud hosting providers like Railway.
 * 
 * DEPLOYMENT INSTRUCTIONS:
 * 1. Go to https://dash.cloudflare.com and create a free account
 * 2. Navigate to Workers & Pages > Create application > Create Worker
 * 3. Name it "polymarket-clob-proxy" (or any name you prefer)
 * 4. Copy this entire file's contents into the worker editor
 * 5. Click "Save and Deploy"
 * 6. Copy your worker URL (e.g., https://polymarket-clob-proxy.YOUR_SUBDOMAIN.workers.dev)
 * 7. In Railway, set: POLYMARKET_CLOB_API_URL=https://polymarket-clob-proxy.YOUR_SUBDOMAIN.workers.dev
 * 8. Redeploy your Railway app
 */

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      const url = new URL(request.url);
      
      // Build target URL to Polymarket CLOB API
      const targetUrl = 'https://clob.polymarket.com' + url.pathname + url.search;
      
      // Clone all headers from the original request
      const headers = new Headers(request.headers);
      
      // Remove headers that might cause issues
      headers.delete('host');
      headers.delete('cf-connecting-ip');
      headers.delete('cf-ipcountry');
      headers.delete('cf-ray');
      headers.delete('cf-visitor');
      
      // Create the proxied request
      const proxyRequest = new Request(targetUrl, {
        method: request.method,
        headers: headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' 
          ? request.body 
          : null,
        redirect: 'follow',
      });
      
      // Forward to Polymarket CLOB API
      const response = await fetch(proxyRequest);
      
      // Clone the response and add CORS headers
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      newHeaders.set('Access-Control-Allow-Headers', '*');
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error) {
      // Return error as JSON
      return new Response(JSON.stringify({ 
        error: 'Proxy error', 
        message: error.message 
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
