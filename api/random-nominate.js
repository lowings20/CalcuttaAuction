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

  const teams = await getTeams();
  const available = teams.filter(t => t.status === 'available');
  if (available.length === 0) {
    return res.status(400).json({ error: 'No teams remaining' });
  }

  // Pick a random available team
  const pick = available[Math.floor(Math.random() * available.length)];
  const settings = await getSettings();
  const startingBid = Math.max(1, Number((req.body || {}).startingBid) || 1);

  // Update team status
  const idx = teams.findIndex(t => t.id === pick.id);
  teams[idx].status = 'active';
  await setTeams(teams);

  // Set auction state
  await setAuction({
    status: 'active',
    currentTeamId: pick.id,
    highBid: 0,
    highBidderId: null,
    highBidderName: '',
    timerDeadline: Date.now() + settings.timerDuration * 1000,
    pausedRemaining: null,
    bidHistory: [],
    startingBid
  });

  res.json({ success: true, team: pick });
};
