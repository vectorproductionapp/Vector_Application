import React from "react";
import "./PipelineRail.css";

export default function PipelineRail({ stages }) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="rail">
      {stages.map((s, i) => (
        <React.Fragment key={s.label}>
          <div className="rail-node">
            <div className="rail-dot">
              {s.value}
            </div>
            <span className="rail-label">{s.label}</span>
            <div className="rail-bar-track">
              <div
                className="rail-bar-fill"
                style={{
                  width: `${Math.max(6, (s.value / max) * 100)}%`,
                }}
              />
            </div>
          </div>
          {i < stages.length - 1 && <div className="rail-connector" />}
        </React.Fragment>
      ))}
    </div>
  );
}
