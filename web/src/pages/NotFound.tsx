import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow">404</p>
        <h1>Nothing at this address</h1>
        <p className="lede">
          The page you asked for does not exist. The registry, the weight lab, and the attack cost
          model are all reachable from the menu above.
        </p>
      </div>
      <Link className="btn" to="/">
        Back to the overview
      </Link>
    </div>
  )
}
