// import React, { useEffect, useState } from "react";
// import { Menu, RefreshCcw } from "lucide-react";
// import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
// import { ThemeProvider } from "./context/ThemeContext";
// import Sidebar from "./components/Sidebar";
// import navConfig from "./data/navConfig";
// import LoginPage from "./pages/LoginPage";
// import SignupPage from "./pages/SignupPage";

// import Dashboard from "./pages/Dashboard";
// import BOQ from "./pages/Model";
// import PODetails from "./pages/PODetails";
// import Invoices from "./pages/Invoices";
// import StockRegister from "./pages/StockRegister";
// import DailyProduction from "./pages/DailyProduction";
// import SaleRegister from "./pages/SaleRegister";
// import DefectiveUnits from "./pages/DefectiveUnits";
// import "./styles/modal-theme.css";


// import "./styles/global.css";
// import "./App.css";

// function AppShell() {
//   const location = useLocation();
//   const navigate = useNavigate();
//   const [navOpen, setNavOpen] = useState(true);

//   const activeTab = navConfig.find((t) => t.path === location.pathname) || navConfig[0];

//   useEffect(() => {
//     const syncSidebarToViewport = () => {
//       setNavOpen(window.innerWidth > 1024);
//     };

//     syncSidebarToViewport();
//     window.addEventListener("resize", syncSidebarToViewport);

//     return () => window.removeEventListener("resize", syncSidebarToViewport);
//   }, []);

//   const handleSelect = (id) => {
//     const tab = navConfig.find((item) => item.id === id);
//     if (tab) {
//       navigate(tab.path);
//     }
//   };

//   const handleLogout = () => {
//     // Hook this up to your real auth flow (clear token, redirect, etc).
//     // eslint-disable-next-line no-alert
//     const confirmed = window.confirm("Log out of Vertex Industries dashboard?");
//     if (confirmed) {
//       navigate("/");
//     }
//   };

//   return (
//     <div className="app-shell">
//       <Sidebar
//         active={activeTab.id}
//         onSelect={handleSelect}
//         open={navOpen}
//         onClose={() => setNavOpen(false)}
//         onToggle={() => setNavOpen((prev) => !prev)}
//         onLogout={handleLogout}
//       />

//       <div className="app-main">
//         <header className="app-topbar">
//           <div className="app-topbar-left">
//             {!navOpen && (
//               <button
//                 className="app-menu-btn"
//                 onClick={() => setNavOpen(true)}
//                 aria-label="Open navigation"
//                 aria-expanded={navOpen}
//               >
//                 <Menu size={18} />
//               </button>
//             )}
//             <h1 className="app-page-title">{activeTab?.label}</h1>
//           </div>

//           <div className="app-topbar-right">
//             <span className="app-refresh-note">
//               <RefreshCcw size={13} /> Refreshed just now
//             </span>
//             <span className="app-live-pill">
//               <span className="app-live-dot" /> Live
//             </span>
//           </div>
//         </header>

//         <div className="app-content">
//           <Routes>
//             <Route path="/dashboard" element={<Dashboard />} />
//             <Route path="/models" element={<BOQ />} />
//             <Route path="/po" element={<PODetails />} />
//             <Route path="/invoices" element={<Invoices />} />
//             <Route path="/stock" element={<StockRegister />} />
//             <Route path="/production" element={<DailyProduction />} />
//             <Route path="/sales" element={<SaleRegister />} />
//             <Route path="/defects" element={<DefectiveUnits />} />
//             <Route path="*" element={<Navigate to="/dashboard" replace />} />
//           </Routes>
//         </div>
//       </div>
//     </div>
//   );
// }

// export default function App() {
//   return (
//     <ThemeProvider>
//       <BrowserRouter>
//         <Routes>
//           <Route path="/" element={<LoginPage />} />
//           <Route path="/login" element={<LoginPage />} />
//           <Route path="/forgot-password" element={<h1>Forgot Password</h1>} />
//           <Route path="/register" element={<SignupPage />} />
//           <Route path="/*" element={<AppShell />} />
//         </Routes>
//       </BrowserRouter>
//     </ThemeProvider>
//   );
// }

import React, { useEffect, useState } from "react";
import { ChevronDown, KeyRound, Menu, User, X } from "lucide-react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider, useAuth } from "./context/Auth";
import ProtectedRoute from "./components/ProtectedRoute";
import GlobalApiLoader from "./components/GlobalApiLoader";
import { RealtimeProvider } from "./components/RealtimeProvider";
import Sidebar from "./components/Sidebar";
import navConfig from "./data/navConfig";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import ForgotPassword from "./pages/ForgotPassword";
import api from "./components/Api";

