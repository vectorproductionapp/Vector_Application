import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import Swal from "sweetalert2";
import {
  UserPlus,
  Mail,
  Lock,
  User as UserIcon,
  Eye,
  EyeOff,
  Users,
  Trash2,
  Pencil,
  X,
} from "lucide-react";
import api from "../components/Api";
import PageFilter, { matchesPageFilter } from "../components/PageFilter";
import { useAuth } from "../context/Auth";

import "./AdminCreateUser.css";

const ROLE_OPTIONS = [
  { value: "user", label: "User" },
  { value: "production_incharge", label: "Production In-charge" },
  { value: "coadmin", label: "Co-Admin" },
  { value: "admin", label: "Admin" },
];

const ROLE_BADGE = {
  user: "role-user",
  production_incharge: "role-production-incharge",
  coadmin: "role-coadmin",
  admin: "role-admin",
};
const USER_FILTER_FIELDS = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  {
    key: "role",
    label: "Role",
    getValue: (user) => ROLE_OPTIONS.find((option) => option.value === user.role)?.label || user.role,
  },
];

const swalSuccess = (title, text) =>
  Swal.fire({
    icon: "success",
    title,
    text,
    timer: 1800,
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

const swalConfirm = (title, text) =>
  Swal.fire({
    icon: "warning",
    title,
    text,
    showCancelButton: true,
    confirmButtonColor: "var(--accent)",
    cancelButtonColor: "var(--bg-surface-alt)",
    confirmButtonText: "Yes, delete",
    cancelButtonText: "Cancel",
    customClass: { popup: "swal-vector-popup" },
  });

function AdminCreateUser() {
  const { email: currentUserEmail } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [pageFilter, setPageFilter] = useState({ field: "", value: "" });

  const [form, setForm] = useState({ name: "", email: "", password: "", confirmPassword: "", role: "user" });
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [accountForm, setAccountForm] = useState({ role: "user" });
  const initialAccountFormRef = useRef({ role: "user" });
  const [savingAccount, setSavingAccount] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await api.get("/admin/users");
      if (res.data.success) setUsers(res.data.users);
    } catch {
      /* silently fail  table just stays empty */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const setRole = (role) => setForm((f) => ({ ...f, role }));

  const resetForm = () => {
    setForm({ name: "", email: "", password: "", confirmPassword: "", role: "user" });
    setShowPassword(false);
  };

  const openModal = () => {
    resetForm();
    setShowModal(true);
  };

  const closeModal = () => {
    if (!submitting) setShowModal(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (form.password !== form.confirmPassword) {
      await swalError("Passwords don't match", "Please make sure both passwords are identical.");
      return;
    }

    setSubmitting(true);

    try {
      const response = await api.post("/admin/create-user", form);

      if (response.data.success) {
        await swalSuccess("Account created", response.data.message);
        setShowModal(false);
        fetchUsers();
      } else {
        await swalError("Couldn't create account", response.data.message);
      }
    } catch (err) {
      await swalError(
        "Couldn't create account",
        err.response?.data?.message || "Something went wrong. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (user) => {
    const result = await swalConfirm(
      "Delete user?",
      `This will permanently remove ${user.name || user.email}.`
    );
    if (!result.isConfirmed) return;

    try {
      const res = await api.delete(`/admin/users/${user.id}`);
      if (res.data.success) {
        await swalSuccess("Deleted", res.data.message);
        fetchUsers();
      } else {
        await swalError("Couldn't delete", res.data.message);
      }
    } catch (err) {
      await swalError(
        "Couldn't delete",
        err.response?.data?.message || "Something went wrong."
      );
    }
  };

  const openAccountEditor = (user) => {
    setEditingUser(user);
    const initialValues = { role: user.role || "user" };
    initialAccountFormRef.current = initialValues;
    setAccountForm(initialValues);
  };

  const requestCloseAccountEditor = async () => {
    if (savingAccount) return;
    if (JSON.stringify(accountForm) !== JSON.stringify(initialAccountFormRef.current)) {
      const result = await Swal.fire({
        title: "Discard unsaved changes?",
        text: "Your account changes will be lost unless you save them.",
        icon: "warning",
        showCancelButton: true,
        confirmButtonText: "Discard changes",
        cancelButtonText: "Keep editing",
        confirmButtonColor: "var(--accent)",
        cancelButtonColor: "var(--bg-surface-alt)",
        reverseButtons: true,
        focusCancel: true,
        customClass: { popup: "swal-vector-popup" },
      });
      if (!result.isConfirmed) return;
    }
    setEditingUser(null);
  };

  const saveAccount = async (event) => {
    event.preventDefault();
    setSavingAccount(true);
    try {
      const res = await api.patch(`/admin/users/${editingUser.id}/account`, {
        role: accountForm.role,
      });
      if (!res.data.success) throw new Error(res.data.message);
      await swalSuccess("Account updated", `${editingUser.name || editingUser.email} has been updated.`);
      setEditingUser(null);
      fetchUsers();
    } catch (err) {
      await swalError("Update failed", err.response?.data?.message || err.message || "Please try again.");
    } finally {
      setSavingAccount(false);
    }
  };

  const filteredUsers = users.filter((user) => matchesPageFilter(user, pageFilter, USER_FILTER_FIELDS));

  return (
    <div className="acu-page">
      {/* â”€â”€ Header bar â”€â”€ */}
      <div className="acu-top">
        <div className="acu-top-left">
          <Users size={20} />
          <div>
            <h2>Manage Users</h2>
            <p>{users.length} account{users.length !== 1 && "s"} registered</p>
          </div>
        </div>
        <div className="acu-top-actions">
          <PageFilter rows={users} fields={USER_FILTER_FIELDS} value={pageFilter} onChange={setPageFilter} />
          <button className="acu-create-btn" onClick={openModal}>
            <UserPlus size={16} />
            Create User
          </button>
        </div>
      </div>

      {/* â”€â”€ Users table â”€â”€ */}
      <div className="acu-table-wrap">
        {loading ? (
          <div className="acu-loading">
            <div className="acu-spinner" />
            Loading users...
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="acu-empty">
            <Users size={36} />
            <p>No users found</p>
          </div>
        ) : (
          <table className="acu-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th className="acu-th-action"></th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id}>
                  <td className="acu-td-name">
                    <div className="acu-user-identity">
                      <div className="acu-avatar">{(u.name || u.email || "?")[0].toUpperCase()}</div>
                      <span>{u.name || ""}</span>
                    </div>
                  </td>
                  <td className="acu-td-email">{u.email}</td>
                  <td>
                    <span className={`acu-role-badge ${ROLE_BADGE[u.role] || ""}`}>
                      {ROLE_OPTIONS.find((option) => option.value === u.role)?.label || u.role}
                    </span>
                  </td>
                  <td className="acu-td-action">
                    {u.email?.toLowerCase() !== currentUserEmail?.toLowerCase() && (
                      <div className="acu-row-actions">
                        <button className="acu-delete-btn" onClick={() => openAccountEditor(u)} title="Edit role or password" aria-label={`Edit ${u.name || u.email || "user"}`}><Pencil size={14} /></button>
                        <button className="acu-delete-btn" onClick={() => handleDelete(u)} title="Delete user" aria-label={`Delete ${u.name || u.email || "user"}`}><Trash2 size={14} /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* â”€â”€ Create user modal â”€â”€ */}
      {showModal && createPortal(
        <div className="acu-overlay" onClick={closeModal}>
          <div className="acu-modal" onClick={(e) => e.stopPropagation()}>
            <div className="acu-modal-header">
              <div className="acu-modal-title">
                <UserPlus size={18} />
                Create Account
              </div>
              <button className="acu-modal-close" onClick={closeModal}>
                <X size={18} />
              </button>
            </div>

            <form className="acu-form" onSubmit={handleSubmit}>
              <div className="acu-field">
                <label>Full Name</label>
                <div className="acu-input-wrap">
                  <UserIcon size={16} className="acu-input-icon" />
                  <input
                    type="text"
                    placeholder="Jane Doe"
                    value={form.name}
                    onChange={update("name")}
                    required
                  />
                </div>
              </div>

              <div className="acu-field">
                <label>Email Address</label>
                <div className="acu-input-wrap">
                  <Mail size={16} className="acu-input-icon" />
                  <input
                    type="email"
                    placeholder="name@company.com"
                    value={form.email}
                    onChange={update("email")}
                    required
                  />
                </div>
              </div>

              <div className="acu-field">
                <label>Password</label>
                <div className="acu-input-wrap">
                  <Lock size={16} className="acu-input-icon" />
                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="At least 8 characters"
                    value={form.password}
                    onChange={update("password")}
                    minLength={8}
                    required
                  />
                  <button
                    type="button"
                    className="acu-input-toggle"
                    onClick={() => setShowPassword((s) => !s)}
                    tabIndex={-1}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <span className="acu-hint">Use a secure password of at least 8 characters.</span>
              </div>

              <div className="acu-field">
                <label>Confirm Password</label>
                <div className="acu-input-wrap">
                  <Lock size={16} className="acu-input-icon" />
                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="Re-enter password"
                    value={form.confirmPassword}
                    onChange={update("confirmPassword")}
                    minLength={8}
                    required
                  />
                </div>
              </div>

              <div className="acu-field">
                <label>Role</label>
                <div className="acu-role-group" role="radiogroup" aria-label="Role">
                  {ROLE_OPTIONS.map((r) => (
                    <button
                      type="button"
                      key={r.value}
                      role="radio"
                      aria-checked={form.role === r.value}
                      className={`acu-role-pill${form.role === r.value ? " active" : ""}`}
                      onClick={() => setRole(r.value)}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="acu-modal-actions">
                <button type="button" className="acu-cancel-btn" onClick={closeModal}>
                  Cancel
                </button>
                <button type="submit" className="acu-submit" disabled={submitting}>
                  {submitting ? "Creating..." : "Register User"}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {editingUser && createPortal(
        <div className="acu-overlay" onClick={requestCloseAccountEditor}>
          <div className="acu-modal" onClick={(event) => event.stopPropagation()}>
            <div className="acu-modal-header"><div className="acu-modal-title"><Pencil size={18} /> Edit Account</div><button className="acu-modal-close" onClick={requestCloseAccountEditor}><X size={18} /></button></div>
            <form className="acu-form" onSubmit={saveAccount}>
              <p className="acu-hint">Updating the role for {editingUser.name || editingUser.email}.</p>
              <div className="acu-field"><label>Role</label><select value={accountForm.role} onChange={(event) => setAccountForm((form) => ({ ...form, role: event.target.value }))}>{ROLE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></div>
              <div className="acu-modal-actions"><button type="button" className="acu-cancel-btn" onClick={requestCloseAccountEditor}>Cancel</button><button type="submit" className="acu-submit" disabled={savingAccount}>{savingAccount ? "Saving..." : "Save Changes"}</button></div>
            </form>
          </div>
        </div>, document.body
      )}
    </div>
  );
}

export default AdminCreateUser;
