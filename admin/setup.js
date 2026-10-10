// Same format the server verifies: pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
const ITERATIONS = 310000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const $ = (s) => document.querySelector(s);

$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#setupMsg');
  const a = $('#pw1').value, b = $('#pw2').value;
  if (a.length < 12) { msg.textContent = 'Use at least 12 characters.'; return; }
  if (a !== b) { msg.textContent = 'The two passwords don’t match.'; return; }
  if (!crypto?.subtle) { msg.textContent = 'This browser can’t create the hash here. Open this page over https (your Netlify site) or use scripts/hash-password.mjs.'; return; }
  msg.textContent = '';
  $('#setupBtn').disabled = true; $('#setupBtn').textContent = 'Creating…';
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(a), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  $('#outHash').value = `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(bits)}`;
  $('#outSecret').value = b64url(crypto.getRandomValues(new Uint8Array(32)));
  $('#pw1').value = ''; $('#pw2').value = '';
  $('#setupOut').hidden = false;
  $('#setupBtn').disabled = false; $('#setupBtn').textContent = 'Create a new hash';
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const el = document.getElementById(b.dataset.copy);
  try { await navigator.clipboard.writeText(el.value); b.textContent = 'Copied'; } catch { el.select(); document.execCommand('copy'); b.textContent = 'Copied'; }
  setTimeout(() => { b.textContent = b.dataset.copy === 'outHash' ? 'Copy hash' : 'Copy secret'; }, 1800);
});
