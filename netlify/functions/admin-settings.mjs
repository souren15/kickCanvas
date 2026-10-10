/**
 * GET  /.netlify/functions/admin-settings                       { live, draft, hasDraft } (admin)
 * PUT  /.netlify/functions/admin-settings  { settings }         save the draft (admin)
 * POST /.netlify/functions/admin-settings  { action: 'publish' | 'discard' }      (admin)
 * The live site only ever reads the PUBLISHED settings; drafts are visible through ?kcpreview=1
 * to a signed-in admin.
 */
import { json, fail, readJson, handle } from '../lib/http.mjs';
import { store, META } from '../lib/storage.mjs';
import { requireAdmin } from '../lib/auth.mjs';
import { readSettings, liveSettings } from '../lib/catalog.mjs';
import { cleanSettings } from '../../js/data/site-config.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default handle(async (req) => {
  const meta = await store(META);
  if (req.method === 'GET') {
    requireAdmin(req);
    const live = await liveSettings();
    const draft = (await readSettings('draft')) || live;
    return json({ ok: true, live, draft, hasDraft: !same(live, draft) });
  }
  const session = requireAdmin(req, { mutating: true });
  const body = await readJson(req, 60_000);
  if (req.method === 'PUT') {
    const res = cleanSettings(body.settings);
    if (!res.ok) return fail(422, res.errors[0], { errors: res.errors });
    await meta.setJSON('settings/draft', { ...res.settings, savedAt: new Date().toISOString(), savedBy: session.username });
    const live = await liveSettings();
    return json({ ok: true, draft: res.settings, hasDraft: !same(live, res.settings) });
  }
  if (req.method === 'POST' && body.action === 'publish') {
    const draft = await readSettings('draft');
    if (!draft) return fail(409, 'There are no saved changes to publish.');
    await meta.setJSON('settings/live', { ...draft, publishedAt: new Date().toISOString(), publishedBy: session.username });
    return json({ ok: true, live: draft, hasDraft: false });
  }
  if (req.method === 'POST' && body.action === 'discard') {
    const live = await liveSettings();
    await meta.setJSON('settings/draft', live);
    return json({ ok: true, draft: live, hasDraft: false });
  }
  return fail(405, 'Method not allowed.');
});
