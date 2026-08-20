const webpush = require('web-push');
const db = require('./db');

let configured = false;

// VAPID keys authenticate this server to push services (Chrome/Firefox/etc). They're
// generated once (see db.js) and reused forever — this just loads them into web-push.
function ensureVapidConfigured() {
  const state = db.get();
  if (!configured) {
    const contactEmail = (state.company && state.company.email) || 'admin@example.com';
    webpush.setVapidDetails(`mailto:${contactEmail}`, state.pushConfig.publicKey, state.pushConfig.privateKey);
    configured = true;
  }
  return state.pushConfig;
}

// Sends a push notification to every subscribed device for the given user IDs.
// Silently drops subscriptions the push service reports as dead (410/404) — devices
// get unsubscribed, browsers get reinstalled, this is expected and routine cleanup.
async function sendPushToUsers(userIds, { title, body, url }) {
  if (!userIds || userIds.length === 0) return { sent: 0 };
  const state = db.get();
  ensureVapidConfigured();

  const targets = state.pushSubscriptions.filter(s => userIds.includes(s.userId));
  if (targets.length === 0) return { sent: 0 };

  const payload = JSON.stringify({
    title: title || 'Al Fitr ERP',
    body: body || '',
    url: url || '/',
    icon: (state.company && state.company.logoPath) || null,
  });

  const results = await Promise.allSettled(
    targets.map(t => webpush.sendNotification(t.subscription, payload))
  );

  let removed = 0;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const code = r.reason && r.reason.statusCode;
      if (code === 410 || code === 404) {
        const idx = state.pushSubscriptions.indexOf(targets[i]);
        if (idx > -1) { state.pushSubscriptions.splice(idx, 1); removed++; }
      } else {
        // Anything other than "this subscription is dead" is worth knowing about —
        // otherwise a real misconfiguration would fail completely silently.
        console.error('[push] delivery failed for user', targets[i].userId, '-', (r.reason && r.reason.message) || r.reason);
      }
    }
  });
  if (removed > 0) await db.persist();

  return { sent: results.filter(r => r.status === 'fulfilled').length, removed };
}

module.exports = { ensureVapidConfigured, sendPushToUsers };
