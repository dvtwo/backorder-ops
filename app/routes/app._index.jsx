import { useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useRevalidator, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import HorizontalBarChart from "../components/HorizontalBarChart";
import TrendChart from "../components/TrendChart";

const chunkArray = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const formatDate = (dateStr) => {
  const date = new Date(dateStr);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((todayStart - dateStart) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const ORDERS_PAGE_SIZE = 100;
const LINE_ITEMS_PAGE_SIZE = 100;
const INVENTORY_BATCH_SIZE = 40;
const MAX_ORDER_PAGES = 25;

const emptySummary = {
  openBackorderOrders: 0,
  totalAffectedSkus: 0,
  totalShortageUnits: 0,
  vendorsAffected: 0,
};

const emptySyncStats = {
  orderPages: 0,
  ordersFetched: 0,
  lineItemsFetched: 0,
  extraLineItemQueries: 0,
  inventoryItemsFetched: 0,
  truncated: false,
};

async function graphqlJson(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(result.errors[0]?.message || "GraphQL query failed");
  }

  return result.data;
}

async function fetchAllOpenOrders(admin) {
  const orders = [];
  let hasNextPage = true;
  let after = null;
  let orderPages = 0;
  let lineItemsFetched = 0;
  let extraLineItemQueries = 0;

  while (hasNextPage && orderPages < MAX_ORDER_PAGES) {
    const data = await graphqlJson(
      admin,
      `#graphql
        query BackorderOrdersPage($first: Int!, $after: String, $lineItemsFirst: Int!) {
          orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true, query: "status:open") {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                name
                createdAt
                displayFulfillmentStatus
                lineItems(first: $lineItemsFirst) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
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
      { first: ORDERS_PAGE_SIZE, after, lineItemsFirst: LINE_ITEMS_PAGE_SIZE },
    );

    const orderConnection = data?.orders;
    const orderEdges = orderConnection?.edges || [];
    orderPages += 1;

    for (const edge of orderEdges) {
      const order = edge?.node;
      if (!order?.id) continue;

      const initialLineItemEdges = order?.lineItems?.edges || [];
      const lineItems = initialLineItemEdges.map((lineEdge) => lineEdge?.node).filter(Boolean);
      lineItemsFetched += lineItems.length;

      let lineItemsHasNextPage = Boolean(order?.lineItems?.pageInfo?.hasNextPage);
      let lineItemsAfter = order?.lineItems?.pageInfo?.endCursor || null;

      while (lineItemsHasNextPage) {
        const lineItemsData = await graphqlJson(
          admin,
          `#graphql
            query BackorderOrderLineItems($id: ID!, $first: Int!, $after: String) {
              order(id: $id) {
                id
                lineItems(first: $first, after: $after) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
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
          `,
          { id: order.id, first: LINE_ITEMS_PAGE_SIZE, after: lineItemsAfter },
        );

        const extraEdges = lineItemsData?.order?.lineItems?.edges || [];
        const extraNodes = extraEdges.map((lineEdge) => lineEdge?.node).filter(Boolean);
        lineItems.push(...extraNodes);
        lineItemsFetched += extraNodes.length;
        extraLineItemQueries += 1;
        lineItemsHasNextPage = Boolean(lineItemsData?.order?.lineItems?.pageInfo?.hasNextPage);
        lineItemsAfter = lineItemsData?.order?.lineItems?.pageInfo?.endCursor || null;
      }

      orders.push({
        id: order.id,
        name: order.name,
        createdAt: order.createdAt,
        displayFulfillmentStatus: order.displayFulfillmentStatus,
        lineItems,
      });
    }

    hasNextPage = Boolean(orderConnection?.pageInfo?.hasNextPage);
    after = orderConnection?.pageInfo?.endCursor || null;
  }

  return {
    orders,
    stats: {
      orderPages,
      ordersFetched: orders.length,
      lineItemsFetched,
      extraLineItemQueries,
      truncated: hasNextPage,
    },
  };
}

async function fetchInventoryByItemId(admin, inventoryItemIds) {
  const inventoryByItemId = {};

  for (const ids of chunkArray(inventoryItemIds, INVENTORY_BATCH_SIZE)) {
    const data = await graphqlJson(
      admin,
      `#graphql
        query InventoryItemLocations($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id
              inventoryLevels(first: 100) {
                edges {
                  node {
                    location {
                      id
                      name
                    }
                    quantities(names: ["available", "incoming"]) {
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
      { ids },
    );

    (data?.nodes || []).forEach((inventoryItem) => {
      if (!inventoryItem?.id) return;

      const locationInventory = (inventoryItem?.inventoryLevels?.edges || []).map(({ node: level }) => ({
        id: level?.location?.id || "",
        name: level?.location?.name || "Unknown location",
        quantity: Math.max(
          Number(
            level?.quantities?.find((quantity) => quantity?.name === "available")
              ?.quantity || 0,
          ),
          0,
        ),
        incoming: Math.max(
          Number(
            level?.quantities?.find((quantity) => quantity?.name === "incoming")
              ?.quantity || 0,
          ),
          0,
        ),
      }));

      inventoryByItemId[inventoryItem.id] = {
        locationInventory,
        inventory: locationInventory.reduce(
          (sum, level) => sum + Number(level.quantity || 0),
          0,
        ),
        incomingInventory: locationInventory.reduce(
          (sum, level) => sum + Number(level.incoming || 0),
          0,
        ),
      };
    });
  }

  return inventoryByItemId;
}

export const loader = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const loadedAt = new Date().toISOString();

    const { orders: rawOrders, stats } = await fetchAllOpenOrders(admin);

    const inventoryItemIds = Array.from(
      new Set(
        rawOrders
          .flatMap((order) => order.lineItems || [])
          .filter((item) => Number(item?.unfulfilledQuantity || 0) > 0)
          .map((item) => item?.variant?.inventoryItem?.id)
          .filter(Boolean),
      ),
    );

    const inventoryByItemId = await fetchInventoryByItemId(admin, inventoryItemIds);
    const skuMap = {};

    rawOrders.forEach((node) => {
      const adminOrderId = node.id?.split("/").pop() || "";
      const lineItems = node.lineItems || [];

      lineItems.forEach((item) => {
        const unfulfilled = Number(item.unfulfilledQuantity || 0);
        if (unfulfilled <= 0) return;

        const key = item.variant?.id || item.sku || `${item.title}-${item.id}`;
        const inventoryItemId = item.variant?.inventoryItem?.id || null;
        const inventoryRecord = inventoryByItemId[inventoryItemId] || (
          inventoryItemId === null
            ? { inventory: 99999, incomingInventory: 0, locationInventory: [] }
            : { inventory: Math.max(Number(item.variant?.inventoryQuantity || 0), 0), incomingInventory: 0, locationInventory: [] }
        );

        if (!skuMap[key]) {
          skuMap[key] = {
            key,
            sku: item.sku || "—",
            product: item.title,
            vendor: item.vendor || "—",
            variantId: item.variant?.id || null,
            inventory: inventoryRecord.inventory,
            totalUnfulfilled: 0,
            shortage: 0,
            affectedOrders: [],
            incomingInventory: Number(inventoryRecord.incomingInventory || 0),
            hasIncomingInventory: Number(inventoryRecord.incomingInventory || 0) > 0,
            purchaseOrderUrl: Number(inventoryRecord.incomingInventory || 0) > 0
              ? `https://${session.shop}/admin/purchase_orders`
              : "",
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


    const openOrdersDetailed = rawOrders
      .map((node) => {
        const adminOrderId = node.id?.split("/").pop() || "";
        const unfulfilledLineItems = (node.lineItems || [])
          .filter((item) => Number(item?.unfulfilledQuantity || 0) > 0)
          .map((item) => {
            const key = item.variant?.id || item.sku || `${item.title}-${item.id}`;
            const inventoryItemId = item.variant?.inventoryItem?.id || null;
            const inventoryRecord = inventoryByItemId[inventoryItemId] || (
              inventoryItemId === null
                ? { inventory: 99999, incomingInventory: 0, locationInventory: [] }
                : { inventory: Math.max(Number(item.variant?.inventoryQuantity || 0), 0), incomingInventory: 0, locationInventory: [] }
            );

            return {
              id: item.id,
              key,
              sku: item.sku || "—",
              product: item.title,
              vendor: item.vendor || "—",
              quantity: Number(item.quantity || 0),
              unfulfilled: Number(item.unfulfilledQuantity || 0),
              variantId: item.variant?.id || null,
              inventoryItemId,
              inventory: Number(inventoryRecord.inventory || 0),
              incomingInventory: Number(inventoryRecord.incomingInventory || 0),
              hasIncomingInventory: Number(inventoryRecord.incomingInventory || 0) > 0,
              purchaseOrderUrl: Number(inventoryRecord.incomingInventory || 0) > 0
                ? `https://${session.shop}/admin/purchase_orders`
                : "",
              locationInventory: inventoryRecord.locationInventory || [],
            };
          });

        return {
          id: node.id,
          adminOrderId,
          name: node.name,
          date: node.createdAt,
          status: node.displayFulfillmentStatus,
          items: (node.lineItems || []).length,
          unfulfilledLineItems,
        };
      })
      .filter((order) => (order.unfulfilledLineItems || []).length > 0);

    const orders = rawOrders
      .map((node) => {
        const lineItems = node.lineItems || [];

        const backorderedLineItems = lineItems
          .filter((item) => {
            const unfulfilled = Number(item.unfulfilledQuantity || 0);
            if (unfulfilled <= 0) return false;

            const key = item.variant?.id || item.sku || `${item.title}-${item.id}`;
            const aggregate = skuMap[key];

            return aggregate && aggregate.shortage > 0;
          })
          .map((item) => ({
            id: item.id,
            key: item.variant?.id || item.sku || `${item.title}-${item.id}`,
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
      openOrdersDetailed,
      restock,
      summary,
      ordersError: "",
      loadedAt,
      syncStats: {
        ...emptySyncStats,
        ...stats,
        inventoryItemsFetched: inventoryItemIds.length,
      },
    };
  } catch (error) {
    return {
      shop: "",
      orders: [],
      openOrdersDetailed: [],
      restock: [],
      summary: emptySummary,
      ordersError: error instanceof Error ? error.message : "Failed to load data",
      loadedAt: new Date().toISOString(),
      syncStats: emptySyncStats,
    };
  }
};

export default function AppIndex() {
  const { shop, orders, openOrdersDetailed, restock, summary, ordersError, loadedAt, syncStats } = useLoaderData();
  const revalidator = useRevalidator();
  const isRefreshing = revalidator.state !== "idle";
  const [activeTab, setActiveTab] = useState("backorders");
  const [shipStatusFilter, setShipStatusFilter] = useState("all");
  const [selectedVendor, setSelectedVendor] = useState("all");
  const [selectedLocationIds, setSelectedLocationIds] = useState([]);
  const [selectedSkuKey, setSelectedSkuKey] = useState(null);
  const [copiedAction, setCopiedAction] = useState("");
  const [analyticsDrilldown, setAnalyticsDrilldown] = useState({
    type: null,
    label: null,
  });
  const analyticsDrilldownRef = useRef(null);
  const skuDrawerRef = useRef(null);

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

        const selectedIncomingInventory = (item.locationInventory || [])
          .filter(
            (location) =>
              allLocationsSelected ||
              normalizedSelectedLocationIds.includes(location.id),
          )
          .reduce((sum, location) => sum + Number(location.incoming || 0), 0);

        return {
          ...item,
          inventory: selectedInventory,
          incomingInventory: selectedIncomingInventory,
          hasIncomingInventory: selectedIncomingInventory > 0,
          purchaseOrderUrl: selectedIncomingInventory > 0
            ? `https://${shop}/admin/purchase_orders`
            : "",
          shortage: Math.max(Number(item.totalUnfulfilled || 0) - selectedInventory, 0),
        };
      })
      .filter((item) => Number(item.shortage || 0) > 0);
  }, [allLocationsSelected, normalizedSelectedLocationIds, restock, shop]);

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


  const selectedSkuItem = useMemo(() => {
    if (!selectedSkuKey) return null;
    return (
      filteredRestock.find((item) => String(item.key || "") === String(selectedSkuKey)) ||
      null
    );
  }, [filteredRestock, selectedSkuKey]);

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


  const fulfillmentOrders = useMemo(() => {
    const inventoryPools = {};

    openOrdersDetailed.forEach((order) => {
      (order.unfulfilledLineItems || []).forEach((item) => {
        if (inventoryPools[item.key] !== undefined) return;

        const selectedInventory = (item.locationInventory || [])
          .filter(
            (location) =>
              allLocationsSelected ||
              normalizedSelectedLocationIds.includes(location.id),
          )
          .reduce((sum, location) => sum + Number(location.quantity || 0), 0);

        inventoryPools[item.key] = selectedInventory;
      });
    });

    return openOrdersDetailed
      .slice()
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map((order) => {
        let fullyAllocatedLines = 0;
        let partiallyAllocatedLines = 0;
        let allocatedUnits = 0;
        let totalUnfulfilledUnits = 0;

        const lineItems = (order.unfulfilledLineItems || []).map((item) => {
          const availableBefore = Number(inventoryPools[item.key] || 0);
          const allocated = Math.min(Number(item.unfulfilled || 0), availableBefore);
          const availableAfter = Math.max(availableBefore - allocated, 0);
          inventoryPools[item.key] = availableAfter;

          totalUnfulfilledUnits += Number(item.unfulfilled || 0);
          allocatedUnits += allocated;

          if (allocated >= Number(item.unfulfilled || 0) && Number(item.unfulfilled || 0) > 0) {
            fullyAllocatedLines += 1;
          } else if (allocated > 0) {
            partiallyAllocatedLines += 1;
          }

          return {
            ...item,
            selectedInventory: availableBefore,
            allocated,
            remainingShort: Math.max(Number(item.unfulfilled || 0) - allocated, 0),
            fulfillmentState:
              allocated >= Number(item.unfulfilled || 0) && Number(item.unfulfilled || 0) > 0
                ? "ready_to_ship"
                : allocated > 0
                  ? "partially_in_stock"
                  : "waiting_for_stock",
          };
        });

        let fulfillmentState = "waiting_for_stock";
        if (lineItems.length > 0 && fullyAllocatedLines === lineItems.length) {
          fulfillmentState = "ready_to_ship";
        } else if (allocatedUnits > 0 || partiallyAllocatedLines > 0 || fullyAllocatedLines > 0) {
          fulfillmentState = "partially_in_stock";
        }

        return {
          ...order,
          lineItems,
          fulfillmentState,
          allocatedUnits,
          totalUnfulfilledUnits,
          readyLineCount: fullyAllocatedLines,
          partiallyAllocatedLines,
        };
      })
      .filter((order) => order.fulfillmentState !== "waiting_for_stock");
  }, [
    allLocationsSelected,
    normalizedSelectedLocationIds,
    openOrdersDetailed,
  ]);

  const filteredFulfillmentOrders = useMemo(() => {
    if (shipStatusFilter === "all") return fulfillmentOrders;
    return fulfillmentOrders.filter((order) => order.fulfillmentState === shipStatusFilter);
  }, [fulfillmentOrders, shipStatusFilter]);

  const fulfillmentSummary = useMemo(() => {
    const readyToShip = fulfillmentOrders.filter(
      (order) => order.fulfillmentState === "ready_to_ship",
    ).length;
    const partiallyInStock = fulfillmentOrders.filter(
      (order) => order.fulfillmentState === "partially_in_stock",
    ).length;

    return {
      eligibleOrders: fulfillmentOrders.length,
      readyToShip,
      partiallyInStock,
      allocatedUnits: fulfillmentOrders.reduce(
        (sum, order) => sum + Number(order.allocatedUnits || 0),
        0,
      ),
    };
  }, [fulfillmentOrders]);

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


  useEffect(() => {
    if (!selectedSkuItem && selectedSkuKey) {
      setSelectedSkuKey(null);
    }
  }, [selectedSkuItem, selectedSkuKey]);

  useEffect(() => {
    if (!selectedSkuKey) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setSelectedSkuKey(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedSkuKey]);

  useEffect(() => {
    if (!copiedAction) return undefined;
    const timeout = window.setTimeout(() => setCopiedAction(""), 1800);
    return () => window.clearTimeout(timeout);
  }, [copiedAction]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('[data-location-popover="true"]')) {
        document
          .querySelectorAll('[data-location-popover="true"]')
          .forEach((el) => el.removeAttribute("open"));
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
    background: "linear-gradient(135deg, #ffffff 0%, #f0f6ff 100%)",
    border: "1px solid #c7d7f5",
    borderRadius: "14px",
    padding: "16px 18px",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.06)",
    borderLeft: "4px solid #3b82f6",
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
    display: "inline-flex",
    gap: "6px",
    alignItems: "center",
    flexWrap: "wrap",
    padding: "6px",
    border: "1px solid #dbe3ef",
    borderRadius: "14px",
    background: "#ffffff",
    boxShadow: "0 2px 8px rgba(15, 23, 42, 0.04)",
    marginBottom: "2px",
  };

  const getTabStyle = (isActive) => ({
    appearance: "none",
    border: isActive ? "1px solid #bfdbfe" : "1px solid transparent",
    background: isActive ? "#dbeafe" : "transparent",
    color: isActive ? "#1d4ed8" : "#5b677a",
    padding: "8px 14px",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: fontStack,
    fontSize: "13px",
    fontWeight: isActive ? 700 : 500,
    boxShadow: isActive ? "0 1px 4px rgba(29, 78, 216, 0.14)" : "none",
    transition: "all 0.15s ease",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
  });

  const getTabBadgeStyle = (isActive) => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "20px",
    padding: "1px 5px",
    height: "18px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: 700,
    lineHeight: 1,
    background: isActive ? "#1d4ed8" : "#e2e8f0",
    color: isActive ? "#ffffff" : "#64748b",
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
    justifyContent: "space-between",
    gap: "14px",
    flexWrap: "wrap",
    padding: "14px 18px",
    borderBottom: "1px solid #e7edf5",
    background: "#fcfdff",
  };

  const toolbarControlsStyle = {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  };

  const labelStyle = {
    fontSize: "12px",
    fontWeight: 600,
    color: "#475467",
    whiteSpace: "nowrap",
  };

  const selectStyle = {
    fontFamily: fontStack,
    fontSize: "13px",
    color: "#17212b",
    padding: "0 12px",
    height: "38px",
    borderRadius: "10px",
    border: "1px solid #cfd8e6",
    background: "#ffffff",
    minWidth: "220px",
    outline: "none",
    boxSizing: "border-box",
  };

  const filterGroupStyle = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    flexWrap: "nowrap",
  };

  const locationPopoverStyle = {
    position: "relative",
  };

  const locationButtonStyle = {
    appearance: "none",
    border: "1px solid #cfd8e6",
    background: "#ffffff",
    color: "#17212b",
    padding: "0 12px",
    height: "38px",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: fontStack,
    fontSize: "13px",
    fontWeight: 500,
    minWidth: "220px",
    textAlign: "left",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    listStyle: "none",
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
    fontWeight: 600,
    whiteSpace: "nowrap",
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


  const fulfillmentBadgeStyles = {
    ready_to_ship: {
      display: "inline-block",
      padding: "4px 8px",
      borderRadius: "999px",
      fontSize: "11px",
      fontWeight: 700,
      background: "#ecfdf3",
      color: "#067647",
      border: "1px solid #abefc6",
      whiteSpace: "nowrap",
    },
    partially_in_stock: {
      display: "inline-block",
      padding: "4px 8px",
      borderRadius: "999px",
      fontSize: "11px",
      fontWeight: 700,
      background: "#fff4df",
      color: "#9a6700",
      border: "1px solid #f1cf8c",
      whiteSpace: "nowrap",
    },
    waiting_for_stock: {
      display: "inline-block",
      padding: "4px 8px",
      borderRadius: "999px",
      fontSize: "11px",
      fontWeight: 700,
      background: "#f2f4f7",
      color: "#667085",
      border: "1px solid #d0d5dd",
      whiteSpace: "nowrap",
    },
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
    background: "linear-gradient(180deg, #f0f4ff 0%, #e8f0fe 100%)",
    borderBottom: "1px solid #c7d7f5",
    borderLeft: "3px solid #3b82f6",
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

  const drawerOverlayStyle = {
    position: "fixed",
    inset: 0,
    background: "rgba(15, 23, 42, 0.28)",
    zIndex: 40,
  };

  const drawerStyle = {
    position: "fixed",
    top: 0,
    right: 0,
    width: "min(520px, 96vw)",
    height: "100dvh",
    maxHeight: "100dvh",
    background: "#ffffff",
    borderLeft: "1px solid #dbe3ef",
    boxShadow: "-18px 0 40px rgba(15, 23, 42, 0.14)",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    overscrollBehavior: "contain",
    minHeight: 0,
  };

  const drawerHeaderWrapStyle = {
    padding: "18px 20px 16px 20px",
    borderBottom: "1px solid #e7edf5",
    background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
    display: "grid",
    gap: "12px",
    flexShrink: 0,
  };

  const drawerCloseButtonStyle = {
    appearance: "none",
    border: "1px solid #d5deea",
    background: "#ffffff",
    borderRadius: "10px",
    padding: "8px 10px",
    fontSize: "12px",
    fontWeight: 600,
    color: "#17212b",
    cursor: "pointer",
  };

  const drawerBodyStyle = {
    flex: "1 1 auto",
    minHeight: 0,
    height: 0,
    overflowY: "scroll",
    overflowX: "hidden",
    WebkitOverflowScrolling: "touch",
    overscrollBehavior: "contain",
    touchAction: "pan-y",
    padding: "18px 20px calc(40px + env(safe-area-inset-bottom, 0px)) 20px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  };

  const drawerSkuStyle = {
    fontSize: "22px",
    fontWeight: 800,
    lineHeight: 1.1,
    color: "#0f172a",
    margin: 0,
  };

  const drawerProductStyle = {
    margin: 0,
    fontSize: "13px",
    lineHeight: 1.5,
    color: "#526076",
  };

  const drawerMetaGridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "10px",
  };

  const drawerMetaCardStyle = {
    border: "1px solid #e7edf5",
    borderRadius: "12px",
    padding: "12px",
    background: "#fbfdff",
  };

  const drawerMetaLabelStyle = {
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.02em",
    textTransform: "uppercase",
    color: "#667085",
  };

  const drawerMetaValueStyle = {
    marginTop: "6px",
    fontSize: "18px",
    fontWeight: 800,
    color: "#0f172a",
  };

  const drawerSectionCardStyle = {
    border: "1px solid #dbe3ef",
    borderRadius: "14px",
    background: "#ffffff",
    overflow: "hidden",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.04)",
  };

  const drawerSectionHeaderStyle = {
    padding: "14px 16px 10px 16px",
    borderBottom: "1px solid #e7edf5",
    background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)",
  };

  const drawerSectionTitleStyle = {
    margin: 0,
    fontSize: "14px",
    fontWeight: 700,
    color: "#0f172a",
  };

  const drawerSectionTextStyle = {
    margin: "4px 0 0 0",
    fontSize: "12px",
    lineHeight: 1.45,
    color: "#667085",
  };

  const drawerSectionBodyStyle = {
    padding: "14px 16px 16px 16px",
    display: "grid",
    gap: "10px",
  };

  const drawerOrderRowStyle = {
    border: "1px solid #e7edf5",
    borderRadius: "12px",
    padding: "10px 12px",
    background: "#fbfdff",
    display: "grid",
    gap: "6px",
  };

  const drawerActionRowStyle = {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
  };

  const drawerActionButtonStyle = {
    appearance: "none",
    border: "1px solid #d5deea",
    background: "#ffffff",
    borderRadius: "10px",
    padding: "10px 12px",
    fontSize: "12px",
    fontWeight: 700,
    color: "#17212b",
    cursor: "pointer",
  };

  const drawerActionPrimaryStyle = {
    ...drawerActionButtonStyle,
    background: "linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)",
    border: "1px solid #bfdbfe",
    color: "#1d4ed8",
  };

  const locationListRowStyle = {
    display: "flex",
    justifyContent: "space-between",
    gap: "10px",
    alignItems: "center",
    border: "1px solid #e7edf5",
    borderRadius: "12px",
    padding: "10px 12px",
    background: "#fbfdff",
  };

  const includedBadgeStyle = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "62px",
    padding: "4px 8px",
    borderRadius: "999px",
    background: "#ecfdf3",
    color: "#067647",
    fontSize: "11px",
    fontWeight: 700,
  };

  const mutedBadgeStyle = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "62px",
    padding: "4px 8px",
    borderRadius: "999px",
    background: "#f2f4f7",
    color: "#667085",
    fontSize: "11px",
    fontWeight: 700,
  };

  const formatStatus = (status) => {
    if (!status) return "Unknown";
    return status
      .toString()
      .replaceAll("_", " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const formatFulfillmentState = (state) => {
    if (state === "ready_to_ship") return "Ready to ship";
    if (state === "partially_in_stock") return "Partially in stock";
    return "Waiting for stock";
  };

  const getOrderAdminUrl = (adminOrderId) => {
    if (!shop || !adminOrderId) return "#";
    return `https://${shop}/admin/orders/${adminOrderId}`;
  };

  const getPurchaseOrdersAdminUrl = () => {
    if (!shop) return "#";
    return `https://${shop}/admin/purchase_orders`;
  };

  const openSkuDrawer = (key) => {
    setSelectedSkuKey(String(key || ""));
  };

  const closeSkuDrawer = () => {
    setSelectedSkuKey(null);
  };

  const handleVendorFilterChange = (value) => {
    setSelectedVendor(value);
    setAnalyticsDrilldown({ type: null, label: null });
  };

  const closeLocationMenus = () => {
    if (typeof document === "undefined") return;
    document
      .querySelectorAll('[data-location-popover="true"]')
      .forEach((element) => element.removeAttribute("open"));
  };

  const handleLocationToggle = (locationId) => {
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
    closeLocationMenus();
  };

  const handleAllLocationsToggle = () => {
    setAnalyticsDrilldown({ type: null, label: null });
    setSelectedLocationIds([]);
    closeLocationMenus();
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

  const copyText = async (value, successLabel) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(String(value || ""));
        setCopiedAction(successLabel);
      }
    } catch (error) {
      console.error("Clipboard copy failed", error);
    }
  };

  const exportSingleSkuCsv = (item) => {
    if (!item) return;

    const headers = [
      "SKU",
      "Product",
      "Vendor",
      "Selected Inventory",
      "Total Unfulfilled",
      "Shortage",
      "Affected Orders",
    ];

    const row = [
      csvEscape(item.sku),
      csvEscape(item.product),
      csvEscape(item.vendor),
      csvEscape(item.inventory),
      csvEscape(item.totalUnfulfilled),
      csvEscape(item.shortage),
      csvEscape((item.affectedOrders || []).map((order) => order.orderName).join(" | ")),
    ];

    const csvContent = [headers.join(","), row.join(",")].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const fileName = `backorder-sku-${String(item.sku || item.product || "item")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}.csv`;

    link.href = url;
    link.setAttribute("download", fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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

        {syncStats?.truncated ? (
          <div
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "flex-start",
              padding: "14px 16px",
              borderRadius: "12px",
              border: "1px solid #f4caca",
              background: "#fff5f5",
              boxShadow: "0 2px 6px rgba(155, 28, 28, 0.06)",
              fontFamily: fontStack,
            }}
          >
            <span style={{ fontSize: "16px", lineHeight: 1.4 }}>⚠️</span>
            <div>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#9b1c1c", marginBottom: "4px" }}>
                Partial data — only the most recent 2,500 orders were scanned
              </div>
              <div style={{ fontSize: "12px", color: "#b42318", lineHeight: 1.5 }}>
                Your store has more open orders than this app can fetch in a single load. Shortage totals, restock lists, and analytics may be incomplete. Refresh to re-check, or contact support if this persists.
              </div>
            </div>
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "12px",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "18px",
            padding: "12px 14px",
            borderRadius: "12px",
            border: "1px solid #dbe3ef",
            background: "#ffffff",
            boxShadow: "0 3px 10px rgba(15, 23, 42, 0.03)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
              Data sync
            </div>
            <div style={{ fontSize: "13px", color: "#475569" }}>
              Last loaded {loadedAt ? new Date(loadedAt).toLocaleString() : "just now"}
              {syncStats?.ordersFetched ? ` • ${syncStats.ordersFetched} open orders scanned` : ""}
              {syncStats?.inventoryItemsFetched ? ` • ${syncStats.inventoryItemsFetched} inventory items checked` : ""}
              {syncStats?.truncated ? " • Reached pagination safety limit" : ""}
            </div>
          </div>

          <button
            type="button"
            onClick={() => revalidator.revalidate()}
            disabled={isRefreshing}
            style={{
              border: "1px solid #cbd5e1",
              background: isRefreshing ? "#f8fafc" : "#ffffff",
              color: "#0f172a",
              borderRadius: "10px",
              padding: "10px 14px",
              fontSize: "13px",
              fontWeight: 700,
              cursor: isRefreshing ? "wait" : "pointer",
              boxShadow: "0 2px 6px rgba(15, 23, 42, 0.04)",
            }}
          >
            {isRefreshing ? "Refreshing…" : "Refresh data"}
          </button>
        </div>

<div style={summaryGridStyle}>
          <div style={{ ...summaryCardStyle, borderLeft: "3px solid #f97316", background: "linear-gradient(135deg, #fff7ed 0%, #ffffff 60%)" }}>
            <div style={{ ...summaryLabelStyle, color: "#c2410c" }}>Open backorder orders</div>
            <div style={{ ...summaryValueStyle, color: "#9a3412" }}>{summary.openBackorderOrders}</div>
            <div style={summaryHelpStyle}>Orders currently affected</div>
          </div>

          <div style={{ ...summaryCardStyle, borderLeft: "3px solid #f59e0b", background: "linear-gradient(135deg, #fffbeb 0%, #ffffff 60%)" }}>
            <div style={{ ...summaryLabelStyle, color: "#b45309" }}>Total affected SKUs</div>
            <div style={{ ...summaryValueStyle, color: "#92400e" }}>{summary.totalAffectedSkus}</div>
            <div style={summaryHelpStyle}>Unique SKUs needing action</div>
          </div>

          <div style={{ ...summaryCardStyle, borderLeft: "3px solid #dc2626", background: "linear-gradient(135deg, #fef2f2 0%, #ffffff 60%)" }}>
            <div style={{ ...summaryLabelStyle, color: "#b91c1c" }}>Total shortage units</div>
            <div style={{ ...summaryValueStyle, color: "#991b1b" }}>{summary.totalShortageUnits}</div>
            <div style={summaryHelpStyle}>Units short across all orders</div>
          </div>

          <div style={{ ...summaryCardStyle, borderLeft: "3px solid #6366f1", background: "linear-gradient(135deg, #eef2ff 0%, #ffffff 60%)" }}>
            <div style={{ ...summaryLabelStyle, color: "#4338ca" }}>Vendors affected</div>
            <div style={{ ...summaryValueStyle, color: "#3730a3" }}>{summary.vendorsAffected}</div>
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
            {orders.length > 0 && <span style={getTabBadgeStyle(activeTab === "backorders")}>{orders.length}</span>}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("fulfillment")}
            style={getTabStyle(activeTab === "fulfillment")}
          >
            Fulfillment
            {fulfillmentOrders.length > 0 && <span style={getTabBadgeStyle(activeTab === "fulfillment")}>{fulfillmentOrders.length}</span>}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("restock")}
            style={getTabStyle(activeTab === "restock")}
          >
            Restock
            {restock.length > 0 && <span style={getTabBadgeStyle(activeTab === "restock")}>{restock.length}</span>}
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
                            target="_blank"
                            rel="noreferrer"
                            style={orderLinkStyle}
                          >
                            {o.name}
                          </a>
                        </td>
                        <td style={bodyCell}>
                          <span style={mutedTextStyle}>
                            {formatDate(o.date)}
                          </span>
                        </td>
                        <td style={bodyCell}>
                          <span style={countTextStyle}>{o.items}</span>
                        </td>
                        <td style={bodyCell}>
                          <span style={o.unfulfilledItems > 1 ? shortageBadgeStyle : countTextStyle}>{o.unfulfilledItems}</span>
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
        ) : activeTab === "fulfillment" ? (
          <div style={cardStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>Orders ready to ship</h2>
              <p style={sectionTextStyle}>
                Open orders re-evaluated against current available inventory. Orders are allocated oldest first so this view reflects which orders can ship now and which are only partially covered.
              </p>
            </div>

            <div style={toolbarStyle}>
              <div style={toolbarControlsStyle}>
                <div style={filterGroupStyle}>
                  <label htmlFor="fulfillment-status-filter" style={labelStyle}>
                    Filter by stock status
                  </label>
                  <select
                    id="fulfillment-status-filter"
                    value={shipStatusFilter}
                    onChange={(event) => setShipStatusFilter(event.target.value)}
                    style={selectStyle}
                  >
                    <option value="all">All eligible orders</option>
                    <option value="ready_to_ship">Ready to ship</option>
                    <option value="partially_in_stock">Partially in stock</option>
                  </select>
                </div>

                <div style={filterGroupStyle}>
                  <span style={labelStyle}>Inventory locations</span>
                  <details data-location-popover="true" style={locationPopoverStyle}>
                    <summary style={locationButtonStyle}>
                      <span style={{ marginRight: "8px", fontSize: "11px" }}>▼</span>
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
                        Choose one or more locations to recalculate which orders can ship now.
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
              </div>

              <div style={resultCountStyle}>
                {filteredFulfillmentOrders.length} order
                {filteredFulfillmentOrders.length === 1 ? "" : "s"}
                {" · "}
                {fulfillmentSummary.readyToShip} ready to ship
                {" · "}
                {fulfillmentSummary.partiallyInStock} partially in stock
                {" · "}
                {fulfillmentSummary.allocatedUnits} unit
                {fulfillmentSummary.allocatedUnits === 1 ? "" : "s"} allocatable
              </div>
            </div>

            {ordersError ? (
              <div style={errorStateStyle}>{ordersError}</div>
            ) : filteredFulfillmentOrders.length === 0 ? (
              <div style={emptyStateStyle}>
                No open orders currently match this stock status filter.
              </div>
            ) : (
              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={headerCell}>Order</th>
                      <th style={headerCell}>Date</th>
                      <th style={headerCell}>Allocatable</th>
                      <th style={headerCell}>Line coverage</th>
                      <th style={headerCell}>SKU coverage</th>
                      <th style={headerCell}>Ship status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFulfillmentOrders.map((order) => (
                      <tr key={`ship-${order.id}`}>
                        <td style={bodyCell}>
                          <a
                            href={getOrderAdminUrl(order.adminOrderId)}
                            target="_blank"
                            rel="noreferrer"
                            style={orderLinkStyle}
                          >
                            {order.name}
                          </a>
                        </td>
                        <td style={bodyCell}>
                          <span style={mutedTextStyle}>
                            {formatDate(order.date)}
                          </span>
                        </td>
                        <td style={bodyCell}>
                          <span style={countTextStyle}>
                            {order.allocatedUnits} / {order.totalUnfulfilledUnits} units
                          </span>
                        </td>
                        <td style={bodyCell}>
                          <span style={countTextStyle}>
                            {order.readyLineCount} / {order.lineItems.length} line
                            {order.lineItems.length === 1 ? "" : "s"} fully covered
                          </span>
                        </td>
                        <td style={bodyCell}>
                          <div style={lineItemsListStyle}>
                            {order.lineItems.map((item) => (
                              <div key={item.id} style={lineItemRowStyle}>
                                <div style={lineItemTextStyle}>
                                  <span style={skuLabelStyle}>SKU: </span>
                                  <span style={skuValueStyle}>{item.sku}</span>
                                  {"  |  "}
                                  <span style={vendorInlineStyle}>{item.vendor}</span>
                                </div>
                                <div style={{ ...lineItemTextStyle, marginTop: "4px" }}>
                                  {item.allocated} / {item.unfulfilled} allocatable
                                  {item.remainingShort > 0 ? ` • ${item.remainingShort} still short` : " • fully covered"}
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td style={bodyCell}>
                          <span style={fulfillmentBadgeStyles[order.fulfillmentState]}>
                            {formatFulfillmentState(order.fulfillmentState)}
                          </span>
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
                <details data-location-popover="true" style={locationPopoverStyle}>
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
                            <th style={headerCell}>On open PO</th>
                            <th style={headerCell}>Qty on order</th>
                            <th style={headerCell}>Total Shortage</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.map((item) => {
                            const rowKey = item.variantId || item.sku || item.product;

                            return (
                              <tr key={`${group.vendor}-${rowKey}`}>
                                <td style={bodyCell}>
                                  <button
                                    type="button"
                                    onClick={() => openSkuDrawer(rowKey)}
                                    style={drilldownButtonStyle}
                                  >
                                    <span style={skuValueStyle}>{item.sku}</span>
                                  </button>
                                </td>
                                <td style={{ ...bodyCell, maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.product}>{item.product}</td>
                                <td style={bodyCell}>
                                  <span style={countTextStyle}>{item.totalUnfulfilled}</span>
                                </td>
                                <td style={bodyCell}>
                                  <span style={countTextStyle}>{item.inventory}</span>
                                </td>
                                <td style={bodyCell}>
                                  {item.hasIncomingInventory ? (
                                    <a
                                      href={item.purchaseOrderUrl || getPurchaseOrdersAdminUrl()}
                                      target="_blank"
                                      rel="noreferrer"
                                      style={orderLinkStyle}
                                      title="Open Shopify Purchase Orders"
                                    >
                                      Yes
                                    </a>
                                  ) : (
                                    <span style={mutedTextStyle}>No</span>
                                  )}
                                </td>
                                <td style={bodyCell}>
                                  {item.hasIncomingInventory ? (
                                    <a
                                      href={item.purchaseOrderUrl || getPurchaseOrdersAdminUrl()}
                                      target="_blank"
                                      rel="noreferrer"
                                      style={orderLinkStyle}
                                      title="Open Shopify Purchase Orders"
                                    >
                                      {item.incomingInventory}
                                    </a>
                                  ) : (
                                    <span style={mutedTextStyle}>0</span>
                                  )}
                                </td>
                                <td style={bodyCell}>
                                  <span style={shortageBadgeStyle}>{item.shortage}</span>
                                </td>
                              </tr>
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
                <details data-location-popover="true" style={locationPopoverStyle}>
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
                                    target="_blank"
                                    rel="noreferrer"
                                    style={orderLinkStyle}
                                  >
                                    {row.orderName}
                                  </a>
                                </td>
                                <td style={bodyCell}>
                                  <span style={mutedTextStyle}>
                                    {formatDate(row.date)}
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

      {selectedSkuItem ? (
        <>
          <button
            type="button"
            aria-label="Close SKU details"
            onClick={closeSkuDrawer}
            style={drawerOverlayStyle}
          />
          <aside ref={skuDrawerRef} style={drawerStyle} aria-label="SKU details panel">
            <div style={drawerHeaderWrapStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
                <div style={{ display: "grid", gap: "6px" }}>
                  <p style={drawerSkuStyle}>{selectedSkuItem.sku}</p>
                  <p style={drawerProductStyle}>{selectedSkuItem.product}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    <span style={vendorMetaBadgeStyle}>{selectedSkuItem.vendor}</span>
                    <span style={vendorMetaBadgeStyle}>{selectedSkuItem.affectedOrders.length} affected order{selectedSkuItem.affectedOrders.length === 1 ? "" : "s"}</span>
                  </div>
                </div>
                <button type="button" onClick={closeSkuDrawer} style={drawerCloseButtonStyle}>
                  Close
                </button>
              </div>

              <div style={drawerMetaGridStyle}>
                <div style={drawerMetaCardStyle}>
                  <div style={drawerMetaLabelStyle}>Selected inventory</div>
                  <div style={drawerMetaValueStyle}>{selectedSkuItem.inventory}</div>
                </div>
                <div style={drawerMetaCardStyle}>
                  <div style={drawerMetaLabelStyle}>Unfulfilled</div>
                  <div style={drawerMetaValueStyle}>{selectedSkuItem.totalUnfulfilled}</div>
                </div>
                <div style={drawerMetaCardStyle}>
                  <div style={drawerMetaLabelStyle}>On order</div>
                  <div style={drawerMetaValueStyle}>{selectedSkuItem.incomingInventory || 0}</div>
                </div>
                <div style={drawerMetaCardStyle}>
                  <div style={drawerMetaLabelStyle}>Shortage</div>
                  <div style={drawerMetaValueStyle}>{selectedSkuItem.shortage}</div>
                </div>
              </div>
            </div>

            <div style={drawerBodyStyle}>
              <div style={drawerSectionCardStyle}>
                <div style={drawerSectionHeaderStyle}>
                  <h3 style={drawerSectionTitleStyle}>Quick actions</h3>
                  <p style={drawerSectionTextStyle}>Fast actions for purchasing and order follow-up.</p>
                </div>
                <div style={drawerSectionBodyStyle}>
                  <div style={drawerActionRowStyle}>
                    <button
                      type="button"
                      onClick={() => copyText(selectedSkuItem.sku, "SKU copied")}
                      style={drawerActionPrimaryStyle}
                    >
                      Copy SKU
                    </button>
                    <button
                      type="button"
                      onClick={() => copyText(
                        (selectedSkuItem.affectedOrders || []).map((order) => order.orderName).join(", "),
                        "Order numbers copied",
                      )}
                      style={drawerActionButtonStyle}
                    >
                      Copy order numbers
                    </button>
                    <button
                      type="button"
                      onClick={() => exportSingleSkuCsv(selectedSkuItem)}
                      style={drawerActionButtonStyle}
                    >
                      Export this SKU
                    </button>
                    {(selectedSkuItem.affectedOrders || [])[0]?.adminOrderId ? (
                      <a
                        href={getOrderAdminUrl(selectedSkuItem.affectedOrders[0].adminOrderId)}
                        target="_blank"
                        rel="noreferrer"
                        style={{ ...drawerActionButtonStyle, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                      >
                        Open first order
                      </a>
                    ) : null}
                    {selectedSkuItem.hasIncomingInventory ? (
                      <a
                        href={selectedSkuItem.purchaseOrderUrl || getPurchaseOrdersAdminUrl()}
                        target="_blank"
                        rel="noreferrer"
                        style={{ ...drawerActionButtonStyle, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                      >
                        Open purchase orders
                      </a>
                    ) : null}
                  </div>
                  {copiedAction ? <div style={locationHintStyle}>{copiedAction}</div> : null}
                </div>
              </div>

              <div style={drawerSectionCardStyle}>
                <div style={drawerSectionHeaderStyle}>
                  <h3 style={drawerSectionTitleStyle}>Per-location inventory</h3>
                  <p style={drawerSectionTextStyle}>See every location and which ones are included in the current restock filter.</p>
                </div>
                <div style={drawerSectionBodyStyle}>
                  {(selectedSkuItem.locationInventory || []).length === 0 ? (
                    <div style={emptyStateStyle}>No location-level inventory was returned for this SKU.</div>
                  ) : (
                    (selectedSkuItem.locationInventory || [])
                      .slice()
                      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                      .map((location) => {
                        const included =
                          allLocationsSelected ||
                          normalizedSelectedLocationIds.includes(location.id);

                        return (
                          <div key={`${selectedSkuItem.key}-${location.id}`} style={locationListRowStyle}>
                            <div style={{ display: "grid", gap: "4px" }}>
                              <div style={{ fontSize: "13px", fontWeight: 700, color: "#17212b" }}>{location.name}</div>
                              <div style={{ fontSize: "12px", color: "#667085" }}>
                                Available: {location.quantity}
                                {Number(location.incoming || 0) > 0 ? ` • On order: ${location.incoming}` : ""}
                              </div>
                            </div>
                            <div style={{ display: "grid", justifyItems: "end", gap: "6px" }}>
                              <div style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>{location.quantity}</div>
                              <span style={included ? includedBadgeStyle : mutedBadgeStyle}>
                                {included ? "Included" : "Excluded"}
                              </span>
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>
              </div>

              <div style={drawerSectionCardStyle}>
                <div style={drawerSectionHeaderStyle}>
                  <h3 style={drawerSectionTitleStyle}>Affected orders</h3>
                  <p style={drawerSectionTextStyle}>Orders currently blocked by this SKU shortage.</p>
                </div>
                <div style={drawerSectionBodyStyle}>
                  {(selectedSkuItem.affectedOrders || []).map((affected) => (
                    <div key={`${selectedSkuItem.key}-${affected.orderId}-${affected.date}`} style={drawerOrderRowStyle}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center" }}>
                        <a
                          href={getOrderAdminUrl(affected.adminOrderId)}
                          target="_blank"
                          rel="noreferrer"
                          style={orderLinkStyle}
                        >
                          {affected.orderName}
                        </a>
                        <span style={shortageBadgeStyle}>{affected.unfulfilled} unfulfilled</span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", color: "#667085", fontSize: "12px" }}>
                        <span>{formatDate(affected.date)}</span>
                        <span>Order ID: {affected.adminOrderId}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const fontStack =
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const message =
    error instanceof Error ? error.message : "An unexpected error occurred.";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #f5f7fb 0%, #eef2f7 100%)",
        padding: "14px",
        fontFamily: fontStack,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          maxWidth: "600px",
          width: "100%",
          marginTop: "40px",
          padding: "24px",
          background: "#ffffff",
          border: "1px solid #f4caca",
          borderRadius: "14px",
          boxShadow: "0 4px 14px rgba(15, 23, 42, 0.06)",
        }}
      >
        <h2
          style={{
            margin: "0 0 8px 0",
            fontSize: "16px",
            fontWeight: 700,
            color: "#9b1c1c",
          }}
        >
          Something went wrong
        </h2>
        <p style={{ margin: 0, fontSize: "13px", color: "#b42318", lineHeight: 1.5 }}>
          {message}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: "16px",
            appearance: "none",
            border: "1px solid #f4caca",
            background: "#fff5f5",
            color: "#9b1c1c",
            padding: "8px 14px",
            borderRadius: "10px",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: fontStack,
          }}
        >
          Reload page
        </button>
      </div>
    </div>
  );
}
