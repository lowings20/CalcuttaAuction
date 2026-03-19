const crypto = require('crypto');
const { ensureInitialized, upsertUser, setSession, heartbeat, getFullState } = require('../lib/kv');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();

  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const trimmed = name.trim();
  const id = crypto.createHash('sha256').update(trimmed.toLowerCase()).digest('hex').slice(0, 16);

  await upsertUser(id, trimmed);

  const token = crypto.randomUUID();
  await setSession(token, id, trimmed);
  await heartbeat(id);

  const state = await getFullState();
  res.json({ user: { id, name: trimmed }, token, state });
};
