import { useMemo, useState } from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);

    const response = await admin.graphql(`
      query BackorderOrders {
        orders(first: 100) {
          edges {
            node {
              id
              name
              createdAt
              displayFulfillmentStatus
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    unfulfilledQuantity
                    sku
                    vendor
                    variant {
                      id
                      inventoryQuantity
                    }
                  }
                }
              }
            }
          }
        }
      }
    `);

    const result = await response.json();

    if (result.errors?.length) {
      return {
        shop: session.shop,
        orders: [],
        restock: [],
        summary: {
          openBackorderOrders: 0,
          totalAffectedSkus: 0,
          totalShortageUnits: 0,
          vendorsAffected: 0,
        },
        ordersError: result.errors[0]?.message || "GraphQL query failed",
      };
    }

    const rawOrders = result?.data?.orders?.edges || [];
    const skuMap = {};

    rawOrders.forEach(({ node }) => {
      const adminOrderId = node.id?.split("/").pop() || "";
      const lineItems = (node.lineItems?.edges || []).map((e) => e.node);

      lineItems.forEach((item) => {
        const unfulfilled = Number(item.unfulfilledQuantity || 0);
        if (unfulfilled <= 0) return;

        const key = item.variant?.id || item.sku || item.title;
        const inventory = Math.max(
          Number(item.variant?.inventoryQuantity || 0),
          0,
        );

        if (!skuMap[key]) {
          skuMap[key] = {
            key,
            sku: item.sku || "—",
            product: item.title,
            vendor: item.vendor || "—",
            variantId: item.variant?.id || null,
            inventory,
            totalUnfulfilled: 0,
            shortage: 0,
            affectedOrders: [],
          };
        }

        skuMap[key].totalUnfulfilled += unfulfilled;
        skuMap[key].affectedOrders.push({
          orderId: node.id,
          adminOrderId,
          orderName: node.name,
          date: node.createdAt,
          unfulfilled,
        });
      });
    });

    Object.values(skuMap).forEach((item) => {
      item.shortage = Math.max(item.totalUnfulfilled - item.inventory, 0);
      item.affectedOrders.sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );
    });

    const orders = rawOrders
      .map(({ node }) => {
        const lineItems = (node.lineItems?.edges || []).map((e) => e.node);

        const backorderedLineItems = lineItems
          .filter((item) => {
            const unfulfilled = Number(item.unfulfilledQuantity || 0);
            if (unfulfilled <= 0) return false;

            const key = item.variant?.id || item.sku || item.title;
            const aggregate = skuMap[key];

            return aggregate && aggregate.shortage > 0;
          })
          .map((item) => ({
            id: item.id,
            sku: item.sku || "—",
            vendor: item.vendor || "—",
          }));

        const adminOrderId = node.id?.split("/").pop() || "";

        return {
          id: node.id,
          adminOrderId,
          name: node.name,
          date: node.createdAt,
          items: lineItems.length,
          unfulfilledItems: backorderedLineItems.length,
          status: node.displayFulfillmentStatus,
          backorderedLineItems,
        };
      })
      .filter((order) => order.unfulfilledItems > 0);

    const restock = Object.values(skuMap)
      .filter((item) => item.shortage > 0)
      .sort((a, b) => {
        const vendorCompare = (a.vendor || "—").localeCompare(b.vendor || "—");
        if (vendorCompare !== 0) return vendorCompare;
        return b.shortage - a.shortage;
      });

    const summary = {
      openBackorderOrders: orders.length,
      totalAffectedSkus: restock.length,
      totalShortageUnits: restock.reduce(
        (sum, item) => sum + Number(item.shortage || 0),
        0,
      ),
      vendorsAffected: new Set(restock.map((item) => item.vendor || "—")).size,
    };

    return {
      shop: session.shop,
      orders,
      restock,
      summary,
      ordersError: "",
    };
  } catch (error) {
    return {
      shop: "",
      orders: [],
      restock: [],
      summary: {
        openBackorderOrders: 0,
        totalAffectedSkus: 0,
        totalShortageUnits: 0,
        vendorsAffected: 0,
      },
      ordersError:
        error instanceof Error ? error.message : "Failed to load data",
    };
  }
};

