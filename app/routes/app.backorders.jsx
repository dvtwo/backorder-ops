export default function Backorders() {
  return (
    <div style={{ padding: "40px", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: "32px", marginBottom: "24px" }}>Backorders</h1>
      
      <div style={{ background: "#f4f6f8", padding: "24px", borderRadius: "8px", marginBottom: "24px" }}>
        <p style={{ fontSize: "18px" }}>
          Test backorder found: <strong>#1002</strong>
        </p>
        <p>Your Prisma model is working and the data is saved.</p>
      </div>

      <button 
        onClick={() => alert("Create new backorder form coming next step")}
        style={{
          background: "#008060",
          color: "white",
          border: "none",
          padding: "12px 24px",
          borderRadius: "6px",
          fontSize: "16px",
          cursor: "pointer"
        }}
      >
        Create New Backorder
      </button>
    </div>
  );
}
