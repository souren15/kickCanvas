/**
 * GET /.netlify/functions/site-settings          published settings (public: no customer data)
 * GET /.netlify/functions/site-settings?preview=1  the unpublished draft - signed-in admin only
 */
import { json, handle, fail } from '../lib/http.mjs';
import { liveSettings, readSettings } from '../lib/catalog.mjs';
import { readSession } from '../lib/auth.mjs';

export default handle(async (req) => {
  if (req.method !== 'GET') return fail(405, 'Method not allowed.');
  const preview = new URL(req.url).searchParams.get('preview') === '1';
  if (preview && readSession(req)) {
    const draft = (await readSettings('draft')) || (await liveSettings());
    return json({ ok: true, preview: true, settings: draft });
  }
  return json({ ok: true, preview: false, settings: await liveSettings() }, 200, {
    'cache-control': 'public, max-age=0, must-revalidate',
  });
});
