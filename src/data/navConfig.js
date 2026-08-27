import {
  LayoutDashboard,
  ClipboardList,
  FileText,
  Receipt,
  Boxes,
  Factory,
  ShoppingCart,
  AlertTriangle,
  UserPlus,
} from "lucide-react";

/**
 * Single list describing every tab. Add a page here + create the
 * matching file in /pages to add a new tab — Sidebar and App both
 * read from this file so they never fall out of sync.
 *
 * `roles`: which roles can see this tab in the sidebar AND are allowed
 * to hit the route directly (enforced by ProtectedRoute in App.jsx).
 * Adjust per page as needed.
 */
const navConfig = [
  { id: "dashboard", label: "Dashboard", path: "/dashboard", icon: LayoutDashboard, roles: ["admin", "coadmin", "production_incharge", "user"] },
  { id: "boq", label: "Models", path: "/models", icon: ClipboardList, roles: ["admin", "coadmin"] },
  { id: "po", label: "PO Details", path: "/po", icon: FileText, roles: ["admin", "coadmin"] },
  { id: "invoices", label: "Invoices", path: "/invoices", icon: Receipt, roles: ["admin", "coadmin", "production_incharge"] },
  { id: "stock", label: "Stock Register", path: "/stock", icon: Boxes, roles: ["admin", "coadmin", "production_incharge"] },
  { id: "production", label: "Daily Production", path: "/production", icon: Factory, roles: ["admin", "coadmin", "production_incharge", "user"] },
  { id: "sales", label: "Sale Register", path: "/sales", icon: ShoppingCart, roles: ["admin", "coadmin", "production_incharge"] },
  { id: "defects", label: "Defective Units", path: "/defects", icon: AlertTriangle, roles: ["admin", "coadmin", "production_incharge"] },
  { id: "create-user", label: "Create Account", path: "/admin/create-user", icon: UserPlus, roles: ["admin"] },
];

export default navConfig;
