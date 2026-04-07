import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

const chunkArray = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

export const loader = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);

    const ordersResponse = await admin.graphql(
      `#graphql
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
                        inventoryItem {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
    );

    const ordersResult = await ordersResponse.json();

    if (ordersResult.errors?.length) {
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
        ordersError: ordersResult.errors[0]?.message || 'GraphQL query failed',
      };
    }

    const rawOrders = ordersResult?.data?.orders?.edges || [];

    const inventoryItemIds = Array.from(
      new Set(
        rawOrders.flatMap(({ node }) =>
          ((node?.lineItems?.edges || []).map((edge) => edge?.node) || [])
            .filter((item) => Number(item?.unfulfilledQuantity || 0) > 0)
            .map((item) => item?.variant?.inventoryItem?.id)
            .filter(Boolean),
        ),
      ),
    );

    const inventoryByItemId = {};
    const inventoryChunks = chunkArray(inventoryItemIds, 20);

    for (const ids of inventoryChunks) {
      const inventoryResponse = await admin.graphql(
        `#graphql
          query InventoryItemLocations($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on InventoryItem {
                id
                inventoryLevels(first: 50) {
                  edges {
                    node {
                      location {
                        id
                        name
                      }
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        { variables: { ids } },
      );

      const inventoryResult = await inventoryResponse.json();

      if (inventoryResult.errors?.length) {
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
          ordersError:
            inventoryResult.errors[0]?.message || 'Inventory query failed',
        };
      }

      (inventoryResult?.data?.nodes || []).forEach((inventoryItem) => {
        if (!inventoryItem?.id) return;

        const locationInventory = (inventoryItem?.inventoryLevels?.edges || []).map(
          ({ node: level }) => ({
            id: level?.location?.id || '',
            name: level?.location?.name || 'Unknown location',
            quantity: Math.max(
              Number(
                level?.quantities?.find((quantity) => quantity?.name === 'available')
                  ?.quantity || 0,
              ),
              0,
            ),
          }),
        );

        inventoryByItemId[inventoryItem.id] = {
          locationInventory,
          inventory: locationInventory.reduce(
            (sum, level) => sum + Number(level.quantity || 0),
            0,
          ),
        };
      });
    }

    const skuMap = {};

    rawOrders.forEach(({ node }) => {
      const adminOrderId = node.id?.split('/').pop() || '';
      const lineItems = (node.lineItems?.edges || []).map((e) => e.node);

      lineItems.forEach((item) => {
        const unfulfilled = Number(item.unfulfilledQuantity || 0);
        if (unfulfilled <= 0) return;

        const key = item.variant?.id || item.sku || item.title;
        const inventoryItemId = item.variant?.inventoryItem?.id || null;
        const inventoryRecord = inventoryByItemId[inventoryItemId] || {
          inventory: Math.max(Number(item.variant?.inventoryQuantity || 0), 0),
          locationInventory: [],
        };

        if (!skuMap[key]) {
          skuMap[key] = {
            key,
            sku: item.sku || '—',
            product: item.title,
            vendor: item.vendor || '—',
            variantId: item.variant?.id || null,
            inventory: inventoryRecord.inventory,
            totalUnfulfilled: 0,
            shortage: 0,
            affectedOrders: [],
            locationInventory: inventoryRecord.locationInventory,
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
            key: item.variant?.id || item.sku || item.title,
            sku: item.sku || '—',
            vendor: item.vendor || '—',
          }));

        const adminOrderId = node.id?.split('/').pop() || '';

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
        const vendorCompare = (a.vendor || '—').localeCompare(b.vendor || '—');
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
      vendorsAffected: new Set(restock.map((item) => item.vendor || '—')).size,
    };

    return {
      shop: session.shop,
      orders,
      restock,
      summary,
      ordersError: '',
    };
  } catch (error) {
    return {
      shop: '',
      orders: [],
      restock: [],
      summary: {
        openBackorderOrders: 0,
        totalAffectedSkus: 0,
        totalShortageUnits: 0,
        vendorsAffected: 0,
      },
      ordersError:
        error instanceof Error ? error.message : 'Failed to load data',
    };
  }
};

function HorizontalBarChart({
  title,
  subtitle,
  data,
  valueFormatter = (value) => String(value),
  emptyText,
  onItemClick,
  activeLabel,
}) {
  const fontStack =
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

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

function TrendChart({ title, subtitle, data, emptyText, onPointClick, activeLabel }) {
  const fontStack =
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

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

    return {
      ...item,
      x,
      y,
    };
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

export default function AppIndex() {
  const { shop, orders, restock, summary, ordersError } = useLoaderData();
  const [activeTab, setActiveTab] = useState("backorders");
  const [selectedVendor, setSelectedVendor] = useState("all");
  const [selectedLocationIds, setSelectedLocationIds] = useState([]);
  const [expandedRestockKey, setExpandedRestockKey] = useState(null);
  const [analyticsDrilldown, setAnalyticsDrilldown] = useState({
    type: null,
    label: null,
  });
  const analyticsDrilldownRef = useRef(null);

  const vendorOptions = useMemo(() => {
    const vendors = Array.from(
      new Set(restock.map((item) => item.vendor || "—")),
    ).sort((a, b) => a.localeCompare(b));
    return ["all", ...vendors];
  }, [restock]);

  const locationOptions = useMemo(() => {
    const locations = [];
    const seen = new Set();

    restock.forEach((item) => {
      (item.locationInventory || []).forEach((location) => {
        if (!location?.id || seen.has(location.id)) return;
        seen.add(location.id);
        locations.push({
          id: location.id,
          name: location.name || "Unknown location",
        });
      });
    });

    return locations.sort((a, b) => a.name.localeCompare(b.name));
  }, [restock]);

  const normalizedSelectedLocationIds = useMemo(() => {
    if (selectedLocationIds.length === 0) return [];
    const validIds = new Set(locationOptions.map((location) => location.id));
    return selectedLocationIds.filter((id) => validIds.has(id));
  }, [locationOptions, selectedLocationIds]);

  const allLocationsSelected =
    locationOptions.length === 0 ||
    normalizedSelectedLocationIds.length === 0 ||
    normalizedSelectedLocationIds.length === locationOptions.length;

  const selectedLocationSummary = allLocationsSelected
    ? "All locations"
    : normalizedSelectedLocationIds.length === 1
      ? locationOptions.find(
          (location) => location.id === normalizedSelectedLocationIds[0],
        )?.name || "1 location"
      : `${normalizedSelectedLocationIds.length} locations`;

  const locationFilteredRestock = useMemo(() => {
    return restock
      .map((item) => {
        const selectedInventory = (item.locationInventory || [])
          .filter(
            (location) =>
              allLocationsSelected ||
              normalizedSelectedLocationIds.includes(location.id),
          )
          .reduce((sum, location) => sum + Number(location.quantity || 0), 0);

        return {
          ...item,
          inventory: selectedInventory,
          shortage: Math.max(Number(item.totalUnfulfilled || 0) - selectedInventory, 0),
        };
      })
      .filter((item) => Number(item.shortage || 0) > 0);
  }, [allLocationsSelected, normalizedSelectedLocationIds, restock]);

  const filteredRestock = useMemo(() => {
    if (selectedVendor === "all") return locationFilteredRestock;
    return locationFilteredRestock.filter(
      (item) => (item.vendor || "—") === selectedVendor,
    );
  }, [locationFilteredRestock, selectedVendor]);

  const filteredRestockKeys = useMemo(
    () => new Set(filteredRestock.map((item) => String(item.key || ""))),
    [filteredRestock],
  );

  const filteredOrders = useMemo(() => {
    return orders
      .map((order) => {
        const backorderedLineItems = (order.backorderedLineItems || []).filter((item) =>
          filteredRestockKeys.has(String(item.key || "")),
        );

        return {
          ...order,
          backorderedLineItems,
          unfulfilledItems: backorderedLineItems.length,
        };
      })
      .filter((order) => order.unfulfilledItems > 0);
  }, [filteredRestockKeys, orders]);

  const statusLabel = (status) => {
    if (!status) return "Unknown";
    return status
      .toString()
      .replaceAll("_", " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  };

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

  const analytics = useMemo(() => {
    const vendorTotals = {};
    const trendMap = {};
    const agingBuckets = {
      "0–7 days": { count: 0, orders: [] },
      "8–14 days": { count: 0, orders: [] },
      "15–30 days": { count: 0, orders: [] },
      "31+ days": { count: 0, orders: [] },
    };

    const now = Date.now();

    filteredRestock.forEach((item) => {
      const vendor = item.vendor || "—";
      vendorTotals[vendor] = (vendorTotals[vendor] || 0) + Number(item.shortage || 0);
    });

    filteredOrders.forEach((order) => {
      const date = new Date(order.date);
      const dateKey = date.toISOString().slice(0, 10);
      const dayLabel = date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });

      if (!trendMap[dateKey]) {
        trendMap[dateKey] = {
          label: dayLabel,
          value: 0,
          dateKey,
          orders: [],
        };
      }

      trendMap[dateKey].value += 1;
      trendMap[dateKey].orders.push(order);

      const daysOld = Math.floor((now - date.getTime()) / (1000 * 60 * 60 * 24));
      let bucketLabel = "31+ days";

      if (daysOld <= 7) {
        bucketLabel = "0–7 days";
      } else if (daysOld <= 14) {
        bucketLabel = "8–14 days";
      } else if (daysOld <= 30) {
        bucketLabel = "15–30 days";
      }

      agingBuckets[bucketLabel].count += 1;
      agingBuckets[bucketLabel].orders.push(order);
    });

    const shortageByVendor = Object.entries(vendorTotals)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    const skuLookup = new Map(
      filteredRestock.map((item) => {
        const normalizedKey = String(item.variantId || item.sku || item.product || "");
        return [
          normalizedKey,
          {
            label: item.sku || item.product,
            value: Number(item.shortage || 0),
            sku: item.sku || "—",
            product: item.product,
            vendor: item.vendor || "—",
            key: normalizedKey,
            affectedOrders: item.affectedOrders || [],
            inventory: Number(item.inventory || 0),
            totalUnfulfilled: Number(item.totalUnfulfilled || 0),
          },
        ];
      }),
    );

    const topSkus = Array.from(skuLookup.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    const trend = Object.values(trendMap)
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
      .slice(-10);

    const aging = Object.entries(agingBuckets).map(([label, detail]) => ({
      label,
      value: detail.count,
      orders: detail.orders,
    }));

    const totalShortageUnits = filteredRestock.reduce(
      (sum, item) => sum + Number(item.shortage || 0),
      0,
    );

    const topVendor = shortageByVendor[0] || null;
    const topSku =
      filteredRestock
        .slice()
        .sort((a, b) => Number(b.shortage || 0) - Number(a.shortage || 0))[0] || null;
    const agingOver14 = agingBuckets["15–30 days"].count + agingBuckets["31+ days"].count;
    const topThreeSkuShortage = filteredRestock
      .slice()
      .sort((a, b) => Number(b.shortage || 0) - Number(a.shortage || 0))
      .slice(0, 3)
      .reduce((sum, item) => sum + Number(item.shortage || 0), 0);

    const insights = [
      topVendor
        ? `${topVendor.label} accounts for the highest shortage volume with ${topVendor.value} units short.`
        : "No vendor shortage trend available yet.",
      topSku
        ? `${topSku.sku || topSku.product} is the most constrained SKU with ${topSku.shortage} units short.`
        : "No SKU shortage trend available yet.",
      filteredRestock.length > 0 && totalShortageUnits > 0
        ? `Top 3 SKUs represent ${Math.round((topThreeSkuShortage / totalShortageUnits) * 100)}% of all current shortage units.`
        : "No concentration insight available yet.",
      `${agingOver14} backorder order${agingOver14 === 1 ? " is" : "s are"} older than 14 days.`,
    ];

    let drilldownTitle = "";
    let drilldownRows = [];

    if (analyticsDrilldown.type === "sku") {
      const selectedSku = skuLookup.get(String(analyticsDrilldown.label || ""));
      if (selectedSku) {
        drilldownTitle = `Affected orders for ${selectedSku.sku}`;
        drilldownRows = selectedSku.affectedOrders.map((affected, index) => ({
          id: `${selectedSku.key}-${affected.orderId || index}-${affected.date || index}`,
          orderName: affected.orderName,
          adminOrderId: affected.adminOrderId,
          date: affected.date,
          metaPrimary: `${affected.unfulfilled} unfulfilled`,
          metaSecondary: selectedSku.vendor,
        }));
      }
    } else if (analyticsDrilldown.type === "aging") {
      const selectedBucket = aging.find((item) => item.label === analyticsDrilldown.label);
      if (selectedBucket) {
        drilldownTitle = `Orders in ${selectedBucket.label}`;
        drilldownRows = selectedBucket.orders.map((order) => ({
          id: `${selectedBucket.label}-${order.id}`,
          orderName: order.name,
          adminOrderId: order.adminOrderId,
          date: order.date,
          metaPrimary: `${order.unfulfilledItems} affected SKU${order.unfulfilledItems === 1 ? "" : "s"}`,
          metaSecondary: statusLabel(order.status),
        }));
      }
    } else if (analyticsDrilldown.type === "trend") {
      const selectedDay = trend.find((item) => item.dateKey === analyticsDrilldown.label);
      if (selectedDay) {
        drilldownTitle = `Orders from ${selectedDay.label}`;
        drilldownRows = selectedDay.orders.map((order) => ({
          id: `${selectedDay.dateKey}-${order.id}`,
          orderName: order.name,
          adminOrderId: order.adminOrderId,
          date: order.date,
          metaPrimary: `${order.unfulfilledItems} affected SKU${order.unfulfilledItems === 1 ? "" : "s"}`,
          metaSecondary: statusLabel(order.status),
        }));
      }
    }

    return {
      shortageByVendor,
      topSkus,
      trend,
      aging,
      insights,
      drilldownTitle,
      drilldownRows,
      filteredSummary: {
        openBackorderOrders: filteredOrders.length,
        totalAffectedSkus: filteredRestock.length,
        totalShortageUnits,
        vendorsAffected: new Set(filteredRestock.map((item) => item.vendor || "—")).size,
        olderThan14Days: agingOver14,
      },
    };
  }, [analyticsDrilldown, filteredOrders, filteredRestock]);

  useEffect(() => {
    if (activeTab !== "analytics") return;
    if (!analyticsDrilldown.type) return;
    if (!analytics.drilldownRows.length) return;

    requestAnimationFrame(() => {
      analyticsDrilldownRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, [activeTab, analytics.drilldownRows.length, analyticsDrilldown.type]);

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
    flexWrap: "wrap",
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

  const filterGroupStyle = {
    display: "grid",
    gap: "4px",
  };

  const locationPopoverStyle = {
    position: "relative",
  };

  const locationButtonStyle = {
    appearance: "none",
    border: "1px solid #cfd8e6",
    background: "#ffffff",
    color: "#17212b",
    padding: "8px 12px",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: fontStack,
    fontSize: "12px",
    fontWeight: 500,
    minWidth: "220px",
    textAlign: "left",
  };

  const locationMenuStyle = {
    position: "absolute",
    top: "calc(100% + 8px)",
    left: 0,
    zIndex: 20,
    minWidth: "280px",
    maxHeight: "280px",
    overflowY: "auto",
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: "12px",
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.12)",
    padding: "8px",
  };

  const locationOptionRowStyle = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "7px 8px",
    borderRadius: "8px",
    fontSize: "12px",
    color: "#17212b",
    cursor: "pointer",
  };

  const locationHintStyle = {
    fontSize: "11px",
    color: "#667085",
    padding: "2px 8px 6px 8px",
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

  const analyticsGridStyle = {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: "12px",
    padding: "12px",
  };

  const analyticsKpiGridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
    gap: "10px",
    padding: "12px 12px 0 12px",
  };

  const analyticsKpiCardStyle = {
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: "14px",
    padding: "14px 16px",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
  };

  const analyticsHintStyle = {
    padding: "0 12px 12px 12px",
    fontSize: "12px",
    color: "#667085",
    fontWeight: 400,
  };

  const analyticsDrilldownWrapStyle = {
    padding: "0 12px 12px 12px",
  };

  const analyticsDrilldownCardStyle = {
    border: "1px solid #dbe3ef",
    background: "#ffffff",
    borderRadius: "14px",
    overflow: "hidden",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
  };

  const analyticsDrilldownHeaderStyle = {
    padding: "12px 14px",
    borderBottom: "1px solid #e7edf5",
    background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)",
    display: "flex",
    justifyContent: "space-between",
    gap: "10px",
    alignItems: "center",
    flexWrap: "wrap",
  };

  const analyticsDrilldownTitleStyle = {
    margin: 0,
    fontSize: "14px",
    lineHeight: 1.2,
    fontWeight: 700,
    color: "#0f172a",
  };

  const analyticsClearButtonStyle = {
    appearance: "none",
    border: "1px solid #cfd8e6",
    background: "#ffffff",
    color: "#344054",
    padding: "7px 10px",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: fontStack,
    fontSize: "12px",
    fontWeight: 600,
  };

  const insightCardStyle = {
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: "14px",
    overflow: "hidden",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
    height: "100%",
  };

  const insightHeaderStyle = {
    padding: "14px 16px 10px 16px",
    borderBottom: "1px solid #e7edf5",
    background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)",
  };

  const insightTitleStyle = {
    margin: 0,
    fontSize: "14px",
    lineHeight: 1.2,
    fontWeight: 700,
    color: "#0f172a",
  };

  const insightSubtitleStyle = {
    marginTop: "4px",
    marginBottom: 0,
    fontSize: "12px",
    lineHeight: 1.4,
    color: "#667085",
    fontWeight: 400,
  };

  const insightListStyle = {
    listStyle: "none",
    margin: 0,
    padding: "14px 16px 16px 16px",
    display: "grid",
    gap: "10px",
  };

  const insightItemStyle = {
    border: "1px solid #e7edf5",
    background: "#fbfdff",
    borderRadius: "10px",
    padding: "10px 12px",
    fontSize: "12px",
    lineHeight: 1.45,
    color: "#344054",
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

  const handleVendorFilterChange = (value) => {
    setSelectedVendor(value);
    setAnalyticsDrilldown({ type: null, label: null });
  };

  const handleLocationToggle = (locationId) => {
    setExpandedRestockKey(null);
    setAnalyticsDrilldown({ type: null, label: null });
    setSelectedLocationIds((current) => {
      if (current.length === 0) {
        return locationOptions
          .map((location) => location.id)
          .filter((id) => id !== locationId);
      }

      if (current.includes(locationId)) {
        const next = current.filter((id) => id !== locationId);
        if (next.length === 0 || next.length === locationOptions.length) {
          return [];
        }
        return next;
      }

      const next = [...current, locationId];
      if (next.length === locationOptions.length) {
        return [];
      }
      return next;
    });
  };

  const handleAllLocationsToggle = () => {
    setExpandedRestockKey(null);
    setAnalyticsDrilldown({ type: null, label: null });
    setSelectedLocationIds([]);
  };

  const handleAnalyticsVendorClick = (item) => {
    setSelectedVendor(item.label === selectedVendor ? "all" : item.label);
    setAnalyticsDrilldown({ type: null, label: null });
  };

  const handleAnalyticsSkuClick = (item) => {
    const normalizedKey = String(item.key || item.sku || item.product || "");
    setAnalyticsDrilldown((current) =>
      current.type === "sku" && String(current.label || "") === normalizedKey
        ? { type: null, label: null }
        : { type: "sku", label: normalizedKey },
    );
  };

  const handleAnalyticsAgingClick = (item) => {
    setAnalyticsDrilldown((current) =>
      current.type === "aging" && current.label === item.label
        ? { type: null, label: null }
        : { type: "aging", label: item.label },
    );
  };

  const handleAnalyticsTrendClick = (item) => {
    setAnalyticsDrilldown((current) =>
      current.type === "trend" && current.label === item.dateKey
        ? { type: null, label: null }
        : { type: "trend", label: item.dateKey },
    );
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
      locations: selectedLocationSummary,
      totalShortage: item.shortage,
      affectedOrders: item.affectedOrders.length,
    }));

    const headers = [
      "SKU",
      "Product",
      "Vendor",
      "Total Unfulfilled",
      "Inventory",
      "Locations",
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
          csvEscape(row.locations),
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

    const locationSlug =
      allLocationsSelected
        ? "all-locations"
        : selectedLocationSummary.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const fileName = `backorder-restock-${vendorSlug}-${locationSlug}.csv`;
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

          <button
            type="button"
            onClick={() => setActiveTab("analytics")}
            style={getTabStyle(activeTab === "analytics")}
          >
            Analytics
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
        ) : activeTab === "restock" ? (
          <div style={cardStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>Products needing restock</h2>
              <p style={sectionTextStyle}>
                Aggregated shortages across all orders, grouped by vendor. Click
                a SKU to see the affected orders.
              </p>
            </div>

            <div style={toolbarStyle}>
              <div style={filterGroupStyle}>
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
              </div>

              <div style={filterGroupStyle}>
                <span style={labelStyle}>Inventory locations</span>
                <details style={locationPopoverStyle}>
                  <summary style={locationButtonStyle}>
                    {selectedLocationSummary}
                  </summary>
                  <div style={locationMenuStyle}>
                    <label style={locationOptionRowStyle}>
                      <input
                        type="checkbox"
                        checked={allLocationsSelected}
                        onChange={handleAllLocationsToggle}
                      />
                      <span>All locations</span>
                    </label>
                    <div style={locationHintStyle}>
                      Choose one or more locations to recalculate available inventory.
                    </div>
                    {locationOptions.map((location) => (
                      <label key={location.id} style={locationOptionRowStyle}>
                        <input
                          type="checkbox"
                          checked={allLocationsSelected || normalizedSelectedLocationIds.includes(location.id)}
                          onChange={() => handleLocationToggle(location.id)}
                        />
                        <span>{location.name}</span>
                      </label>
                    ))}
                  </div>
                </details>
              </div>

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
                No restock shortages found for the current vendor and location filter.
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
                            <th style={headerCell}>Selected Inventory</th>
                            <th style={headerCell}>Total Shortage</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.map((item) => {
                            const rowKey =
                              item.variantId || item.sku || item.product;
                            const isExpanded = expandedRestockKey === rowKey;

                            return (
                              <Fragment key={`${group.vendor}-${rowKey}`}>
                                <tr>
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
                                  <tr>
                                    <td colSpan={5} style={expandedRowCellStyle}>
                                      <div style={drilldownCardStyle}>
                                        <div style={drilldownHeaderStyle}>
                                          Affected orders for {" "}
                                          <span style={skuValueStyle}>
                                            {item.sku}
                                          </span>
                                        </div>
                                        <table style={drilldownTableStyle}>
                                          <thead>
                                            <tr>
                                              <th style={drilldownHeaderCellStyle}>
                                                Order
                                              </th>
                                              <th style={drilldownHeaderCellStyle}>
                                                Date
                                              </th>
                                              <th style={drilldownHeaderCellStyle}>
                                                Unfulfilled Qty
                                              </th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {item.affectedOrders.map((affected) => (
                                              <tr
                                                key={`${group.vendor}-${rowKey}-${affected.orderId}-${affected.date}`}
                                              >
                                                <td style={drilldownBodyCellStyle}>
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
                                                <td style={drilldownBodyCellStyle}>
                                                  <span style={mutedTextStyle}>
                                                    {new Date(
                                                      affected.date,
                                                    ).toLocaleDateString()}
                                                  </span>
                                                </td>
                                                <td style={drilldownBodyCellStyle}>
                                                  <span style={countTextStyle}>
                                                    {affected.unfulfilled}
                                                  </span>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
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
        ) : (
          <div style={cardStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>Backorder analytics</h2>
              <p style={sectionTextStyle}>
                Snapshot analytics from the current live backlog. Use the vendor
                filter to focus the charts.
              </p>
            </div>

            <div style={toolbarStyle}>
              <div style={filterGroupStyle}>
                <label htmlFor="analytics-vendor-filter" style={labelStyle}>
                  Filter analytics by vendor
                </label>
                <select
                  id="analytics-vendor-filter"
                  value={selectedVendor}
                  onChange={(event) => handleVendorFilterChange(event.target.value)}
                  style={selectStyle}
                >
                  {vendorOptions.map((vendor) => (
                    <option key={vendor} value={vendor}>
                      {vendor === "all" ? "All vendors" : vendor}
                    </option>
                  ))}
                </select>
              </div>

              <div style={filterGroupStyle}>
                <span style={labelStyle}>Inventory locations</span>
                <details style={locationPopoverStyle}>
                  <summary style={locationButtonStyle}>
                    {selectedLocationSummary}
                  </summary>
                  <div style={locationMenuStyle}>
                    <label style={locationOptionRowStyle}>
                      <input
                        type="checkbox"
                        checked={allLocationsSelected}
                        onChange={handleAllLocationsToggle}
                      />
                      <span>All locations</span>
                    </label>
                    <div style={locationHintStyle}>
                      Choose one or more locations to recalculate analytics from available inventory.
                    </div>
                    {locationOptions.map((location) => (
                      <label key={location.id} style={locationOptionRowStyle}>
                        <input
                          type="checkbox"
                          checked={allLocationsSelected || normalizedSelectedLocationIds.includes(location.id)}
                          onChange={() => handleLocationToggle(location.id)}
                        />
                        <span>{location.name}</span>
                      </label>
                    ))}
                  </div>
                </details>
              </div>

              <div style={resultCountStyle}>
                {analytics.filteredSummary.openBackorderOrders} order
                {analytics.filteredSummary.openBackorderOrders === 1 ? "" : "s"}
                {" · "}
                {analytics.filteredSummary.totalAffectedSkus} SKU
                {analytics.filteredSummary.totalAffectedSkus === 1 ? "" : "s"}
                {" · "}
                {analytics.filteredSummary.totalShortageUnits} shortage unit
                {analytics.filteredSummary.totalShortageUnits === 1 ? "" : "s"}
              </div>
            </div>

            {ordersError ? (
              <div style={errorStateStyle}>{ordersError}</div>
            ) : (
              <>
                <div style={analyticsKpiGridStyle}>
                  <div style={analyticsKpiCardStyle}>
                    <div style={summaryLabelStyle}>Open backorder orders</div>
                    <div style={summaryValueStyle}>
                      {analytics.filteredSummary.openBackorderOrders}
                    </div>
                    <div style={summaryHelpStyle}>Current filtered backlog</div>
                  </div>
                  <div style={analyticsKpiCardStyle}>
                    <div style={summaryLabelStyle}>Affected SKUs</div>
                    <div style={summaryValueStyle}>
                      {analytics.filteredSummary.totalAffectedSkus}
                    </div>
                    <div style={summaryHelpStyle}>SKUs with an active shortage</div>
                  </div>
                  <div style={analyticsKpiCardStyle}>
                    <div style={summaryLabelStyle}>Shortage units</div>
                    <div style={summaryValueStyle}>
                      {analytics.filteredSummary.totalShortageUnits}
                    </div>
                    <div style={summaryHelpStyle}>Units currently short</div>
                  </div>
                  <div style={analyticsKpiCardStyle}>
                    <div style={summaryLabelStyle}>Vendors affected</div>
                    <div style={summaryValueStyle}>
                      {analytics.filteredSummary.vendorsAffected}
                    </div>
                    <div style={summaryHelpStyle}>Suppliers in this view</div>
                  </div>
                  <div style={analyticsKpiCardStyle}>
                    <div style={summaryLabelStyle}>Orders older than 14 days</div>
                    <div style={summaryValueStyle}>
                      {analytics.filteredSummary.olderThan14Days}
                    </div>
                    <div style={summaryHelpStyle}>Highest urgency backlog</div>
                  </div>
                </div>

                <div style={analyticsHintStyle}>
                  Click a vendor bar to filter the app. Click a SKU, trend point, or aging bucket to open affected-order drilldowns.
                </div>

                <div style={analyticsGridStyle}>
                  <HorizontalBarChart
                    title="Shortage units by vendor"
                    subtitle="Which suppliers are driving the most shortage volume right now."
                    data={analytics.shortageByVendor}
                    valueFormatter={(value) => `${value} units`}
                    emptyText="No vendor shortage data available."
                    onItemClick={handleAnalyticsVendorClick}
                    activeLabel={selectedVendor === "all" ? null : selectedVendor}
                  />

                  <HorizontalBarChart
                    title="Top backordered SKUs"
                    subtitle="Click a bar to see the affected orders for that SKU."
                    data={analytics.topSkus}
                    valueFormatter={(value) => `${value} short`}
                    emptyText="No SKU shortage data available."
                    onItemClick={handleAnalyticsSkuClick}
                    activeLabel={
                      analyticsDrilldown.type === "sku"
                        ? analytics.topSkus.find(
                            (item) => String(item.key) === String(analyticsDrilldown.label),
                          )?.label
                        : null
                    }
                  />

                  <TrendChart
                    title="Backorder orders over time"
                    subtitle="Click a point to see affected orders created on that day."
                    data={analytics.trend}
                    emptyText="No order trend data available."
                    onPointClick={handleAnalyticsTrendClick}
                    activeLabel={
                      analyticsDrilldown.type === "trend"
                        ? analytics.trend.find((item) => item.dateKey === analyticsDrilldown.label)?.label
                        : null
                    }
                  />

                  <HorizontalBarChart
                    title="Aging buckets"
                    subtitle="Click a bucket to review older backorder orders."
                    data={analytics.aging}
                    valueFormatter={(value) => `${value} orders`}
                    emptyText="No aging data available."
                    onItemClick={handleAnalyticsAgingClick}
                    activeLabel={
                      analyticsDrilldown.type === "aging" ? analyticsDrilldown.label : null
                    }
                  />

                  <div style={insightCardStyle}>
                    <div style={insightHeaderStyle}>
                      <h3 style={insightTitleStyle}>Insights</h3>
                      <p style={insightSubtitleStyle}>
                        Quick operational takeaways from the current snapshot.
                      </p>
                    </div>
                    <ul style={insightListStyle}>
                      {analytics.insights.map((insight) => (
                        <li key={insight} style={insightItemStyle}>
                          {insight}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div style={insightCardStyle}>
                    <div style={insightHeaderStyle}>
                      <h3 style={insightTitleStyle}>Chart actions</h3>
                      <p style={insightSubtitleStyle}>
                        Faster ways to move from analytics into actual work.
                      </p>
                    </div>
                    <div
                      style={{
                        padding: "14px 16px 16px 16px",
                        display: "grid",
                        gap: "10px",
                      }}
                    >
                      <div style={insightItemStyle}>
                        <strong style={{ color: "#0f172a" }}>Vendor chart:</strong>{" "}
                        filters the whole app to one supplier.
                      </div>
                      <div style={insightItemStyle}>
                        <strong style={{ color: "#0f172a" }}>SKU chart:</strong>{" "}
                        opens affected orders for the selected SKU.
                      </div>
                      <div style={insightItemStyle}>
                        <strong style={{ color: "#0f172a" }}>Trend chart:</strong>{" "}
                        shows which orders landed on a selected day.
                      </div>
                      <div style={insightItemStyle}>
                        <strong style={{ color: "#0f172a" }}>Aging chart:</strong>{" "}
                        isolates orders by backlog age bucket.
                      </div>
                    </div>
                  </div>
                </div>

                {analytics.drilldownRows.length > 0 ? (
                  <div ref={analyticsDrilldownRef} style={analyticsDrilldownWrapStyle}>
                    <div style={analyticsDrilldownCardStyle}>
                      <div style={analyticsDrilldownHeaderStyle}>
                        <h3 style={analyticsDrilldownTitleStyle}>
                          {analytics.drilldownTitle}
                        </h3>
                        <button
                          type="button"
                          onClick={() => setAnalyticsDrilldown({ type: null, label: null })}
                          style={analyticsClearButtonStyle}
                        >
                          Clear drilldown
                        </button>
                      </div>

                      <div style={tableWrapStyle}>
                        <table style={tableStyle}>
                          <thead>
                            <tr>
                              <th style={headerCell}>Order</th>
                              <th style={headerCell}>Date</th>
                              <th style={headerCell}>Details</th>
                              <th style={headerCell}>Status / Vendor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analytics.drilldownRows.map((row) => (
                              <tr key={row.id}>
                                <td style={bodyCell}>
                                  <a
                                    href={getOrderAdminUrl(row.adminOrderId)}
                                    target="_top"
                                    rel="noreferrer"
                                    style={orderLinkStyle}
                                  >
                                    {row.orderName}
                                  </a>
                                </td>
                                <td style={bodyCell}>
                                  <span style={mutedTextStyle}>
                                    {new Date(row.date).toLocaleDateString()}
                                  </span>
                                </td>
                                <td style={bodyCell}>
                                  <span style={countTextStyle}>{row.metaPrimary}</span>
                                </td>
                                <td style={bodyCell}>
                                  <span style={mutedTextStyle}>{row.metaSecondary}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
