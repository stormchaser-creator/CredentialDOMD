// Native details/summary provides Enter, Space and touch activation. Keep
// closing, focus return and the surrounding mobile navigation consistent.
(() => {
  const menus = [...document.querySelectorAll('.support-menu')];
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = toggle && document.getElementById(toggle.getAttribute('aria-controls'));
  const closeSupport = () => menus.forEach(menu => { menu.open = false; });
  const setMobileOpen = open => {
    if (!nav) return;
    nav.classList.toggle('mobile-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (!open) closeSupport();
  };
  toggle?.addEventListener('click', () => setMobileOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = menus.find(menu => menu.open);
    if (open) {
      open.open = false;
      open.querySelector('summary').focus();
      event.preventDefault();
    } else if (toggle?.getAttribute('aria-expanded') === 'true') {
      setMobileOpen(false);
      toggle.focus();
      event.preventDefault();
    }
  });
  document.addEventListener('click', event => {
    menus.forEach(menu => {
      if (!menu.contains(event.target) || event.target.closest('a')) menu.open = false;
    });
    if (nav?.contains(event.target) && event.target.closest('a')) setMobileOpen(false);
  });
  document.addEventListener('focusin', event => {
    menus.forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
  });
  window.addEventListener('resize', () => { if (window.innerWidth > 1024) setMobileOpen(false); });
})();
