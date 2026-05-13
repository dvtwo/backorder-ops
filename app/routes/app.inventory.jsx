import { authenticate } from "../shopify.server";
import { fetchInventoryCatalog } from "../inventory.server";

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { inventoryRows, stats } = await fetchInventoryCatalog(admin);

    return {
      inventoryCatalog: inventoryRows,
      inventoryError: "",
      loadedAt: new Date().toISOString(),
      stats,
    };
  } catch (error) {
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
