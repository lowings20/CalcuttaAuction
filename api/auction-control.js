const { ensureInitialized, getAuction, setAuction, getTeams, setTeams, DEFAULT_AUCTION } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { action } = req.body || {};

  if (action === 'pause') {
    const auction = await getAuction();
    if (auction.status !== 'active') return res.status(400).json({ error: 'No active auction to pause' });
    auction.pausedRemaining = Math.max(0, auction.timerDeadline - Date.now());
    auction.timerDeadline = null;
    auction.status = 'paused';
    await setAuction(auction);
    return res.json({ success: true });
  }

  if (action === 'resume') {
    const auction = await getAuction();
    if (auction.status !== 'paused') return res.status(400).json({ error: 'Auction is not paused' });
    auction.status = 'active';
    auction.timerDeadline = Date.now() + (auction.pausedRemaining || 15000);
    auction.pausedRemaining = null;
    await setAuction(auction);
    return res.json({ success: true });
  }

  if (action === 'skip') {
    const auction = await getAuction();
    if (auction.status !== 'active' && auction.status !== 'paused') {
      return res.status(400).json({ error: 'No auction in progress' });
    }
    const teams = await getTeams();
    const idx = teams.findIndex(t => t.id === auction.currentTeamId);
    if (idx >= 0) {
      teams[idx].status = 'available';
      await setTeams(teams);
    }
    await setAuction({ ...DEFAULT_AUCTION });
    return res.json({ success: true });
  }

  res.status(400).json({ error: 'Unknown action' });
};
