const { ensureInitialized, getChat, addChatMessage } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  await ensureInitialized();

  // GET — fetch recent messages
  if (req.method === 'GET') {
    await authenticate(req);
    const messages = await getChat();
    return res.json({ messages });
  }

  // POST — send a message
  if (req.method === 'POST') {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const message = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      userId: user.userId,
      userName: user.userName,
      text: text.trim().slice(0, 500),
      time: Date.now()
    };

    await addChatMessage(message);
    return res.json({ success: true, message });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
