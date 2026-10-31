// Wasted Poker House Ledger: saves and loads the whole ledger from Upstash Redis.
// Needs Upstash Redis connected to the Vercel project, which adds
// KV_REST_API_URL and KV_REST_API_TOKEN automatically. No other setup.

const V_KEY = 'wphl:v';      // version number, goes up by 1 on every save
const D_KEY = 'wphl:data';   // the ledger itself (JSON text)
const MAX_BYTES = 900 * 1024;

// Save only if nobody else saved since this phone last loaded (prevents two phones overwriting each other).
const SAVE_IF_CURRENT = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v ~= tonumber(ARGV[1]) then return -1 end
redis.call('SET', KEYS[2], ARGV[2])
return redis.call('INCR', KEYS[1])
`;

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `Database error ${r.status}`);
  return j.result;
}

async function readLedger() {
  const [v, data] = await redis(['MGET', V_KEY, D_KEY]);
  return { v: Number(v || 0), state: data ? JSON.parse(data) : null };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!url || !token) return res.status(500).json({ error: 'Upstash Redis is not connected' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await readLedger());
    }

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const { state, base } = body;
      if (!state || typeof state !== 'object' || !state.current || !Array.isArray(state.history)) {
        return res.status(400).json({ error: 'Not a valid ledger' });
      }
      const text = JSON.stringify(state);
      if (Buffer.byteLength(text) > MAX_BYTES) {
        return res.status(413).json({ error: 'Ledger is too large to save' });
      }
      const v = await redis(['EVAL', SAVE_IF_CURRENT, '2', V_KEY, D_KEY, String(Number(base) || 0), text]);
      if (Number(v) === -1) {
        return res.status(409).json(await readLedger()); // someone else saved first: send them the latest
      }
      return res.status(200).json({ v: Number(v) });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
