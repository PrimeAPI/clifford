import type { Job } from 'bullmq';
import type { DeliveryAckJob, Logger } from '@clifford/sdk';
import { getDb, messages } from '@clifford/db';
import { eq } from 'drizzle-orm';

export async function processDeliveryAck(job: Job<DeliveryAckJob>, logger: Logger) {
  const { messageId, status, error } = job.data;
  const db = getDb();

  const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) {
    logger.warn({ messageId }, 'Delivery ack message not found');
    return;
  }

  await db
    .update(messages)
    .set({
      deliveryStatus: status,
      deliveryError: status === 'failed' ? error ?? 'Delivery failed' : null,
      deliveredAt: status === 'delivered' ? new Date() : null,
    })
    .where(eq(messages.id, messageId));
}
