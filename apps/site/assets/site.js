// The phone-width menu, shared by every page: the button opens it, a link or Escape closes it.
/* global document */
(function () {
  var menu = document.getElementById('menuBtn'), links = document.getElementById('navLinks');
  if (!menu || !links) return;
  function setMenu(open) {
    links.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  menu.addEventListener('click', function () { setMenu(!links.classList.contains('open')); });
  links.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && links.classList.contains('open')) { setMenu(false); menu.focus(); }
  });
})();
