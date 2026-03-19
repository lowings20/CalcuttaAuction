const { ensureInitialized, getAuction, setAuction, getTeams, setTeams, getSettings } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const auction = await getAuction();
  if (auction.status === 'active' || auction.status === 'paused') {
    return res.status(400).json({ error: 'An auction is already in progress' });
  }

  const { teamId, startingBid } = req.body || {};
  const teams = await getTeams();
  const team = teams.find(t => t.id === teamId);
  if (!team || team.status === 'sold') {
    return res.status(400).json({ error: 'Team not available' });
  }

  const settings = await getSettings();
  const start = Math.max(1, Number(startingBid) || 1);

  // Update team status
  team.status = 'active';
  await setTeams(teams);

  // Set auction state
  await setAuction({
    status: 'active',
    currentTeamId: teamId,
    highBid: 0,
    highBidderId: null,
    highBidderName: '',
    timerDeadline: Date.now() + settings.timerDuration * 1000,
    pausedRemaining: null,
    bidHistory: [],
    startingBid: start
  });

  res.json({ success: true });
};
