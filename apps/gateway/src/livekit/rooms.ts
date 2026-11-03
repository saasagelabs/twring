import type { LiveKitConfig } from '@twring/config/gateway';
import { RoomServiceClient } from 'livekit-server-sdk';

/** Room administration the call registry needs (rooms are created on first join; see tokens.ts). */
export interface RoomService {
  /** Removes the room and disconnects everyone in it. Resolves if the room is already gone. */
  deleteRoom(name: string): Promise<void>;
  /** Removes one participant from a room. Resolves if they are already gone. */
  removeParticipant(room: string, identity: string): Promise<void>;
  /** Cheap authenticated call for /health/ready. */
  ping(): Promise<void>;
}

/** The server API speaks HTTP(S) on the same host as the WebSocket signalling URL. */
export function liveKitApiHost(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return parsed.origin;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

export function createLiveKitRoomService(config: LiveKitConfig): RoomService {
  const client = new RoomServiceClient(liveKitApiHost(config.url), config.apiKey, config.apiSecret);
  return {
    async deleteRoom(name) {
      try {
        await client.deleteRoom(name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async removeParticipant(room, identity) {
      try {
        await client.removeParticipant(room, identity);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async ping() {
      await client.listRooms(['cord-health-probe']);
    },
  };
}
