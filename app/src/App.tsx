import {
  createBrowserRouter,
  RouterProvider,
} from 'react-router-dom'
import Layout, { LandingLayout, NotFound } from './components/Layout'
import Landing from './pages/Landing'
import Lobby from './pages/Lobby'
import AuctionRoom from './pages/AuctionRoom'
import Create from './pages/Create'
import Me from './pages/Me'
import Proof from './pages/Proof'
import Admin from './pages/Admin'

// Landing paths — going TO these from the app is a "back" transition
const LANDING_PATHS = new Set(['/'])
// App paths — going TO these from landing is a "forward" transition
function isAppPath(p: string) { return !LANDING_PATHS.has(p) }
function isLandingPath(p: string) { return LANDING_PATHS.has(p) }

// Set direction attribute on <html> before the View Transition fires.
// Called from onClick of forward/back links — runs synchronously before
// react-router calls document.startViewTransition.
export function setNavDirection(to: string, from: string) {
  const dir =
    (isLandingPath(from) && isAppPath(to)) ? 'forward' :
    (isAppPath(from) && isLandingPath(to)) ? 'back' :
    ''
  if (dir) {
    document.documentElement.dataset.nav = dir
    // Clear after the transition completes (or 800 ms fallback)
    setTimeout(() => { delete document.documentElement.dataset.nav }, 800)
  }
}

const router = createBrowserRouter([
  {
    element: <LandingLayout />,
    children: [{ path: '/', element: <Landing /> }],
  },
  {
    element: <Layout />,
    children: [
      { path: '/lots',     element: <Lobby /> },
      { path: '/lot/:id',  element: <AuctionRoom /> },
      { path: '/create',   element: <Create /> },
      { path: '/me',       element: <Me /> },
      { path: '/proof',    element: <Proof /> },
      { path: '/admin',    element: <Admin /> },
      { path: '*',         element: <NotFound /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
