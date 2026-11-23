import { formatWalletAssetRow, type WalletAssetRow } from "../../../review-app/src/walletAssetRow.js";
import { asRecord } from "../../../review-app/src/parse.js";
import { section, accordion, element, monoShort, placeholder, row, timeValue } from "../../../review-app/src/ui/ui.js";
import { qualifiedName } from "../../../review-app/src/format.js";
import { t } from "../../../review-app/src/i18n/i18n.js";
import type { CardRenderer } from "./lifecycle.js";
import "../../../review-app/src/account.css";

export const accountRenderer = {
  title: "Account assets",
  guidance: (_snapshot, context) => context.recoveryNeeded ? "Ask in chat to view the assets for this account." : undefined,
  controls: () => element("p", "ui-note", "Please provide a Sui address in chat."),
  result(snapshot) {
    const payload = asRecord(snapshot.data);
    if (!payload || payload.status !== "ok" || !Array.isArray(payload.balances) ||
        typeof payload.account !== "string" || !Array.isArray(payload.nfts) || !Array.isArray(payload.objectGroups) ||
        typeof payload.objectsTruncated !== "boolean" || typeof payload.fetchedAt !== "string") throw new Error("Account data is incomplete.");
    const node = element("div");
    node.append(identitySection(payload.account, payload), balanceSection(payload));
    const seen = typeof payload.displayObjectCount === "number" ? payload.displayObjectCount : payload.nfts.length;
    node.append(row("Objects with Display metadata", payload.objectScanStatus === "unavailable" ? "Unavailable" :
      `${seen}${payload.objectsTruncated ? " observed (partial scan)" : ""}`));
    const renderable = typeof payload.renderableDisplayCount === "number" ? payload.renderableDisplayCount : seen;
    if (renderable < seen) node.append(row("With a display name or image", String(renderable)));
    if (payload.displayObjectsTruncated) node.append(placeholder(`Showing ${payload.nfts.length} of ${renderable} displayable objects.`));
    const details = accordion("Details");
    if (payload.nfts.length) details.body.append(nftSection(payload));
    details.body.append(row(t.common.retrievedAt, timeValue(payload.fetchedAt)));
    node.append(details.details, objectsSection(payload));
    return { node };
  }
} satisfies CardRenderer;

function identitySection(address: string, payload: Record<string, unknown>): HTMLElement {
  const node = section();
  const name = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : undefined;
  if (name) node.append(row(t.account.name, name));
  else if (payload.nameStatus === "unavailable") node.append(row(t.account.name, "Unavailable"));
  node.append(row(t.account.address, monoShort(address)));
  return node;
}

// Show the verified total without exposing the storage format of the balance.
function balanceSection(payload: Record<string, unknown>): HTMLElement {
  const node = section(t.account.balances);
  if (payload.balancesIncompleteReason) node.append(placeholder("The balance scan is incomplete. Only consistently observed balances are shown."));
  const balances = Array.isArray(payload.balances) ? payload.balances : [];
  if (balances.length === 0) {
    if (!payload.balancesIncompleteReason) node.append(element("p", "ui-note", t.account.noBalances));
    return node;
  }
  for (const entry of balances) {
    const assetRow = formatWalletAssetRow(entry);
    if (assetRow) {
      node.append(assetBreakdownRow(assetRow));
    }
  }
  return node;
}

// Owned NFTs with a Display name/image, available in the detail slide. Images
// load directly from their external host (page CSP allows external https), with a
// no-referrer policy so only the image bytes are requested.
function nftSection(payload: Record<string, unknown>): HTMLElement {
  const node = section("Objects with Display metadata");
  const nfts = Array.isArray(payload.nfts) ? payload.nfts : [];
  const grid = element("div", "account-nfts");
  for (const raw of nfts) {
    const nft = asRecord(raw);
    if (nft) {
      grid.append(nftTile(nft));
    }
  }
  node.append(grid);
  return node;
}

function nftTile(nft: Record<string, unknown>): HTMLElement {
  const type = typeof nft.type === "string" ? nft.type : "";
  const name = typeof nft.name === "string" && nft.name.length > 0 ? nft.name : qualifiedName(type);
  const imageUrl = typeof nft.imageUrl === "string" && nft.imageUrl.length > 0 ? imageSrc(nft.imageUrl) : undefined;
  const tile = element("div", "account-nft");
  if (imageUrl) {
    const img = document.createElement("img");
    img.className = "account-nft-img";
    img.src = imageUrl;
    img.alt = name;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    // A failed external image is replaced with a "No image" box rather than the
    // browser's broken-image glyph.
    img.addEventListener("error", () => {
      img.replaceWith(element("div", "account-nft-img account-nft-noimg", t.account.noImage));
    });
    tile.append(img);
  } else {
    tile.append(element("div", "account-nft-img account-nft-noimg", t.account.noImage));
  }
  tile.append(element("span", "account-nft-name", name));
  return tile;
}

function objectsSection(payload: Record<string, unknown>): HTMLElement {
  const groups = Array.isArray(payload.objectGroups) ? payload.objectGroups : [];
  const body = element("div");
  const count = groups.reduce((sum, raw) => {
    const group = asRecord(raw);
    return sum + (typeof group?.count === "number" ? group.count : 0);
  }, 0);
  if (count > 0) body.append(element("p", "ui-note", `${count} other owned objects are not shown here.`));
  if (payload.objectsTruncated === true) {
    body.append(placeholder(t.account.objectsTruncated));
  }
  return body;
}

function assetBreakdownRow(assetRow: WalletAssetRow): HTMLElement {
  const node = element("div", "account-asset");
  node.append(element("span", "account-asset-symbol", assetRow.symbol));
  const total = element("span", "account-asset-total");
  total.append(assetRow.total);
  node.append(total);
  if (assetRow.coinType) node.append(element("span", "ui-mono", assetRow.coinType));
  return node;
}

// NFT image hosts vary; ipfs:// URLs are rewritten to a public gateway so the
// browser (which has no ipfs scheme handler) can still load them over https.
function imageSrc(url: string): string {
  const resolved = url.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${url.slice("ipfs://".length)}` : url;
  try { return (new URL(resolved).protocol === "https:" || /^data:image\//i.test(resolved)) ? resolved : ""; } catch { return ""; }
}
