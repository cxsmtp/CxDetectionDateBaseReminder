// The deactivation page (src/activation.js): enter the product activation code from the maintainer, and on
// success go back to the app.
const form = document.getElementById('activate-form');
const status = document.getElementById('status');
const say = (text, kind = '') => {
  status.textContent = text;
  status.className = kind;
};
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('submit');
  button.disabled = true;
  say('Checking the code…');
  try {
    const res = await fetch('/api/licence/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('code').value }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'This activation code is not valid.');
    say(`Activated until ${String(body.until).slice(0, 10)}. Opening CxMissionZero…`, 'ok');
    setTimeout(() => location.replace('/'), 1200);
  } catch (error) {
    say(error.message, 'error');
    button.disabled = false;
  }
});
