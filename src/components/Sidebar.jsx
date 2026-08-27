import React from "react";
import Swal from "sweetalert2";
import { Sun, Moon, LogOut, KeyRound, ChevronRight, ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../context/ThemeContext";
import "./Sidebar.css";

// `items` is the already role-filtered nav list from App.jsx (built off
// navConfig + the signed-in user's role). Sidebar no longer imports the
// full navConfig itself, so it can never render a tab the user can't
// actually open.
export default function Sidebar({ active, items, onSelect, open, onClose, onToggle, onLogout, onChangePassword }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const navigate = useNavigate();

  const tabs = items || [];

  const handleLogoutClick = async () => {
    const result = await Swal.fire({
      title: "Log out?",
      text: "You'll need to sign in again to access your account.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Yes, log out",
      cancelButtonText: "Cancel",
      confirmButtonColor: "var(--accent)",
      cancelButtonColor: "var(--bg-surface-alt)",
      reverseButtons: true,
      focusCancel: true,
      customClass: { popup: "swal-vector-popup" },
    });

    if (result.isConfirmed) {
      onLogout?.();
    }
  };

  return (
    <>
      <div className={`nav-backdrop ${open ? "open" : ""}`} onClick={onClose} />

      <aside className={`sidebar ${open ? "open" : "collapsed"}`}>
        <div className="brand">
          <div className="brand-mark">
            <img src="/images/vector.png" alt="Vector Logo" className="logo-image" />
          </div>
          <div className="brand-text">
            <b>Vector</b>
            <span>Production &amp; Sales Control</span>
          </div>
        </div>

        <nav aria-label="Primary navigation">
        <ul className="nav-list">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <li key={t.id}>
                <button
                  className={`nav-item ${active === t.id ? "active" : ""}`}
                  onClick={() => {
                    onSelect?.(t.id);
                    navigate(t.path);
                  }}
                >
                  {Icon && <Icon size={16} />}
                  {t.label}
                </button>
              </li>
            );
          })}
        </ul>
        </nav>

        <div className="sidebar-bottom">
          <button
            type="button"
            className="collapse-toggle"
            onClick={onToggle}
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
            title={open ? "Collapse sidebar" : "Expand sidebar"}
          >
            {open ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
          </button>

          <button
            className="change-password-btn"
            onClick={onChangePassword}
          >
            <KeyRound size={15} /> Change Password
          </button>

          <button
            className="theme-toggle"
            onClick={toggleTheme}
            role="switch"
            aria-checked={isDark}
            aria-label="Toggle dark mode"
          >
            <span className="theme-toggle-option">
              <Sun size={14} />
              Light
            </span>
            <span className="theme-toggle-track">
              <span className={`theme-toggle-thumb ${isDark ? "is-dark" : ""}`} />
            </span>
            <span className="theme-toggle-option">
              <Moon size={14} />
              Dark
            </span>
          </button>

          <button className="logout-btn" onClick={handleLogoutClick}>
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}
