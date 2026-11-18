ALTER TABLE "MessagingConversation" ADD COLUMN "hasInboundReply" BOOLEAN NOT NULL DEFAULT false;

UPDATE "MessagingConversation" AS c
SET "hasInboundReply" = true
WHERE c."hasBroadcastMessage" = true
  AND EXISTS (
    SELECT 1
    FROM "MessagingMessage" AS m
    WHERE m."conversationId" = c.id
      AND m.direction = 'INBOUND'
  );
