const { ensureInitialized, getAuction, setAuction, addBid, getSettings, checkAndFinalizeAuction } = require('../lib/kv');
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  await ensureInitialized();
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  // Check if deadline already passed
  let auction = await checkAndFinalizeAuction();
  if (auction.status !== 'active') {
    return res.status(400).json({ error: 'No active auction' });
  }

  const { amount } = req.body || {};
  const bidAmount = Number(amount);
  if (isNaN(bidAmount) || bidAmount <= auction.highBid) {
    return res.status(400).json({ error: `Bid must be greater than $${auction.highBid}` });
  }

  const settings = await getSettings();

  // Record bid
  await addBid({
    teamId: auction.currentTeamId,
    userId: user.userId,
    userName: user.userName,
    amount: bidAmount,
    time: Date.now()
  });

  // Update auction
  auction.highBid = bidAmount;
  auction.highBidderId = user.userId;
  auction.highBidderName = user.userName;
  auction.bidHistory.unshift({ userName: user.userName, amount: bidAmount, time: Date.now() });
  auction.timerDeadline = Date.now() + settings.timerDuration * 1000; // Reset timer
  await setAuction(auction);

  res.json({ success: true });
};
