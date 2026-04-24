// Vercel serverless function that mirrors the local Vite dev plugin.
// Logs each event to Vercel's built-in log viewer (free tier: ~1h retention).
//
// Pair this with the vercel.json rewrite that maps /log -> /api/log,
// so src/logger.js can use the same URL in dev and production.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  let body = '';
  if (typeof req.body === 'string') {
    body = req.body;
  } else if (Buffer.isBuffer(req.body)) {
    body = req.body.toString('utf8');
  } else if (req.body) {
    body = JSON.stringify(req.body);
  }

  if (body.length > 8192) body = body.slice(0, 8192) + ' …[truncated]';

  const ts = new Date().toISOString();
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '-';
  const tag = `[${ts}] [${ip}]`;

  for (const line of body.split('\n')) {
    if (line.trim()) console.log(`${tag} ${line}`);
  }

  res.status(204).end();
}
