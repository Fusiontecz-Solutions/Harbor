import { useEffect, useRef } from "react";
import { useSocket } from "@/context/SocketContext";
import type { ApplicationLetterStatus } from "@/types/applicationTypes";

/** Matches backend `LETTER_DELIVERY_STATUS_SOCKET_EVENT`. */
export const LETTER_DELIVERY_STATUS_SOCKET_EVENT = "letter:delivery-status";

export type LetterDeliveryStatusRealtimePayload = {
  applicationId?: string;
  status?: string;
  templateName?: string;
  letterType?: ApplicationLetterStatus["letterType"];
  recipient?: string | null;
  sentAt?: string | null;
  ocid?: string;
};

/**
 * Instant Letters-list refresh when SendGrid Event Webhook updates
 * delivered / opened / clicked (no wait for the next poll).
 */
export function useLetterDeliveryStatusRealtime(
  enabled: boolean,
  onUpdate: (payload: LetterDeliveryStatusRealtimePayload) => void,
): void {
  const { socket } = useSocket();
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!enabled || !socket) return;

    const handle = (payload: LetterDeliveryStatusRealtimePayload) => {
      if (!payload?.applicationId || !payload?.status) return;
      onUpdateRef.current(payload);
    };

    socket.on(LETTER_DELIVERY_STATUS_SOCKET_EVENT, handle);
    return () => {
      socket.off(LETTER_DELIVERY_STATUS_SOCKET_EVENT, handle);
    };
  }, [socket, enabled]);
}
