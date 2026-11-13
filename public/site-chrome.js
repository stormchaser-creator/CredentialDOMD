// Mobile menu for the shared public-site header (scripts/site-chrome.mjs).
(() => {
  const button = document.querySelector('.cdm-menu-btn');
  const menu = document.getElementById('cdm-menu');
  if (!button || !menu) return;
  const set = open => {
    menu.classList.toggle('cdm-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Close' : 'Menu';
  };
  button.addEventListener('click', () => set(button.getAttribute('aria-expanded') !== 'true'));
  menu.addEventListener('click', event => { if (event.target.closest('a')) set(false); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') { set(false); button.focus(); }
  });
})();
