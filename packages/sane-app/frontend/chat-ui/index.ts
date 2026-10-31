/**
 * Opt-in presentation foundations for chat features.
 *
 * Keep fetching, operation identity, delivery evidence, and domain status labels
 * in each feature's existing client/presentation/controller layers. These
 * components only own layout, visual tone, and local disclosure behavior.
 *
 * Existing feature UIs are intentionally not migrated by introducing this API.
 */
export * from "./chat-card";
export * from "./chat-controls";
export * from "./chat-dialog";
export * from "./chat-overflow-menu";
