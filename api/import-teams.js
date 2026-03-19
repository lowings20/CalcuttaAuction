const { ensureInitialized, setTeams, clearBids, setAuction, DEFAULT_AUCTION } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const teamsData = req.body;
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

  res.json({ success: true, count: teams.length });
};
