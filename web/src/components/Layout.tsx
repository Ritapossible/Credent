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
 * Theme starts from whatever `index.html` stamped, so the toggle agrees with the
 * paint that already happened rather than flipping on mount.
 */
function initialTheme(): Theme {
  const stamped = document.documentElement.getAttribute('data-theme')
  return stamped === 'light' ? 'light' : 'dark'
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
    window.scrollTo(0, 0)
  }, [location.pathname])

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
          <p className="muted">
            Credent is a demonstration interface. Scores are computed in-browser from fixture
            attestations using the same integer math as the contract — no deployment is being read.
          </p>
          <p className="muted">
            Built on <strong>GenLayer</strong> intelligent contracts.
          </p>
        </div>
      </footer>
    </>
  )
}

function Mark() {
  return (
    <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="14" fill="none" stroke="var(--rule-strong)" strokeWidth="2" />
      <path
        d="M16 2a14 14 0 0 1 0 28"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="4.5" fill="var(--accent)" />
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
