/**
 * Theme bootstrap. Runs before the first paint.
 *
 * The choice the toggle records has to be applied before anything is painted,
 * or a viewer whose OS is dark and who chose light sees a dark page for the
 * length of a module fetch and a React mount, then a flash to light. Stamping
 * from React alone cannot avoid that: by the time a component runs, the wrong
 * paint has already happened.
 *
 * A file rather than an inline `<script>`: the site ships `script-src 'self'`
 * with no `'unsafe-inline'`, so an inline bootstrap would be blocked in
 * production - the one place the flash actually matters.
 *
 * The key is duplicated from `Layout.tsx` because nothing in `public/` is part
 * of the bundle and there is no import to share a constant through. Both spell
 * it `credent.theme`; change neither alone.
 */
;(function () {
  try {
    var choice = window.localStorage.getItem('credent.theme')
    if (choice === 'dark' || choice === 'light') {
      document.documentElement.setAttribute('data-theme', choice)
    }
    // No stored choice: leave the document unstamped so the tokens' own
    // `prefers-color-scheme` block decides, which is what the toggle then
    // reads back on mount.
  } catch (error) {
    // Storage blocked, as in private browsing with cookies refused. The OS
    // preference still applies; only the remembered override is lost.
  }
})()
