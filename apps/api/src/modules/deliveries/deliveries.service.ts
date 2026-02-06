import { config } from '../../config.js';

export function requireDeliveryToken(req: any, reply: any) {
  const token = req.headers['x-delivery-token'] as string | undefined;
  if (!config.deliveryToken || token !== config.deliveryToken) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
