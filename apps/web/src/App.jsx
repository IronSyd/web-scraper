import { useEffect, useRef, useState } from "react";
import Offcanvas from "bootstrap/js/dist/offcanvas";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import Home from "./pages/Home.jsx";
import Source from "./pages/Source.jsx";
import Run from "./pages/Run.jsx";
import History from "./pages/History.jsx";
import Brand from "./components/Brand.jsx";
import SourceIcon from "./components/SourceIcon.jsx";
import CollectionAvailability from "./components/CollectionAvailability.jsx";
import { sourceNames, sources } from "./api.js";

function Layout() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const sidebarRef = useRef(/** @type {HTMLElement|null} */ (null));
  const toggleRef = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const mainRef = useRef(/** @type {HTMLElement|null} */ (null));
  const drawerRef = useRef(
    /** @type {InstanceType<typeof Offcanvas>|null} */ (null),
  );
  const destinationFocus = useRef(false);
  const drawerOpening = useRef(false);
  const deferredHide = useRef(false);
  const location = useLocation();
  const pageName =
    location.pathname === "/"
      ? "Overview"
      : location.pathname === "/history"
        ? "Collection history"
        : location.pathname.startsWith("/runs/")
          ? "Saved run"
          : sources.find((source) => location.pathname === `/sources/${source}`)
            ? sourceNames[
                /** @type {import('./api.js').Source} */ (
                  location.pathname.split("/")[2]
                )
              ]
            : "Page not found";

  useEffect(() => {
    const element = sidebarRef.current;
    if (!element) return;
    const drawer = new Offcanvas(element, {
      backdrop: true,
      keyboard: true,
      scroll: false,
    });
    drawerRef.current = drawer;
    const onShow = () => {
      drawerOpening.current = true;
      deferredHide.current = false;
      setNavigationOpen(true);
    };
    const onShown = () => {
      drawerOpening.current = false;
      if (deferredHide.current) {
        deferredHide.current = false;
        drawer.hide();
      }
    };
    /** @param {Event} event */
    const onHide = (event) => {
      // Bootstrap's queued show callback must finish before a competing hide.
      if (drawerOpening.current) {
        event.preventDefault();
        deferredHide.current = true;
      }
    };
    const onHidden = () => {
      drawerOpening.current = false;
      deferredHide.current = false;
      setNavigationOpen(false);
      if (destinationFocus.current)
        mainRef.current?.focus({ preventScroll: true });
      else if (toggleRef.current?.getClientRects().length)
        toggleRef.current.focus();
      destinationFocus.current = false;
    };
    element.addEventListener("show.bs.offcanvas", onShow);
    element.addEventListener("shown.bs.offcanvas", onShown);
    element.addEventListener("hide.bs.offcanvas", onHide);
    element.addEventListener("hidden.bs.offcanvas", onHidden);
    const desktop = window.matchMedia("(min-width: 992px)");
    const onBreakpointChange = () => {
      if (desktop.matches) {
        destinationFocus.current = true;
        drawer.hide();
      }
    };
    desktop.addEventListener("change", onBreakpointChange);
    return () => {
      desktop.removeEventListener("change", onBreakpointChange);
      element.removeEventListener("show.bs.offcanvas", onShow);
      element.removeEventListener("shown.bs.offcanvas", onShown);
      element.removeEventListener("hide.bs.offcanvas", onHide);
      element.removeEventListener("hidden.bs.offcanvas", onHidden);
      if (element.classList.contains("showing")) {
        element.addEventListener(
          "shown.bs.offcanvas",
          () => {
            element.addEventListener(
              "hidden.bs.offcanvas",
              () => drawer.dispose(),
              { once: true },
            );
            drawer.hide();
          },
          { once: true },
        );
      } else if (element.matches(".show, .hiding")) {
        element.addEventListener(
          "hidden.bs.offcanvas",
          () => drawer.dispose(),
          { once: true },
        );
        if (!element.classList.contains("hiding")) drawer.hide();
      } else drawer.dispose();
      drawerRef.current = null;
    };
  }, []);

  useEffect(() => {
    document.title = `${pageName} | Webby`;
    if (!sidebarRef.current?.matches(".show, .showing, .hiding"))
      mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname, pageName]);

  function followNavigation() {
    destinationFocus.current = true;
    drawerRef.current?.hide();
  }

  return (
    <div
      className="workspace-shell"
      onKeyDownCapture={(event) => {
        if (
          event.key === "Escape" &&
          (navigationOpen || drawerOpening.current)
        ) {
          event.preventDefault();
          event.stopPropagation();
          drawerRef.current?.hide();
        }
      }}
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="mobile-header">
        <Brand />
        <button
          className="icon-button navigation-toggle"
          type="button"
          ref={toggleRef}
          aria-label="Open navigation"
          aria-controls="workspace-navigation"
          aria-expanded={navigationOpen}
          onClick={() => {
            destinationFocus.current = false;
            drawerRef.current?.show(toggleRef.current ?? undefined);
          }}
        >
          <SourceIcon name="menu" size={22} />
        </button>
      </header>
      <aside
        className="workspace-sidebar offcanvas-lg offcanvas-start"
        id="workspace-navigation"
        tabIndex={-1}
        aria-labelledby="workspace-navigation-label"
        ref={sidebarRef}
      >
        <h2 id="workspace-navigation-label" className="visually-hidden">
          Webby navigation
        </h2>
        <div className="sidebar-brand">
          <Brand onNavigate={followNavigation} />
          <button
            className="icon-button sidebar-close"
            type="button"
            aria-label="Close navigation"
            onClick={() => {
              destinationFocus.current = false;
              drawerRef.current?.hide();
            }}
          >
            <SourceIcon name="close" />
          </button>
        </div>
        <div className="offcanvas-body">
          <nav className="sidebar-navigation" aria-label="Main navigation">
            <NavLink
              to="/"
              end
              className="sidebar-link"
              onClick={followNavigation}
            >
              <SourceIcon name="overview" />
              <span>Overview</span>
            </NavLink>
            <div className="sidebar-group">
              <p className="sidebar-group-label" id="sources-label">
                Sources
              </p>
              <ul aria-labelledby="sources-label">
                {sources.map((source) => (
                  <li key={source}>
                    <NavLink
                      to={`/sources/${source}`}
                      className="sidebar-link"
                      onClick={followNavigation}
                    >
                      <SourceIcon name={source} />
                      <span>{sourceNames[source]}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
            <NavLink
              to="/history"
              className="sidebar-link"
              onClick={followNavigation}
            >
              <SourceIcon name="history" />
              <span>History</span>
            </NavLink>
          </nav>
          <div className="sidebar-footer">
            <span className="local-indicator" aria-hidden="true" />
            Local workspace<p>Collect. Clean. Keep.</p>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="workspace-header">
          <div className="workspace-breadcrumb">
            <Link to="/">Workspace</Link>
            <span className="breadcrumb-divider" aria-hidden="true">
              /
            </span>
            <span>{pageName}</span>
          </div>
          <CollectionAvailability />
        </header>
        <main
          id="main-content"
          className="workspace-content"
          ref={mainRef}
          tabIndex={-1}
        >
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/sources/:source" element={<Source />} />
            <Route path="/runs/:id" element={<Run />} />
            <Route path="/history" element={<History />} />
            <Route
              path="/tiobe/Tiobe"
              element={<Navigate to="/sources/tiobe" replace />}
            />
            <Route
              path="/amazon/Amazon"
              element={<Navigate to="/sources/amazon" replace />}
            />
            <Route
              path="*"
              element={
                <section>
                  <header className="page-heading">
                    <h1>Page not found</h1>
                    <p className="page-intro">
                      This page does not exist. Choose a source or reopen your
                      saved work.
                    </p>
                  </header>
                  <Link className="btn btn-primary" to="/">
                    Return to overview
                  </Link>
                </section>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}
export default function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  );
}