export default function AppIndex() {
  const { shop, orders, restock, summary, ordersError } = useLoaderData();
  const [activeTab, setActiveTab] = useState("backorders");
  const [selectedVendor, setSelectedVendor] = useState("all");
  const [expandedRestockKey, setExpandedRestockKey] = useState(null);

  const vendorOptions = useMemo(() => {
    const vendors = Array.from(
      new Set(restock.map((item) => item.vendor || "—")),
    ).sort((a, b) => a.localeCompare(b));
    return ["all", ...vendors];
  }, [restock]);

  const filteredRestock = useMemo(() => {
    if (selectedVendor === "all") return restock;
    return restock.filter((item) => (item.vendor || "—") === selectedVendor);
  }, [restock, selectedVendor]);

  const groupedRestock = useMemo(() => {
    const groups = {};

    filteredRestock.forEach((item) => {
      const vendor = item.vendor || "—";

      if (!groups[vendor]) {
        groups[vendor] = {
          vendor,
          items: [],
          skuCount: 0,
          shortageUnits: 0,
        };
      }

      groups[vendor].items.push(item);
      groups[vendor].skuCount += 1;
      groups[vendor].shortageUnits += Number(item.shortage || 0);
    });

    return Object.values(groups).sort((a, b) =>
      a.vendor.localeCompare(b.vendor),
    );
  }, [filteredRestock]);

  const fontStack =
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  const pageStyle = {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #f5f7fb 0%, #eef2f7 100%)",
    padding: "14px",
    fontFamily: fontStack,
    color: "#17212b",
  };

  const containerStyle = {
    maxWidth: "1450px",
    margin: "0 auto",
    display: "grid",
    gap: "12px",
  };

  const heroStyle = {
    background: "linear-gradient(135deg, #ffffff 0%, #f8fbff 100%)",
    border: "1px solid #dbe3ef",
    borderRadius: "14px",
    padding: "16px 18px",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
  };

  const heroTitleStyle = {
    margin: 0,
    fontSize: "22px",
    lineHeight: 1.1,
    fontWeight: 700,
    letterSpacing: "-0.02em",
    color: "#0f172a",
  };

  const heroTextStyle = {
    marginTop: "6px",
    marginBottom: 0,
    fontSize: "13px",
    lineHeight: 1.45,
    color: "#526076",
    maxWidth: "820px",
    fontWeight: 400,
  };

  const summaryGridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: "10px",
  };

  const summaryCardStyle = {
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: "14px",
    padding: "14px 16px",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
  };

  const summaryLabelStyle = {
    fontSize: "11px",
    fontWeight: 600,
    color: "#667085",
    marginBottom: "8px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };

  const summaryValueStyle = {
    fontSize: "26px",
    lineHeight: 1,
    fontWeight: 700,
    color: "#0f172a",
    marginBottom: "4px",
  };

  const summaryHelpStyle = {
    fontSize: "12px",
    color: "#667085",
    fontWeight: 400,
  };

  const tabsRowStyle = {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  };

  const getTabStyle = (isActive) => ({
    appearance: "none",
    border: isActive ? "1px solid #3b82f6" : "1px solid #cfd8e6",
    background: isActive ? "#eaf2ff" : "#ffffff",
    color: isActive ? "#1d4ed8" : "#1f2937",
    padding: "8px 14px",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: fontStack,
    fontSize: "13px",
    fontWeight: 600,
    boxShadow: isActive ? "0 3px 10px rgba(59, 130, 246, 0.08)" : "none",
    transition: "all 0.15s ease",
  });

  const cardStyle = {
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: "14px",
    overflow: "hidden",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
  };

  const sectionHeaderStyle = {
    padding: "16px 18px 12px 18px",
    borderBottom: "1px solid #e7edf5",
    background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)",
  };

  const sectionTitleStyle = {
    margin: 0,
    fontSize: "16px",
    lineHeight: 1.2,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    color: "#0f172a",
    fontFamily: fontStack,
  };

  const sectionTextStyle = {
    marginTop: "5px",
    marginBottom: 0,
    fontSize: "12px",
    color: "#5b677a",
    lineHeight: 1.4,
    fontFamily: fontStack,
    fontWeight: 400,
  };

  const toolbarStyle = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap",
    padding: "12px 18px",
    borderBottom: "1px solid #e7edf5",
    background: "#fcfdff",
  };

  const labelStyle = {
    fontSize: "12px",
    fontWeight: 600,
    color: "#475467",
  };

  const selectStyle = {
    fontFamily: fontStack,
    fontSize: "12px",
    color: "#17212b",
    padding: "8px 12px",
    borderRadius: "10px",
    border: "1px solid #cfd8e6",
    background: "#ffffff",
    minWidth: "220px",
    outline: "none",
  };

  const exportButtonStyle = {
    appearance: "none",
    border: "1px solid #cfd8e6",
    background: "#ffffff",
    color: "#17212b",
    padding: "8px 12px",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: fontStack,
    fontSize: "12px",
    fontWeight: 600,
  };

  const resultCountStyle = {
    fontSize: "12px",
    color: "#667085",
    fontWeight: 500,
  };

  const tableWrapStyle = {
    overflowX: "auto",
  };

  const tableStyle = {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: fontStack,
  };

  const headerCell = {
    textAlign: "left",
    fontSize: "11px",
    fontWeight: 600,
    color: "#5b677a",
    background: "#f7f9fc",
    borderBottom: "1px solid #e7edf5",
    padding: "10px 12px",
    verticalAlign: "top",
    whiteSpace: "nowrap",
  };

  const bodyCell = {
    fontSize: "12px",
    color: "#17212b",
    borderBottom: "1px solid #eef2f7",
    padding: "10px 12px",
    verticalAlign: "top",
    lineHeight: 1.3,
    fontWeight: 400,
  };

  const orderLinkStyle = {
    color: "#1d4ed8",
    textDecoration: "none",
    fontWeight: 600,
    fontSize: "12px",
  };

  const mutedTextStyle = {
    fontWeight: 400,
    color: "#475467",
    fontSize: "12px",
  };

  const countTextStyle = {
    fontWeight: 600,
    color: "#0f172a",
    fontSize: "12px",
  };

  const badgeStyle = {
    display: "inline-block",
    padding: "4px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: 600,
    background: "#fff4df",
    color: "#9a6700",
    border: "1px solid #f1cf8c",
    whiteSpace: "nowrap",
  };

  const shortageBadgeStyle = {
    display: "inline-block",
    background: "#fdecec",
    padding: "3px 7px",
    borderRadius: "999px",
    fontWeight: 700,
    color: "#9b1c1c",
    border: "1px solid #f4caca",
    minWidth: "22px",
    textAlign: "center",
    fontSize: "11px",
  };

  const emptyStateStyle = {
    padding: "16px 18px 18px 18px",
    color: "#5b677a",
    fontSize: "12px",
    fontFamily: fontStack,
    fontWeight: 400,
  };

  const errorStateStyle = {
    padding: "16px 18px 18px 18px",
    color: "#b42318",
    fontSize: "12px",
    fontWeight: 600,
    fontFamily: fontStack,
  };

  const lineItemsListStyle = {
    display: "grid",
    gap: "4px",
    minWidth: "220px",
  };

  const lineItemRowStyle = {
    border: "1px solid #e7edf5",
    background: "#fbfdff",
    borderRadius: "8px",
    padding: "6px 8px",
  };

  const lineItemTextStyle = {
    fontSize: "12px",
    color: "#475467",
    lineHeight: 1.3,
    fontWeight: 400,
  };

  const skuLabelStyle = {
    fontWeight: 400,
    color: "#475467",
  };

  const skuValueStyle = {
    fontWeight: 600,
    color: "#0f172a",
  };

  const vendorInlineStyle = {
    fontWeight: 400,
    color: "#475467",
  };

  const drilldownButtonStyle = {
    appearance: "none",
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    fontFamily: fontStack,
    fontSize: "12px",
    cursor: "pointer",
    textAlign: "left",
  };

  const expandedRowCellStyle = {
    padding: "0 12px 12px 12px",
    background: "#fbfdff",
    borderBottom: "1px solid #eef2f7",
  };

  const drilldownCardStyle = {
    border: "1px solid #e7edf5",
    background: "#ffffff",
    borderRadius: "10px",
    overflow: "hidden",
    marginTop: "-2px",
  };

  const drilldownHeaderStyle = {
    padding: "10px 12px",
    borderBottom: "1px solid #eef2f7",
    background: "#f9fbff",
    fontSize: "12px",
    color: "#475467",
    fontWeight: 600,
  };

  const drilldownTableStyle = {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: fontStack,
  };

  const drilldownHeaderCellStyle = {
    textAlign: "left",
    fontSize: "11px",
    fontWeight: 600,
    color: "#667085",
    background: "#ffffff",
    borderBottom: "1px solid #eef2f7",
    padding: "8px 12px",
  };

  const drilldownBodyCellStyle = {
    fontSize: "12px",
    color: "#17212b",
    borderBottom: "1px solid #f2f4f7",
    padding: "8px 12px",
    fontWeight: 400,
  };

  const vendorGroupWrapStyle = {
    display: "grid",
    gap: "12px",
    padding: "12px",
  };

  const vendorGroupCardStyle = {
    border: "1px solid #e7edf5",
    borderRadius: "12px",
    overflow: "hidden",
    background: "#ffffff",
  };

  const vendorGroupHeaderStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap",
    padding: "12px 14px",
    background: "linear-gradient(180deg, #f9fbff 0%, #f4f8ff 100%)",
    borderBottom: "1px solid #e7edf5",
  };

  const vendorGroupTitleStyle = {
    fontSize: "14px",
    fontWeight: 700,
    color: "#0f172a",
  };

  const vendorGroupMetaStyle = {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
    alignItems: "center",
  };

  const vendorMetaBadgeStyle = {
    display: "inline-block",
    padding: "4px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: 600,
    background: "#ffffff",
    color: "#475467",
    border: "1px solid #dbe3ef",
  };

  const formatStatus = (status) => {
    if (!status) return "Unknown";
    return status
      .toString()
      .replaceAll("_", " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const getOrderAdminUrl = (adminOrderId) => {
    if (!shop || !adminOrderId) return "#";
    return `https://${shop}/admin/orders/${adminOrderId}`;
  };

  const toggleExpandedRestock = (key) => {
    setExpandedRestockKey((current) => (current === key ? null : key));
  };

  const csvEscape = (value) => {
    const stringValue = String(value ?? "");
    if (
      stringValue.includes(",") ||
      stringValue.includes('"') ||
      stringValue.includes("\n")
    ) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  const exportRestockCsv = () => {
    const rows = filteredRestock.map((item) => ({
      sku: item.sku,
      product: item.product,
      vendor: item.vendor,
      totalUnfulfilled: item.totalUnfulfilled,
      inventory: item.inventory,
      totalShortage: item.shortage,
      affectedOrders: item.affectedOrders.length,
    }));

    const headers = [
      "SKU",
      "Product",
      "Vendor",
      "Total Unfulfilled",
      "Inventory",
      "Total Shortage",
      "Affected Orders",
    ];

    const csvLines = [
      headers.join(","),
      ...rows.map((row) =>
        [
          csvEscape(row.sku),
          csvEscape(row.product),
          csvEscape(row.vendor),
          csvEscape(row.totalUnfulfilled),
          csvEscape(row.inventory),
          csvEscape(row.totalShortage),
          csvEscape(row.affectedOrders),
        ].join(","),
      ),
    ];

    const csvContent = csvLines.join("\n");
    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });

    const vendorSlug =
      selectedVendor === "all"
        ? "all-vendors"
        : selectedVendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const fileName = `backorder-restock-${vendorSlug}.csv`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.setAttribute("download", fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        <div style={heroStyle}>
          <h1 style={heroTitleStyle}>Backorder Ops</h1>
          <p style={heroTextStyle}>
            Track inventory shortages, review affected orders, and generate a
            clearer restock list for purchasing.
          </p>
        </div>

        <div style={summaryGridStyle}>
          <div style={summaryCardStyle}>
            <div style={summaryLabelStyle}>Open backorder orders</div>
            <div style={summaryValueStyle}>{summary.openBackorderOrders}</div>
            <div style={summaryHelpStyle}>Orders currently affected</div>
          </div>

          <div style={summaryCardStyle}>
            <div style={summaryLabelStyle}>Total affected SKUs</div>
            <div style={summaryValueStyle}>{summary.totalAffectedSkus}</div>
            <div style={summaryHelpStyle}>Unique SKUs needing action</div>
          </div>

          <div style={summaryCardStyle}>
            <div style={summaryLabelStyle}>Total shortage units</div>
            <div style={summaryValueStyle}>{summary.totalShortageUnits}</div>
            <div style={summaryHelpStyle}>Units short across all orders</div>
          </div>

          <div style={summaryCardStyle}>
            <div style={summaryLabelStyle}>Vendors affected</div>
            <div style={summaryValueStyle}>{summary.vendorsAffected}</div>
            <div style={summaryHelpStyle}>Suppliers impacted</div>
          </div>
        </div>

        <div style={tabsRowStyle}>
          <button
            type="button"
            onClick={() => setActiveTab("backorders")}
            style={getTabStyle(activeTab === "backorders")}
          >
            Backorders
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("restock")}
            style={getTabStyle(activeTab === "restock")}
          >
            Restock
          </button>
        </div>

        {activeTab === "backorders" ? (
          <div style={cardStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>Live backorders</h2>
              <p style={sectionTextStyle}>
                Orders with real inventory shortages. Click an order number to
                open it in Shopify Admin.
              </p>
            </div>

            {ordersError ? (
              <div style={errorStateStyle}>{ordersError}</div>
            ) : orders.length === 0 ? (
              <div style={emptyStateStyle}>No backorders found.</div>
            ) : (
              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={headerCell}>Order</th>
                      <th style={headerCell}>Date</th>
                      <th style={headerCell}>Items</th>
                      <th style={headerCell}>Backordered</th>
                      <th style={headerCell}>Backordered SKUs / Vendors</th>
                      <th style={headerCell}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td style={bodyCell}>
                          <a
                            href={getOrderAdminUrl(o.adminOrderId)}
                            target="_top"
                            rel="noreferrer"
                            style={orderLinkStyle}
                          >
                            {o.name}
                          </a>
                        </td>
                        <td style={bodyCell}>
                          <span style={mutedTextStyle}>
                            {new Date(o.date).toLocaleDateString()}
                          </span>
                        </td>
                        <td style={bodyCell}>
                          <span style={countTextStyle}>{o.items}</span>
                        </td>
                        <td style={bodyCell}>
                          <span style={countTextStyle}>{o.unfulfilledItems}</span>
                        </td>
                        <td style={bodyCell}>
                          <div style={lineItemsListStyle}>
                            {o.backorderedLineItems.map((item) => (
                              <div key={item.id} style={lineItemRowStyle}>
                                <div style={lineItemTextStyle}>
                                  <span style={skuLabelStyle}>SKU: </span>
                                  <span style={skuValueStyle}>{item.sku}</span>
                                  {"  |  "}
                                  <span style={vendorInlineStyle}>
                                    {item.vendor}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td style={bodyCell}>
                          <span style={badgeStyle}>{formatStatus(o.status)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div style={cardStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>Products needing restock</h2>
              <p style={sectionTextStyle}>
                Aggregated shortages across all orders, grouped by vendor. Click
                a SKU to see the affected orders.
              </p>
            </div>

            <div style={toolbarStyle}>
              <label htmlFor="vendor-filter" style={labelStyle}>
                Filter by vendor
              </label>
              <select
                id="vendor-filter"
                value={selectedVendor}
                onChange={(event) => {
                  setSelectedVendor(event.target.value);
                  setExpandedRestockKey(null);
                }}
                style={selectStyle}
              >
                {vendorOptions.map((vendor) => (
                  <option key={vendor} value={vendor}>
                    {vendor === "all" ? "All vendors" : vendor}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={exportRestockCsv}
                style={exportButtonStyle}
              >
                Export CSV
              </button>

              <div style={resultCountStyle}>
                {filteredRestock.length} result
                {filteredRestock.length === 1 ? "" : "s"}
              </div>
            </div>

            {groupedRestock.length === 0 ? (
              <div style={emptyStateStyle}>
                No restock shortages found for this vendor.
              </div>
            ) : (
              <div style={vendorGroupWrapStyle}>
                {groupedRestock.map((group) => (
                  <div key={group.vendor} style={vendorGroupCardStyle}>
                    <div style={vendorGroupHeaderStyle}>
                      <div style={vendorGroupTitleStyle}>{group.vendor}</div>
                      <div style={vendorGroupMetaStyle}>
                        <span style={vendorMetaBadgeStyle}>
                          {group.skuCount} SKU{group.skuCount === 1 ? "" : "s"}
                        </span>
                        <span style={vendorMetaBadgeStyle}>
                          {group.shortageUnits} shortage unit
                          {group.shortageUnits === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>

                    <div style={tableWrapStyle}>
                      <table style={tableStyle}>
                        <thead>
                          <tr>
                            <th style={headerCell}>SKU</th>
                            <th style={headerCell}>Product</th>
                            <th style={headerCell}>Total Unfulfilled</th>
                            <th style={headerCell}>Inventory</th>
                            <th style={headerCell}>Total Shortage</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.map((item) => {
                            const rowKey =
                              item.variantId || item.sku || item.product;
                            const isExpanded = expandedRestockKey === rowKey;

                            return (
                              <>
                                <tr key={`row-${group.vendor}-${rowKey}`}>
                                  <td style={bodyCell}>
                                    <button
                                      type="button"
                                      onClick={() => toggleExpandedRestock(rowKey)}
                                      style={drilldownButtonStyle}
                                    >
                                      <span style={skuValueStyle}>
                                        {item.sku}
                                      </span>
                                    </button>
                                  </td>
                                  <td style={bodyCell}>{item.product}</td>
                                  <td style={bodyCell}>
                                    <span style={countTextStyle}>
                                      {item.totalUnfulfilled}
                                    </span>
                                  </td>
                                  <td style={bodyCell}>
                                    <span style={countTextStyle}>
                                      {item.inventory}
                                    </span>
                                  </td>
                                  <td style={bodyCell}>
                                    <span style={shortageBadgeStyle}>
                                      {item.shortage}
                                    </span>
                                  </td>
                                </tr>
                                {isExpanded ? (
                                  <tr
                                    key={`expanded-${group.vendor}-${rowKey}`}
                                  >
                                    <td colSpan={5} style={expandedRowCellStyle}>
                                      <div style={drilldownCardStyle}>
                                        <div style={drilldownHeaderStyle}>
                                          Affected orders for{" "}
                                          <span style={skuValueStyle}>
                                            {item.sku}
                                          </span>
                                        </div>
                                        <table style={drilldownTableStyle}>
                                          <thead>
                                            <tr>
                                              <th
                                                style={drilldownHeaderCellStyle}
                                              >
                                                Order
                                              </th>
                                              <th
                                                style={drilldownHeaderCellStyle}
                                              >
                                                Date
                                              </th>
                                              <th
                                                style={drilldownHeaderCellStyle}
                                              >
                                                Unfulfilled Qty
                                              </th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {item.affectedOrders.map(
                                              (affected) => (
                                                <tr
                                                  key={`${group.vendor}-${rowKey}-${affected.orderId}-${affected.date}`}
                                                >
                                                  <td
                                                    style={
                                                      drilldownBodyCellStyle
                                                    }
                                                  >
                                                    <a
                                                      href={getOrderAdminUrl(
                                                        affected.adminOrderId,
                                                      )}
                                                      target="_top"
                                                      rel="noreferrer"
                                                      style={orderLinkStyle}
                                                    >
                                                      {affected.orderName}
                                                    </a>
                                                  </td>
                                                  <td
                                                    style={
                                                      drilldownBodyCellStyle
                                                    }
                                                  >
                                                    <span
                                                      style={mutedTextStyle}
                                                    >
                                                      {new Date(
                                                        affected.date,
                                                      ).toLocaleDateString()}
                                                    </span>
                                                  </td>
                                                  <td
                                                    style={
                                                      drilldownBodyCellStyle
                                                    }
                                                  >
                                                    <span
                                                      style={countTextStyle}
                                                    >
                                                      {affected.unfulfilled}
                                                    </span>
                                                  </td>
                                                </tr>
                                              ),
                                            )}
                                          </tbody>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                ) : null}
                              </>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
