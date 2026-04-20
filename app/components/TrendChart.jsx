const fontStack =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export default function TrendChart({ title, subtitle, data, emptyText, onPointClick, activeLabel }) {
  const chartCardStyle = {
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: "14px",
    overflow: "hidden",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
  };

  const chartHeaderStyle = {
    padding: "14px 16px 10px 16px",
    borderBottom: "1px solid #e7edf5",
    background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)",
  };

  const chartTitleStyle = {
    margin: 0,
    fontSize: "14px",
    lineHeight: 1.2,
    fontWeight: 700,
    color: "#0f172a",
    fontFamily: fontStack,
  };

  const chartSubtitleStyle = {
    marginTop: "4px",
    marginBottom: 0,
    fontSize: "12px",
    lineHeight: 1.4,
    color: "#667085",
    fontFamily: fontStack,
    fontWeight: 400,
  };

  const chartBodyStyle = {
    padding: "14px 16px 16px 16px",
  };

  const emptyStateStyle = {
    color: "#5b677a",
    fontSize: "12px",
    fontFamily: fontStack,
    fontWeight: 400,
  };

  if (!data.length) {
    return (
      <div style={chartCardStyle}>
        <div style={chartHeaderStyle}>
          <h3 style={chartTitleStyle}>{title}</h3>
          <p style={chartSubtitleStyle}>{subtitle}</p>
        </div>
        <div style={chartBodyStyle}>
          <div style={emptyStateStyle}>{emptyText}</div>
        </div>
      </div>
    );
  }

  const width = 680;
  const height = 260;
  const padding = { top: 20, right: 18, bottom: 38, left: 18 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...data.map((item) => Number(item.value || 0)), 1);

  const points = data.map((item, index) => {
    const x =
      data.length === 1
        ? padding.left + innerWidth / 2
        : padding.left + (index / (data.length - 1)) * innerWidth;
    const y =
      padding.top + innerHeight - (Number(item.value || 0) / maxValue) * innerHeight;

    return { ...item, x, y };
  });

  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");

  return (
    <div style={chartCardStyle}>
      <div style={chartHeaderStyle}>
        <h3 style={chartTitleStyle}>{title}</h3>
        <p style={chartSubtitleStyle}>{subtitle}</p>
      </div>

      <div style={chartBodyStyle}>
        <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }}>
          <line
            x1={padding.left}
            y1={height - padding.bottom}
            x2={width - padding.right}
            y2={height - padding.bottom}
            stroke="#d7dfeb"
            strokeWidth="1"
          />

          <path d={path} fill="none" stroke="#3b82f6" strokeWidth="3" strokeLinecap="round" />

          {points.map((point) => {
            const isActive = activeLabel === point.label;
            return (
              <g
                key={`${point.label}-${point.value}`}
                onClick={onPointClick ? () => onPointClick(point) : undefined}
                style={onPointClick ? { cursor: "pointer" } : undefined}
              >
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={isActive ? "6" : "4"}
                  fill="#ffffff"
                  stroke={isActive ? "#1d4ed8" : "#2563eb"}
                  strokeWidth={isActive ? "3" : "2"}
                />
                <text
                  x={point.x}
                  y={height - 14}
                  textAnchor="middle"
                  fontSize="11"
                  fill={isActive ? "#1d4ed8" : "#667085"}
                  fontFamily={fontStack}
                  fontWeight={isActive ? "700" : "400"}
                >
                  {point.label}
                </text>
                <text
                  x={point.x}
                  y={point.y - 10}
                  textAnchor="middle"
                  fontSize="11"
                  fill="#0f172a"
                  fontWeight="600"
                  fontFamily={fontStack}
                >
                  {point.value}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
