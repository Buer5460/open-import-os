/**
 * Barrel for the business service layer. Subpath imports also exist for
 * tree-shaking, but a single entry keeps API/MCP wiring simple.
 */
export { ENGINE_VERSION as COST_ENGINE_VERSION, calculateLandedCost, allocateBatch } from "./cost.js";
export { ENGINE_VERSION as PROFIT_ENGINE_VERSION, calculateProfit, verifyTargetPrice, roundPriceUp } from "./profit.js";
export * from "./products.js";
export * from "./fees.js";
export * from "./calculations.js";
export * from "./classification.js";
export * from "./import.js";
