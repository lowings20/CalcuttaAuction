const { ensureInitialized, getTeams, setTeams } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { id, name, seed, region } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'Missing fields' });

  const teams = await getTeams();
  const team = teams.find(t => t.id === id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  team.name = name;
  team.seed = Number(seed);
  team.region = region;
  await setTeams(teams);

  res.json({ success: true });
};
