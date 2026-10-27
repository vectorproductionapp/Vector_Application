import Swal from "sweetalert2";

/**
 * The app's "are you sure?" dialog for removing something.
 *
 * Styled like the other confirmations (swal-vector-popup) and focused on
 * Cancel, so a stray Enter never removes anything. Resolves to true only when
 * the user confirms.
 */
export default async function confirmRemove({ title, text, confirmText = "Yes, remove" }) {
  const result = await Swal.fire({
    title,
    text,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: "Cancel",
    confirmButtonColor: "var(--accent)",
    cancelButtonColor: "var(--bg-surface-alt)",
    reverseButtons: true,
    focusCancel: true,
    customClass: { popup: "swal-vector-popup" },
  });
  return Boolean(result.isConfirmed);
}
