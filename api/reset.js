const { ensureInitialized, getTeams, setTeams, clearBids, setAuction, DEFAULT_AUCTION } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

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

  res.json({ success: true });
};
