import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import Swal from "sweetalert2";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
} from "lucide-react";

import "./AdminLogin.css";


const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";

const errorMessage = (error, fallback) =>
  error.response?.data?.message || error.message || fallback;

function ForgotPassword() {
  const navigate = useNavigate();
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [resendSeconds, setResendSeconds] = useState(0);

  useEffect(() => {
    if (resendSeconds <= 0) return undefined;
    const timer = window.setInterval(() => {
      setResendSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  const requestOtp = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    setSubmitting(true);
    setError("");
    setMessage("");

    try {
      const response = await axios.post(`${API_BASE_URL}/forgot-password/request`, {
        email: normalizedEmail,
      });
      setEmail(normalizedEmail);
      setMessage(response.data.message);
      setResendSeconds(response.data.retryAfter || 60);
      setStep("otp");
    } catch (requestError) {
      const retryAfter = requestError.response?.data?.retryAfter;
      if (retryAfter) {
        setEmail(normalizedEmail);
        setResendSeconds(retryAfter);
        setStep("otp");
      }
      const requestMessage = errorMessage(
        requestError,
        "Unable to send the verification code."
      );
      if (requestError.response?.status === 404) {
        await Swal.fire({
          icon: "warning",
          title: "Email Not Found",
          text: requestMessage,
          confirmButtonColor: "var(--accent)",
          customClass: { popup: "swal-vector-popup" },
        });
      } else {
        setError(requestMessage);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleEmailSubmit = async (event) => {
    event.preventDefault();
    await requestOtp();
  };

  const handleOtpSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const response = await axios.post(`${API_BASE_URL}/forgot-password/verify`, {
        email,
        otp,
      });
      setResetToken(response.data.resetToken);
      setMessage("Code verified. Create your new password.");
      setStep("password");
    } catch (verifyError) {
      setError(errorMessage(verifyError, "The verification code is invalid."));
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasswordSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/forgot-password/reset`, {
        email,
        resetToken,
        newPassword,
      });
      await Swal.fire({
        icon: "success",
        title: "Password Changed",
        text: response.data.message,
        confirmButtonColor: "var(--accent)",
        customClass: { popup: "swal-vector-popup" },
      });
      navigate("/login", { replace: true });
    } catch (resetError) {
      setError(errorMessage(resetError, "Unable to change the password."));
    } finally {
      setSubmitting(false);
    }
  };

  const useDifferentEmail = () => {
    setStep("email");
    setOtp("");
    setResetToken("");
    setMessage("");
    setError("");
  };

  return (
    <main className="admin-login-page">
      <div className="admin-bg-grid" />
      <div className="admin-bg-glow glow1" />
      <div className="admin-bg-glow glow2" />

      <section className="admin-login-card common-login-card recovery-card">
        <img
          className="common-login-logo"
          src="/images/vector-pdf.png"
          alt="Vector"
        />

        <div className="admin-login-header recovery-header">
          <h1>
            {step === "email" && "Forgot Password"}
            {step === "otp" && "Verify OTP"}
            {step === "password" && "Create New Password"}
          </h1>
          <p className="recovery-subtitle">
            {step === "email" && "Enter your registered email to receive a verification code."}
            {step === "otp" && `Enter the six-digit code sent to ${email}.`}
            {step === "password" && "Use at least 8 characters for your new password."}
          </p>
        </div>

        {message && <div className="recovery-message" role="status">{message}</div>}
        {error && <div className="recovery-error" role="alert">{error}</div>}

        {step === "email" && (
          <form className="admin-login-form" onSubmit={handleEmailSubmit}>
            <div className="admin-field">
              <label>Email Address</label>
              <div className="admin-input-wrap">
                <Mail size={17} className="admin-input-icon" />
                <input
                  type="email"
                  placeholder="name@company.com"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoFocus
                />
              </div>
            </div>

            <button type="submit" className="admin-login-button" disabled={submitting}>
              {submitting ? "Sending Code..." : "Send OTP"}
            </button>
          </form>
        )}

        {step === "otp" && (
          <form className="admin-login-form" onSubmit={handleOtpSubmit}>
            <div className="admin-field">
              <label>Verification Code</label>
              <div className="admin-input-wrap">
                <KeyRound size={17} className="admin-input-icon" />
                <input
                  className="recovery-otp-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
                  required
                  autoFocus
                />
              </div>
            </div>

            <button type="submit" className="admin-login-button" disabled={submitting || otp.length !== 6}>
              {submitting ? "Verifying..." : "Verify OTP"}
            </button>

            <div className="recovery-secondary-actions">
              <button type="button" className="admin-inline-link" onClick={useDifferentEmail}>
                Change email
              </button>
              <button
                type="button"
                className="admin-inline-link"
                onClick={requestOtp}
                disabled={submitting || resendSeconds > 0}
              >
                {resendSeconds > 0 ? `Resend in ${resendSeconds}s` : "Resend OTP"}
              </button>
            </div>
          </form>
        )}

        {step === "password" && (
          <form className="admin-login-form" onSubmit={handlePasswordSubmit}>
            <div className="admin-field">
              <label>New Password</label>
              <div className="admin-input-wrap">
                <Lock size={17} className="admin-input-icon" />
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter new password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={72}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  autoFocus
                />
                <button
                  type="button"
                  className="admin-password-toggle"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Hide passwords" : "Show passwords"}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>

            <div className="admin-field">
              <label>Confirm New Password</label>
              <div className="admin-input-wrap">
                <Lock size={17} className="admin-input-icon" />
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Re-enter new password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={72}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                />
              </div>
            </div>

            <button type="submit" className="admin-login-button" disabled={submitting}>
              {submitting ? "Changing Password..." : "Change Password"}
            </button>
          </form>
        )}

        <Link to="/login" className="recovery-back-link">
          <ArrowLeft size={15} />
          Back to Sign In
        </Link>
      </section>
    </main>
  );
}

export default ForgotPassword;
