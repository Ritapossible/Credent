import { Navigate, Route, Routes } from 'react-router-dom'

import Layout from './components/Layout'
import Overview from './pages/Overview'
import Registry from './pages/Registry'
import AgentDetail from './pages/AgentDetail'
import WeightLab from './pages/WeightLab'
import AttackCost from './pages/AttackCost'
import ScopeBuilder from './pages/ScopeBuilder'
import Attest from './pages/Attest'
import Payouts from './pages/Payouts'
import PolicyPage from './pages/PolicyPage'
import Docs from './pages/Docs'
import NotFound from './pages/NotFound'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="agents" element={<Registry />} />
        <Route path="agents/:address" element={<AgentDetail />} />
        <Route path="lab" element={<WeightLab />} />
        <Route path="attack" element={<AttackCost />} />
        <Route path="scope" element={<ScopeBuilder />} />
        <Route path="attest" element={<Attest />} />
        <Route path="payouts" element={<Payouts />} />
        <Route path="policy" element={<PolicyPage />} />
        <Route path="docs" element={<Docs />} />
        <Route path="index.html" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
