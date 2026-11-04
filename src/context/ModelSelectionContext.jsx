import React, { createContext, useContext, useMemo, useState } from "react";

const ModelSelectionContext = createContext(null);

export function ModelSelectionProvider({ children }) {
  const [selectedModel, setSelectedModel] = useState("");
  const value = useMemo(() => ({ selectedModel, setSelectedModel }), [selectedModel]);

  return (
    <ModelSelectionContext.Provider value={value}>
      {children}
    </ModelSelectionContext.Provider>
  );
}

export function useModelSelection() {
  const context = useContext(ModelSelectionContext);
  if (!context) {
    throw new Error("useModelSelection must be used within ModelSelectionProvider.");
  }
  return context;
}
