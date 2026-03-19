const { ensureInitialized, getTeams, setTeams, clearBids, setAuction, getSettings, setSettings, DEFAULT_AUCTION } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { action } = req.body || {};

  // --- Update team ---
  if (action === 'update-team') {
    const { id, name, seed, region } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'Missing fields' });
    const teams = await getTeams();
    const team = teams.find(t => t.id === id);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    team.name = name;
    team.seed = Number(seed);
    team.region = region;
    await setTeams(teams);
    return res.json({ success: true });
  }

  // --- Reset all ---
  if (action === 'reset') {
    const teams = await getTeams();
    for (const t of teams) {
      t.status = 'available';
      t.owner_id = null;
      t.owner_name = null;
      t.winning_bid = 0;
    }
    await setTeams(teams);
    await clearBids();
    await setAuction({ ...DEFAULT_AUCTION });
    return res.json({ success: true });
  }

  // --- Settings ---
  if (action === 'settings') {
    const { bidIncrement, timerDuration } = req.body;
    const settings = await getSettings();
    if (bidIncrement != null) settings.bidIncrement = Math.max(1, Number(bidIncrement));
    if (timerDuration != null) settings.timerDuration = Math.max(5, Math.min(120, Number(timerDuration)));
    await setSettings(settings);
    return res.json({ success: true, settings });
  }

  // --- Import teams ---
  if (action === 'import-teams') {
    const { teams: teamsData } = req.body;
    if (!Array.isArray(teamsData) || teamsData.length === 0) {
      return res.status(400).json({ error: 'Invalid teams data' });
    }
    const teams = teamsData.map((t, i) => ({
      id: i + 1,
      name: t.name,
      seed: Number(t.seed),
      region: t.region,
      owner_id: null,
      owner_name: null,
      winning_bid: 0,
      status: 'available'
    }));
    await setTeams(teams);
    await clearBids();
    await setAuction({ ...DEFAULT_AUCTION });
    return res.json({ success: true, count: teams.length });
  }

  res.status(400).json({ error: 'Unknown action' });
};
