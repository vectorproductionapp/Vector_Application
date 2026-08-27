import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/Auth";

/**
 * Wrap any route element with this to enforce login + role.
 *
 *   <Route path="/models" element={
 *     <ProtectedRoute allowedRoles={["admin", "coadmin"]}>
 *       <BOQ />
 *     </ProtectedRoute>
 *   } />
 *
 * - Not logged in            -> redirect to /login
 * - Logged in, wrong role    -> redirect to /unauthorized
 * - Logged in, role allowed  -> renders children
 */
export default function ProtectedRoute({ allowedRoles, redirectTo = "/login", children }) {
  const { isAuthenticated, role } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to={redirectTo} replace state={{ from: location }} />;
  }

  if (allowedRoles && !allowedRoles.includes(role)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return children;
}
