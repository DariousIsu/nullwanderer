/* My Workspace shell — surface navigation. Each rail entry mounts its surface page in the
   <webview> (live surfaces with data-src) or shows the placeholder (surfaces not built yet).
   The Editor surface loads editor.html, which gets window.sq via the shared preload (forced
   onto the webview in main's will-attach-webview). Studios are operator-only — no Zoe here. */
'use strict';
const view = document.getElementById('surface');
const placeholder = document.getElementById('placeholder');
const titleEl = document.getElementById('surface-title');
const subEl = document.getElementById('surface-sub');
const phTitle = document.getElementById('ph-title');
const phSub = document.getElementById('ph-sub');

function select(btn) {
  if (btn.disabled) return;
  document.querySelectorAll('.surface').forEach(b => b.classList.toggle('active', b === btn));
  titleEl.textContent = btn.dataset.title || btn.textContent.trim();
  subEl.textContent = btn.dataset.sub || '';
  const src = btn.dataset.src;
  if (src) {
    placeholder.classList.remove('show');
    view.style.display = 'inline-flex';
    if (view.getAttribute('src') !== src) view.setAttribute('src', src);
  } else {
    // surface not built yet → placeholder
    view.style.display = 'none';
    phTitle.textContent = (btn.dataset.title || btn.textContent.trim()) + ' — coming soon';
    placeholder.classList.add('show');
  }
}

document.querySelectorAll('.surface').forEach(btn => btn.addEventListener('click', () => select(btn)));

// surface a clearer message if the embedded surface fails to load
view.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return; // aborted (normal on src swap)
  view.style.display = 'none';
  phTitle.textContent = 'Surface failed to load';
  phSub.textContent = `(${e.errorCode}) ${e.errorDescription || ''}`;
  placeholder.classList.add('show');
});
