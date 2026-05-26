import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

// ── Query: find a product variant by exact SKU ────────────────────────────────

const FIND_VARIANT_BY_SKU = `#graphql
  query FindVariantBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      edges {
        node {
          id
          sku
          product {
            id
          }
        }
      }
    }
  }
`;

export async function findVariantBySku(
  admin: AdminApiContext,
  sku: string
): Promise<{ variantId: string; productId: string } | null> {
  const response = await admin.graphql(FIND_VARIANT_BY_SKU, {
    variables: { query: `sku:"${sku}"` },
  });

  const data = (await response.json()) as {
    data?: {
      productVariants?: {
        edges: Array<{
          node: { id: string; sku: string; product: { id: string } };
        }>;
      };
    };
  };

  const edge = data.data?.productVariants?.edges?.[0];
  if (!edge) return null;

  return {
    variantId: edge.node.id,
    productId: edge.node.product.id,
  };
}

// ── Query: list products (for dashboard table) ────────────────────────────────

const LIST_PRODUCTS = `#graphql
  query ListProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: TITLE) {
      edges {
        node {
          id
          title
          handle
          status
          featuredImage {
            url
          }
          variants(first: 1) {
            edges {
              node {
                id
                sku
                price
              }
            }
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export type ShopifyProductRow = {
  id: string;
  title: string;
  handle: string;
  status: string;
  sku: string;
  price: string;
  variantId: string;
  image: string | null;
};

export async function listProducts(
  admin: AdminApiContext,
  limit = 100
): Promise<ShopifyProductRow[]> {
  const results: ShopifyProductRow[] = [];
  let after: string | undefined;

  while (results.length < limit) {
    const batchSize = Math.min(50, limit - results.length);
    const response = await admin.graphql(LIST_PRODUCTS, {
      variables: { first: batchSize, after: after ?? null },
    });

    const data = (await response.json()) as {
      data?: {
        products?: {
          edges: Array<{
            cursor: string;
            node: {
              id: string;
              title: string;
              handle: string;
              status: string;
              featuredImage?: { url: string } | null;
              variants: {
                edges: Array<{ node: { id: string; sku: string; price: string } }>;
              };
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      };
    };

    const edges = data.data?.products?.edges ?? [];
    for (const { node } of edges) {
      const variant = node.variants.edges[0]?.node;
      results.push({
        id: node.id,
        title: node.title,
        handle: node.handle,
        status: node.status,
        sku: variant?.sku ?? "",
        price: variant?.price ?? "",
        variantId: variant?.id ?? "",
        image: node.featuredImage?.url ?? null,
      });
    }

    const pageInfo = data.data?.products?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  return results;
}

// ── Query: find a product by title ────────────────────────────────────────────

const FIND_PRODUCT_BY_TITLE = `#graphql
  query FindProductByTitle($query: String!) {
    products(first: 1, query: $query) {
      edges {
        node {
          id
          variants(first: 1) {
            edges {
              node { id }
            }
          }
        }
      }
    }
  }
`;

export async function findProductByTitle(
  admin: AdminApiContext,
  title: string
): Promise<{ variantId: string; productId: string } | null> {
  const response = await admin.graphql(FIND_PRODUCT_BY_TITLE, {
    variables: { query: `title:"${title}"` },
  });

  const data = (await response.json()) as {
    data?: {
      products?: {
        edges: Array<{
          node: {
            id: string;
            variants: { edges: Array<{ node: { id: string } }> };
          };
        }>;
      };
    };
  };

  const node = data.data?.products?.edges?.[0]?.node;
  if (!node) return null;

  return {
    productId: node.id,
    variantId: node.variants.edges[0]?.node.id ?? "",
  };
}

// ── Query: find a product by handle ───────────────────────────────────────────

const FIND_PRODUCT_BY_HANDLE = `#graphql
  query FindProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      id
      variants(first: 1) {
        edges {
          node { id }
        }
      }
    }
  }
