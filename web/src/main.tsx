import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { WalletProvider } from './chain/useWallet'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      {/* Above the router: the connection outlives navigation, and the masthead
          reads it on every page. */}
      <WalletProvider>
        <App />
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>,
)
