import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/agents', label: 'Registry', end: false },
  { to: '/lab', label: 'Weight lab', end: false },
  { to: '/attack', label: 'Attack cost', end: false },
  { to: '/scope', label: 'Scope builder', end: false },
  { to: '/policy', label: 'Policy', end: false },
]

type Theme = 'dark' | 'light'

/**
 * Theme starts from whatever already painted, so the toggle agrees with the page
 * rather than flipping on mount. The document ships unstamped, in which case the
 * paint came from `prefers-color-scheme` and that is what has to be read back -
 * defaulting to light here would show a dark page behind a sun icon.
 */
function initialTheme(): Theme {
  const stamped = document.documentElement.getAttribute('data-theme')
  if (stamped === 'dark' || stamped === 'light') return stamped
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function Layout() {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  /**
   * Scroll-to-top on navigation, except when the link carried a hash - the docs
   * page is linked into by section, and resetting to the top would swallow the
   * anchor. Router navigation does not move the document itself, so the target
   * has to be scrolled into view by hand; `scroll-margin-top` on the headings
   * keeps it clear of the sticky masthead.
   *
   * It lands twice on purpose. The webfont is `display: swap`, so the first
   * scroll is measured against fallback metrics and everything above the target
   * reflows taller when Outfit arrives - which slid the heading about 100px up,
   * behind the masthead. Landing again once font metrics are final fixes it, and
   * is a no-op when the font was already cached.
   */
  useEffect(() => {
    if (!location.hash) {
      window.scrollTo(0, 0)
      return
    }

    const id = decodeURIComponent(location.hash.slice(1))
    let cancelled = false

    const land = () => {
      if (cancelled) return
      document.getElementById(id)?.scrollIntoView()
    }

    if (document.getElementById(id)) land()
    else window.scrollTo(0, 0)

    void document.fonts.ready.then(land)

    return () => {
      cancelled = true
    }
  }, [location.pathname, location.hash, location.key])

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="masthead">
        <div className="shell masthead__inner">
          <NavLink to="/" className="brand" aria-label="Credent home">
            <Mark />
            <span className="brand__text">
              Credent
              <span className="brand__sub">reputation as collateral</span>
            </span>
          </NavLink>

          <button
            type="button"
            className="masthead__toggle"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? 'Close' : 'Menu'}
          </button>

          <nav
            id="primary-nav"
            className={`nav${menuOpen ? ' nav--open' : ''}`}
            aria-label="Primary"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}

            {/* Docs is a destination rather than a peer section, so it sits apart
                as a pill instead of becoming a seventh identical link. */}
            <NavLink
              to="/docs"
              className={({ isActive }) => `nav__docs${isActive ? ' nav__docs--active' : ''}`}
            >
              Docs
            </NavLink>
          </nav>

          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <main id="main">
        <Outlet />
      </main>

      <footer className="footer">
        <div className="shell footer__inner">
          <div className="footer__brand">
            <Mark />
            <span>Credent</span>
          </div>
          <p className="muted footer__note">
            Every score on this site is read from the deployed contract. The derivations beside
            them are recomputed in-browser by a port pinned to the engine, vector for vector.
          </p>
          <p className="muted">
            Built on <strong>GenLayer</strong> intelligent contracts.
          </p>
        </div>
      </footer>
    </>
  )
}

/**
 * The mark is a scoring gauge drawn as five discrete arcs: four carried, one
 * still open. That is the product in one glyph - a standing built out of
 * countable attestations rather than a continuous ring that could mean anything.
 * The rotated core is the only non-circular element, which is what makes it
 * legible as a silhouette at favicon size.
 */
function Mark() {
  return (
    <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <g fill="none" strokeWidth="3.2" strokeLinecap="round">
        <path d="M6.571 10.335A11 11 0 0 1 13.526 5.282" stroke="var(--rule-strong)" />
        <g stroke="var(--accent)">
          <path d="M18.474 5.282A11 11 0 0 1 25.429 10.335" />
          <path d="M26.958 15.041A11 11 0 0 1 24.302 23.217" />
          <path d="M20.298 26.126A11 11 0 0 1 11.702 26.126" />
          <path d="M7.698 23.217A11 11 0 0 1 5.042 15.041" />
        </g>
      </g>
      <rect
        x="12.4"
        y="12.4"
        width="7.2"
        height="7.2"
        rx="2.3"
        fill="var(--accent)"
        transform="rotate(45 16 16)"
      />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
      </g>
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  )
}
