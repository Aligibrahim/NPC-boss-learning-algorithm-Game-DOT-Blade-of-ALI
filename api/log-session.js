// Session-start marker for production. Paired with api/log.js.
// Prints a banner line so you can scroll to it in the Vercel log viewer
// and see everything that followed from one player's page-load.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const ts = new Date().toISOString();
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '-';
  const ua = (req.headers['user-agent'] || '-').slice(0, 120);

  console.log(`===== NEW SESSION [${ts}] [${ip}] ua=${ua} =====`);
  res.status(204).end();
}
