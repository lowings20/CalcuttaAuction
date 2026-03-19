const { ensureInitialized, getFullState } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  await authenticate(req); // refreshes heartbeat

  const state = await getFullState();
  res.json(state);
};
