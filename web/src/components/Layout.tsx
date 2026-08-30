import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'

import ConnectButton from './ConnectButton'
import ErrorBoundary from './ErrorBoundary'
import { CONFIG_ERROR } from '../chain/config'

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/agents', label: 'Registry', end: false },
  { to: '/lab', label: 'Weight lab', end: false },
  { to: '/attack', label: 'Attack cost', end: false },
  { to: '/scope', label: 'Scope builder', end: false },
  { to: '/attest', label: 'Attest', end: false },
  { to: '/payouts', label: 'Payouts', end: false },
  { to: '/policy', label: 'Policy', end: false },
]

/**
 * The footer is a site map, not a second masthead. It repeats every route the
 * nav carries and adds the docs sections, which are the only destinations deep
 * enough that a visitor who scrolled to the bottom looking for one would
 * otherwise have to go back up and hunt for them.
 */
const FOOTER_NAV = [
  {
    title: 'Product',
    links: [
      { to: '/', label: 'Overview' },
      { to: '/agents', label: 'Registry' },
      { to: '/policy', label: 'Policy' },
    ],
  },
  {
    title: 'Tools',
    links: [
      { to: '/lab', label: 'Weight lab' },
      { to: '/attack', label: 'Attack cost' },
      { to: '/scope', label: 'Scope builder' },
      { to: '/attest', label: 'Attest' },
    ],
  },
  {
    title: 'Documentation',
    links: [
      { to: '/docs#protocol', label: 'How the protocol works' },
      { to: '/docs#scoring', label: 'The scoring math' },
      { to: '/docs#economics', label: 'Bonds and attacks' },
      { to: '/docs#parameters', label: 'Parameter reference' },
    ],
  },
]

type Theme = 'dark' | 'light'

/**
 * Where the chosen theme is remembered. Spelled the same way in
 * `public/theme.js`, which is what applies it before the first paint and cannot
 * import from here. Changing one means changing both.
 */
const THEME_KEY = 'credent.theme'

function storedTheme(): Theme | null {
  try {
    const choice = window.localStorage.getItem(THEME_KEY)
    return choice === 'dark' || choice === 'light' ? choice : null
  } catch {
    return null
  }
}

/**
 * Theme starts from whatever already painted, so the toggle agrees with the page
 * rather than flipping on mount. `theme.js` has already stamped a remembered
 * choice by now; an unstamped document means there is none and the paint came
 * from `prefers-color-scheme`, which is what has to be read back - defaulting to
 * light here would show a dark page behind a sun icon.
 */
function initialTheme(): Theme {
  const stamped = document.documentElement.getAttribute('data-theme')
  if (stamped === 'dark' || stamped === 'light') return stamped
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function Layout() {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  /**
   * Whether the theme is the visitor's own choice or just the OS showing
   * through. Only a choice is persisted: writing the resolved value on mount
   * would silently pin every first-time viewer to whatever their OS said at that
   * moment, and they would stop following it afterwards.
   */
  const [chosen, setChosen] = useState(() => storedTheme() !== null)
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  /** The bar and its drawer. A press anywhere outside this closes the drawer. */
  const bar = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Keep following the OS until the visitor overrides it, which is what an
  // unstamped document already does in CSS - this only keeps the icon and the
  // React state in step when the setting changes while the tab is open.
  useEffect(() => {
    if (chosen) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => setTheme(media.matches ? 'dark' : 'light')
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [chosen])

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    setChosen(true)
    try {
      window.localStorage.setItem(THEME_KEY, next)
    } catch {
      // Storage blocked. The page still switches; it just will not survive a
      // reload, which is not worth failing the toggle over.
    }
  }

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  /**
   * Close the drawer on an outside press or Escape.
   *
   * It hangs over the page now instead of pushing it down, so a visitor who opens
   * it and then reaches for the content underneath needs the panel to get out of
   * the way - and a press that lands on the page behind is that request.
   */
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent) => {
      if (!bar.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

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
        <div className="shell masthead__inner" ref={bar}>
          <NavLink to="/" className="brand" aria-label="Credent home">
            <Mark />
            <span className="brand__text">
              Credent
              <span className="brand__sub">reputation as collateral</span>
            </span>
          </NavLink>

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

          {/**
           * Actions, not destinations - and grouped as such.
           *
           * The wallet control used to sit at the end of the nav, which put the
           * one button on the page that spends money in the same flex row as
           * seven links, at a different height from both of its neighbours. Every
           * wallet-bearing site puts connect in a right-hand cluster with the
           * other chrome controls, and this group is that cluster: it holds its
           * place at every width, so the wallet no longer disappears into a
           * hamburger menu on a phone.
           */}
          <div className="masthead__actions">
            <ConnectButton />

            <button
              type="button"
              className="icon-button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>

            <button
              type="button"
              className="icon-button masthead__toggle"
              aria-expanded={menuOpen}
              aria-controls="primary-nav"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <CloseIcon /> : <MenuIcon />}
            </button>
          </div>
        </div>
      </header>

      {/* Site-wide, because a bad network alias breaks every page that reads
          the chain and the visitor should not have to find one to be told. */}
      {CONFIG_ERROR !== null ? (
        <div className="config-banner" role="alert">
          <div className="shell">
            <strong>Misconfigured build.</strong> {CONFIG_ERROR}
          </div>
        </div>
      ) : null}

      <main id="main">
        {/* Keyed by path so a page that threw does not keep its failed state
            after the visitor navigates somewhere else. */}
        <ErrorBoundary key={location.pathname} scope="page">
          <Outlet />
        </ErrorBoundary>
      </main>

      <footer className="footer">
        <div className="shell">
          <div className="footer__top">
            <div className="footer__identity">
              <Link to="/" className="footer__brand" aria-label="Credent home">
                <Mark />
                <span>Credent</span>
              </Link>
              <p className="muted footer__note">
                Reputation as collateral. Scores are read from the deployed contract; the
                derivations beside them are recomputed in-browser by a port pinned to the engine.
              </p>
            </div>

            <nav className="footer__nav" aria-label="Footer">
              {FOOTER_NAV.map((group) => (
                <div key={group.title} className="footer__group">
                  <h2 className="footer__heading">{group.title}</h2>
                  <ul className="footer__list">
                    {group.links.map((link) => (
                      <li key={link.to}>
                        <Link to={link.to} className="footer__link">
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </div>

          <div className="footer__bottom">
            <p className="muted">© {new Date().getFullYear()} Credent</p>
            <p className="muted">
              Built on <strong>GenLayer</strong> intelligent contracts
            </p>
          </div>
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

/**
 * The menu button is an icon now rather than the words "Menu" and "Close".
 *
 * Squaring it off is what let the wallet control stay on the masthead row on a
 * phone: the two words were ~80px of the ~330px available, and the pill they
 * sat in was a third distinct control height beside the theme toggle.
 */
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
