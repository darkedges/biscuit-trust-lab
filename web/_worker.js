import { runDemo } from '../lib/relay.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/health' && request.method === 'GET') {
      return Response.json({ ok: true, runtime: 'cloudflare-pages' });
    }
    if (path === '/api/run' && request.method === 'POST') {
      try {
        if (Number(request.headers.get('content-length') || 0) > 20_000) {
          return Response.json({ error: 'Request is too large' }, { status: 413 });
        }
        const body = await request.text();
        if (body.length > 20_000) return Response.json({ error: 'Request is too large' }, { status: 413 });
        return Response.json(await runDemo(JSON.parse(body)));
      } catch (error) {
        const status = error.name === 'ValidationError' || error instanceof SyntaxError ? 400 : 500;
        return Response.json({ error: status === 400 ? error.message : 'Could not run the network demo' }, { status });
      }
    }
    if (path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
