// The phone-width menu, shared by every page: the button opens it and moves to its first link; a
// link, Escape, or moving on past the header closes it.
/* global document */
(function () {
  var menu = document.getElementById('menuBtn'), links = document.getElementById('navLinks');
  if (!menu || !links) return;
  function setMenu(open) {
    links.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  menu.addEventListener('click', function () {
    var open = !links.classList.contains('open');
    setMenu(open);
    // The links sit before the button in the page, so the keyboard would otherwise skip them.
    if (open) { var first = links.querySelector('a'); if (first) first.focus(); }
  });
  var header = menu.closest('header');
  if (header) header.addEventListener('focusout', function (e) {
    if (links.classList.contains('open') && e.relatedTarget && !header.contains(e.relatedTarget)) setMenu(false);
  });
  links.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && links.classList.contains('open')) { setMenu(false); menu.focus(); }
  });
})();
