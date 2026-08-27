// import React, { useState } from "react";
// import "./CreateEntityModal.css";

// export default function CreateEntityModal({ title, namePlaceholder, onClose, onCreate }) {
//   const [name, setName] = useState("");
//   const [timing, setTiming] = useState("");

//   const canSubmit = name.trim().length > 0;

//   const handleSubmit = (e) => {
//     e.preventDefault();
//     if (!canSubmit) return;
//     onCreate({ name: name.trim(), timing });
//     onClose();
//   };

//   return (
//     <div className="modal-overlay" onClick={onClose}>
//       <div className="modal-card" onClick={(e) => e.stopPropagation()}>
//         <h3 className="modal-title">{title}</h3>

//         <form onSubmit={handleSubmit}>
//           <label className="modal-label">
//             Name
//             <input
//               type="text"
//               className="modal-input"
//               placeholder={namePlaceholder}
//               value={name}
//               onChange={(e) => setName(e.target.value)}
//               autoFocus
//             />
//           </label>

//           <label className="modal-label">
//             Timing
//             <input
//               type="datetime-local"
//               className="modal-input"
//               value={timing}
//               onChange={(e) => setTiming(e.target.value)}
//             />
//           </label>

//           <div className="modal-actions">
//             <button type="button" className="modal-btn-cancel" onClick={onClose}>
//               Cancel
//             </button>
//             <button type="submit" className="modal-btn-submit" disabled={!canSubmit}>
//               Create
//             </button>
//           </div>
//         </form>
//       </div>
//     </div>
//   );
// }


import React, { useState } from "react";
import { createPortal } from "react-dom";
import DateTimePicker from "./DateTimePicker";
import { SearchableSelect } from "./SearchBar";
import "./CreateEntityModal.css";

const CREATE_NEW_ITEM_CODE = "__create_new_item_code__";

export default function CreateEntityModal({
  title,
  namePlaceholder,
  onClose,
  onCreate,
  showTiming = true,
  itemCodeOptions,
  itemCode,
  onItemCodeChange,
  onCreateNewItemCode,
  itemCodesLoading = false,
}) {
  const [name, setName] = useState("");
  const [timing, setTiming] = useState("");

  const canSubmit = name.trim().length > 0 && (!itemCodeOptions || Boolean(itemCode));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    const result = await onCreate({ name: name.trim(), timing, itemCode });
    if (result !== false) {
      onClose();
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>

        <form onSubmit={handleSubmit}>
          <label className="modal-label">
            Name
            <input
              type="text"
              className="modal-input"
              placeholder={namePlaceholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>

          {showTiming && (
            <label className="modal-label">
              Timing
              <DateTimePicker value={timing} onChange={setTiming} />
            </label>
          )}

          {itemCodeOptions && (
            <label className="modal-label">
              Item Code
              <SearchableSelect
                options={itemCodeOptions}
                value={itemCode}
                onChange={(value) => {
                  if (value === CREATE_NEW_ITEM_CODE) {
                    onCreateNewItemCode?.();
                  } else {
                    onItemCodeChange?.(value);
                  }
                }}
                loading={itemCodesLoading}
                placeholder="Select Item Code"
                emptyMessage="No existing Item Codes"
                actionOption={{
                  value: CREATE_NEW_ITEM_CODE,
                  label: "+ Create New Item Code",
                }}
              />
            </label>
          )}

          <div className="modal-actions">
            <button type="button" className="modal-btn-cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="modal-btn-submit" disabled={!canSubmit}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