import Dashboard from "./pages/Dashboard";
import BOQ from "./pages/Model";
import PODetails from "./pages/PODetails";
import Invoices from "./pages/Invoices";
import StockRegister from "./pages/StockRegister";
import DailyProduction from "./pages/DailyProduction";
import SaleRegister from "./pages/SaleRegister";
import DefectiveUnits from "./pages/DefectiveUnits";
import AdminCreateUser from "./pages/AdminCreateUser";
import "./App.css";
import "./styles/global.css";

const ROLE_LABELS = {
  admin: "Admin",
  coadmin: "Co-Admin",
  production_incharge: "Production In-charge",
  user: "User",
};

// Sections that remember their drill-down (kept across a browser refresh).
// Clicking their sidebar item must re-open the section at its first page:
// clear the stored drill keys (covers returning from another tab) and tell
// the mounted page, if any, to drop its drill-down right away.
const NAV_DRILL_RESETS = {
  "/models": { keys: ["vector_active_model", "vector_active_phase"], event: "vector:models-reset" },
  "/po": { keys: ["vector_po_drill"], event: "vector:po-reset" },
  "/invoices": { keys: ["vector_invoices_drill"], event: "vector:invoices-reset" },
};

function Unauthorized() {
  return (
    <div style={{ padding: "3rem", textAlign: "center" }}>
      <h1>403 — Not Authorized</h1>
      <p>You don't have permission to view this page.</p>
    </div>
  );
}

