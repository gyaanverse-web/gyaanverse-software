import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/dist/queueAdapters/bullMQ.js'
import { FastifyAdapter } from '@bull-board/fastify'
import { getEvaluationQueue } from '@modules/evaluation/evaluation.service.js'
import { getEmailQueue, getSmsQueue, getBulkQueue } from '@modules/notification/notification.queues.js'

export function createBoard() {
  const serverAdapter = new FastifyAdapter()
  serverAdapter.setBasePath('/queues')

  createBullBoard({
    queues: [
      new BullMQAdapter(getEvaluationQueue()),
      new BullMQAdapter(getEmailQueue()),
      new BullMQAdapter(getSmsQueue()),
      new BullMQAdapter(getBulkQueue()),
    ],
    serverAdapter,
  })

  return serverAdapter
}
