import React, { createContext, useContext, useEffect, useState } from "react";

const AuthContext = createContext(null);

const STORAGE_KEY = "vector_auth";

function readStoredAuth() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(readStoredAuth);

  useEffect(() => {
    if (auth) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }, [auth]);

  const login = ({ token, role, name, email, userId }) => {
    setAuth({ token, role, name, email, userId });
  };

  const logout = () => {
    setAuth(null);
  };

  const value = {
    token: auth?.token || null,
    role: auth?.role || null,
    name: auth?.name || "",
    email: auth?.email || "",
    userId: auth?.userId || "",
    isAuthenticated: !!auth?.token,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

export default AuthContext;
