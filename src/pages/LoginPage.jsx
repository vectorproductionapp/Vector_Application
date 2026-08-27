import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import Swal from "sweetalert2";

import {
  Mail,
  Lock,
  Eye,
  EyeOff,
} from "lucide-react";

import { useAuth } from "../context/Auth";

import "./AdminLogin.css";

const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "";

// ---- Themed SweetAlert2 helpers (brand colors, consistent with the rest of the app) ----
const swalSuccess = (title, text) =>
  Swal.fire({
    icon: "success",
    title,
    text,
    timer: 1500,
    showConfirmButton: false,
    customClass: { popup: "swal-vector-popup" },
  });

const swalError = (title, text) =>
  Swal.fire({
    icon: "error",
    title,
    text,
    confirmButtonColor: "var(--accent)",
    customClass: { popup: "swal-vector-popup" },
  });

function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    setSubmitting(true);

    try {
      const response = await axios.post(`${API_BASE_URL}/login`, {
        email,
        password,
      });

      if (response.data.success) {
        login({
          token: response.data.token,
          role: response.data.role || "user",
          name: response.data.name,
          email,
          userId: response.data.userId,
        });
        await swalSuccess("Welcome", `Hello ${response.data.name}`);
        navigate("/dashboard");
      } else {
        // Covers a 200 response that still reports failure (e.g. wrong
        // credentials returned as { success: false, message: "..." }
        // instead of a non-2xx status).
        await swalError(
          "Login Failed",
          response.data.message || "Unable to login. Please try again."
        );
      }
    } catch (err) {
      await swalError(
        "Login Failed",
        err.response?.data?.message || "Unable to login. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="admin-login-page">
      <div className="admin-bg-grid" />
      <div className="admin-bg-glow glow1" />
      <div className="admin-bg-glow glow2" />

      <section className="admin-login-card common-login-card">
        <img
          className="common-login-logo"
          src="/images/vector-pdf.png"
          alt="Vector"
        />

        <div className="admin-login-header">
          <h1>Welcome</h1>
        </div>

        <form className="admin-login-form" onSubmit={handleSubmit}>
          <div className="admin-field">
            <label>Email Address</label>
            <div className="admin-input-wrap">
              <Mail size={17} className="admin-input-icon" />
              <input
                type="email"
                placeholder="name@company.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="admin-field">
            <label>Password</label>
            <div className="admin-input-wrap">
              <Lock size={17} className="admin-input-icon" />
              <input
                type={showPassword ? "text" : "password"}
                placeholder="Enter password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="admin-password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <EyeOff size={17} />
                ) : (
                  <Eye size={17} />
                )}
              </button>
            </div>
          </div>

          <div className="common-login-actions">
            <Link to="/forgot-password" className="common-login-link">
              Forgot Password?
            </Link>
          </div>

          <button
            type="submit"
            className="admin-login-button"
            disabled={submitting}
          >
            {submitting ? "Signing In..." : "Sign In"}
          </button>
        </form>

        <p className="common-login-footer-text">
          Don't have an account?{" "}
          <Link to="/register" className="common-login-link">
            Sign Up
          </Link>
        </p>
      </section>
    </main>
  );
}

export default LoginPage;
