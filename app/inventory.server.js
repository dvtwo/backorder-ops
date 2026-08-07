const PRODUCT_VARIANTS_PAGE_SIZE = 100;
const INVENTORY_LEVELS_PAGE_SIZE = 100;
const MAX_PRODUCT_VARIANT_PAGES = 30;
const INVENTORY_CATALOG_LEVEL_CONCURRENCY = 4;

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

async function graphqlJson(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(result.errors[0]?.message || "GraphQL query failed");
  }

  return result.data;
}

const quantityValue = (quantities = [], name) =>
  Number(quantities.find((quantity) => quantity?.name === name)?.quantity || 0);

const normalizeInventoryLevel = (level) => {
  const quantities = level?.quantities || [];
  const reserved = quantityValue(quantities, "reserved");
  const damaged = quantityValue(quantities, "damaged");
  const qualityControl = quantityValue(quantities, "quality_control");
  const safetyStock = quantityValue(quantities, "safety_stock");

  return {
    locationId: level?.location?.id || "",
    locationName: level?.location?.name || "Unknown location",
    onHand: quantityValue(quantities, "on_hand"),
    committed: quantityValue(quantities, "committed"),
    unavailable: reserved + damaged + qualityControl + safetyStock,
    available: quantityValue(quantities, "available"),
    incoming: quantityValue(quantities, "incoming"),
  };
};

async function fetchInventoryLevelPages(admin, inventoryItemId, firstPageEdges, firstPageInfo) {
  const edges = [...(firstPageEdges || [])];
  let hasNextPage = Boolean(firstPageInfo?.hasNextPage);
  let after = firstPageInfo?.endCursor || null;

  while (hasNextPage) {
    const data = await graphqlJson(
      admin,
      `#graphql
        query InventoryCatalogLevelPage($id: ID!, $first: Int!, $after: String) {
          inventoryItem(id: $id) {
            id
            inventoryLevels(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  location {
                    id
                    name
                  }
                  quantities(names: ["available", "incoming", "committed", "damaged", "on_hand", "quality_control", "reserved", "safety_stock"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        }
      `,
      { id: inventoryItemId, first: INVENTORY_LEVELS_PAGE_SIZE, after },
    );

    const connection = data?.inventoryItem?.inventoryLevels;
    edges.push(...(connection?.edges || []));
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = connection?.pageInfo?.endCursor || null;
  }

  return edges;
}

export async function fetchInventoryCatalog(admin) {
  const inventoryRows = [];
  let hasNextPage = true;
  let after = null;
  let productVariantPages = 0;
  let productVariantsFetched = 0;

  while (hasNextPage && productVariantPages < MAX_PRODUCT_VARIANT_PAGES) {
    const data = await graphqlJson(
      admin,
      `#graphql
        query InventoryCatalogVariants($first: Int!, $after: String, $levelsFirst: Int!) {
          productVariants(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                title
                sku
                displayName
                product {
                  id
                  title
                  vendor
                  status
                }
                inventoryItem {
                  id
                  inventoryLevels(first: $levelsFirst) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    edges {
                      node {
                        location {
                          id
                          name
                        }
                        quantities(names: ["available", "incoming", "committed", "damaged", "on_hand", "quality_control", "reserved", "safety_stock"]) {
                          name
                          quantity
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
      {
        first: PRODUCT_VARIANTS_PAGE_SIZE,
        after,
        levelsFirst: INVENTORY_LEVELS_PAGE_SIZE,
      },
    );

    const connection = data?.productVariants;
    const edges = connection?.edges || [];
    productVariantPages += 1;
    productVariantsFetched += edges.length;

    const pageRows = await mapWithConcurrency(
      edges,
      INVENTORY_CATALOG_LEVEL_CONCURRENCY,
      async (edge) => {
      const variant = edge?.node;
      if (!variant?.id) return [];

      const inventoryItemId = variant?.inventoryItem?.id || "";
      const inventoryLevelConnection = variant?.inventoryItem?.inventoryLevels;
      const inventoryLevelEdges = inventoryItemId
        ? await fetchInventoryLevelPages(
            admin,
            inventoryItemId,
            inventoryLevelConnection?.edges || [],
            inventoryLevelConnection?.pageInfo,
          )
        : [];

      const levels = inventoryLevelEdges
        .map((levelEdge) => normalizeInventoryLevel(levelEdge?.node))
        .filter(Boolean);
      const rowLevels = levels.length
        ? levels
        : [
            {
              locationId: "",
              locationName: "No inventory location",
              onHand: 0,
              committed: 0,
              unavailable: 0,
              available: 0,
              incoming: 0,
            },
          ];

      return rowLevels.map((level) => ({
          id: `${variant.id}-${level.locationId || "none"}`,
          productId: variant.product?.id || "",
          variantId: variant.id,
          inventoryItemId,
          product: variant.product?.title || variant.displayName || "Untitled product",
          variant: variant.title === "Default Title" ? "" : variant.title || "",
          displayName: variant.displayName || variant.product?.title || "Untitled product",
          sku: variant.sku || "-",
          brand: variant.product?.vendor || "-",
          status: variant.product?.status || "UNKNOWN",
          ...level,
        }));
    });

    inventoryRows.push(...pageRows.flat());

    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = connection?.pageInfo?.endCursor || null;
  }

  return {
    inventoryRows,
    stats: {
      productVariantPages,
      productVariantsFetched,
      productVariantsTruncated: hasNextPage,
    },
  };
}
