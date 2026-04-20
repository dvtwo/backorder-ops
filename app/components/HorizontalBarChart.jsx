const fontStack =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export default function HorizontalBarChart({
  title,
  subtitle,
  data,
  valueFormatter = (value) => String(value),
  emptyText,
  onItemClick,
  activeLabel,
}) {
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
    display: "grid",
    gap: "10px",
  };

  const emptyStateStyle = {
    color: "#5b677a",
    fontSize: "12px",
    fontFamily: fontStack,
    fontWeight: 400,
  };

  const maxValue = Math.max(...data.map((item) => Number(item.value || 0)), 0);

  return (
    <div style={chartCardStyle}>
      <div style={chartHeaderStyle}>
        <h3 style={chartTitleStyle}>{title}</h3>
        <p style={chartSubtitleStyle}>{subtitle}</p>
      </div>

      <div style={chartBodyStyle}>
        {data.length === 0 ? (
          <div style={emptyStateStyle}>{emptyText}</div>
        ) : (
          data.map((item) => {
            const width =
              maxValue > 0 ? `${Math.max((item.value / maxValue) * 100, 6)}%` : "0%";

            const isActive = activeLabel === item.label;
            const content = (
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "10px",
                    marginBottom: "6px",
                    fontFamily: fontStack,
                  }}
                >
                  <div
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "#17212b",
                      lineHeight: 1.3,
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      fontWeight: 700,
                      color: "#0f172a",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {valueFormatter(item.value)}
                  </div>
                </div>

                <div
                  style={{
                    height: "10px",
                    background: isActive ? "#dbeafe" : "#eef2f7",
                    borderRadius: "999px",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width,
                      height: "100%",
                      background: isActive
                        ? "linear-gradient(90deg, #60a5fa 0%, #1d4ed8 100%)"
                        : "linear-gradient(90deg, #93c5fd 0%, #3b82f6 100%)",
                      borderRadius: "999px",
                    }}
                  />
                </div>
              </div>
            );

            if (!onItemClick) {
              return <div key={`${item.label}-${item.value}`}>{content}</div>;
            }

            return (
              <button
                key={`${item.label}-${item.value}`}
                type="button"
                onClick={() => onItemClick(item)}
                style={{
                  appearance: "none",
                  border: isActive ? "1px solid #bfdbfe" : "1px solid transparent",
                  background: isActive ? "#f8fbff" : "transparent",
                  borderRadius: "10px",
                  padding: "8px 10px",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                {content}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
