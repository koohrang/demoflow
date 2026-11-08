import { h, icon } from './ui.js';

export function topnav(active) {
  const link = (href, label, key, ic) => h('a', { href, 'aria-current': active === key ? 'page' : null }, icon(ic, 18), label);
  return h('header', { class: 'topnav' },
    h('a', { class: 'logo', href: '#/' }, h('img', { src: window.TM_LOGO, alt: '' }), h('span', null, 'Demo', h('em', null, 'flow'))),
    h('nav', { class: 'nav', 'aria-label': 'Main' },
      link('#/', 'Demos', 'library', 'film'),
      link('#/settings', 'Settings', 'settings', 'settings')),
    h('div', { class: 'nav-foot' },
      h('strong', null, 'Everything stays here'),
      'Demos are saved in this browser on this computer. Nothing is uploaded.',
      h('a', { class: 'app-version', href: '#/settings/updates', title: 'Updates' }, `Demoflow ${window.DF_VERSION || ''}`)));
}
