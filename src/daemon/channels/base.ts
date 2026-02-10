/**
 * @module daemon/channels/base
 * @role Re-export the Channel interface from shared types.
 * @responsibilities
 *   - Provide the Channel contract that all adapters must implement
 * @dependencies shared/types
 * @effects None
 */

export type { Channel, IncomingMessage } from "../../shared/types";
