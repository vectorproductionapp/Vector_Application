import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import Swal from "sweetalert2";

import {
  Mail,
  Lock,
  User,
  Eye,
  EyeOff,
  Briefcase,
  Check,
  X,
  Shield,
} from "lucide-react";

import "./SignupPage.css";

const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "";

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

const ROLES = [
  { value: "user", label: "User", desc: "Standard access" },
  { value: "production_incharge", label: "Production Incharge", desc: "Production oversight" },
  { value: "coadmin", label: "Co-Admin", desc: "Elevated privileges" },
  { value: "admin", label: "Admin", desc: "Full system access" },
];

const PASSWORD_RULES = [
  { id: "length", test: (p) => p.length >= 8, label: "At least 8 characters" },
  { id: "upper", test: (p) => /[A-Z]/.test(p), label: "One uppercase letter" },
  { id: "lower", test: (p) => /[a-z]/.test(p), label: "One lowercase letter" },
  { id: "number", test: (p) => /[0-9]/.test(p), label: "One number" },
];

function SignupPage() {
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [role, setRole] = useState("user");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState({});

  const passwordChecks = useMemo(
    () => PASSWORD_RULES.map((r) => ({ ...r, pass: r.test(password) })),
    [password]
  );

  const passwordStrength = useMemo(() => {
    const passed = passwordChecks.filter((c) => c.pass).length;
    if (passed <= 1) return { level: "weak", label: "Weak", color: "#ef4444", width: "25%" };
    if (passed === 2) return { level: "fair", label: "Fair", color: "#f59e0b", width: "50%" };
    if (passed === 3) return { level: "good", label: "Good", color: "#3b82f6", width: "75%" };
    return { level: "strong", label: "Strong", color: "#22c55e", width: "100%" };
  }, [passwordChecks]);

  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  const handleBlur = (field) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      Swal.fire({
        icon: "error",
        title: "Password Mismatch",
        text: "Passwords do not match.",
        customClass: { popup: "swal-vector-popup" },
      });
      return;
    }

    setSubmitting(true);

    try {
      const response = await axios.post(`${API_BASE_URL}/signup`, {
        name,
        email,
        password,
        role,
      });

      if (response.data.success) {
        await swalSuccess("Account Created", "You can now sign in.");
        navigate("/login");
      }
    } catch (err) {
      swalError(
        "Signup Failed",
        err.response?.data?.message ||
          "Unable to create account. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="signup-page">
      <div className="signup-bg-grid" />
      <div className="signup-bg-glow glow-a" />
      <div className="signup-bg-glow glow-b" />

      <section className="signup-card">
        <img
          className="signup-logo"
          src="/images/vector-pdf.png"
          alt="Vector"
        />

        <div className="signup-header">
          <h1>Create Account</h1>
          <p>Join the Vector production portal</p>
        </div>

        <form className="signup-form" onSubmit={handleSubmit}>
          {/* NAME */}
          <div className={`signup-field ${touched.name && !name ? "has-error" : ""}`}>
            <label>Full Name</label>
            <div className="signup-input-wrap">
              <User size={17} className="signup-input-icon" />
              <input
                type="text"
                placeholder="John Doe"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => handleBlur("name")}
                required
              />
            </div>
            {touched.name && !name && (
              <span className="signup-field-error">Name is required</span>
            )}
          </div>

          {/* EMAIL */}
          <div className={`signup-field ${touched.email && !email ? "has-error" : ""}`}>
            <label>Email Address</label>
            <div className="signup-input-wrap">
              <Mail size={17} className="signup-input-icon" />
              <input
                type="email"
                placeholder="name@company.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => handleBlur("email")}
                required
              />
            </div>
            {touched.email && !email && (
              <span className="signup-field-error">Valid email is required</span>
            )}
          </div>

          {/* ROLE */}
          <div className="signup-field">
            <label>Register as</label>
            <div className="signup-input-wrap">
              <Briefcase size={17} className="signup-input-icon" />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="signup-role-select"
                required
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <span className="signup-role-hint">
              {ROLES.find((r) => r.value === role)?.desc}
            </span>
          </div>

          {/* PASSWORD */}
          <div className="signup-field">
            <label>Password</label>
            <div className="signup-input-wrap">
              <Lock size={17} className="signup-input-icon" />
              <input
                type={showPassword ? "text" : "password"}
                placeholder="Create a strong password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="signup-password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>

            {password.length > 0 && (
              <div className="signup-strength">
                <div className="signup-strength-bar">
                  <div
                    className="signup-strength-fill"
                    style={{
                      width: passwordStrength.width,
                      backgroundColor: passwordStrength.color,
                    }}
                  />
                </div>
                <span
                  className="signup-strength-label"
                  style={{ color: passwordStrength.color }}
                >
                  {passwordStrength.label}
                </span>
              </div>
            )}

            {password.length > 0 && (
              <div className="signup-rules">
                {passwordChecks.map((rule) => (
                  <div
                    key={rule.id}
                    className={`signup-rule ${rule.pass ? "pass" : ""}`}
                  >
                    {rule.pass ? (
                      <Check size={13} className="rule-icon" />
                    ) : (
                      <X size={13} className="rule-icon" />
                    )}
                    <span>{rule.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* CONFIRM PASSWORD */}
          <div
            className={`signup-field ${
              passwordsMismatch ? "has-error" : passwordsMatch ? "has-success" : ""
            }`}
          >
            <label>Confirm Password</label>
            <div className="signup-input-wrap">
              <Lock size={17} className="signup-input-icon" />
              <input
                type={showPassword ? "text" : "password"}
                placeholder="Re-enter password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
              {passwordsMatch && <Check size={17} className="signup-success-icon" />}
              {passwordsMismatch && <X size={17} className="signup-error-icon" />}
            </div>
            {passwordsMismatch && (
              <span className="signup-field-error">Passwords do not match</span>
            )}
          </div>

          <button
            type="submit"
            className="signup-button"
            disabled={submitting}
          >
            {submitting ? (
              <span className="signup-button-loading">
                <span className="signup-spinner" />
                Creating Account...
              </span>
            ) : (
              <>
                <Shield size={17} />
                Create Account
              </>
            )}
          </button>
        </form>

        <div className="signup-divider">
          <span>or</span>
        </div>

        <p className="signup-footer">
          Already have an account?{" "}
          <Link to="/login" className="signup-link">
            Sign In
          </Link>
        </p>

        <p className="signup-terms">
          By signing up, you agree to our Terms of Service and Privacy Policy.
        </p>
      </section>
    </main>
  );
}

export default SignupPage;
