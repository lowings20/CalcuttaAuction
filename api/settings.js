const { ensureInitialized, getSettings, setSettings } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { bidIncrement, timerDuration } = req.body || {};
  const settings = await getSettings();

  if (bidIncrement != null) settings.bidIncrement = Math.max(1, Number(bidIncrement));
  if (timerDuration != null) settings.timerDuration = Math.max(5, Math.min(120, Number(timerDuration)));
  await setSettings(settings);

  res.json({ success: true, settings });
};
