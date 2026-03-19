const { ensureInitialized, getAuction, setAuction, getTeams, setTeams, DEFAULT_AUCTION } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const auction = await getAuction();
  if (auction.status !== 'active' && auction.status !== 'paused') {
    return res.status(400).json({ error: 'No auction in progress' });
  }

  // Revert team status
  const teams = await getTeams();
  const idx = teams.findIndex(t => t.id === auction.currentTeamId);
  if (idx >= 0) {
    teams[idx].status = 'available';
    await setTeams(teams);
  }

  await setAuction({ ...DEFAULT_AUCTION });
  res.json({ success: true });
};