function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { role, name, email, logout } = useAuth();
  const [navOpen, setNavOpen] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);

  // Only show/allow nav items this role is permitted to see.
  const visibleNav = navConfig.filter((item) => item.roles.includes(role));
  const activeTab = visibleNav.find((t) => t.path === location.pathname) || visibleNav[0];
  const roleLabel = ROLE_LABELS[role] || String(role || "User").replaceAll("_", " ");

  useEffect(() => {
    const syncSidebarToViewport = () => {
      setNavOpen(window.innerWidth > 1024);
    };

    syncSidebarToViewport();
    window.addEventListener("resize", syncSidebarToViewport);

    return () => window.removeEventListener("resize", syncSidebarToViewport);
  }, []);


  useEffect(() => {
    const root = document.body;
    root.classList.add("app-session-active");

    const fieldSelector = 'input:not([type="password"]):not([type="checkbox"]):not([type="radio"]), textarea';
    const disableBrowserSuggestions = (node) => {
      const fields = [];
      if (node.matches?.(fieldSelector)) fields.push(node);
      node.querySelectorAll?.(fieldSelector).forEach((field) => fields.push(field));
      fields.forEach((field) => {
        field.setAttribute("autocomplete", "off");
        field.setAttribute("aria-autocomplete", "none");
      });
    };

    disableBrowserSuggestions(root);
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) disableBrowserSuggestions(node);
        });
      });
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      root.classList.remove("app-session-active");
    };
  }, []);

  const handleSelect = (id) => {
    const tab = visibleNav.find((item) => item.id === id);
    if (tab) {
      const reset = NAV_DRILL_RESETS[tab.path];
      if (reset) {
        reset.keys.forEach((key) => {
          try {
            sessionStorage.removeItem(key);
          } catch {
            /* storage unavailable */
          }
        });
        window.dispatchEvent(new Event(reset.event));
      }
      navigate(tab.path);
    }
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };
  const changePassword = async (event) => {
    event.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirmPassword) return setPasswordError("New passwords do not match.");
    setPasswordSaving(true); setPasswordError("");
    try { await api.post("/account/change-password", passwordForm); setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" }); setProfileOpen(false); }
    catch (error) { setPasswordError(error.response?.data?.message || "Unable to change password."); }
    finally { setPasswordSaving(false); }
  };

  return (
    <div className="app-shell">
      <Sidebar
        active={activeTab?.id}
        items={visibleNav}
        onSelect={handleSelect}
        open={navOpen}
        onClose={() => setNavOpen(false)}
        onToggle={() => setNavOpen((prev) => !prev)}
        onLogout={handleLogout}
        onChangePassword={() => setProfileOpen(true)}
      />

      <div className="app-main">
        <header className="app-topbar">
          <div className="app-topbar-left">
            {!navOpen && (
              <button
                className="app-menu-btn"
                onClick={() => setNavOpen(true)}
                aria-label="Open navigation"
                aria-expanded={navOpen}
              >
                <Menu size={18} />
              </button>
            )}
            <h1 className="app-page-title">{activeTab?.label}</h1>
          </div>

          <div className="app-topbar-right">
            <div className="profile-menu-wrap"><button type="button" className="profile-menu-toggle" onClick={() => setProfileMenuOpen((open) => !open)} aria-label="Open profile menu" aria-expanded={profileMenuOpen}><ChevronDown size={16} /></button>{profileMenuOpen && <div className="profile-menu"><button type="button" onClick={() => { setProfileMenuOpen(false); setProfileOpen(true); }}><KeyRound size={15} /> Change password</button></div>}</div>
            <button type="button" className="profile-password-trigger" onClick={() => setProfileOpen(true)}><KeyRound size={15} /> Change password</button>
            <div className="app-user" title={`${email || name || "Signed-in user"} — ${roleLabel}`}>
              <span className="app-user-icon" aria-hidden="true">
                <User size={17} />
              </span>
              <span className="app-user-details">
                <span className="app-user-name">{name || email || "User"}</span>
                <span className="app-user-role">{roleLabel}</span>
              </span>
            </div>
          </div>
        </header>

        {profileOpen && <div className="profile-password-overlay" onClick={() => setProfileOpen(false)}><div className="profile-password-modal" onClick={(event) => event.stopPropagation()}><button type="button" className="profile-password-close" onClick={() => setProfileOpen(false)}><X size={18} /></button><h2><KeyRound size={19} /> Change Password</h2><p>{email}</p><form onSubmit={changePassword}><label>Current password<input type="password" value={passwordForm.currentPassword} onChange={(event) => setPasswordForm((form) => ({ ...form, currentPassword: event.target.value }))} required /></label><label>New password<input type="password" minLength={8} value={passwordForm.newPassword} onChange={(event) => setPasswordForm((form) => ({ ...form, newPassword: event.target.value }))} required /></label><label>Confirm new password<input type="password" minLength={8} value={passwordForm.confirmPassword} onChange={(event) => setPasswordForm((form) => ({ ...form, confirmPassword: event.target.value }))} required /></label>{passwordError && <div className="profile-password-error">{passwordError}</div>}<button type="submit" disabled={passwordSaving}>{passwordSaving ? "Updating..." : "Update password"}</button></form></div></div>}

        <main className="app-content">
          <Routes>
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute allowedRoles={["admin", "coadmin", "production_incharge", "user"]}>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/models"
              element={
                <ProtectedRoute allowedRoles={["admin", "coadmin"]}>
                  <BOQ />
                </ProtectedRoute>
              }
            />
            <Route
              path="/po"
              element={
                <ProtectedRoute allowedRoles={["admin", "coadmin"]}>
                  <PODetails />
                </ProtectedRoute>
              }
            />
            <Route
              path="/invoices"
              element={
                <ProtectedRoute allowedRoles={["admin", "coadmin", "production_incharge"]}>
                  <Invoices />
                </ProtectedRoute>
              }
            />
            <Route
              path="/stock"
              element={
                <ProtectedRoute allowedRoles={["admin", "coadmin", "production_incharge"]}>
                  <StockRegister />
                </ProtectedRoute>
              }
            />
            <Route
              path="/production"
              element={
                <ProtectedRoute allowedRoles={["admin", "coadmin", "production_incharge", "user"]}>
                  <DailyProduction />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sales"
              element={
                <ProtectedRoute allowedRoles={["admin", "coadmin", "production_incharge"]}>
                  <SaleRegister />
                </ProtectedRoute>
              }
            />
            <Route
              path="/defects"
              element={
                <ProtectedRoute allowedRoles={["admin", "coadmin", "production_incharge"]}>
                  <DefectiveUnits />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/create-user"
              element={
                <ProtectedRoute allowedRoles={["admin"]} redirectTo="/login">
                  <AdminCreateUser />
                </ProtectedRoute>
              }
            />
            <Route path="/unauthorized" element={<Unauthorized />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
        <footer className="app-footer">
           © 2026 Office2000 Solutions Pvt Ltd
        </footer>
      </div>
    </div>
  );
}

export default function App() {
return (
<ThemeProvider>
<AuthProvider>
{/* One WebSocket for the app: pages refresh their own view when data changes. */}
<RealtimeProvider>
<BrowserRouter>
<GlobalApiLoader />
<Routes>
<Route path="/" element={<LoginPage />} />
<Route path="/login" element={<LoginPage />} />
<Route path="/admin/login" element={<Navigate to="/login" replace />} />
<Route path="/forgot-password" element={<ForgotPassword />} />
<Route path="/register" element={<SignupPage />} />
<Route path="/unauthorized" element={<Unauthorized />} />
<Route path="/*" element={<AppShell />} />
</Routes>
</BrowserRouter>
</RealtimeProvider>
</AuthProvider>
</ThemeProvider>
);
}
