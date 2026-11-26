/* Apply the last active TurboWarp editor theme to same-origin companion pages. */
(() => {
  const KEY = 'project-turbowarp-theme';
  const apply = () => {
    try {
      const theme = JSON.parse(localStorage.getItem(KEY) || '{}');
      const root = document.documentElement;
      const map = {
        'color-scheme': 'color-scheme',
        'looks-secondary': 'accent',
        'looks-secondary-dark': 'accent-hover',
        'menu-bar-background': 'menu-bar-background',
        'menu-bar-foreground': 'menu-bar-foreground',
        'page-background': 'bg',
        'page-foreground': 'fg',
        'popover-background': 'card',
        'input-background': 'input-background',
        'ui-primary': 'soft',
        'ui-secondary': 'soft-hover',
        'ui-black-transparent': 'line'
      };
      for (const [source, target] of Object.entries(map)) {
        if (typeof theme[source] === 'string') root.style.setProperty('--' + target, theme[source]);
      }
      if (theme['color-scheme']) root.style.colorScheme = theme['color-scheme'];
      if (theme['looks-secondary']) root.style.setProperty('--accent', theme['looks-secondary']);
    } catch (e) {
      // Fall back to each page's built-in light/dark palette.
    }
  };
  apply();
  window.addEventListener('storage', event => {
    if (event.key === KEY) apply();
  });
})();
