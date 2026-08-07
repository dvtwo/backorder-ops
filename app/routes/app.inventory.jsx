import { authenticate } from "../shopify.server";
import { fetchInventoryCatalog } from "../inventory.server";
import { getCachedValue } from "../cache.server";

const INVENTORY_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

export const loader = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const force = url.searchParams.has("refresh");
    const { value, cached, cachedAt } = await getCachedValue(
      `inventory-catalog:${session.shop}`,
      INVENTORY_CATALOG_CACHE_TTL_MS,
      () => fetchInventoryCatalog(admin),
      { force },
    );

    return {
      inventoryCatalog: value.inventoryRows,
      inventoryError: "",
      loadedAt: cachedAt,
      stats: {
        ...value.stats,
        cached,
        cachedAt,
      },
    };
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error("Inventory catalog load failed", error);

    return {
      inventoryCatalog: [],
      inventoryError:
        error instanceof Error ? error.message : "Failed to load inventory data",
      loadedAt: new Date().toISOString(),
      stats: {
        productVariantPages: 0,
        productVariantsFetched: 0,
        productVariantsTruncated: false,
      },
    };
  }
};
