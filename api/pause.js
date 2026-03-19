const { ensureInitialized, getAuction, setAuction } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const auction = await getAuction();
  if (auction.status !== 'active') return res.status(400).json({ error: 'No active auction to pause' });

  auction.pausedRemaining = Math.max(0, auction.timerDeadline - Date.now());
  auction.timerDeadline = null;
  auction.status = 'paused';
  await setAuction(auction);

  res.json({ success: true });
};
