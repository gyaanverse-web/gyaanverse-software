// Client-side page loader for file:// and served deployments
const root = document.getElementById('content');
const homeHTML = root.innerHTML;
// Lock the base directory at load time so fetch paths stay correct even if
// the browser URL changes (e.g. after history.pushState on a server).
const base = document.baseURI.replace(/[^\/]+$/, '');

async function load(path) {
  try {
    const res = await fetch(base + path);
    if (!res.ok) throw new Error('Not found');
    root.innerHTML = await res.text();
  } catch (e) {
    root.innerHTML = `<section class="page"><h2>Page not found</h2><p>Could not load ${path}.</p></section>`;
  }
}

function showHome() {
  root.innerHTML = homeHTML;
}

function linkHandler(e) {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');

  if (href === '/' || href === '' || href === './') {
    showHome();
    return;
  }
  if (href === '#contact') {
    showHome();
    setTimeout(() => document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' }), 0);
    return;
  }

  const path = href.replace(/^\//, '');
  load(path);
}

document.addEventListener('click', linkHandler);

// Show executive summary by default
load('pages/executive.html');
