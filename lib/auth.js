const { getSession, heartbeat } = require('./kv');

/**
 * Extract the authenticated user from the request, or return null.
 * Also refreshes the heartbeat.
 */
async function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const session = await getSession(token);
  if (!session) return null;

  await heartbeat(session.userId);
  return session;
}

module.exports = { authenticate };