`;

export async function findProductByHandle(
  admin: AdminApiContext,
  handle: string
): Promise<{ variantId: string; productId: string } | null> {
  const response = await admin.graphql(FIND_PRODUCT_BY_HANDLE, {
    variables: { handle },
  });

  const data = (await response.json()) as {
    data?: {
      productByHandle?: {
        id: string;
        variants: { edges: Array<{ node: { id: string } }> };
      } | null;
    };
  };

  const product = data.data?.productByHandle;
  if (!product) return null;

  return {
    productId: product.id,
    variantId: product.variants.edges[0]?.node.id ?? "",
  };
}

// ── Mutation: update product-level fields ─────────────────────────────────────

const UPDATE_PRODUCT = `#graphql
  mutation UpdateProduct($product: ProductUpdateInput!, $identifier: ProductUpdateIdentifiers!) {
    productUpdate(product: $product, identifier: $identifier) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Update product-level fields (title, bodyHtml, vendor, productType, tags).
 * Only call this when at least one of these fields is present in `fields`.
 * Returns an array of user-error strings (empty array = success).
 */
export async function updateProductFields(
  admin: AdminApiContext,
  productId: string,
  fields: Partial<{
    title: string;
    bodyHtml: string;
    vendor: string;
    productType: string;
    tags: string[];
  }>
): Promise<string[]> {
  const product: Record<string, unknown> = {};

  if (fields.title !== undefined) product.title = fields.title;
  if (fields.bodyHtml !== undefined) product.bodyHtml = fields.bodyHtml;
  if (fields.vendor !== undefined) product.vendor = fields.vendor;
  if (fields.productType !== undefined) product.productType = fields.productType;
  if (fields.tags !== undefined) product.tags = fields.tags;

  const response = await admin.graphql(UPDATE_PRODUCT, {
    variables: {
      product,
      identifier: { id: productId },
    },
  });

  const data = (await response.json()) as {
    data?: {
      productUpdate?: {
        userErrors: Array<{ field: string[]; message: string }>;
      };
    };
  };

  const userErrors = data.data?.productUpdate?.userErrors ?? [];
  return userErrors.map((e) => `[product ${productId}] ${e.message}`);
}

// ── Mutation: update variant-level fields ─────────────────────────────────────

const UPDATE_VARIANT = `#graphql
  mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Update variant-level fields (price, compareAtPrice, barcode).
 * Only call this when at least one of these fields is present in `fields`.
 * compareAtPrice should be null to clear it, or a numeric string to set it.
 * Returns an array of user-error strings (empty array = success).
 */
export async function updateVariantFields(
  admin: AdminApiContext,
  variantId: string,
  productId: string,
  fields: Partial<{
    price: string;
    compareAtPrice: string | null;
    barcode: string;
  }>
): Promise<string[]> {
  const variantInput: Record<string, unknown> = { id: variantId };

  if (fields.price !== undefined) variantInput.price = fields.price;
  if (fields.compareAtPrice !== undefined)
    variantInput.compareAtPrice =
      fields.compareAtPrice === "" || fields.compareAtPrice === "0"
        ? null
        : fields.compareAtPrice;
  if (fields.barcode !== undefined) variantInput.barcode = fields.barcode;

  const response = await admin.graphql(UPDATE_VARIANT, {
    variables: {
      productId,
      variants: [variantInput],
    },
  });

  const data = (await response.json()) as {
    data?: {
      productVariantsBulkUpdate?: {
        userErrors: Array<{ field: string[]; message: string }>;
      };
    };
  };

  const userErrors = data.data?.productVariantsBulkUpdate?.userErrors ?? [];
  return userErrors.map((e) => `[variant ${variantId}] ${e.message}`);
}

// ── Query: get existing product image URLs (to avoid duplicates) ──────────────

const GET_PRODUCT_IMAGES = `#graphql
  query GetProductImages($id: ID!) {
    product(id: $id) {
      media(first: 20) {
        edges {
          node {
            ... on MediaImage {
              image {
                url
              }
            }
          }
        }
      }
    }
  }
`;

export async function getProductImageUrls(
  admin: AdminApiContext,
  productId: string
): Promise<string[]> {
  const response = await admin.graphql(GET_PRODUCT_IMAGES, {
    variables: { id: productId },
  });

  const data = (await response.json()) as {
    data?: {
      product?: {
        media: {
          edges: Array<{ node: { image?: { url: string } } }>;
        };
      };
    };
  };

  return (data.data?.product?.media.edges ?? [])
    .map((e) => e.node.image?.url ?? "")
    .filter(Boolean);
}

// ── Mutation: attach images to a product ──────────────────────────────────────

const CREATE_PRODUCT_MEDIA = `#graphql
  mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
    productCreateMedia(media: $media, productId: $productId) {
      media {
        alt
        mediaContentType
        status
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

/**
 * Attach image URLs to a product. Skips URLs that the product already has
 * (matched by URL substring to handle CDN rewrites).
 * Returns an array of error strings (empty = success).
 */
export async function attachProductImages(
  admin: AdminApiContext,
  productId: string,
  imageUrls: string[],
  altText = ""
): Promise<string[]> {
  const valid = imageUrls.filter((u) => u.startsWith("http"));
  if (valid.length === 0) return [];

  // Fetch existing images and skip already-present ones
  const existing = await getProductImageUrls(admin, productId);
  const toAdd = valid.filter(
    (url) => !existing.some((ex) => ex.includes(url) || url.includes(ex))
  );
  if (toAdd.length === 0) return [];

  const media = toAdd.map((url) => ({
    originalSource: url,
    alt: altText,
    mediaContentType: "IMAGE",
  }));

  const response = await admin.graphql(CREATE_PRODUCT_MEDIA, {
    variables: { productId, media },
  });

  const data = (await response.json()) as {
    data?: {
      productCreateMedia?: {
        mediaUserErrors: Array<{ field: string[]; message: string }>;
      };
    };
  };

  const errs = data.data?.productCreateMedia?.mediaUserErrors ?? [];
  return errs.map((e) => `[image ${productId}] ${e.message}`);
}

// ── Mutation: create/replace variant options ──────────────────────────────────

const GET_PRODUCT_OPTIONS = `#graphql
  query GetProductOptions($id: ID!) {
    product(id: $id) {
      options {
        id
        name
        values
      }
    }
  }
`;

const CREATE_PRODUCT_OPTIONS = `#graphql
  mutation productOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
    productOptionsCreate(productId: $productId, options: $options) {
      product {
        id
        options {
          id
          name
          values
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const UPDATE_PRODUCT_OPTION = `#graphql
  mutation productOptionUpdate($productId: ID!, $option: OptionUpdateInput!, $variantStrategy: ProductOptionUpdateVariantStrategy) {
    productOptionUpdate(productId: $productId, option: $option, variantStrategy: $variantStrategy) {
      product {
        id
        options {
          id
          name
          values
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Ensure a product has the given option with the given values.
 * - If the option doesn't exist yet → creates it with all values.
 * - If it exists → updates it to include any missing values.
 * Uses variantStrategy: LEAVE_AS_IS to avoid destroying existing variants.
 * Returns an array of error strings.
 */
export async function upsertProductOption(
  admin: AdminApiContext,
  productId: string,
  optionName: string,
  optionValues: string[]
): Promise<string[]> {
  if (!optionName || optionValues.length === 0) return [];

  // Fetch current options
  const optRes = await admin.graphql(GET_PRODUCT_OPTIONS, {
    variables: { id: productId },
  });
  const optData = (await optRes.json()) as {
    data?: {
      product?: {
        options: Array<{ id: string; name: string; values: string[] }>;
      };
    };
  };

  const existing = optData.data?.product?.options ?? [];
  const match = existing.find(
    (o) => o.name.toLowerCase() === optionName.toLowerCase()
  );

  if (!match) {
    // Create the option from scratch
    const response = await admin.graphql(CREATE_PRODUCT_OPTIONS, {
      variables: {
        productId,
        options: [
          {
            name: optionName,
            values: optionValues.map((v) => ({ name: v })),
          },
        ],
      },
    });
    const data = (await response.json()) as {
      data?: {
        productOptionsCreate?: {
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };
    };
    return (data.data?.productOptionsCreate?.userErrors ?? []).map(
      (e) => `[option create ${optionName}] ${e.message}`
    );
  }

  // Option exists — find values that need to be added
  const existingValues = new Set(match.values.map((v) => v.toLowerCase()));
  const newValues = optionValues.filter(
    (v) => !existingValues.has(v.toLowerCase())
  );
  if (newValues.length === 0) return [];

  const allValues = [...match.values, ...newValues];
  const response = await admin.graphql(UPDATE_PRODUCT_OPTION, {
    variables: {
      productId,
      option: {
        id: match.id,
        name: optionName,
        values: allValues.map((v) => ({ name: v })),
      },
      variantStrategy: "LEAVE_AS_IS",
    },
  });
  const data = (await response.json()) as {
    data?: {
      productOptionUpdate?: {
        userErrors: Array<{ field: string[]; message: string }>;
      };
    };
  };
  return (data.data?.productOptionUpdate?.userErrors ?? []).map(
    (e) => `[option update ${optionName}] ${e.message}`
  );
}

// ── Mutation: create a new product with an initial variant ────────────────────

const CREATE_PRODUCT = `#graphql
  mutation CreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        variants(first: 1) {
          edges {
            node { id }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function createProduct(
  admin: AdminApiContext,
  fields: {
    title: string;
    bodyHtml?: string;
    vendor?: string;
    productType?: string;
    tags?: string[];
    sku?: string;
    price?: string;
    compareAtPrice?: string | null;
    barcode?: string;
  }
): Promise<{ productId: string; variantId: string } | { errors: string[] }> {
  // Step 1: create the product (product-level fields only)
  const productInput: Record<string, unknown> = {
    title: fields.title,
    status: "ACTIVE",
  };
  if (fields.bodyHtml) productInput.descriptionHtml = fields.bodyHtml;
  if (fields.vendor) productInput.vendor = fields.vendor;
  if (fields.productType) productInput.productType = fields.productType;
  if (fields.tags) productInput.tags = fields.tags;

  const response = await admin.graphql(CREATE_PRODUCT, {
    variables: { product: productInput },
  });

  const data = (await response.json()) as {
    data?: {
      productCreate?: {
        product?: {
          id: string;
          variants: { edges: Array<{ node: { id: string } }> };
        };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    };
  };

  const userErrors = data.data?.productCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { errors: userErrors.map((e) => e.message) };
  }

  const product = data.data?.productCreate?.product;
  if (!product) return { errors: ["productCreate returned no product"] };

  const productId = product.id;
  const variantId = product.variants.edges[0]?.node.id ?? "";

  // Step 2: update the default variant with price/SKU/barcode
  const hasVariantFields = fields.sku || fields.price || fields.compareAtPrice !== undefined || fields.barcode;
  if (variantId && hasVariantFields) {
    const variantInput: Record<string, unknown> = { id: variantId };
    if (fields.sku) variantInput.sku = fields.sku;
    if (fields.price) variantInput.price = fields.price;
    if (fields.compareAtPrice !== undefined) variantInput.compareAtPrice = fields.compareAtPrice ?? null;
    if (fields.barcode) variantInput.barcode = fields.barcode;

    const variantErrors = await updateVariantFields(
      admin,
      variantId,
      productId,
      {
        price: fields.price,
        compareAtPrice: fields.compareAtPrice,
        barcode: fields.barcode,
      }
    );
    if (variantErrors.length > 0) {
      return { errors: variantErrors };
    }
  }

  return { productId, variantId };
}
